// Library extras: search filtering (title + snippet, grouping bypassed), the
// per-card "…" menu dismissal (outside click / Escape), and the .txt export
// (filename derivation + Blob contents).

import { describe, expect, it } from "vitest";
import { createMockProofreader } from "./helpers/mock-proofreader.js";
import {
  $,
  NOW,
  docCards,
  docTitles,
  groupHeadings,
  lastDownloadedFile,
  loadPage,
  openCardMenu,
  settle,
  tick,
} from "./helpers/page.js";

const HOUR = 60 * 60 * 1000;

const NOTES = [
  { id: "a", body: "Shopping list\nmilk, eggs, bread", updatedAt: NOW - HOUR },
  { id: "b", body: "Meeting notes\nplan the Q3 launch", updatedAt: NOW - 2 * HOUR },
  { id: "c", body: "Recipe\nwhisk eggs and flour", updatedAt: NOW - 3 * HOUR },
];

function search(text) {
  $("docSearch").value = text;
  $("docSearch").dispatchEvent(new Event("input", { bubbles: true }));
}

describe("search", () => {
  it("filters by title and snippet, case-insensitively", async () => {
    await loadPage({ mock: createMockProofreader(), notes: NOTES });

    search("EGGS"); // appears in two snippets
    expect(docTitles().sort()).toEqual(["Recipe", "Shopping list"]);

    search("meeting"); // title match
    expect(docTitles()).toEqual(["Meeting notes"]);
  });

  it("bypasses grouping while searching (flat, recency-sorted list)", async () => {
    await loadPage({ mock: createMockProofreader(), notes: NOTES });
    expect(groupHeadings()).toEqual(["Today"]); // grouped before searching

    search("e"); // matches all three
    expect(groupHeadings()).toEqual([]); // no headings while searching
    expect(docTitles()).toEqual(["Shopping list", "Meeting notes", "Recipe"]); // recency
  });

  it("shows a 'no match' empty state, and clearing the query restores the list", async () => {
    await loadPage({ mock: createMockProofreader(), notes: NOTES });

    search("zzzz");
    expect(docCards()).toHaveLength(0);
    expect($("docEmpty").hidden).toBe(false);
    expect($("docEmpty").textContent).toContain("No notes match");

    search("");
    expect($("docEmpty").hidden).toBe(true);
    expect(docCards()).toHaveLength(3);
  });
});

describe("the '…' menu dismissal", () => {
  it("closes on an outside click", async () => {
    await loadPage({ mock: createMockProofreader(), notes: [NOTES[0]] });
    const card = docCards()[0];

    openCardMenu(card);
    expect(card.querySelector(".doc-menu")).not.toBeNull();

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(card.querySelector(".doc-menu")).toBeNull();
  });

  it("closes on Escape, and reopening resets an armed delete", async () => {
    await loadPage({ mock: createMockProofreader(), notes: [NOTES[0]] });
    const card = docCards()[0];

    const [, del] = openCardMenu(card);
    del.click(); // arm the delete
    expect(del.textContent).toBe("Confirm delete");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(card.querySelector(".doc-menu")).toBeNull();

    // Reopening builds a fresh menu — the delete is back to its first step.
    const [, del2] = openCardMenu(card);
    expect(del2.textContent).toBe("Delete");
    expect(docCards()).toHaveLength(1); // nothing was deleted
  });
});

describe("export", () => {
  it("downloads the body as <title>.txt", async () => {
    await loadPage({ mock: createMockProofreader(), notes: [NOTES[0]] });

    const [exportBtn] = openCardMenu(docCards()[0]);
    expect(exportBtn.textContent).toBe("Export");
    exportBtn.click();
    await settle();
    await tick(10); // let the FileReader (in the harness's download stub) fire

    const file = lastDownloadedFile();
    expect(file.filename).toBe("Shopping list.txt");
    expect(await file.text()).toBe("Shopping list\nmilk, eggs, bread");
  });

  it("falls back to 'Untitled note.txt' when the title sanitizes to empty", async () => {
    await loadPage({
      mock: createMockProofreader(),
      notes: [{ id: "x", body: "///\nbody after a slashes-only title", updatedAt: NOW - HOUR }],
    });

    openCardMenu(docCards()[0])[0].click(); // Export
    await settle();
    await tick(10);

    const file = lastDownloadedFile();
    expect(file.filename).toBe("Untitled note.txt");
    expect(await file.text()).toBe("///\nbody after a slashes-only title");
  });
});
