// Unit tests for lib/dictionary.js — the pure custom-dictionary logic, hit
// directly. Pins the candidate extraction edges, the symmetric eligibility
// predicate, the hunspell-style case rule, and — critically — that
// applyCorrections reproduces every fixture's correctedInput byte-for-byte
// (Apply all splices the FILTERED list itself; this proves the splice math
// against real model output before anything trusts it with subsets).

import { describe, expect, it } from "vitest";
import {
  applyCorrections, candidateWord, countAppliedCorrections, createMatcher, filterCorrections,
  isEligible, isValidWord, MAX_WORD_LENGTH,
} from "../lib/dictionary.js";
import basic from "./fixtures/basic-grammar-spelling.json";
import clean from "./fixtures/clean.json";
import insertion from "./fixtures/insertion.json";
import multiOverlap from "./fixtures/multi-overlap.synthetic.json";
import noTypes from "./fixtures/no-types.synthetic.json";

const TEXT = "He wrote loafs of text"; // "loafs" = [9, 14)

describe("candidateWord", () => {
  it("returns the flagged word for a plain single-token span", () => {
    expect(candidateWord(TEXT, { startIndex: 9, endIndex: 14 })).toBe("loafs");
  });

  it("strips edge punctuation the span dragged in", () => {
    const text = 'He said "loafs", twice.';
    // Span covers the quotes and the comma: "loafs",
    expect(candidateWord(text, { startIndex: 8, endIndex: 16 })).toBe("loafs");
  });

  it("keeps internal punctuation (apostrophes, hyphens)", () => {
    const text = "Its don't e-mail";
    expect(candidateWord(text, { startIndex: 4, endIndex: 9 })).toBe("don't");
    expect(candidateWord(text, { startIndex: 10, endIndex: 16 })).toBe("e-mail");
  });

  it("returns null for a pure insertion (zero-width span)", () => {
    // The anchored adjacent word must never become a candidate.
    expect(candidateWord(TEXT, { startIndex: 14, endIndex: 14 })).toBeNull();
  });

  it("returns null for a multi-word span", () => {
    expect(candidateWord("I seen it", { startIndex: 0, endIndex: 6 })).toBeNull();
  });

  it("returns null for a punctuation-only span", () => {
    expect(candidateWord("a , b", { startIndex: 2, endIndex: 3 })).toBeNull();
  });

  it("returns null past the entry length cap", () => {
    const long = "x".repeat(MAX_WORD_LENGTH + 1);
    expect(candidateWord(long, { startIndex: 0, endIndex: long.length })).toBeNull();
  });

  it.each([
    ["negative start", { startIndex: -1, endIndex: 3 }],
    ["end past the text", { startIndex: 0, endIndex: 999 }],
    ["inverted span", { startIndex: 5, endIndex: 2 }],
    ["non-numeric indices", { startIndex: undefined, endIndex: undefined }],
  ])("returns null for %s", (_label, c) => {
    expect(candidateWord(TEXT, c)).toBeNull();
  });
});

describe("isValidWord", () => {
  it.each([
    ["a word", "Acme", true],
    ["empty", "", false],
    ["internal whitespace", "two words", false],
    ["a tab", "a\tb", false],
    [`${MAX_WORD_LENGTH} chars (at the cap)`, "x".repeat(MAX_WORD_LENGTH), true],
    [`${MAX_WORD_LENGTH + 1} chars (past the cap)`, "x".repeat(MAX_WORD_LENGTH + 1), false],
    ["a non-string", 42, false],
  ])("%s → %s", (_label, w, valid) => {
    expect(isValidWord(w)).toBe(valid);
  });
});

describe("isEligible — the one predicate behind button AND filter", () => {
  const spelling = { startIndex: 9, endIndex: 14, correction: "loaves", types: ["spelling"] };

  it("a typed spelling correction with a candidate is eligible", () => {
    expect(isEligible(TEXT, spelling)).toBe(true);
  });

  it("typed non-spelling corrections are not suppressible", () => {
    expect(isEligible(TEXT, { ...spelling, types: ["grammar"] })).toBe(false);
    expect(isEligible(TEXT, { ...spelling, types: ["punctuation"] })).toBe(false);
  });

  it("types absent or empty degrades to the word-only heuristic (still eligible)", () => {
    // Not every build honours includeCorrectionTypes — see AGENTS.md.
    expect(isEligible(TEXT, { startIndex: 9, endIndex: 14, correction: "loaves" })).toBe(true);
    expect(isEligible(TEXT, { startIndex: 9, endIndex: 14, correction: "loaves", types: [] })).toBe(true);
  });

  it("no candidate word → never eligible, whatever the types say", () => {
    expect(isEligible(TEXT, { startIndex: 14, endIndex: 14, types: ["spelling"] })).toBe(false);
    expect(isEligible("I seen it", { startIndex: 0, endIndex: 6, types: ["spelling"] })).toBe(false);
  });
});

