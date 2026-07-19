// page/content/language.js — the declared-language gate's tag parsing and
// field-language resolution. The eligibility integration lives in
// page-detect.test.js; the mid-session re-check in page-lifecycle.test.js.

import { afterEach, describe, expect, it } from "vitest";
import {
  SUPPORTED_INPUT_LANGUAGES,
  declaredFieldLanguage,
  isSupportedFieldLanguage,
  primaryLanguageSubtag,
} from "../page/content/language.js";

afterEach(() => {
  document.documentElement.removeAttribute("lang");
  document.body.innerHTML = "";
});

describe("primaryLanguageSubtag", () => {
  it("lowercases and strips region/script subtags", () => {
    expect(primaryLanguageSubtag("en")).toBe("en");
    expect(primaryLanguageSubtag("en-GB")).toBe("en");
    expect(primaryLanguageSubtag("FR")).toBe("fr");
    expect(primaryLanguageSubtag("zh-Hant-TW")).toBe("zh");
    expect(primaryLanguageSubtag("  pt-BR  ")).toBe("pt");
  });

  it("returns null for empty and non-string tags", () => {
    expect(primaryLanguageSubtag("")).toBe(null);
    expect(primaryLanguageSubtag("   ")).toBe(null);
    expect(primaryLanguageSubtag(null)).toBe(null);
    expect(primaryLanguageSubtag(undefined)).toBe(null);
    expect(primaryLanguageSubtag(42)).toBe(null);
  });
});

describe("declaredFieldLanguage", () => {
  it("uses the nearest ancestor-or-self lang declaration", () => {
    document.body.innerHTML =
      '<div lang="fr"><div lang="en-US"><textarea id="f"></textarea></div></div>';
    expect(declaredFieldLanguage(document.getElementById("f"))).toBe("en");
  });

  it("falls back to the document element when nothing closer declares", () => {
    document.documentElement.setAttribute("lang", "de");
    const field = document.createElement("textarea");
    expect(declaredFieldLanguage(field)).toBe("de");
  });

  it("treats an empty lang as unknown, even over a declared document language", () => {
    document.documentElement.setAttribute("lang", "fr");
    document.body.innerHTML = '<div lang=""><textarea id="f"></textarea></div>';
    expect(declaredFieldLanguage(document.getElementById("f"))).toBe(null);
  });

  it("returns null when no language is declared anywhere", () => {
    expect(declaredFieldLanguage(document.createElement("textarea"))).toBe(null);
    expect(declaredFieldLanguage(null)).toBe(null);
  });
});

describe("isSupportedFieldLanguage", () => {
  it("assumes support when undeclared, and matches on the primary subtag", () => {
    expect(SUPPORTED_INPUT_LANGUAGES).toContain("en");
    expect(isSupportedFieldLanguage(document.createElement("textarea"))).toBe(true);
    const en = document.createElement("textarea");
    en.setAttribute("lang", "en-AU");
    expect(isSupportedFieldLanguage(en)).toBe(true);
    const fr = document.createElement("textarea");
    fr.setAttribute("lang", "fr-CA");
    expect(isSupportedFieldLanguage(fr)).toBe(false);
  });
});
