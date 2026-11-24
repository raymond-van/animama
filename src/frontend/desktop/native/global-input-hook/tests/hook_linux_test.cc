// The Linux hook's decisions, without X11: the key table, the button mapping,
// the session check and the press and release transitions of one binding.
// It includes only the portable header, so it builds and runs on any host.
#include "../src/hook_linux_keys.h"

#include <cstdlib>
#include <iostream>
#include <string>

namespace {

using animama_linux::HoldMatcher;
using animama_linux::Modifiers;
using animama_linux::Transition;

unsigned assertions = 0;

void Require(bool condition, const std::string &message) {
  ++assertions;
  if (!condition) {
    std::cerr << "FAIL: " << message << '\n';
    std::exit(1);
  }
}

HookConfig KeyBinding(const std::string &code, unsigned modifiers) {
  HookConfig config;
  config.code = code;
  config.ctrl = (modifiers & 1) != 0;
  config.alt = (modifiers & 2) != 0;
  config.shift = (modifiers & 4) != 0;
  config.meta = (modifiers & 8) != 0;
  return config;
}

Modifiers Held(unsigned modifiers) {
  return Modifiers{(modifiers & 1) != 0, (modifiers & 2) != 0,
                   (modifiers & 4) != 0, (modifiers & 8) != 0};
}

} // namespace

int main() {
  using animama_linux::AnimamaMouseButton;
  using animama_linux::ModifiersFromMask;
  using animama_linux::SessionIsX11;
  using animama_linux::XKeyCode;

  // X key codes are evdev scan codes plus 8.
  Require(XKeyCode("KeyA") == 38, "KeyA is X key code 38");
  Require(XKeyCode("Backquote") == 49, "Backquote is X key code 49");
  Require(XKeyCode("Space") == 65, "Space is X key code 65");
  Require(XKeyCode("F24") == 202, "F24 is X key code 202");
  Require(XKeyCode("ArrowUp") == 111, "ArrowUp is X key code 111");
  Require(!XKeyCode("NotAKey"), "an unknown code has no key");
  Require(!XKeyCode(""), "an empty code has no key");

  // Buttons: X puts back and forward after the four scroll directions.
  Require(AnimamaMouseButton(1) == 1 && AnimamaMouseButton(2) == 2 &&
              AnimamaMouseButton(3) == 3,
          "left, middle and right keep their numbers");
  Require(AnimamaMouseButton(8) == 4 && AnimamaMouseButton(9) == 5,
          "back and forward are 4 and 5");
  for (int wheel = 4; wheel <= 7; ++wheel)
    Require(AnimamaMouseButton(wheel) == 0, "the scroll wheel is not a button");
  Require(AnimamaMouseButton(0) == 0 && AnimamaMouseButton(10) == 0,
          "unknown buttons are not bound");

  // Shift 1, Control 4, Mod1 8, Mod4 64; Lock (2) and Num Lock (16) ignored.
  const Modifiers all = ModifiersFromMask(1u | 4u | 8u | 64u | 2u | 16u);
  Require(all.shift && all.ctrl && all.alt && all.meta, "all four read");
  const Modifiers locks = ModifiersFromMask(2u | 16u | 128u);
  Require(!locks.shift && !locks.ctrl && !locks.alt && !locks.meta,
          "lock states are not modifiers");

  // A press counts only under exactly the binding's modifiers.
  const int key = *XKeyCode("Backquote");
  for (unsigned wanted = 0; wanted < 16; ++wanted) {
    for (unsigned actual = 0; actual < 16; ++actual) {
      HoldMatcher matcher(KeyBinding("Backquote", wanted));
      const auto held = [actual] { return Held(actual); };
      const Transition down = matcher.OnKey(key, true, held);
      Require((down == Transition::kDown) == (wanted == actual),
              "press matches exactly the binding's modifiers");
      // A release always ends a hold, whatever is held by then.
      const auto none = [] { return Modifiers{}; };
      Require((matcher.OnKey(key, false, none) == Transition::kUp) ==
                  (wanted == actual),
              "release ends only a hold that began");
    }
  }

  {
    HoldMatcher matcher(KeyBinding("Backquote", 0));
    unsigned asked = 0;
    const auto held = [&asked] {
      ++asked;
      return Modifiers{};
    };
    Require(matcher.Valid(), "a known key is a valid binding");
    Require(matcher.OnKey(*XKeyCode("KeyA"), true, held) == Transition::kNone,
            "another key is ignored");
    Require(asked == 0, "modifiers are not read for another key");
    Require(matcher.OnKey(key, true, held) == Transition::kDown, "down once");
    Require(matcher.OnKey(key, true, held) == Transition::kNone,
            "a repeated press is not a second down");
    Require(asked == 1, "modifiers are read once, at the first press");
    Require(matcher.OnButton(1, true, held) == Transition::kNone,
            "a key binding ignores buttons");
    Require(matcher.OnKey(key, false, held) == Transition::kUp, "up once");
    Require(matcher.OnKey(key, false, held) == Transition::kNone,
            "a release with nothing held is ignored");
    Require(matcher.OnKey(key, true, held) == Transition::kDown, "down again");
    Require(matcher.Reset() == Transition::kUp, "a reset owes a release");
    Require(matcher.Reset() == Transition::kNone, "and only one");
  }

  Require(!HoldMatcher(KeyBinding("NotAKey", 0)).Valid(),
          "an unknown key is not a valid binding");
  for (int button = -1; button <= 33; ++button) {
    HookConfig config;
    config.mouse = true;
    config.button = button;
    Require(HoldMatcher(config).Valid() == (button >= 1 && button <= 5),
            "only the five reportable buttons are valid mouse bindings");
  }

  {
    HookConfig config;
    config.mouse = true;
    config.button = 4; // back
    HoldMatcher matcher(config);
    const auto none = [] { return Modifiers{}; };
    Require(matcher.Valid(), "a mouse binding needs no key");
    Require(matcher.OnButton(1, true, none) == Transition::kNone,
            "another button is ignored");
    Require(matcher.OnButton(4, true, none) == Transition::kNone,
            "a scroll event is never the bound button");
    Require(matcher.OnKey(key, true, none) == Transition::kNone,
            "a mouse binding ignores keys");
    Require(matcher.OnButton(8, true, none) == Transition::kDown,
            "X button 8 is the back button");
    Require(matcher.OnButton(8, false, none) == Transition::kUp, "and up");
  }

  // The hook is offered on an X11 session only.
  Require(SessionIsX11("x11", nullptr, ":0"), "an X11 session");
  Require(SessionIsX11(nullptr, nullptr, ":0"), "an unnamed session with X");
  Require(SessionIsX11("tty", "", ":0"), "startx from a console");
  Require(!SessionIsX11("wayland", "wayland-0", ":0"), "Wayland with XWayland");
  Require(!SessionIsX11(nullptr, "wayland-0", ":0"), "a compositor socket");
  Require(!SessionIsX11("x11", nullptr, nullptr), "no display at all");
  Require(SessionIsX11("x11", "stale", ":0"), "X11 wins when it says so");

  std::cout << "hook_linux_test: " << assertions << " assertions passed\n";
  return 0;
}
