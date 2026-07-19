import { describe, expect, it } from "vitest";
import {
  applyWindowCorrections,
  createDocumentProofreadWindows,
  createFocusedProofreadWindow,
  createProofreadWindowsForText,
  mapWindowCorrectionsToDocument,
  mergeWindowCorrections,
} from "../page/content/proofread-window.js";

describe("focused proofread windows", () => {
  it("returns the whole text below the model budget", () => {
    expect(createFocusedProofreadWindow("short text", 3, { maxCodeUnits: 20 }))
      .toEqual({ text: "short text", baseOffset: 0, isWindow: false });
  });

  it("chooses a bounded window around the caret and records its document base", () => {
    const text = `${"a".repeat(30)}\n\nI seen it near the caret. ${"z".repeat(30)}`;
    const caret = text.indexOf("seen") + 1;
    const win = createFocusedProofreadWindow(text, caret, {
      maxCodeUnits: 34,
      sentenceOvershootCodeUnits: 8,
    });

    expect(win.isWindow).toBe(true);
    expect(win.text).toContain("I seen it near the caret.");
    expect(win.baseOffset).toBe(32);
    expect(win.text.length).toBeLessThanOrEqual(34);
  });

  it("prefers a sentence boundary within the overshoot budget", () => {
    const text = `${"x".repeat(12)} I seen it now. ${"tail".repeat(12)}`;
    const win = createFocusedProofreadWindow(text, 14, {
      maxCodeUnits: 28,
      sentenceOvershootCodeUnits: 8,
    });

    expect(win.text.endsWith(".")).toBe(true);
    expect(win.text.length).toBeLessThanOrEqual(28);
  });

  it("does not split surrogate pairs at window edges", () => {
    const smile = "\uD83D\uDE00";
    const text = `aa${smile}${"b".repeat(20)}${smile}cc`;
    const win = createFocusedProofreadWindow(text, 12, {
      maxCodeUnits: 9,
      sentenceOvershootCodeUnits: 0,
    });

    expect(win.text.charCodeAt(0)).not.toBe(0xDE00);
    expect(win.text.charCodeAt(win.text.length - 1)).not.toBe(0xD83D);
  });

  it("maps window-relative corrections back to whole-document offsets and de-duplicates", () => {
    const win = { isWindow: true, text: "I seen it.", baseOffset: 100 };

    expect(mapWindowCorrectionsToDocument([
      { startIndex: 2, endIndex: 6, correction: "saw" },
      { startIndex: 2, endIndex: 6, correction: "saw" },
      { startIndex: 0, endIndex: 999, correction: "bad" },
    ], win)).toEqual([
      { startIndex: 102, endIndex: 106, correction: "saw" },
    ]);
  });

  it("uses whole-document windows only while the bounded window budget holds", () => {
    const text = "abcdefghij1234567890abcde";

    expect(createProofreadWindowsForText(text, 12, {
      maxCodeUnits: 10,
      maxDocumentWindows: 4,
      overlapCodeUnits: 4,
      sentenceOvershootCodeUnits: 0,
    }).map((win) => [win.windowStart, win.windowEnd])).toEqual([
      [0, 10],
      [6, 16],
      [12, 22],
      [18, 25],
    ]);

    expect(createProofreadWindowsForText(text, 12, {
      maxCodeUnits: 10,
      maxDocumentWindows: 2,
      overlapCodeUnits: 4,
      sentenceOvershootCodeUnits: 0,
    })).toHaveLength(1);
  });

  it("plans overlapping document windows that cover the whole text within budget", () => {
    const text = "one two three four five six seven eight nine ten eleven";
    const windows = createDocumentProofreadWindows(text, {
      maxCodeUnits: 20,
      overlapCodeUnits: 5,
      sentenceOvershootCodeUnits: 0,
    });

    expect(windows.length).toBeGreaterThan(1);
    expect(windows[0].windowStart).toBe(0);
    expect(windows.at(-1).windowEnd).toBe(text.length);
    for (const win of windows) expect(win.text.length).toBeLessThanOrEqual(20);
    for (let i = 1; i < windows.length; i += 1) {
      expect(windows[i].windowStart).toBeLessThan(windows[i - 1].windowEnd);
      expect(windows[i].windowStart).toBeGreaterThan(windows[i - 1].windowStart);
    }

    const covered = Array(text.length).fill(false);
    for (const win of windows) {
      for (let i = win.windowStart; i < win.windowEnd; i += 1) covered[i] = true;
    }
    expect(covered.every(Boolean)).toBe(true);
  });

  it("assigns trusted correction ranges across overlaps without gaps", () => {
    const text = "abcdefghij1234567890";
    const windows = createDocumentProofreadWindows(text, {
      maxCodeUnits: 10,
      overlapCodeUnits: 4,
      sentenceOvershootCodeUnits: 0,
    });

    expect(windows.map((win) => [win.windowStart, win.windowEnd])).toEqual([
      [0, 10],
      [6, 16],
      [12, 20],
    ]);
    expect(windows.map((win) => [win.trustedStart, win.trustedEnd])).toEqual([
      [0, 8],
      [8, 14],
      [14, 20],
    ]);
    for (const win of windows) {
      expect(win.trustedStart).toBeGreaterThanOrEqual(win.windowStart);
      expect(win.trustedEnd).toBeLessThanOrEqual(win.windowEnd);
    }
  });

  it("keeps document-window edges off surrogate-pair interiors", () => {
    const smile = "\uD83D\uDE00";
    const text = `${smile}abc${smile}def${smile}ghi${smile}jkl`;
    const windows = createDocumentProofreadWindows(text, {
      maxCodeUnits: 7,
      overlapCodeUnits: 2,
      sentenceOvershootCodeUnits: 0,
    });

    for (const win of windows) {
      expect(text.charCodeAt(win.windowStart)).not.toBe(0xDE00);
      expect(text.charCodeAt(win.windowEnd - 1)).not.toBe(0xD83D);
    }
  });

  it("keeps only the trusted side of overlap corrections", () => {
    const text = "abcdefghij1234567890";
    const windows = createDocumentProofreadWindows(text, {
      maxCodeUnits: 10,
      overlapCodeUnits: 4,
      sentenceOvershootCodeUnits: 0,
    });

    expect(mergeWindowCorrections([
      {
        window: windows[0],
        corrections: [
          { startIndex: 7, endIndex: 8, correction: "H" },
          { startIndex: 8, endIndex: 9, correction: "I" },
        ],
      },
      {
        window: windows[1],
        corrections: [
          { startIndex: 1, endIndex: 2, correction: "H" },
          { startIndex: 2, endIndex: 3, correction: "I" },
        ],
      },
    ])).toEqual([
      { startIndex: 7, endIndex: 8, correction: "H" },
      { startIndex: 8, endIndex: 9, correction: "I" },
    ]);
  });

  it("assigns zero-length overlap-boundary insertions to only one window", () => {
    const text = "abcdefghij1234567890";
    const windows = createDocumentProofreadWindows(text, {
      maxCodeUnits: 10,
      overlapCodeUnits: 4,
      sentenceOvershootCodeUnits: 0,
    });

    expect(mergeWindowCorrections([
      {
        window: windows[0],
        corrections: [{ startIndex: 8, endIndex: 8, correction: "," }],
      },
      {
        window: windows[1],
        corrections: [{ startIndex: 2, endIndex: 2, correction: ";" }],
      },
    ])).toEqual([
      { startIndex: 8, endIndex: 8, correction: ";" },
    ]);
  });

  it("keeps a zero-length insertion at the true document end", () => {
    const text = "abcdefghij1234567890";
    const windows = createDocumentProofreadWindows(text, {
      maxCodeUnits: 10,
      overlapCodeUnits: 4,
      sentenceOvershootCodeUnits: 0,
    });

    expect(mergeWindowCorrections([
      {
        window: windows.at(-1),
        corrections: [{ startIndex: windows.at(-1).text.length, endIndex: windows.at(-1).text.length, correction: "." }],
      },
    ])).toEqual([
      { startIndex: text.length, endIndex: text.length, correction: "." },
    ]);
  });

  it("merges duplicate corrections emitted from overlapping windows", () => {
    const first = { isWindow: true, text: "I seen it and", baseOffset: 0 };
    const second = { isWindow: true, text: "seen it and teh", baseOffset: 2 };

    expect(mergeWindowCorrections([
      {
        window: first,
        corrections: [{ startIndex: 2, endIndex: 6, correction: "saw" }],
      },
      {
        window: second,
        corrections: [
          { startIndex: 0, endIndex: 4, correction: "saw" },
          { startIndex: 12, endIndex: 15, correction: "the" },
        ],
      },
    ])).toEqual([
      { startIndex: 2, endIndex: 6, correction: "saw" },
      { startIndex: 14, endIndex: 17, correction: "the" },
    ]);
  });

  it("builds Apply-all text from trusted whole-document window corrections", () => {
    const text = "I seen it and teh result.";
    const first = {
      isWindow: true,
      text: "I seen it and teh",
      baseOffset: 0,
      trustedStart: 0,
      trustedEnd: 14,
    };
    const second = {
      isWindow: true,
      text: "teh result.",
      baseOffset: 14,
      trustedStart: 14,
      trustedEnd: text.length,
    };

    expect(applyWindowCorrections(text, [
      {
        window: first,
        corrections: [
          { startIndex: 2, endIndex: 6, correction: "saw" },
          { startIndex: 14, endIndex: 17, correction: "the" },
        ],
      },
      {
        window: second,
        corrections: [{ startIndex: 0, endIndex: 3, correction: "the" }],
      },
    ])).toBe("I saw it and the result.");
  });
});
