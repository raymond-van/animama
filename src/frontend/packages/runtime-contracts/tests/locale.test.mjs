import assert from "node:assert/strict";
import test from "node:test";
import {
  SOURCE_LOCALE,
  SUPPORTED_LOCALES,
  formattingLocale,
  isBetaLocale,
  isUiLocale,
  localeDirection,
  localeNativeName,
  matchLocale,
  resolveLocale,
} from "../dist/locale.js";

test("English is the source locale and the four first-wave locales are beta", () => {
  assert.deepEqual(SUPPORTED_LOCALES, ["en", "ja", "ko", "zh-Hans", "zh-Hant"]);
  assert.equal(SOURCE_LOCALE, "en");
  assert.equal(isBetaLocale("en"), false);
  for (const tag of ["ja", "ko", "zh-Hans", "zh-Hant"])
    assert.equal(isBetaLocale(tag), true, tag);
});

test("every locale is named in its own script", () => {
  assert.deepEqual(
    SUPPORTED_LOCALES.map((tag) => localeNativeName(tag)),
    ["English", "日本語", "한국어", "简体中文", "繁體中文"],
  );
});

test("only canonical supported tags are stored values", () => {
  for (const tag of SUPPORTED_LOCALES) assert.equal(isUiLocale(tag), true, tag);
  for (const value of [
    "en-US",
    "JA",
    "zh",
    "zh-CN",
    "fr",
    "",
    null,
    undefined,
    3,
  ])
    assert.equal(isUiLocale(value), false, String(value));
});

test("tags match by language, and Chinese by script then region", () => {
  const cases = [
    ["en", "en"],
    ["en-GB", "en"],
    ["en_us", "en"],
    ["ja-JP", "ja"],
    ["JA", "ja"],
    ["ko-KR", "ko"],
    ["zh", "zh-Hans"],
    ["zh-CN", "zh-Hans"],
    ["zh-SG", "zh-Hans"],
    ["zh-Hans", "zh-Hans"],
    ["zh-Hans-HK", "zh-Hans"],
    ["zh-TW", "zh-Hant"],
    ["zh-HK", "zh-Hant"],
    ["zh-MO", "zh-Hant"],
    ["zh-Hant", "zh-Hant"],
    ["zh-Hant-CN", "zh-Hant"],
    ["zh_TW", "zh-Hant"],
    ["fr-FR", null],
    ["", null],
    ["*", null],
  ];
  for (const [tag, expected] of cases)
    assert.equal(matchLocale(tag), expected, tag);
});

test("a saved locale wins, then the first supported preferred language, then English", () => {
  const cases = [
    [{ saved: "ja", preferred: ["ko-KR"] }, "ja"],
    [{ saved: null, preferred: ["ko-KR", "ja"] }, "ko"],
    [{ saved: undefined, preferred: ["fr-FR", "de", "zh-TW"] }, "zh-Hant"],
    [{ saved: null, preferred: ["fr-FR", "de"] }, "en"],
    [{ saved: null, preferred: [] }, "en"],
    [{}, "en"],
    // Stored values outside the contract (for example a legacy `en-US`) mean unset.
    [{ saved: "en-US", preferred: ["ja-JP"] }, "ja"],
    [{ saved: "fr", preferred: [] }, "en"],
  ];
  for (const [input, expected] of cases)
    assert.equal(resolveLocale(input), expected, JSON.stringify(input));
});

test("formatting uses the system region when its language matches the active locale", () => {
  assert.equal(formattingLocale("en", ["en-GB", "ja-JP"]), "en-GB");
  assert.equal(formattingLocale("ja", ["en-GB", "ja-JP"]), "ja-JP");
  assert.equal(formattingLocale("zh-Hant", ["zh-HK"]), "zh-HK");
  assert.equal(formattingLocale("zh-Hans", ["zh-HK"]), "zh-Hans");
  assert.equal(formattingLocale("ko", ["en-US"]), "ko");
  assert.equal(formattingLocale("en", []), "en");
  assert.equal(formattingLocale("en", ["not a tag"]), "en");
});

test("a canonical visitor choice follows the saved preference and precedes browser languages", () => {
  assert.equal(
    resolveLocale({ saved: "ja", visitor: "ko", preferred: ["en-GB"] }),
    "ja",
  );
  assert.equal(
    resolveLocale({ saved: null, visitor: "zh-Hant", preferred: ["ko-KR"] }),
    "zh-Hant",
  );
  assert.equal(
    resolveLocale({
      saved: "invalid",
      visitor: "zh-TW",
      preferred: ["fr", "ko-KR"],
    }),
    "ko",
  );
  assert.equal(resolveLocale({ visitor: null, preferred: ["fr"] }), "en");
});

test("current UI Locales are left-to-right; right-to-left languages are recognized", () => {
  for (const tag of SUPPORTED_LOCALES)
    assert.equal(localeDirection(tag), "ltr", tag);
  assert.equal(localeDirection("ar-EG"), "rtl");
  assert.equal(localeDirection("he_IL"), "rtl");
});