describe("createMatcher — the case rule", () => {
  it("an all-lowercase entry matches case-insensitively", () => {
    const m = createMatcher(["acme"]);
    expect(m.matches("acme")).toBe(true);
    expect(m.matches("Acme")).toBe(true); // sentence start
    expect(m.matches("ACME")).toBe(true);
  });

  it("an entry with any uppercase matches exactly", () => {
    const m = createMatcher(["Acme"]);
    expect(m.matches("Acme")).toBe(true);
    expect(m.matches("acme")).toBe(false);
    expect(m.matches("ACME")).toBe(false);
  });

  it("handles empty and garbage word lists", () => {
    expect(createMatcher([]).matches("x")).toBe(false);
    expect(createMatcher(undefined).matches("x")).toBe(false);
    expect(createMatcher([42, ""]).matches("42")).toBe(false);
  });
});

describe("filterCorrections", () => {
  const text = basic.input; // "seen" grammar @ [2,6), "loafs" spelling @ [53,58)
  const corrections = basic.result.corrections;

  it("removes eligible corrections whose candidate matches", () => {
    const out = filterCorrections(text, corrections, createMatcher(["loafs"]));
    expect(out).toHaveLength(1);
    expect(out[0].correction).toBe("saw"); // the grammar one survives
  });

  it("never suppresses a typed non-spelling correction, even on a word match", () => {
    const out = filterCorrections(text, corrections, createMatcher(["seen"]));
    expect(out).toHaveLength(2); // "seen" is grammar-typed — untouched
  });

  it("suppresses every instance of the word at once", () => {
    const t = "loafs and loafs";
    const cs = [
      { startIndex: 0, endIndex: 5, correction: "loaves", types: ["spelling"] },
      { startIndex: 10, endIndex: 15, correction: "loaves", types: ["spelling"] },
    ];
    expect(filterCorrections(t, cs, createMatcher(["loafs"]))).toHaveLength(0);
  });

  it("passes everything through with no matcher or empty dictionary", () => {
    expect(filterCorrections(text, corrections, null)).toEqual(corrections);
    expect(filterCorrections(text, corrections, createMatcher([]))).toEqual(corrections);
  });
});

describe("applyCorrections", () => {
  // The keystone: over the recorded fixtures the splice must equal the
  // model's own correctedInput — only then may Apply all trust it with
  // filtered subsets. (The synthetic fixtures were built to agree too.)
  it.each([
    ["basic-grammar-spelling (RECORDED)", basic],
    ["insertion (RECORDED)", insertion],
    ["clean (RECORDED)", clean],
    ["no-types (synthetic)", noTypes],
    ["multi-overlap (synthetic)", multiOverlap],
  ])("equals the fixture's correctedInput: %s", (_label, fixture) => {
    expect(applyCorrections(fixture.input, fixture.result.corrections))
      .toBe(fixture.result.correctedInput);
  });

  it("splices a filtered subset, leaving the suppressed word intact", () => {
    const kept = basic.result.corrections.filter((c) => !c.types.includes("spelling"));
    expect(applyCorrections(basic.input, kept))
      .toBe("I saw him yesterday at the store, and he bought two loafs of bread.");
  });

  it("drops the later of two overlapping corrections (mirrors usableSpans)", () => {
    const out = applyCorrections("the the store", [
      { startIndex: 0, endIndex: 7, correction: "the" },
      { startIndex: 4, endIndex: 13, correction: "the shop" }, // overlaps — dropped
    ]);
    expect(out).toBe("the store");
  });

  it("counts only valid non-overlapping edits", () => {
    expect(countAppliedCorrections(multiOverlap.input, multiOverlap.result.corrections)).toBe(3);
    expect(countAppliedCorrections("bad", [
      { startIndex: 0, endIndex: 3, correction: null },
      { startIndex: 8, endIndex: 9, correction: "x" },
    ])).toBe(0);
  });

  it("splices a zero-width insertion, including one adjacent to another span", () => {
    expect(applyCorrections("a b", [{ startIndex: 1, endIndex: 1, correction: "," }]))
      .toBe("a, b");
    // Insertion exactly at a previous correction's end survives de-overlap.
    expect(applyCorrections("teh cat", [
      { startIndex: 0, endIndex: 3, correction: "the" },
      { startIndex: 3, endIndex: 3, correction: "," },
    ])).toBe("the, cat");
  });

  it("skips malformed spans without dropping the rest", () => {
    expect(applyCorrections("teh cat", [
      { startIndex: -2, endIndex: 3, correction: "XXX" },
      { startIndex: 0, endIndex: 999, correction: "XXX" },
      { startIndex: 4, endIndex: 7, correction: "dog" },
    ])).toBe("teh dog");
  });

  it("returns the text untouched for an empty list", () => {
    expect(applyCorrections("as is", [])).toBe("as is");
    expect(applyCorrections("as is", undefined)).toBe("as is");
  });
});
