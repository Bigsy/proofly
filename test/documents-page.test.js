// ui/documents-page.js with a stub store against the real options.html DOM:
// the count line, Export all producing the bundle download, and Import
// merging additively with the right status (incl. the GitHub-sync tail).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { initDocumentsPage } from "../ui/documents-page.js";
import { BUNDLE_FORMAT } from "../lib/notes-transfer.js";
import optionsSource from "../options/options.html?raw";

const innerHtml = optionsSource
  .replace(/<script type="module" src="options\.js"><\/script>/, "")
  .match(/<html[^>]*>([\s\S]*)<\/html>/)[1];

const $ = (id) => document.getElementById(id);
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function makeStubStore(initial = []) {
  const notes = new Map(initial.map((n) => [n.id, n]));
  return {
    notes,
    listIndex: vi.fn(async () => [...notes.values()].map(({ id, updatedAt }) => ({ id, updatedAt }))),
    listNotes: vi.fn(async () => [...notes.values()]),
    mergeNotes: vi.fn(async (list) => { for (const n of list) notes.set(n.id, n); return list; }),
  };
}

let lastDownload = null;
function installDownloadStub() {
  lastDownload = null;
  let lastBlob = null;
  URL.createObjectURL = vi.fn((blob) => { lastBlob = blob; return "blob:mock"; });
  URL.revokeObjectURL = vi.fn();
  HTMLAnchorElement.prototype.click = vi.fn(function click() {
    if (!this.download) return;
    const text = new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.readAsText(lastBlob);
    });
    lastDownload = { filename: this.download, text: () => text };
  });
}

async function load(initial, extra = {}) {
  document.documentElement.innerHTML = innerHtml;
  installDownloadStub();
  const store = makeStubStore(initial);
  const page = initDocumentsPage({
    els: {
      count: $("docsCount"),
      importFile: $("docsImportFile"),
      importBtn: $("importDocsBtn"),
      exportBtn: $("exportDocsBtn"),
      status: $("docsTransferStatus"),
    },
    store,
    now: () => new Date(2026, 7, 26).getTime(),
    ...extra,
  });
  await page.ready;
  return store;
}

async function importFile(name, text) {
  Object.defineProperty($("docsImportFile"), "files", {
    configurable: true,
    value: [{ name, text: vi.fn(async () => text) }],
  });
  $("docsImportFile").dispatchEvent(new Event("change"));
  await settle();
}

const bundle = (notes) => JSON.stringify({ format: BUNDLE_FORMAT, version: 1, notes });

beforeEach(() => { document.documentElement.innerHTML = ""; });

describe("documents card", () => {
  it("shows the count and disables Export all when there is nothing to export", async () => {
    await load([]);
    expect($("docsCount").textContent).toBe("0 notes on this browser");
    expect($("exportDocsBtn").disabled).toBe(true);
  });

  it("exports every note as one dated JSON bundle", async () => {
    await load([
      { id: "a", body: "Alpha\none", createdAt: 1, updatedAt: 2 },
      { id: "b", body: "Beta", createdAt: 3, updatedAt: 4 },
    ]);
    expect($("docsCount").textContent).toBe("2 notes on this browser");
    $("exportDocsBtn").click();
    await settle();
    expect(lastDownload.filename).toBe("proofly-notes-2026-08-26.json");
    const data = JSON.parse(await lastDownload.text());
    expect(data.format).toBe(BUNDLE_FORMAT);
    expect(data.notes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(data.notes[0].body).toBe("Alpha\none");
    expect($("docsTransferStatus").textContent).toBe("Exported 2 notes.");
  });

  it("imports additively: new notes added, newer copies win, older ones ignored", async () => {
    const store = await load([
      { id: "keep", body: "local newer", createdAt: 1, updatedAt: 50 },
      { id: "bump", body: "local older", createdAt: 1, updatedAt: 10 },
    ]);
    await importFile("notes.json", bundle([
      { id: "keep", body: "remote older", updatedAt: 40 },
      { id: "bump", body: "remote newer", updatedAt: 20 },
      { id: "new", body: "brand new", updatedAt: 5 },
    ]));
    expect(store.mergeNotes).toHaveBeenCalledTimes(1);
    expect(store.mergeNotes.mock.calls[0][0].map((n) => n.id)).toEqual(["new", "bump"]);
    expect(store.notes.get("keep").body).toBe("local newer");
    expect(store.notes.get("bump").body).toBe("remote newer");
    expect($("docsCount").textContent).toBe("3 notes on this browser");
    expect($("docsTransferStatus").textContent)
      .toBe("Imported 2 notes (1 new, 1 updated), 1 already up to date.");
    expect($("importDocsBtn").disabled).toBe(false);
  });

  it("reports a non-Proofly file as an error without writing", async () => {
    const store = await load([]);
    await importFile("words.txt", "alpha\nbeta");
    expect(store.mergeNotes).not.toHaveBeenCalled();
    expect($("docsTransferStatus").textContent).toMatch(/^Couldn't import: .*valid JSON/);
    expect($("docsTransferStatus").classList.contains("error")).toBe(true);
  });

  it("re-importing the same export is a no-op and skips sync", async () => {
    const sync = vi.fn(async () => true);
    const store = await load([{ id: "a", body: "x", createdAt: 1, updatedAt: 2 }], { sync });
    await importFile("notes.json", bundle([{ id: "a", body: "x", createdAt: 1, updatedAt: 2 }]));
    expect(store.mergeNotes).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    expect($("docsTransferStatus").textContent).toBe("Nothing to import, 1 already up to date.");
  });

  it("syncs with GitHub after a real import and reports a sync failure as such", async () => {
    const sync = vi.fn(async () => true);
    await load([], { sync });
    await importFile("notes.json", bundle([{ id: "a", body: "x", updatedAt: 2 }]));
    expect(sync).toHaveBeenCalledTimes(1);
    expect($("docsTransferStatus").textContent).toBe("Imported 1 note (1 new). Synced with GitHub.");

    sync.mockRejectedValueOnce(new Error("offline"));
    await importFile("notes.json", bundle([{ id: "b", body: "y", updatedAt: 2 }]));
    expect($("docsTransferStatus").textContent)
      .toBe("Imported 1 note (1 new). Saved here, but GitHub sync failed: offline");
    expect($("docsTransferStatus").classList.contains("error")).toBe(true);
  });
});
