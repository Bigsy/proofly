// P3 — interactions: apply/apply-all, the squiggle popup, unsupported builds.
//
// Popup tests assert that it opens with the right content, never where —
// jsdom doesn't lay out, so positioning is untestable here.

import { describe, expect, it } from "vitest";
import { createMockProofreader } from "./helpers/mock-proofreader.js";
import {
  $,
  clickEditorAt,
  correctionCards,
  loadPage,
  settle,
  squiggles,
  tick,
} from "./helpers/page.js";
import basic from "./fixtures/basic-grammar-spelling.json";
import multiOverlap from "./fixtures/multi-overlap.synthetic.json";

async function loadFixture(fixture) {
  const mock = createMockProofreader({ results: [fixture.result] });
  await loadPage({ text: fixture.input, mock });
  return mock;
}

describe("applyCorrection", () => {
  it("splices exactly [startIndex, endIndex) and re-proofreads", async () => {
    const mock = await loadFixture(basic);

    correctionCards()[0].querySelector("button").click(); // Apply "seen" → "saw"
    await settle();

    expect($("editor").value).toBe(
      "I saw him yesterday at the store, and he bought two loafs of bread.",
    );
    // Re-proofread happened immediately (no debounce) on a fresh instance.
    expect(mock.ledger.instances).toHaveLength(2);
    expect(mock.ledger.instances[1].proofreadCalls).toEqual([$("editor").value]);
  });

  it("applies a non-primary Harper suggestion selected from the shared card", async () => {
    const mock = createMockProofreader({ results: [{ corrections: [{
      startIndex: 0,
      endIndex: 5,
      correction: "weird",
      suggestions: [
        { replacement: "weird" },
        { replacement: "wired" },
      ],
      types: ["spelling"],
    }] }] });
    await loadPage({ text: "wierd choice", mock });

    const card = correctionCards()[0];
    const choices = card.querySelectorAll(".citem__suggestion");
    expect([...choices].map((choice) => choice.getAttribute("aria-label")))
      .toEqual(["Use weird", "Use wired"]);
    choices[1].focus();
    choices[1].click();
    expect(document.activeElement).toBe(choices[1]);
    expect(correctionCards()[0]).toBe(card); // selection must not rebuild the focused card
    expect(card.querySelector(".chip--to").textContent).toBe("wired");
    card.querySelector(".citem__apply").click();
    await settle();

    expect($("editor").value).toBe("wired choice");
  });
});

describe("apply-all", () => {
  it("Apply all puts correctedInput in the editor and re-proofreads", async () => {
    const mock = await loadFixture(basic);

    $("applyBtn").click();
    await settle();

    expect($("editor").value).toBe(basic.result.correctedInput);
    expect(mock.ledger.instances).toHaveLength(2);
  });

  it("uses selected alternatives and skips informational zero-suggestion issues", async () => {
    const mock = createMockProofreader({ results: [{ corrections: [
      {
        startIndex: 0, endIndex: 5, correction: "weird",
        suggestions: [{ replacement: "weird" }, { replacement: "wired" }],
      },
      { startIndex: 6, endIndex: 12, correction: null, suggestions: [], explanation: "Information only" },
      { startIndex: 13, endIndex: 16, correction: "the", suggestions: [{ replacement: "the" }] },
    ] }] });
    await loadPage({ text: "wierd notice teh", mock });

    correctionCards()[0].querySelectorAll(".citem__suggestion")[1].click();
    expect(correctionCards()[1].querySelector(".citem__apply")).toBeNull();
    $("applyBtn").click();
    await settle();

    expect($("editor").value).toBe("wired notice the");
    expect($("toastText").textContent).toBe("Applied 2 corrections");
  });

  it("counts only the non-overlapping edits Apply all actually splices", async () => {
    await loadFixture(multiOverlap);

    $("applyBtn").click();
    await settle();

    expect($("editor").value).toBe(multiOverlap.result.correctedInput);
    expect($("toastText").textContent).toBe("Applied 3 corrections");
  });
});

