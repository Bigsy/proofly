// P1 — rendering: displaySpan anchoring, usableSpans de-overlap, degradation.
//
// jsdom doesn't lay anything out, so these tests assert DOM *structure*
// (which spans exist, with which classes and text) — never pixel geometry.

import { describe, expect, it } from "vitest";
import { createMockProofreader } from "./helpers/mock-proofreader.js";
import {
  $,
  correctionCards,
  loadPage,
  squiggles,
  tick,
  typeInEditor,
} from "./helpers/page.js";
import basic from "./fixtures/basic-grammar-spelling.json";
import clean from "./fixtures/clean.json";
import insertion from "./fixtures/insertion.json";
import multiOverlap from "./fixtures/multi-overlap.synthetic.json";
import noTypes from "./fixtures/no-types.synthetic.json";

// Boot the page with a fixture pre-filled; init() auto-proofreads it.
async function loadFixture(fixture) {
  const mock = createMockProofreader({ results: [fixture.result] });
  await loadPage({ text: fixture.input, mock });
  return mock;
}

describe("page boot", () => {
  it("loads the real page and reports the model ready", async () => {
    const mock = createMockProofreader();
    await loadPage({ mock });

    expect($("statusText").textContent).toBe("Ready");
    expect($("status").className).toContain("status--ok");
    // Empty editor → no auto-proofread, placeholder still showing.
    expect(mock.ledger.instances).toHaveLength(0);
    expect($("empty").hidden).toBe(false);
    expect($("results").hidden).toBe(true);
  });
});

describe("squiggle rendering (displaySpan anchoring)", () => {
  it("renders real edit spans as-is, coloured by type", async () => {
    await loadFixture(basic);

    const spans = squiggles();
    expect(spans.map((s) => s.textContent)).toEqual(["seen", "loafs"]);
    expect(spans[0].className).toBe("squiggle squiggle--grammar");
    expect(spans[1].className).toBe("squiggle squiggle--spelling");
    // The backdrop mirrors the editor text exactly (squiggles + text nodes).
    expect($("highlights").textContent).toBe(basic.input);
    expect($("summary").textContent).toBe("2 corrections suggested.");
    // The corrections dropdown ships collapsed and is expandable (not empty).
    expect($("correctionsDrop").open).toBe(false);
    expect($("correctionsDrop").className).not.toContain("is-empty");
    // List cards use the one-line layout.
    for (const card of correctionCards()) {
      expect(card.className).toContain("citem--row");
    }
  });

  it("anchors a pure insertion to the word before it", async () => {
    await loadFixture(insertion);

    const spans = squiggles();
    expect(spans.map((s) => s.textContent)).toEqual(["France"]);
    expect(spans[0].className).toBe("squiggle squiggle--punctuation");
    expect($("highlights").textContent).toBe(insertion.input);

    // The card shows the anchored word with and without the insertion,
    // not "∅ → ,".
    const [card] = correctionCards();
    expect(card.querySelector(".chip--from").textContent).toBe("France");
    expect(card.querySelector(".chip--to").textContent).toBe("France,");
  });

  it("falls back to the word after for an insertion at text start", async () => {
    const text = "hello world";
    const mock = createMockProofreader({
      results: [{
        correctedInput: "Oh, hello world",
        corrections: [{ startIndex: 0, endIndex: 0, correction: "Oh, " }],
      }],
    });
    await loadPage({ text, mock });

    expect(squiggles().map((s) => s.textContent)).toEqual(["hello"]);
    // Insertion before a word: card shows "word → <insertion>word".
    const [card] = correctionCards();
    expect(card.querySelector(".chip--from").textContent).toBe("hello");
    expect(card.querySelector(".chip--to").textContent).toBe("Oh, hello");
  });

  // Seen live: the model suggested inserting a space, and the chips rendered
  // as two identical-looking pills ("Line" → " Line" — edge whitespace is
  // invisible in a chip). Whitespace-only diffs draw the whitespace itself.
  it("makes a whitespace-only insertion visible in the chips", async () => {
    const mock = createMockProofreader({
      results: [{
        correctedInput: "week\n Line 1",
        corrections: [{ startIndex: 5, endIndex: 5, correction: " " }],
      }],
    });
    await loadPage({ text: "week\nLine 1", mock });

    const [card] = correctionCards();
    expect(card.querySelector(".chip--from").textContent).toBe("Line");
    expect(card.querySelector(".chip--to").textContent).toBe("␣Line");
  });

  it("makes a whitespace-only deletion visible ('␣␣ → ␣', not blank pills)", async () => {
    const mock = createMockProofreader({
      results: [{
        correctedInput: "a b",
        corrections: [{ startIndex: 1, endIndex: 3, correction: " " }],
      }],
    });
    await loadPage({ text: "a  b", mock });

    const [card] = correctionCards();
    expect(card.querySelector(".chip--from").textContent).toBe("␣␣");
    expect(card.querySelector(".chip--to").textContent).toBe("␣");
  });

  it("leaves visible-text corrections untouched (no whitespace glyphs)", async () => {
    const mock = createMockProofreader({
      results: [{
        correctedInput: "I am very happy.",
        corrections: [{ startIndex: 2, endIndex: 8, correction: "am very" }],
      }],
    });
    await loadPage({ text: "I amvery happy.", mock });

    const [card] = correctionCards();
    expect(card.querySelector(".chip--to").textContent).toBe("am very"); // real space, no ␣
  });

  it("renders no squiggle (but doesn't crash) for an unanchorable insertion", async () => {
    // Insertion at index 2 of "a  b": only whitespace on both sides.
    const mock = createMockProofreader({
      results: [{
        correctedInput: "a , b",
        corrections: [{ startIndex: 2, endIndex: 2, correction: "," }],
      }],
    });
    await loadPage({ text: "a  b", mock });

    expect(squiggles()).toHaveLength(0);
    // The correction still appears in the list and the summary.
    expect(correctionCards()).toHaveLength(1);
    expect($("summary").textContent).toBe("1 correction suggested.");
  });

  it("silently skips out-of-bounds and non-numeric spans", async () => {
    const mock = createMockProofreader({
      results: [{
        correctedInput: "hello world",
        corrections: [
          { startIndex: 3, endIndex: 99, correction: "x" },
          { startIndex: "x", endIndex: 5, correction: "y" },
        ],
      }],
    });
    await loadPage({ text: "hello world", mock });

    expect(squiggles()).toHaveLength(0);
    expect($("highlights").textContent).toBe("hello world");
    // Only the backdrop filters; the list still shows every correction.
    expect(correctionCards()).toHaveLength(2);
  });
});

