#include "platform_hook.h"

#include "hook_linux_keys.h"

#include <X11/XKBlib.h>
#include <X11/Xlib.h>
#include <X11/extensions/XInput2.h>

#include <poll.h>
#include <unistd.h>

#include <condition_variable>
#include <cstdlib>
#include <mutex>
#include <string>
#include <thread>
#include <utility>

// Global Press to talk on an X11 session. XInput 2 raw events are delivered to
// a listener on the root window whichever application has focus, and reading
// them takes nothing from that application: this hook never grabs, never
// injects and never suppresses input. It looks at one binding and reports
// only that binding's down and up transitions; no key or button value leaves
// this file.

namespace {

using animama_linux::HoldMatcher;
using animama_linux::Modifiers;
using animama_linux::Transition;

std::mutex state_mutex;
std::condition_variable state_changed;
std::thread hook_thread;
int stop_pipe[2] = {-1, -1};
bool startup_complete = false;
bool startup_ok = false;
std::string startup_error;
HookEventCallback emit_event;

// Xlib's default handler ends the process on any protocol error. Nothing this
// hook asks for is worth that: ignore the error and carry on.
int IgnoreXError(Display *, XErrorEvent *) { return 0; }

void Emit(Transition transition) {
  if (transition == Transition::kDown)
    emit_event(true);
  else if (transition == Transition::kUp)
    emit_event(false);
}

void Fail(const std::string &message) {
  {
    std::scoped_lock lock(state_mutex);
    startup_error = message;
    startup_ok = false;
    startup_complete = true;
  }
  state_changed.notify_all();
}

void RunHook(HookConfig config, int stop_read) {
  XSetErrorHandler(IgnoreXError);
  Display *display = XOpenDisplay(nullptr);
  if (!display)
    return Fail("Animama could not connect to the X server.");
  int opcode = 0;
  int event = 0;
  int error = 0;
  int major = 2;
  int minor = 1;
  // Version 2.1 delivers raw events even while another client holds a grab.
  if (!XQueryExtension(display, "XInputExtension", &opcode, &event, &error) ||
      XIQueryVersion(display, &major, &minor) != Success ||
      (major == 2 && minor < 1) || major < 2) {
    XCloseDisplay(display);
    return Fail("This X server does not provide XInput 2.1.");
  }

  unsigned char bits[XIMaskLen(XI_LASTEVENT)] = {};
  XIEventMask mask;
  mask.deviceid = XIAllMasterDevices;
  mask.mask_len = sizeof bits;
  mask.mask = bits;
  if (config.mouse) {
    XISetMask(bits, XI_RawButtonPress);
    XISetMask(bits, XI_RawButtonRelease);
  } else {
    XISetMask(bits, XI_RawKeyPress);
    XISetMask(bits, XI_RawKeyRelease);
  }
  XISelectEvents(display, DefaultRootWindow(display), &mask, 1);
  XFlush(display);

  HoldMatcher matcher(std::move(config));
  // Raw events carry no modifier state, so ask the server when it matters.
  const auto modifiers = [display]() {
    XkbStateRec state;
    if (XkbGetState(display, XkbUseCoreKbd, &state) != Success)
      return Modifiers{};
    return animama_linux::ModifiersFromMask(state.mods);
  };

  {
    std::scoped_lock lock(state_mutex);
    startup_ok = true;
    startup_complete = true;
  }
  state_changed.notify_all();

  pollfd watched[2] = {{ConnectionNumber(display), POLLIN, 0},
                       {stop_read, POLLIN, 0}};
  for (;;) {
    while (XPending(display) > 0) {
      XEvent next;
      XNextEvent(display, &next);
      XGenericEventCookie *cookie = &next.xcookie;
      if (next.type != GenericEvent || cookie->extension != opcode ||
          !XGetEventData(display, cookie))
        continue;
      const auto *raw = static_cast<const XIRawEvent *>(cookie->data);
      switch (cookie->evtype) {
      case XI_RawKeyPress:
      case XI_RawKeyRelease:
        Emit(matcher.OnKey(raw->detail, cookie->evtype == XI_RawKeyPress,
                           modifiers));
        break;
      case XI_RawButtonPress:
      case XI_RawButtonRelease:
        Emit(matcher.OnButton(raw->detail,
                              cookie->evtype == XI_RawButtonPress, modifiers));
        break;
      default:
        break;
      }
      XFreeEventData(display, cookie);
    }
    if (poll(watched, 2, -1) < 0)
      continue;
    // Asked to stop, or the X connection is gone: either way the hold ends.
    if (watched[1].revents != 0 ||
        (watched[0].revents & (POLLERR | POLLHUP | POLLNVAL)) != 0)
      break;
  }
  // Fail closed: never leave a microphone hold active behind a dead hook.
  Emit(matcher.Reset());
  XCloseDisplay(display);
}

} // namespace

bool PlatformHookSupported() {
  return animama_linux::SessionIsX11(std::getenv("XDG_SESSION_TYPE"),
                                     std::getenv("WAYLAND_DISPLAY"),
                                     std::getenv("DISPLAY"));
}

// X11 has no permission to grant: any client may listen for raw events.
bool PlatformPermissionGranted() { return true; }

bool PlatformRequestPermission() { return true; }

bool PlatformStartHook(const HookConfig &config, HookEventCallback callback,
                       std::string *error) {
  if (!PlatformHookSupported()) {
    *error = "Global Press to talk needs an X11 session on Linux.";
    return false;
  }
  if (!HoldMatcher(config).Valid()) {
    *error = "The selected keyboard key is not supported on Linux.";
    return false;
  }
  PlatformStopHook();
  int pipe_ends[2];
  if (pipe(pipe_ends) != 0) {
    *error = "Animama could not start the global input monitor.";
    return false;
  }
  {
    std::scoped_lock lock(state_mutex);
    emit_event = std::move(callback);
    stop_pipe[0] = pipe_ends[0];
    stop_pipe[1] = pipe_ends[1];
    startup_complete = false;
    startup_ok = false;
    startup_error.clear();
  }
  hook_thread = std::thread(RunHook, config, pipe_ends[0]);
  std::unique_lock lock(state_mutex);
  state_changed.wait(lock, [] { return startup_complete; });
  if (!startup_ok) {
    *error = startup_error;
    lock.unlock();
    PlatformStopHook();
    return false;
  }
  return true;
}

void PlatformStopHook() {
  int write_end = -1;
  {
    std::scoped_lock lock(state_mutex);
    write_end = stop_pipe[1];
  }
  if (write_end >= 0) {
    const char byte = 's';
    // The thread also wakes if this write fails: closing the pipe ends poll.
    (void)!write(write_end, &byte, 1);
  }
  if (hook_thread.joinable())
    hook_thread.join();
  std::scoped_lock lock(state_mutex);
  for (int &end : stop_pipe) {
    if (end >= 0)
      close(end);
    end = -1;
  }
  emit_event = nullptr;
}
