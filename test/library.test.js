// Library UI: card content (title / snippet / "Edited …" meta), Today /
// Yesterday / Earlier grouping, the empty state, and the two-step inline delete
// confirm. Driven through the real page harness; the store is seeded via
// loadPage({ notes }) so init opens the library.

import { describe, expect, it } from "vitest";
import { createMockProofreader } from "./helpers/mock-proofreader.js";
import {
  $,
  NOW,
  docCards,
  docTitles,
  groupHeadings,
  inEditor,
  inLibrary,
  loadPage,
  openCardMenu,
  settle,
} from "./helpers/page.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const cardText = (card, sel) => card.querySelector(sel)?.textContent ?? null;

describe("card content", () => {
  it("shows the derived title, snippet, and relative-time meta", async () => {
    await loadPage({
      mock: createMockProofreader(),
      notes: [{ id: "n1", body: "Grocery list\nmilk and eggs", updatedAt: NOW - 2 * HOUR }],
    });

    const [card] = docCards();
    expect(cardText(card, ".doc-card__title")).toBe("Grocery list");
    expect(cardText(card, ".doc-card__snippet")).toBe("milk and eggs");
    expect(cardText(card, ".doc-card__meta")).toBe("Edited 2 hours ago");
  });

  it("renders a single-line note with no snippet element and 'Untitled note' for a blank body", async () => {
    await loadPage({
      mock: createMockProofreader(),
      notes: [
        { id: "single", body: "Just a title", updatedAt: NOW - HOUR },
        { id: "blank", body: "   ", updatedAt: NOW - 2 * HOUR },
      ],
    });

    const [single, blank] = docCards();
    expect(cardText(single, ".doc-card__title")).toBe("Just a title");
    expect(single.querySelector(".doc-card__snippet")).toBeNull();
    expect(cardText(blank, ".doc-card__title")).toBe("Untitled note");
  });
});

describe("Chrome AI setup", () => {
  it("puts only the optional Rewriter flag link at the bottom of Docs", async () => {
    await loadPage({
      mock: createMockProofreader(),
      notes: [{ id: "n1", body: "Note", updatedAt: NOW - HOUR }],
    });

    const links = [...$("apiSetup").querySelectorAll("a")];
    expect(links.map((link) => link.textContent)).toEqual(["Enable Rewriter API"]);

    links[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(globalThis.chrome.tabs.create).toHaveBeenCalledWith({
      url: "chrome://flags/#rewriter-api-for-gemini-nano",
    });
  });
});

describe("recency grouping", () => {
  it("renders Today / Yesterday / Earlier headings over the right cards", async () => {
    await loadPage({
      mock: createMockProofreader(),
      notes: [
        { id: "t", body: "Today note", updatedAt: NOW - 2 * HOUR },
        { id: "y", body: "Yesterday note", updatedAt: NOW - 20 * HOUR },
        { id: "e", body: "Old note", updatedAt: NOW - 5 * DAY },
      ],
    });

    expect(groupHeadings()).toEqual(["Today", "Yesterday", "Earlier"]);
    expect(docTitles()).toEqual(["Today note", "Yesterday note", "Old note"]);
  });

  it("omits headings for empty buckets", async () => {
    await loadPage({
      mock: createMockProofreader(),
      notes: [
        { id: "t1", body: "A", updatedAt: NOW - HOUR },
        { id: "t2", body: "B", updatedAt: NOW - 3 * HOUR },
      ],
    });
    expect(groupHeadings()).toEqual(["Today"]);
    expect(docCards()).toHaveLength(2);
  });
});

// The card can't be a <button> (the "…" menu button nests inside it), so it
// carries role=button + tabindex and handles Enter/Space itself — without
// that, keyboard users can reach New doc / search / the menus but can never
// open a note.
describe("keyboard access to cards", () => {
  const key = (el, k) =>
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

  it("exposes cards as focusable buttons", async () => {
    await loadPage({
      mock: createMockProofreader(),
      notes: [{ id: "n1", body: "Note", updatedAt: NOW - HOUR }],
    });
    const [card] = docCards();
    expect(card.tabIndex).toBe(0);
    expect(card.getAttribute("role")).toBe("button");
  });

  it.each([["Enter"], [" "]])("opens the note on %j", async (k) => {
    await loadPage({
      mock: createMockProofreader(),
      notes: [{ id: "n1", body: "Keyboard note", updatedAt: NOW - HOUR }],
    });

    const [card] = docCards();
    const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    card.dispatchEvent(e);
    await settle();

    expect(inEditor()).toBe(true);
    expect($("editor").value).toBe("Keyboard note");
    expect(e.defaultPrevented).toBe(true); // Space must not scroll the list
  });

  it("ignores Enter bubbling up from the '…' menu button", async () => {
    await loadPage({
      mock: createMockProofreader(),
      notes: [{ id: "n1", body: "Note", updatedAt: NOW - HOUR }],
    });

    const [card] = docCards();
    key(card.querySelector(".doc-card__menu-btn"), "Enter");
    await settle();

    // The card handler must not hijack the button's own activation.
    expect(inLibrary()).toBe(true);
  });
});

describe("two-step delete", () => {
  it("arms on the first click and deletes on the second, staying in the library", async () => {
    await loadPage({
      mock: createMockProofreader(),
      notes: [
        { id: "keep", body: "Keep me", updatedAt: NOW - HOUR },
        { id: "del", body: "Delete me", updatedAt: NOW - 2 * HOUR },
      ],
    });

    const target = docCards()[1]; // "Delete me"
    const [, del] = openCardMenu(target); // [Export, Delete]
    expect(del.textContent).toBe("Delete");

    del.click(); // first click — arms
    expect(del.textContent).toBe("Confirm delete");
    expect(docCards()).toHaveLength(2); // nothing deleted yet

    del.click(); // second click — confirms
    await settle();

    expect(inLibrary()).toBe(true);
    expect(docTitles()).toEqual(["Keep me"]);
    // Gone from storage too.
    const remaining = await globalThis.chrome.storage.local.get("noteIndex");
    expect(remaining.noteIndex.map((e) => e.id)).toEqual(["keep"]);
  });

  it("shows the empty state after deleting the last note", async () => {
    await loadPage({
      mock: createMockProofreader(),
      notes: [{ id: "only", body: "Lonely", updatedAt: NOW - HOUR }],
    });

    const [, del] = openCardMenu(docCards()[0]);
    del.click();
    del.click();
    await settle();

    expect(inLibrary()).toBe(true);
    expect(docCards()).toHaveLength(0);
    expect($("docEmpty").hidden).toBe(false);
    expect($("docEmpty").textContent).toContain("No notes yet");
  });
});
