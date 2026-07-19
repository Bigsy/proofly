// page/content/detect.js — the field-eligibility matrix.

import { afterEach, describe, expect, it } from "vitest";
import { isEligibleField } from "../page/content/detect.js";

function input(type, attrs = {}) {
  const el = document.createElement("input");
  if (type != null) el.setAttribute("type", type);
  Object.assign(el, attrs);
  return el;
}

afterEach(() => {
  document.documentElement.removeAttribute("lang");
});

describe("isEligibleField", () => {
  it("accepts a plain textarea", () => {
    expect(isEligibleField(document.createElement("textarea"))).toBe(true);
  });

  it("accepts prose-bearing inputs (incl. the implicit default type)", () => {
    for (const t of ["text", "search", "TEXT"]) {
      expect(isEligibleField(input(t)), `type=${t}`).toBe(true);
    }
    expect(isEligibleField(input(null)), "no type attribute").toBe(true);
  });

  it("rejects non-prose input types", () => {
    // email/number lack the selection API (click→caret needs it); password is
    // never proofread; url/tel values are never prose; the rest don't hold text.
    for (const t of ["password", "email", "number", "url", "tel", "hidden", "checkbox", "radio", "date", "file", "submit"]) {
      expect(isEligibleField(input(t)), `type=${t}`).toBe(false);
    }
  });

  it("rejects read-only, disabled, and aria-readonly fields", () => {
    expect(isEligibleField(input("text", { disabled: true }))).toBe(false);
    expect(isEligibleField(input("text", { readOnly: true }))).toBe(false);
    const ta = document.createElement("textarea");
    ta.setAttribute("aria-readonly", "true");
    expect(isEligibleField(ta)).toBe(false);
  });

  it("honours the page's spellcheck=false opt-out on form fields", () => {
    const ta = document.createElement("textarea");
    ta.setAttribute("spellcheck", "false");
    expect(isEligibleField(ta)).toBe(false);
    const el = input("text");
    el.setAttribute("spellcheck", "false");
    expect(isEligibleField(el)).toBe(false);
  });

  it("rejects fields governed by a declared unsupported language", () => {
    const own = document.createElement("textarea");
    own.setAttribute("lang", "fr");
    expect(isEligibleField(own), "own lang").toBe(false);

    const wrapper = document.createElement("div");
    wrapper.setAttribute("lang", "de-DE");
    const inherited = document.createElement("textarea");
    wrapper.appendChild(inherited);
    expect(isEligibleField(inherited), "ancestor lang").toBe(false);

    document.documentElement.setAttribute("lang", "fr");
    expect(isEligibleField(document.createElement("textarea")), "document lang").toBe(false);
  });

  it("accepts supported and undeclared languages (nearest declaration wins)", () => {
    expect(isEligibleField(document.createElement("textarea")), "no lang anywhere").toBe(true);

    const gb = document.createElement("textarea");
    gb.setAttribute("lang", "en-GB");
    expect(isEligibleField(gb), "regional English").toBe(true);

    document.documentElement.setAttribute("lang", "fr");
    const enIsland = document.createElement("div");
    enIsland.setAttribute("lang", "en");
    const field = document.createElement("textarea");
    enIsland.appendChild(field);
    document.body.appendChild(enIsland);
    try {
      expect(isEligibleField(field), "en island on a fr page").toBe(true);
      // lang="" = "language unknown" per the HTML spec — treated as undeclared.
      enIsland.setAttribute("lang", "");
      expect(isEligibleField(field), "empty lang resets to unknown").toBe(true);
    } finally {
      enIsland.remove();
    }
  });

  it("rejects non-fields", () => {
    expect(isEligibleField(null)).toBe(false);
    expect(isEligibleField(document.createElement("div"))).toBe(false);
    expect(isEligibleField(document.body)).toBe(false);
  });

  it("accepts contenteditable textbox roots like Slack's Quill editor", () => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-multiline", "true");
    editor.dataset.qa = "texty_input";
    expect(isEligibleField(editor)).toBe(true);
  });

  it("accepts ProseMirror roots through their dedicated adapter without broadening generic contenteditable", () => {
    const generic = document.createElement("div");
    generic.setAttribute("contenteditable", "true");
    expect(isEligibleField(generic)).toBe(false);

    generic.className = "ProseMirror";
    expect(isEligibleField(generic)).toBe(true);
  });

  it("rejects hidden contenteditable clipboard helpers", () => {
    const clipboard = document.createElement("div");
    clipboard.setAttribute("contenteditable", "true");
    clipboard.setAttribute("aria-hidden", "true");
    expect(isEligibleField(clipboard)).toBe(false);
  });
});

// Text extraction and caret mapping are snapshot concerns — every session is
// adapter-backed, so those paths live on the adapters' snapshots (covered by
// the adapter suites and contenteditable-adapter.test.js), not here.
