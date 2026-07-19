// Navigation + auto-save integration: the library ⇄ editor router, the
// view choice on init, open/Back/New transitions, the debounced auto-save and
// its round-trip through storage, and the blank-note rules.
//
// These drive the REAL sidepanel.html/js through the page harness; the store is
// seeded via loadPage({ notes }) and read back to simulate reopening the panel.

import { describe, expect, it } from "vitest";
import { createMockProofreader } from "./helpers/mock-proofreader.js";
import {
  $,
  NOW,
  clickEditorAt,
  docCards,
  docTitles,
  inEditor,
  inLibrary,
  loadPage,
  settle,
  squiggles,
  tick,
  typeInEditor,
} from "./helpers/page.js";
import basic from "./fixtures/basic-grammar-spelling.json";

const HOUR = 60 * 60 * 1000;

// Read every persisted note back out of the live chrome.storage.local stub,
// shaped for re-seeding via loadPage({ notes }) — i.e. "reopen the panel".
async function dumpNotes() {
  const all = await globalThis.chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith("note:"))
    .map(([, v]) => ({ id: v.id, body: v.body, createdAt: v.createdAt, updatedAt: v.updatedAt }));
}

describe("init view choice", () => {
  it("opens a blank editor (not the library) when there are no stored notes", async () => {
    await loadPage({ mock: createMockProofreader() });
    expect(inEditor()).toBe(true);
    expect($("editor").value).toBe("");
    expect($("backBtn").hidden).toBe(false); // back arrow shows in the editor
  });

  it("opens the library when there are stored notes", async () => {
    await loadPage({
      mock: createMockProofreader(),
      notes: [{ id: "n1", body: "Hello\nworld", updatedAt: NOW - HOUR }],
    });
    expect(inLibrary()).toBe(true);
    expect($("backBtn").hidden).toBe(true); // no back arrow in the library
    expect(docTitles()).toEqual(["Hello"]);
  });
});

describe("opening a note", () => {
  it("loads the body into the editor and proofreads it when the model is ready", async () => {
    await loadPage({
      mock: createMockProofreader({ results: [basic.result] }),
      notes: [{ id: "n1", body: basic.input, updatedAt: NOW - HOUR }],
    });

    docCards()[0].click();
    await settle();

    expect(inEditor()).toBe(true);
    expect($("editor").value).toBe(basic.input);
    expect(squiggles().map((s) => s.textContent)).toEqual(["seen", "loafs"]);
  });

  it("does not re-save or reorder when a note is opened but not edited", async () => {
    await loadPage({
      mock: createMockProofreader(),
      notes: [
        { id: "a", body: "Alpha", updatedAt: NOW - HOUR },
        { id: "b", body: "Beta", updatedAt: NOW - 2 * HOUR },
      ],
    });
    expect(docTitles()).toEqual(["Alpha", "Beta"]); // a is newer

    docCards()[0].click();
    await settle();
    $("backBtn").click();
    await settle();

    // Opening 'a' didn't bump its updatedAt, so the order is unchanged.
    expect(docTitles()).toEqual(["Alpha", "Beta"]);
  });
});

describe("Back", () => {
  it("returns to the library and re-renders the list", async () => {
    await loadPage({
      mock: createMockProofreader(),
      notes: [{ id: "n1", body: "One", updatedAt: NOW - HOUR }],
    });
    docCards()[0].click();
    await settle();
    expect(inEditor()).toBe(true);

    $("backBtn").click();
    await settle();
    expect(inLibrary()).toBe(true);
    expect(docCards()).toHaveLength(1);
  });
});

describe("New doc", () => {
  it("opens a blank editor without auto-proofreading", async () => {
    const mock = createMockProofreader();
    await loadPage({ mock, notes: [{ id: "n1", body: "x", updatedAt: NOW - HOUR }] });

    $("newDocBtn").click();
    await settle();

    expect(inEditor()).toBe(true);
    expect($("editor").value).toBe("");
    expect($("empty").hidden).toBe(false);
    expect(mock.ledger.instances).toHaveLength(0); // nothing to proofread
  });
});

describe("auto-save round-trip", () => {
  it("persists typed text after the debounce; reopening the panel shows the note", async () => {
    await loadPage({ mock: createMockProofreader() }); // empty → blank editor
    expect(inEditor()).toBe(true);

    typeInEditor("Shopping list\nmilk, eggs");
    await tick(1000); // save debounce

    const persisted = await dumpNotes();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].body).toBe("Shopping list\nmilk, eggs");

    // Reopen the panel from the same store → library with the saved note.
    await loadPage({ mock: createMockProofreader(), notes: persisted });
    expect(inLibrary()).toBe(true);
    expect(docTitles()).toEqual(["Shopping list"]);
  });

  it("flushes the pending save on Back (no debounce wait needed)", async () => {
    await loadPage({
      mock: createMockProofreader(),
      notes: [{ id: "n1", body: "draft", updatedAt: NOW - HOUR }],
    });
    docCards()[0].click();
    await settle();

    typeInEditor("draft, edited");
    $("backBtn").click(); // Back before the save debounce fires
    await settle();

    const persisted = await dumpNotes();
    expect(persisted[0].body).toBe("draft, edited");
  });
});

