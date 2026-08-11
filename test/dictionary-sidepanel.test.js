// The custom dictionary in the side panel: the popup/card "Add to dictionary"
// affordances, the post-filter render seam (add → every squiggle for the word
// drops, NO re-proofread — the shared tripwire in helpers/setup.js enforces
// the fresh-instance half of that for free), the Apply-all splice that keeps
// suppressed words intact, and live re-filtering on external sync changes.

import { describe, expect, it } from "vitest";
import { loadDictionary } from "../lib/dictionary-store.js";
import { createMockProofreader } from "./helpers/mock-proofreader.js";
import {
  $, clickEditorAt, correctionCards, loadPage, settle, squiggles, tick,
} from "./helpers/page.js";
import basic from "./fixtures/basic-grammar-spelling.json";
import insertion from "./fixtures/insertion.json";

// basic.input: "seen" → "saw" (grammar) at [2,6), "loafs" → "loaves"
// (spelling) at [53,58).
async function loadBasic(storage = {}) {
  const mock = createMockProofreader({ results: [basic.result] });
  await loadPage({ text: basic.input, mock, storage });
  return mock;
}

const sync = () => globalThis.chrome.storage.sync;

const popupButtons = () =>
  [...$("popup").querySelectorAll(".popup__actions button")]
    .map((b) => b.getAttribute("aria-label"));

describe("the popup button", () => {
  it("offers the dictionary for a spelling correction, with the exact word", async () => {
    await loadBasic();
    clickEditorAt(54); // inside "loafs"
    expect($("popup").hidden).toBe(false);
    expect(popupButtons()).toEqual(["Add “loafs” to dictionary", "Dismiss for now"]);
  });

  it("does not offer it for a typed grammar correction", async () => {
    await loadBasic();
    clickEditorAt(3); // inside "seen" — grammar
    expect($("popup").hidden).toBe(false);
    expect(popupButtons()).toEqual(["Dismiss for now"]);
  });

  it("does not offer it for a pure insertion (anchored word ≠ candidate)", async () => {
    const mock = createMockProofreader({ results: [insertion.result] });
    await loadPage({ text: insertion.input, mock });
    clickEditorAt(18); // inside "France" — the "," insertion's anchor
    expect($("popup").hidden).toBe(false);
    expect(popupButtons()).toEqual(["Dismiss for now"]);
  });

  it("offers it when types are absent (degraded build heuristic)", async () => {
    const mock = createMockProofreader({
      results: [{
        correctedInput: "I saw two loaves.",
        corrections: [{ startIndex: 10, endIndex: 15, correction: "loaves" }],
      }],
    });
    await loadPage({ text: "I saw two loafs.", mock });
    clickEditorAt(12);
    expect(popupButtons()).toEqual(["Add “loafs” to dictionary", "Dismiss for now"]);
  });
});

