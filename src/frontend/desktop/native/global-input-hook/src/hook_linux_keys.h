#pragma once

// The part of the Linux hook that decides, without touching X11: which X key
// code a binding names and when a held binding goes down and up. It compiles
// on any host, so its test runs wherever the suite does.

#include <functional>
#include <optional>
#include <string>
#include <utility>

#include "platform_hook.h"

namespace animama_linux {

// DOM KeyboardEvent.code names a physical key. On Linux the kernel reports it
// as an evdev scan code, and every current X server adds 8 to make the X key
// code, whatever the keyboard layout.
inline std::optional<int> XKeyCode(const std::string &code) {
  static const std::pair<const char *, int> evdev[] = {
      {"Escape", 1},      {"Digit1", 2},       {"Digit2", 3},
      {"Digit3", 4},      {"Digit4", 5},       {"Digit5", 6},
      {"Digit6", 7},      {"Digit7", 8},       {"Digit8", 9},
      {"Digit9", 10},     {"Digit0", 11},      {"Minus", 12},
      {"Equal", 13},      {"Backspace", 14},   {"Tab", 15},
      {"KeyQ", 16},       {"KeyW", 17},        {"KeyE", 18},
      {"KeyR", 19},       {"KeyT", 20},        {"KeyY", 21},
      {"KeyU", 22},       {"KeyI", 23},        {"KeyO", 24},
      {"KeyP", 25},       {"BracketLeft", 26}, {"BracketRight", 27},
      {"Enter", 28},      {"KeyA", 30},        {"KeyS", 31},
      {"KeyD", 32},       {"KeyF", 33},        {"KeyG", 34},
      {"KeyH", 35},       {"KeyJ", 36},        {"KeyK", 37},
      {"KeyL", 38},       {"Semicolon", 39},   {"Quote", 40},
      {"Backquote", 41},  {"Backslash", 43},   {"KeyZ", 44},
      {"KeyX", 45},       {"KeyC", 46},        {"KeyV", 47},
      {"KeyB", 48},       {"KeyN", 49},        {"KeyM", 50},
      {"Comma", 51},      {"Period", 52},      {"Slash", 53},
      {"Space", 57},      {"F1", 59},          {"F2", 60},
      {"F3", 61},         {"F4", 62},          {"F5", 63},
      {"F6", 64},         {"F7", 65},          {"F8", 66},
      {"F9", 67},         {"F10", 68},         {"F11", 87},
      {"F12", 88},        {"NumpadEnter", 96}, {"Home", 102},
      {"ArrowUp", 103},   {"PageUp", 104},     {"ArrowLeft", 105},
      {"ArrowRight", 106}, {"End", 107},       {"ArrowDown", 108},
      {"PageDown", 109},  {"Insert", 110},     {"Delete", 111},
      {"F13", 183},       {"F14", 184},        {"F15", 185},
      {"F16", 186},       {"F17", 187},        {"F18", 188},
      {"F19", 189},       {"F20", 190},        {"F21", 191},
      {"F22", 192},       {"F23", 193},        {"F24", 194},
  };
  for (const auto &[name, scan] : evdev)
    if (code == name)
      return scan + 8;
  return std::nullopt;
}

// Animama numbers buttons 1 left, 2 middle, 3 right, 4 back, 5 forward. X
// numbers the first three the same, uses 4 to 7 for the scroll wheel, and
// puts back and forward at 8 and 9. Zero means "not a button to bind".
inline int AnimamaMouseButton(int x_button) {
  if (x_button >= 1 && x_button <= 3)
    return x_button;
  if (x_button == 8 || x_button == 9)
    return x_button - 4;
  return 0;
}

struct Modifiers {
  bool ctrl = false;
  bool alt = false;
  bool shift = false;
  bool meta = false;
};

// X's modifier mask bits: Shift 1, Control 4, Mod1 (Alt) 8, Mod4 (Super) 64.
// Lock, Num Lock and the AltGr level are not binding modifiers.
inline Modifiers ModifiersFromMask(unsigned mask) {
  return Modifiers{(mask & 4u) != 0, (mask & 8u) != 0, (mask & 1u) != 0,
                   (mask & 64u) != 0};
}

enum class Transition { kNone, kDown, kUp };

// Follows one binding through raw press and release events. A press counts
// only while the held modifiers equal the binding's exactly; a release counts
// whenever the binding is down, so a modifier let go first cannot strand it.
class HoldMatcher {
 public:
  explicit HoldMatcher(HookConfig config)
      : config_(std::move(config)),
        key_(config_.mouse ? std::nullopt : XKeyCode(config_.code)) {}

  // A keyboard binding must name a key this table knows.
  bool Valid() const { return config_.mouse || key_.has_value(); }
  bool Down() const { return down_; }

  // `modifiers` is asked only for a press of the bound key or button.
  Transition OnKey(int x_keycode, bool press,
                   const std::function<Modifiers()> &modifiers) {
    if (config_.mouse || !key_ || x_keycode != *key_)
      return Transition::kNone;
    return Apply(press, modifiers);
  }

  Transition OnButton(int x_button, bool press,
                      const std::function<Modifiers()> &modifiers) {
    if (!config_.mouse || AnimamaMouseButton(x_button) != config_.button ||
        config_.button == 0)
      return Transition::kNone;
    return Apply(press, modifiers);
  }

  // The hook lost its view of the input: report a release if one is owed.
  Transition Reset() {
    if (!down_)
      return Transition::kNone;
    down_ = false;
    return Transition::kUp;
  }

 private:
  Transition Apply(bool press, const std::function<Modifiers()> &modifiers) {
    if (press) {
      // A repeated press while held changes nothing.
      if (down_)
        return Transition::kNone;
      const Modifiers held = modifiers();
      if (held.ctrl != config_.ctrl || held.alt != config_.alt ||
          held.shift != config_.shift || held.meta != config_.meta)
        return Transition::kNone;
      down_ = true;
      return Transition::kDown;
    }
    return Reset();
  }

  HookConfig config_;
  std::optional<int> key_;
  bool down_ = false;
};

// A Wayland session shows an X11 client only the keys pressed in X11 windows,
// so the hook is offered on an X11 session alone.
inline bool SessionIsX11(const char *session_type, const char *wayland_display,
                         const char *display) {
  const std::string type = session_type ? session_type : "";
  if (type == "wayland")
    return false;
  if (type != "x11" && wayland_display && *wayland_display)
    return false;
  return display && *display;
}

} // namespace animama_linux
