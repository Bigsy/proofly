// Unit tests for lib/corrections.js — the pure span math, hit directly
// rather than through the DOM. The page-level suites exercise the common
// paths incidentally; these pin down the edge cases (insertion anchoring,
// unanchorable spans, de-overlap, out-of-range, smallest-span-wins).

import { describe, expect, it } from "vitest";
import {
  displaySpan,
  findCorrectionAt,
  rebaseCorrectionsAfterSingleEdit,
  usableSpans,
} from "../lib/corrections.js";

const TEXT = "I visited France last year"; // "France" = [10, 16)

describe("displaySpan", () => {
  it("uses the correction's own span for a real edit", () => {
    expect(displaySpan(TEXT, { startIndex: 2, endIndex: 9 }))
      .toEqual({ start: 2, end: 9 });
  });

  it("anchors a zero-width insertion to the word BEFORE it", () => {
    // Inserting "," at 16 — right after "France" → underline "France".
    expect(displaySpan(TEXT, { startIndex: 16, endIndex: 16 }))
      .toEqual({ start: 10, end: 16 });
  });

  it("anchors a zero-width insertion to the word AFTER it when nothing precedes", () => {
    // Inserting at 0 — only the following word can anchor it.
    expect(displaySpan(TEXT, { startIndex: 0, endIndex: 0 }))
      .toEqual({ start: 0, end: 1 }); // "I"
  });

  it("returns null for an insertion surrounded by whitespace (unanchorable)", () => {
    expect(displaySpan("a  b", { startIndex: 2, endIndex: 2 })).toBeNull();
  });

  it.each([
    ["negative start", { startIndex: -1, endIndex: 3 }],
    ["end past the text", { startIndex: 0, endIndex: 999 }],
    ["non-numeric indices", { startIndex: undefined, endIndex: undefined }],
  ])("returns null for %s", (_label, c) => {
    expect(displaySpan(TEXT, c)).toBeNull();
  });
});

describe("usableSpans", () => {
  it("sorts by start and keeps the original correction index", () => {
    const spans = usableSpans(TEXT, [
      { startIndex: 10, endIndex: 16 },
      { startIndex: 2, endIndex: 9 },
    ]);
    expect(spans).toEqual([
      { start: 2, end: 9, i: 1 },
      { start: 10, end: 16, i: 0 },
    ]);
  });

  it("drops a span overlapping the previous one (first-by-start wins)", () => {
    const spans = usableSpans("she said the the store thing", [
      { startIndex: 9, endIndex: 16 },  // "the the"
      { startIndex: 13, endIndex: 22 }, // "the store" — overlaps
    ]);
    expect(spans.map((s) => s.i)).toEqual([0]);
  });

  it("keeps spans that merely touch (end == next start)", () => {
    const spans = usableSpans("abcdef", [
      { startIndex: 0, endIndex: 3 },
      { startIndex: 3, endIndex: 6 },
    ]);
    expect(spans).toHaveLength(2);
  });

  it("skips unanchorable/out-of-range corrections without dropping the rest", () => {
    const spans = usableSpans(TEXT, [
      { startIndex: -5, endIndex: 2 },   // out of range
      { startIndex: 10, endIndex: 16 },  // fine
    ]);
    expect(spans.map((s) => s.i)).toEqual([1]);
  });
});

describe("findCorrectionAt", () => {
  const overlapping = [
    { startIndex: 9, endIndex: 16 },  // len 7
    { startIndex: 13, endIndex: 22 }, // len 9 — covers 18 too
  ];

  it("returns the covering correction's index; span end is inclusive", () => {
    expect(findCorrectionAt(TEXT, [{ startIndex: 2, endIndex: 9 }], 5)).toBe(0);
    expect(findCorrectionAt(TEXT, [{ startIndex: 2, endIndex: 9 }], 9)).toBe(0);
  });

  it("picks the smallest covering span on overlap", () => {
    expect(findCorrectionAt("she said the the store thing", overlapping, 14)).toBe(0);
  });

  it("resolves an insertion via its anchored adjacent word", () => {
    // The "," insertion at 16 anchors to "France" — a click inside it hits.
    expect(findCorrectionAt(TEXT, [{ startIndex: 16, endIndex: 16 }], 12)).toBe(0);
  });

  it("returns -1 outside every span, and for unanchorable corrections", () => {
    expect(findCorrectionAt(TEXT, [{ startIndex: 2, endIndex: 9 }], 20)).toBe(-1);
    expect(findCorrectionAt("a  b", [{ startIndex: 2, endIndex: 2 }], 2)).toBe(-1);
    expect(findCorrectionAt(TEXT, [], 5)).toBe(-1);
  });
});

describe("rebaseCorrectionsAfterSingleEdit", () => {
  it("keeps corrections before and after a single edit, shifting later spans", () => {
    const oldText = "I seen it and teh result.";
    const nextText = "Yesterday, I seen it and teh result.";
    const corrections = [
      { startIndex: 2, endIndex: 6, correction: "saw", types: ["grammar"] },
      { startIndex: 14, endIndex: 17, correction: "the", types: ["spelling"] },
    ];

    expect(rebaseCorrectionsAfterSingleEdit(oldText, corrections, nextText)).toEqual([
      { startIndex: 13, endIndex: 17, correction: "saw", types: ["grammar"] },
      { startIndex: 25, endIndex: 28, correction: "the", types: ["spelling"] },
    ]);
  });

  it("drops corrections whose display span touches the edited range", () => {
    const oldText = "I seen it and teh result.";
    const nextText = "I saw it and teh result.";

    expect(rebaseCorrectionsAfterSingleEdit(oldText, [
      { startIndex: 2, endIndex: 6, correction: "saw", types: ["grammar"] },
      { startIndex: 14, endIndex: 17, correction: "the", types: ["spelling"] },
    ], nextText)).toEqual([
      { startIndex: 13, endIndex: 16, correction: "the", types: ["spelling"] },
    ]);
  });

  it("requires zero-width insertion anchors to still match their original word", () => {
    const oldText = "In France we ate.";
    const corrections = [
      { startIndex: 9, endIndex: 9, correction: ",", types: ["punctuation"] },
    ];

    expect(rebaseCorrectionsAfterSingleEdit(oldText, corrections, "In old France we ate.")).toEqual([
      { startIndex: 13, endIndex: 13, correction: ",", types: ["punctuation"] },
    ]);
    expect(rebaseCorrectionsAfterSingleEdit(oldText, corrections, "In Fronce we ate.")).toEqual([]);
  });
});