describe("adding a word", () => {
  it("drops the word's squiggle + card, fixes the count, persists — and never re-proofreads", async () => {
    const mock = await loadBasic();
    expect(squiggles().map((s) => s.textContent)).toEqual(["seen", "loafs"]);
    expect(mock.ledger.instances).toHaveLength(1);

    clickEditorAt(54);
    $("popup").querySelector(".popup__dict").click();
    await settle();

    expect($("popup").hidden).toBe(true);
    expect(squiggles().map((s) => s.textContent)).toEqual(["seen"]);
    expect(correctionCards()).toHaveLength(1);
    expect($("summary").textContent).toBe("1 correction suggested.");
    expect(await loadDictionary()).toEqual(["loafs"]);

    // The whole point: a Set lookup, not a model call. Let the debounce window
    // pass too — nothing may have scheduled a proofread.
    await tick(1000);
    expect(mock.ledger.instances).toHaveLength(1);
  });

  it("one add suppresses EVERY instance of the word at once", async () => {
    const text = "Their loafs and more loafs here.";
    const mock = createMockProofreader({
      results: [{
        correctedInput: "Their loaves and more loaves here.",
        corrections: [
          { startIndex: 6, endIndex: 11, correction: "loaves", types: ["spelling"] },
          { startIndex: 21, endIndex: 26, correction: "loaves", types: ["spelling"] },
        ],
      }],
    });
    await loadPage({ text, mock });
    expect(squiggles()).toHaveLength(2);

    clickEditorAt(8);
    $("popup").querySelector(".popup__dict").click();
    await settle();

    expect(squiggles()).toHaveLength(0);
    expect($("summary").textContent).toBe("No issues found");
    expect($("applyBtn").disabled).toBe(true);
  });

  it("the list card's Add to dictionary button works too, only on suppressible cards", async () => {
    const mock = await loadBasic();
    const dictBtns = correctionCards().map((c) => c.querySelector(".citem__dict"));
    expect(dictBtns[0]).toBeNull();     // "seen" — grammar
    expect(dictBtns[1]).not.toBeNull(); // "loafs" — spelling

    dictBtns[1].click();
    await settle();
    expect(squiggles().map((s) => s.textContent)).toEqual(["seen"]);
    expect(await loadDictionary()).toEqual(["loafs"]);
    expect(mock.ledger.instances).toHaveLength(1);
  });

  it("surfaces a quota rejection on the status line (the optimistic filter stands)", async () => {
    await loadBasic();
    sync().set.mockRejectedValueOnce(new Error("QUOTA_BYTES_PER_ITEM exceeded"));

    clickEditorAt(54);
    $("popup").querySelector(".popup__dict").click();
    await settle();

    expect($("statusText").textContent).toMatch(/Couldn't save “loafs”/);
    expect(squiggles().map((s) => s.textContent)).toEqual(["seen"]); // session-local suppression kept
  });
});

describe("a seeded dictionary", () => {
  it("filters the FIRST render — no squiggle flash", async () => {
    await loadBasic({ customDictionary: ["loafs"] });
    expect(squiggles().map((s) => s.textContent)).toEqual(["seen"]);
    expect($("summary").textContent).toBe("1 correction suggested.");
    expect(correctionCards()).toHaveLength(1);
  });

  it("a lowercase entry suppresses the TitleCase instance (case rule)", async () => {
    const mock = createMockProofreader({
      results: [{
        correctedInput: "Loaves are nice.",
        corrections: [{ startIndex: 0, endIndex: 5, correction: "Loaves", types: ["spelling"] }],
      }],
    });
    await loadPage({ text: "Loafs are nice.", mock, storage: { customDictionary: ["loafs"] } });
    expect(squiggles()).toHaveLength(0);
    expect($("summary").textContent).toBe("No issues found");
  });
});

describe("Apply all with suppressions", () => {
  it("applies only unsuppressed corrections — the dictionary word stays intact", async () => {
    await loadBasic({ customDictionary: ["loafs"] });
    expect($("applyBtn").disabled).toBe(false);

    $("applyBtn").click();
    await settle();
    // "seen" fixed; "loafs" NOT "fixed back" by the model's correctedInput.
    expect($("editor").value)
      .toBe("I saw him yesterday at the store, and he bought two loafs of bread.");
    expect($("toastText").textContent).toBe("Applied 1 correction");
  });
});

describe("external dictionary changes (sync round-trip)", () => {
  it("re-filters the kept raw corrections without a proofread", async () => {
    const mock = await loadBasic();
    expect(squiggles()).toHaveLength(2);

    // Another device / the options page writes the key; the storage stub
    // fires onChanged exactly like Chrome does.
    await sync().set({ customDictionary: ["loafs"] });
    await settle();

    expect(squiggles().map((s) => s.textContent)).toEqual(["seen"]);
    expect($("summary").textContent).toBe("1 correction suggested.");
    expect(mock.ledger.instances).toHaveLength(1);
  });

  it("all suppressed → 'No issues found' and Apply all disabled; removal restores them", async () => {
    const text = "Some loafs here.";
    const mock = createMockProofreader({
      results: [{
        correctedInput: "Some loaves here.",
        corrections: [{ startIndex: 5, endIndex: 10, correction: "loaves", types: ["spelling"] }],
      }],
    });
    await loadPage({ text, mock });
    expect(squiggles()).toHaveLength(1);

    await sync().set({ customDictionary: ["loafs"] });
    await settle();
    expect(squiggles()).toHaveLength(0);
    expect($("summary").textContent).toBe("No issues found");
    expect($("applyBtn").disabled).toBe(true);
    expect($("correctionsDrop").classList.contains("is-empty")).toBe(true);

    // Removing the word re-derives from the same raw result — still no model call.
    await sync().set({ customDictionary: [] });
    await settle();
    expect(squiggles().map((s) => s.textContent)).toEqual(["loafs"]);
    expect($("applyBtn").disabled).toBe(false);
    expect(mock.ledger.instances).toHaveLength(1);
  });

  it("a change landing after the user edited (stale window) renders nothing", async () => {
    const mock = await loadBasic();
    $("editor").value = basic.input + " More";
    $("editor").dispatchEvent(new Event("input", { bubbles: true }));
    expect(squiggles()).toHaveLength(0); // input handler cleared the result

    await sync().set({ customDictionary: ["loafs"] });
    await settle();
    expect(squiggles()).toHaveLength(0); // no stale re-render
    expect(mock.ledger.instances).toHaveLength(1); // (debounced run not fired yet)
  });
});