describe("squiggle popup (findCorrectionAt)", () => {
  it("opens on click inside a squiggle with that correction's content", async () => {
    await loadFixture(basic);

    clickEditorAt(3); // inside "seen" [2,6)
    expect($("popup").hidden).toBe(false);
    expect($("popup").querySelector(".chip--from").textContent).toBe("seen");
    expect($("popup").querySelector(".chip--to").textContent).toBe("saw");
    expect($("popup").querySelector(".popup__dismiss").getAttribute("aria-label"))
      .toBe("Dismiss for now");
  });

  it("treats the span end as inclusive: a caret right after the word still targets it", async () => {
    await loadFixture(basic);

    clickEditorAt(6); // exactly endIndex of "seen" [2,6)
    expect($("popup").hidden).toBe(false);
    expect($("popup").querySelector(".chip--from").textContent).toBe("seen");
  });

  it("picks the smallest covering span on overlap", async () => {
    await loadFixture(multiOverlap);

    // Caret 18 is covered by both [13,20) "the the" (len 7) and
    // [17,26) "the store" (len 9) — the smaller span wins.
    clickEditorAt(18);
    expect($("popup").hidden).toBe(false);
    expect($("popup").querySelector(".chip--from").textContent).toBe("the the");
    expect($("popup").querySelector(".chip--to").textContent).toBe("the");
  });

  it("closes on a click outside any squiggle and on Escape", async () => {
    await loadFixture(basic);

    clickEditorAt(3);
    expect($("popup").hidden).toBe(false);
    clickEditorAt(20); // clean stretch of text
    expect($("popup").hidden).toBe(true);

    clickEditorAt(3);
    expect($("popup").hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect($("popup").hidden).toBe(true);
  });

  it("applies the fix from the popup", async () => {
    await loadFixture(basic);

    clickEditorAt(3);
    const [applyFix] = $("popup").querySelectorAll("button");
    applyFix.click();
    await settle();

    expect($("popup").hidden).toBe(true);
    expect($("editor").value).toBe(
      "I saw him yesterday at the store, and he bought two loafs of bread.",
    );
  });

  it("selects and applies a non-primary suggestion from the popup", async () => {
    const mock = createMockProofreader({ results: [{ corrections: [{
      startIndex: 0, endIndex: 5, correction: "weird",
      suggestions: [{ replacement: "weird" }, { replacement: "wired" }],
    }] }] });
    await loadPage({ text: "wierd choice", mock });

    clickEditorAt(2);
    const popup = $("popup");
    popup.querySelectorAll(".citem__suggestion")[1].click();
    await settle();

    expect($("editor").value).toBe("wired choice");
  });

  it("keeps advice compact and Dismiss for now hides only that occurrence", async () => {
    const text = "The city is famous its beaches.";
    const mock = createMockProofreader({ results: [{ corrections: [{
      startIndex: 4,
      endIndex: 9,
      correction: null,
      suggestions: [],
      types: ["miscellaneous"],
      explanation: "You may be missing a preposition here.",
    }] }] });
    await loadPage({ text, mock });

    clickEditorAt(6);
    const popup = $("popup");
    expect(popup.hidden).toBe(false);
    expect(popup.querySelector(".chip--from")).toBeNull();
    expect(popup.querySelector(".badge").textContent).toBe("General");
    expect(popup.querySelector(".explain")).toBeNull();
    expect(popup.querySelector(".popup__dismiss").getAttribute("aria-label"))
      .toBe("Dismiss for now");

    popup.querySelector(".popup__dismiss").click();
    expect(popup.hidden).toBe(true);
    expect(squiggles()).toHaveLength(0);
    expect(correctionCards()).toHaveLength(0);
    expect(mock.ledger.instances).toHaveLength(1);
  });

  it("rebases a dismissal through unrelated edits but reports a new occurrence", async () => {
    const correction = {
      startIndex: 0, endIndex: 5, correction: "weird",
      suggestions: [{ replacement: "weird" }], types: ["spelling"],
    };
    const mock = createMockProofreader({ results: [
      { corrections: [correction] },
      { corrections: [
        { ...correction, startIndex: 7, endIndex: 12 },
        { ...correction, startIndex: 22, endIndex: 27 },
      ] },
    ] });
    await loadPage({ text: "wierd note", mock });

    clickEditorAt(2);
    $("popup").querySelector(".popup__dismiss").click();
    expect(squiggles()).toHaveLength(0);

    const editor = $("editor");
    editor.value = "Today, wierd note";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    editor.value = "Today, wierd note and wierd";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await tick(700);

    expect(squiggles().map((span) => span.textContent)).toEqual(["wierd"]);
    expect(correctionCards()).toHaveLength(1);
  });
});