describe("blank-note rules", () => {
  it("discards a brand-new note left blank on Back", async () => {
    await loadPage({
      mock: createMockProofreader(),
      notes: [{ id: "n1", body: "Keeper", updatedAt: NOW - HOUR }],
    });

    $("newDocBtn").click();
    await settle();
    // Don't type anything — the new doc stays blank.
    $("backBtn").click();
    await settle();

    expect(inLibrary()).toBe(true);
    expect(docCards()).toHaveLength(1); // only the original note
    expect(docTitles()).toEqual(["Keeper"]);
  });

  it("preserves an existing note emptied to blank (becomes 'Untitled note')", async () => {
    await loadPage({
      mock: createMockProofreader(),
      notes: [{ id: "n1", body: "Has content", updatedAt: NOW - HOUR }],
    });
    docCards()[0].click();
    await settle();

    typeInEditor(""); // clear the existing note
    $("backBtn").click();
    await settle();

    expect(inLibrary()).toBe(true);
    expect(docCards()).toHaveLength(1); // not deleted
    expect(docTitles()).toEqual(["Untitled note"]);
  });
});

// The proofread result state (currentText/currentCorrections/currentCorrected
// in sidepanel.js) must not survive navigation: openNote/startNewDoc swap the
// editor's value WITHOUT an `input` event, so the input handler's reset never
// runs for them. Found via live MCP testing: a stale popup "Apply" on a blank
// New doc spliced the PREVIOUS note's body into it (auto-save then persisted
// the phantom note), and an in-flight proofread landed its squiggles on the
// blank doc after navigation. resetResultState() is the fix; these pin it.
describe("result-state isolation across navigation", () => {
  it("shows no stale popup on a new doc where the previous note had a correction", async () => {
    const mock = createMockProofreader({ results: [basic.result] });
    await loadPage({
      mock,
      notes: [{ id: "n1", body: basic.input, updatedAt: NOW - HOUR }],
    });
    docCards()[0].click();
    await settle();
    expect(squiggles()).toHaveLength(2); // the note's corrections are live

    $("backBtn").click();
    await settle();
    $("newDocBtn").click();
    await settle();

    clickEditorAt(3); // blank doc, inside where "seen"'s correction span was
    expect($("popup").hidden).toBe(true);
    expect($("applyBtn").disabled).toBe(true);
    expect($("results").hidden).toBe(true);
  });

  it("aborts an in-flight proofread on navigation; its late result changes nothing", async () => {
    const mock = createMockProofreader();
    await loadPage({
      mock,
      notes: [{ id: "n1", body: "draft text", updatedAt: NOW - HOUR }],
    });

    const slow = mock.enqueueControlled();
    docCards()[0].click(); // the open-time proofread is now in flight
    await settle();
    $("backBtn").click();
    await settle();
    $("newDocBtn").click(); // blank — no new proofread to supersede the old one
    await settle();
    // The invalidated run set "Proofreading…" and nothing else will overwrite it
    // (no follow-up run on a blank doc) — navigation must restore the status.
    expect($("statusText").textContent).toBe("Ready");

    // Even on a build that ignored the abort, the late result must not land.
    slow.resolve({
      correctedInput: "STALE",
      corrections: [{ startIndex: 0, endIndex: 5, correction: "Stale" }],
    });
    await settle();
    expect(squiggles()).toHaveLength(0);
    expect($("highlights").textContent).toBe("");
    expect($("results").hidden).toBe(true);
  });

  it("cancels the debounced proofread when navigating before it fires", async () => {
    const mock = createMockProofreader();
    await loadPage({
      mock,
      notes: [{ id: "n1", body: "draft", updatedAt: NOW - HOUR }],
    });
    docCards()[0].click();
    await settle(); // the open-time proofread (#1) has run

    typeInEditor("draft edited"); // arms the 700 ms debounce
    $("backBtn").click(); // navigate before it fires
    await settle();
    await tick(700);

    expect(inLibrary()).toBe(true);
    expect(mock.ledger.instances).toHaveLength(1); // nothing ran in the library
    expect($("statusText").textContent).toBe("Ready"); // no flicker
  });
});

describe("works without the Chrome Proofreader API", () => {
  it("loads, proofreads, and saves notes through packaged Harper", async () => {
    await loadPage({ mock: null, notes: [{ id: "n1", body: "Offline note", updatedAt: NOW - HOUR }] });

    expect(inLibrary()).toBe(true);
    expect(docTitles()).toEqual(["Offline note"]);

    docCards()[0].click();
    await settle();
    expect(inEditor()).toBe(true);
    expect($("editor").value).toBe("Offline note");
    expect($("statusText").textContent).toBe("Ready");

    typeInEditor("Offline note\nedited offline");
    $("backBtn").click();
    await settle();
    const persisted = await dumpNotes();
    expect(persisted[0].body).toBe("Offline note\nedited offline");
  });
});
