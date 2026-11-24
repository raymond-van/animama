// animama-process-guard (Linux): run one Animama sidecar so that it cannot
// outlive the desktop app. The contract matches the Windows guard
// (process_guard.cpp), so the main process drives both the same way.
//
// Usage: animama-process-guard -- <absolute executable> [arguments...]
//
// 1. The service starts in its own process group and waits. The guard writes
//    one line to stdout, "animama-process-guard pid=<service pid>", and only
//    then lets the service run. The service's own output follows.
// 2. Standard input is the lifeline. When it reaches end of file (Electron
//    closed it, exited or crashed), or the guard receives SIGTERM, SIGINT or
//    SIGHUP, the guard sends the service SIGINT: PostgreSQL's fast shutdown and
//    a graceful stop for the server. If the service is still running after 15
//    seconds, the backend's own graceful-shutdown limit, the guard kills its
//    process group.
// 3. If the guard itself is killed, the kernel kills the service (its
//    parent-death signal). Unlike a Windows job this does not reach the
//    service's own children; PostgreSQL's exit when the postmaster dies.
// 4. When the service exits, anything left in its process group is killed. The
//    guard then waits briefly for orphans it adopted and exits with the
//    service's exit code, or 128 plus the signal that ended it.
//
// Secrets reach the service only through the inherited environment.
//
// The Linux-only calls are the child subreaper and the parent-death signal.
// Everything else is POSIX, so the lifeline logic is also tested on macOS.

#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifdef __linux__
#include <sys/prctl.h>
#endif

// Tests shorten the grace period; a staged guard always uses the default.
#ifndef GUARD_GRACE_MS
#define GUARD_GRACE_MS 15000
#endif
#define GUARD_ORPHAN_MS 5000

enum { kUsageError = 2, kStartError = 3, kExecError = 127 };

// Signal handlers only write one byte here; the main loop does the work.
static int signal_pipe[2] = {-1, -1};

static void on_signal(int number) {
  const int saved = errno;
  const char byte = number == SIGCHLD ? 'C' : 'T';
  // A full pipe already holds a pending wake-up, so a failed write is fine.
  (void)!write(signal_pipe[1], &byte, 1);
  errno = saved;
}

static long long now_ms(void) {
  struct timespec time;
  clock_gettime(CLOCK_MONOTONIC, &time);
  return (long long)time.tv_sec * 1000 + time.tv_nsec / 1000000;
}

static int set_cloexec_nonblocking(int descriptor) {
  const int flags = fcntl(descriptor, F_GETFL);
  return flags < 0 || fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) < 0 ||
                 fcntl(descriptor, F_SETFD, FD_CLOEXEC) < 0
             ? -1
             : 0;
}

static int fail(int code, const char* message) {
  fprintf(stderr, "animama-process-guard: %s\n", message);
  return code;
}

// The signals the guard handles. They are blocked across fork, so a stop that
// arrives before the service has reset them is delivered to the service with
// its default action instead of being swallowed by the guard's handler.
static void handled_signals(sigset_t* set) {
  sigemptyset(set);
  sigaddset(set, SIGCHLD);
  sigaddset(set, SIGTERM);
  sigaddset(set, SIGINT);
  sigaddset(set, SIGHUP);
}

// The service: wait for the guard's go-ahead, then become the executable.
static void run_service(pid_t guard, int go_read, char** arguments) {
  static const int handled[] = {SIGCHLD, SIGTERM, SIGINT, SIGHUP, SIGPIPE};
  sigset_t none;
  setpgid(0, 0);
  for (size_t i = 0; i < sizeof handled / sizeof handled[0]; ++i)
    signal(handled[i], SIG_DFL);
  // Only now may a pending stop reach the service: it ends it at once.
  sigemptyset(&none);
  sigprocmask(SIG_SETMASK, &none, NULL);
#ifdef __linux__
  // If the guard is killed, take the service with it.
  prctl(PR_SET_PDEATHSIG, SIGKILL);
#endif
  // The guard may have died before the signal was armed.
  if (getppid() != guard) _exit(kExecError);
  // The lifeline belongs to the guard; the service reads nothing.
  const int null = open("/dev/null", O_RDONLY);
  if (null < 0 || dup2(null, STDIN_FILENO) < 0) _exit(kExecError);
  if (null != STDIN_FILENO) close(null);
  char go;
  ssize_t count;
  do count = read(go_read, &go, 1);
  while (count < 0 && errno == EINTR);
  // End of file means the guard gave up before the handshake.
  if (count != 1) _exit(kExecError);
  close(go_read);
  execv(arguments[0], arguments);
  fprintf(stderr, "animama-process-guard: cannot run %s: %s\n", arguments[0],
          strerror(errno));
  _exit(kExecError);
}

