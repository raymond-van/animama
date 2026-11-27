import { act } from "react";
import { getI18n } from "react-i18next";
import {
  PSEUDO_CLOSE,
  PSEUDO_LOCALE,
  PSEUDO_OPEN,
} from "@animama/product-ui/i18n";

/**
 * The pseudo-locale check for component tests: under it every catalog string
 * is wrapped in marks, so visible text outside the marks was written inline
 * instead of coming from a catalog. Test-only.
 */

/**
 * Render what follows in the pseudo-locale; call the result to return to
 * English. Components on the page are worded again inside `act`.
 */
export async function enterPseudoLocale(): Promise<() => Promise<void>> {
  const change = (language: string) =>
    act(async () => {
      await getI18n().changeLanguage(language);
    });
  await change(PSEUDO_LOCALE);
  return () => change("en");
}

const MARKED = new RegExp(
  `${PSEUDO_OPEN}[^${PSEUDO_CLOSE}]*${PSEUDO_CLOSE}`,
  "g",
);
const LETTER = /\p{L}/u;
/** Attributes people read or hear. */
const TEXT_ATTRIBUTES = ["aria-label", "placeholder", "title", "alt"];

/**
 * The visible strings under `root` that hold letters outside the pseudo
 * marks. `data` lists text that is data, not interface wording (names,
 * requests, answers), which is removed before the check.
 */
export function unmarkedText(
  root: ParentNode,
  data: readonly string[] = [],
): string[] {
  const found: string[] = [];
  const check = (text: string | null) => {
    if (!text) return;
    let rest = text.replace(MARKED, "");
    // Longest first, so a name that contains another is removed whole.
    for (const value of [...data].sort((a, b) => b.length - a.length))
      rest = rest.split(value).join("");
    if (LETTER.test(rest)) found.push(text.trim());
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent?.closest("script, style, [hidden]")) continue;
    check(node.textContent);
  }
  for (const element of root.querySelectorAll("*"))
    for (const attribute of TEXT_ATTRIBUTES)
      check(element.getAttribute(attribute));
  return found;
}
