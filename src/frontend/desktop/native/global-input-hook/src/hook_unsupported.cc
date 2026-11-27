#include "platform_hook.h"

bool PlatformHookSupported() { return false; }
bool PlatformPermissionGranted() { return false; }
bool PlatformRequestPermission() { return false; }

bool PlatformStartHook(const HookConfig &, HookEventCallback,
                       std::string *error) {
  *error = "Global hold shortcuts are not supported on this system.";
  return false;
}

void PlatformStopHook() {}