describe("usableSpans de-overlap", () => {
  it("keeps first-by-start, keeps adjacent, drops overlaps — list shows all", async () => {
    await loadFixture(multiOverlap);

    // Fixture arrives unsorted: [13,20), [2,5), [5,9), [17,26).
    // Sorted + de-overlapped: [2,5) kept, [5,9) adjacent → kept,
    // [13,20) kept, [17,26) starts inside [13,20) → dropped.
    const spans = squiggles();
    expect(spans.map((s) => s.textContent)).toEqual(["has", " ran", "the the"]);
    expect($("highlights").textContent).toBe(multiOverlap.input);

    // The backdrop de-overlaps; the corrections list does NOT.
    expect(correctionCards()).toHaveLength(4);
    expect($("summary").textContent).toBe("4 corrections suggested.");
  });
});

describe("graceful degradation (types/explanation absent)", () => {
  it("renders bare cards and uncoloured squiggles when types are missing", async () => {
    await loadFixture(noTypes);

    for (const span of squiggles()) expect(span.className).toBe("squiggle");
    for (const card of correctionCards()) {
      expect(card.querySelector(".badges")).toBeNull();
      expect(card.querySelector(".explain")).toBeNull();
    }
  });

  it("renders badge row and explanation when present", async () => {
    // Synthetic: the recorded Beta 150 build never emits `explanation`, but
    // earlier builds do — graft one onto the recorded shape.
    const withExplanation = structuredClone(basic.result);
    withExplanation.corrections[0].explanation = "Past tense of 'see' is 'saw'.";
    const mock = createMockProofreader({ results: [withExplanation] });
    await loadPage({ text: basic.input, mock });

    const [first, second] = correctionCards();
    expect(
      [...first.querySelectorAll(".badge")].map((b) => b.textContent),
    ).toEqual(["Grammar"]);
    expect(first.querySelector(".explain").textContent).toBe(
      "Past tense of 'see' is 'saw'.",
    );
    // The row layout truncates — the full text must survive as a tooltip.
    expect(first.querySelector(".explain").title).toBe(
      "Past tense of 'see' is 'saw'.",
    );
    expect(
      [...second.querySelectorAll(".badge")].map((b) => b.textContent),
    ).toEqual(["Spelling"]);
    expect(second.querySelector(".explain")).toBeNull();
  });
});

