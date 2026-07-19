import { describe, expect, it } from "vitest";
import { applyCorrections } from "../lib/dictionary.js";
import { normalizeHarperLints } from "../lib/harper-corrections.js";

function suggestion(kind, replacement = "") {
  return { kind: () => kind, get_replacement_text: () => replacement };
}

function lint(start, end, {
  kind = "Spelling", message = "Possible spelling mistake.", suggestions = [],
} = {}) {
  return {
    span: () => ({ start, end }),
    lint_kind: () => kind,
    message: () => message,
    suggestions: () => suggestions,
  };
}

describe("normalizeHarperLints", () => {
  it("copies replacements, removals, insertions, messages, and alternatives", () => {
    expect(normalizeHarperLints("wierd  text", [
      lint(0, 5, { suggestions: [suggestion(0, "weird"), suggestion("Replace", "wired")] }),
      lint(5, 7, { kind: "Formatting", suggestions: [suggestion(1, "ignored")] }),
      lint(7, 11, { kind: "Punctuation", suggestions: [suggestion(2, ".")] }),
    ])).toEqual([
      {
        startIndex: 0, endIndex: 5, correction: "weird",
        suggestions: [{ replacement: "weird" }, { replacement: "wired" }],
        types: ["spelling"], explanation: "Possible spelling mistake.",
      },
      {
        startIndex: 5, endIndex: 7, correction: "", suggestions: [{ replacement: "" }],
        types: ["formatting"], explanation: "Possible spelling mistake.",
      },
      {
        startIndex: 11, endIndex: 11, correction: ".", suggestions: [{ replacement: "." }],
        types: ["punctuation"], explanation: "Possible spelling mistake.",
      },
    ]);
  });

  it("frees every WASM-backed span and suggestion wrapper after copying", () => {
    let spanFrees = 0;
    let suggestionFrees = 0;
    const wrappedLint = lint(0, 3, { suggestions: [suggestion(0, "good"), suggestion(99, "bad")] });
    wrappedLint.span = () => ({ start: 0, end: 3, free: () => { spanFrees += 1; } });
    const wrappedSuggestions = wrappedLint.suggestions();
    for (const item of wrappedSuggestions) {
      item.free = () => { suggestionFrees += 1; };
    }
    wrappedLint.suggestions = () => wrappedSuggestions;

    normalizeHarperLints("bad", [wrappedLint]);

    expect(spanFrees).toBe(1);
    expect(suggestionFrees).toBe(2);
  });

  it("normalizes spelling, grammar, and punctuation categories", () => {
    const result = normalizeHarperLints("abc", [
      lint(0, 1, { kind: "Spelling", suggestions: [suggestion(0, "A")] }),
      lint(1, 2, { kind: "Grammar", suggestions: [suggestion(0, "B")] }),
      lint(2, 3, { kind: "Punctuation", suggestions: [suggestion(0, "C")] }),
    ]);
    expect(result.map((issue) => issue.types[0])).toEqual(["spelling", "grammar", "punctuation"]);
  });

  it("retains adjacent, nested, and partially overlapping spans in deterministic order", () => {
    const result = normalizeHarperLints("0123456789", [
      lint(4, 8, { suggestions: [suggestion(0, "partial")] }),
      lint(2, 4, { suggestions: [suggestion(0, "adjacent")] }),
      lint(3, 5, { suggestions: [suggestion(0, "nested")] }),
      lint(2, 8, { suggestions: [suggestion(0, "outer")] }),
    ]);
    expect(result.map(({ startIndex, endIndex, correction }) => [startIndex, endIndex, correction])).toEqual([
      [2, 4, "adjacent"], [2, 8, "outer"], [3, 5, "nested"], [4, 8, "partial"],
    ]);
  });

  it("keeps a no-suggestion lint informational and Apply all ignores it", () => {
    const issues = normalizeHarperLints("bad text", [
      lint(0, 3),
      lint(4, 8, { suggestions: [suggestion(0, "copy")] }),
    ]);
    expect(issues[0]).toMatchObject({ correction: null, suggestions: [] });
    expect(applyCorrections("bad text", issues)).toBe("bad copy");
  });

  it.each([
    ["negative", lint(-1, 1)],
    ["inverted", lint(2, 1)],
    ["past end", lint(0, 4)],
    ["fractional", lint(0.5, 2)],
    ["missing span", { suggestions: () => [] }],
  ])("drops malformed Harper data: %s", (_label, badLint) => {
    expect(normalizeHarperLints("abc", [badLint])).toEqual([]);
  });

  it("drops unusable suggestions but preserves valid ones", () => {
    const issues = normalizeHarperLints("bad", [lint(0, 3, {
      suggestions: [
        suggestion(99, "no"),
        { kind: () => 0, get_replacement_text: () => undefined },
        suggestion(0, "good"),
      ],
    })]);
    expect(issues[0].suggestions).toEqual([{ replacement: "good" }]);
  });

  it("validates UTF-16 offsets without converting emoji or combining marks", () => {
    const text = "😀 cafe\u0301";
    const issues = normalizeHarperLints(text, [
      lint(0, 2, { suggestions: [suggestion(0, "🙂")] }),
      lint(3, 8, { suggestions: [suggestion(0, "café")] }),
      lint(1, 2, { suggestions: [suggestion(0, "broken surrogate")] }),
    ]);
    expect(issues.map(({ startIndex, endIndex }) => [startIndex, endIndex])).toEqual([[0, 2], [3, 8]]);
    expect(applyCorrections(text, issues)).toBe("🙂 café");
  });

  it("splits mixed suggestion kinds so every alternative shares one splice span", () => {
    const issues = normalizeHarperLints("word", [lint(0, 4, {
      suggestions: [suggestion(0, "ward"), suggestion(2, "!")],
    })]);
    expect(issues).toHaveLength(2);
    expect(issues.map((issue) => [issue.startIndex, issue.endIndex, issue.correction]))
      .toEqual([[0, 4, "ward"], [4, 4, "!"]]);
  });

  it("Apply all uses only each issue's selected primary suggestion", () => {
    const issues = normalizeHarperLints("wierd text", [
      lint(0, 5, { suggestions: [suggestion(0, "weird"), suggestion(0, "wired")] }),
      lint(10, 10, { kind: "Punctuation", suggestions: [suggestion(2, "."), suggestion(2, "!")] }),
    ]);
    expect(applyCorrections("wierd text", issues)).toBe("weird text.");
  });
});