int main(int argc, char** argv) {
  if (argc < 3 || strcmp(argv[1], "--") != 0 || argv[2][0] != '/')
    return fail(kUsageError,
                "usage: animama-process-guard -- <absolute executable> "
                "[arguments...]");
  if (access(argv[2], X_OK) != 0)
    return fail(kStartError, "the executable is missing or cannot be run");

  int go_pipe[2];
  if (pipe(signal_pipe) != 0 || pipe(go_pipe) != 0 ||
      set_cloexec_nonblocking(signal_pipe[0]) != 0 ||
      set_cloexec_nonblocking(signal_pipe[1]) != 0 ||
      fcntl(go_pipe[1], F_SETFD, FD_CLOEXEC) != 0)
    return fail(kStartError, "cannot create its pipes");

  struct sigaction action;
  memset(&action, 0, sizeof action);
  action.sa_handler = on_signal;
  sigemptyset(&action.sa_mask);
  action.sa_flags = SA_RESTART;
  sigaction(SIGCHLD, &action, NULL);
  sigaction(SIGTERM, &action, NULL);
  sigaction(SIGINT, &action, NULL);
  sigaction(SIGHUP, &action, NULL);
  // Electron may be gone when the handshake or a log line is written.
  signal(SIGPIPE, SIG_IGN);

#ifdef __linux__
  // Orphans of the service are handed to the guard, which waits for them.
  prctl(PR_SET_CHILD_SUBREAPER, 1);
#endif

  const pid_t guard = getpid();
  sigset_t handled;
  handled_signals(&handled);
  sigprocmask(SIG_BLOCK, &handled, NULL);
  const pid_t service = fork();
  if (service < 0) return fail(kStartError, "cannot start the service");
  if (service == 0) {
    close(go_pipe[1]);
    run_service(guard, go_pipe[0], argv + 2);
  }
  // Unblock rather than restore: a mask inherited with these signals blocked
  // would leave the guard deaf to its service's exit.
  sigprocmask(SIG_UNBLOCK, &handled, NULL);
  close(go_pipe[0]);
  // Also set here, so the group exists whichever process runs first.
  setpgid(service, service);

  printf("animama-process-guard pid=%ld\n", (long)service);
  fflush(stdout);
  (void)!write(go_pipe[1], "g", 1);
  close(go_pipe[1]);

  int lifeline_open = 1;
  int stopping = 0;
  long long deadline = 0;
  int status = 0;
  for (;;) {
    struct pollfd watched[2] = {
        {.fd = signal_pipe[0], .events = POLLIN},
        {.fd = lifeline_open ? STDIN_FILENO : -1, .events = POLLIN},
    };
    int timeout = -1;
    if (stopping && deadline) {
      const long long left = deadline - now_ms();
      timeout = left > 0 ? (int)left : 0;
    }
    const int ready = poll(watched, 2, timeout);
    if (ready < 0 && errno != EINTR) {
      kill(-service, SIGKILL);
      return fail(kStartError, "cannot watch its lifeline");
    }

    int stop_requested = 0;
    if (ready > 0 && watched[0].revents) {
      char bytes[64];
      ssize_t count;
      while ((count = read(signal_pipe[0], bytes, sizeof bytes)) > 0)
        for (ssize_t i = 0; i < count; ++i)
          if (bytes[i] == 'T') stop_requested = 1;
    }
    if (ready > 0 && watched[1].revents) {
      char bytes[256];
      const ssize_t count = read(STDIN_FILENO, bytes, sizeof bytes);
      // Bytes on the lifeline mean nothing; only its end does.
      if (count == 0 || (count < 0 && errno != EINTR && errno != EAGAIN)) {
        lifeline_open = 0;
        stop_requested = 1;
      }
    }

    // Look without reaping: while the service is a zombie its process ID, and
    // so its process group ID, cannot be given to another process.
    siginfo_t info;
    memset(&info, 0, sizeof info);
    if (waitid(P_PID, (id_t)service, &info, WEXITED | WNOHANG | WNOWAIT) == 0 &&
        info.si_pid == service) {
      kill(-service, SIGKILL);
      while (waitpid(service, &status, 0) < 0 && errno == EINTR) {
      }
      break;
    }

    if (stop_requested && !stopping) {
      stopping = 1;
      deadline = now_ms() + GUARD_GRACE_MS;
      kill(service, SIGINT);
    }
    if (stopping && deadline && now_ms() >= deadline) {
      deadline = 0;
      kill(-service, SIGKILL);
    }
  }

  // Wait for adopted orphans (a subreaper has them; elsewhere there are none).
  const long long orphans_until = now_ms() + GUARD_ORPHAN_MS;
  for (;;) {
    const pid_t reaped = waitpid(-1, NULL, WNOHANG);
    if (reaped < 0 && errno != EINTR) break;
    if (reaped == 0) {
      if (now_ms() >= orphans_until) break;
      struct pollfd wake = {.fd = signal_pipe[0], .events = POLLIN};
      char bytes[64];
      poll(&wake, 1, 100);
      while (read(signal_pipe[0], bytes, sizeof bytes) > 0) {
      }
    }
  }

  if (WIFEXITED(status)) return WEXITSTATUS(status);
  return WIFSIGNALED(status) ? 128 + WTERMSIG(status) : kStartError;
}