describe("informational advice", () => {
  it("renders context and explanation without presenting a deletion or action", async () => {
    const text = 'She whispered "hurry"and left.';
    const mock = createMockProofreader({ results: [{ corrections: [{
      startIndex: 15,
      endIndex: 24,
      correction: null,
      suggestions: [],
      types: ["formatting"],
      explanation: "A quote must be preceded or succeeded by a space.",
    }] }] });
    await loadPage({ text, mock });

    const [card] = correctionCards();
    expect(card.className).toContain("citem--informational");
    expect(card.querySelector(".citem__excerpt").textContent).toBe('hurry"and');
    expect(card.querySelector(".chip--from")).toBeNull();
    expect(card.querySelector(".chip--to")).toBeNull();
    expect(card.querySelector(".arrow")).toBeNull();
    expect(card.querySelector(".citem__apply")).toBeNull();
    expect(card.querySelector(".citem__dict")).toBeNull();
    expect(card.querySelector(".badge").textContent).toBe("Formatting");
    expect(card.querySelector(".explain").textContent)
      .toBe("A quote must be preceded or succeeded by a space.");
    expect($("summary").textContent).toBe("1 writing suggestion.");
    expect($("applyBtn").disabled).toBe(true);
  });

  it("summarizes mixed fixes and advice separately", async () => {
    const mock = createMockProofreader({ results: [{ corrections: [
      { startIndex: 0, endIndex: 5, correction: "weird", suggestions: [{ replacement: "weird" }] },
      {
        startIndex: 6, endIndex: 12, correction: null, suggestions: [],
        types: ["readability"], explanation: "Review this wording.",
      },
    ] }] });
    await loadPage({ text: "wierd notice", mock });

    expect($("summary").textContent).toBe("1 correction and 1 writing suggestion.");
    expect($("applyBtn").disabled).toBe(false);
  });

  it("uses a readable neutral fallback for an unknown future kind", async () => {
    const mock = createMockProofreader({ results: [{ corrections: [{
      startIndex: 0,
      endIndex: 5,
      correction: "weird",
      suggestions: [{ replacement: "weird" }],
      types: ["FutureClarityCheck"],
    }] }] });
    await loadPage({ text: "wierd", mock });

    const [span] = squiggles();
    expect(span.className).toBe("squiggle squiggle--futureclaritycheck");
    expect(span.style.getPropertyValue("--harper-kind-color")).toBe("#94a3b8");
    expect(correctionCards()[0].querySelector(".badge").textContent)
      .toBe("Future Clarity Check");
  });
});

describe("clean result", () => {
  it("shows the no-issues summary and disables the empty dropdown", async () => {
    await loadFixture(clean);

    expect($("summary").textContent).toBe("No issues found");
    expect($("correctionsList").hidden).toBe(true);
    expect(squiggles()).toHaveLength(0);
    // Nothing to expand: the dropdown is marked empty and forced closed.
    expect($("correctionsDrop").className).toContain("is-empty");
    expect($("correctionsDrop").open).toBe(false);
  });
});

describe("corrections dropdown open state", () => {
  it("preserves the user's open choice across re-proofreads", async () => {
    const mock = await loadFixture(basic);
    $("correctionsDrop").open = true; // user expands it

    mock.enqueue(basic.result);
    typeInEditor(basic.input + " Again.");
    await tick(700);

    expect($("summary").textContent).toBe("2 corrections suggested.");
    expect($("correctionsDrop").open).toBe(true); // still open
  });

  it("forces the dropdown closed when a clean result lands", async () => {
    await loadFixture(basic);
    $("correctionsDrop").open = true;

    typeInEditor("All good now."); // queue empty → mock returns a clean pass
    await tick(700);

    expect($("summary").textContent).toBe("No issues found");
    expect($("correctionsDrop").open).toBe(false);
    expect($("correctionsDrop").className).toContain("is-empty");
  });
});
