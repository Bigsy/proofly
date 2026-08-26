// lib/notes-transfer.js — the export-all / import bundle: serialization is
// stable and drops junk, parsing rejects foreign files but tolerates bad
// entries, and the merge plan is additive + last-write-wins per note.

import { describe, expect, it } from "vitest";
import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  bundleFilename,
  describeImport,
  parseBundle,
  planImport,
  serializeBundle,
} from "../lib/notes-transfer.js";

const NOW = Date.UTC(2026, 7, 26, 12);

describe("serializeBundle", () => {
  it("emits the envelope with notes sorted by id and defaults filled", () => {
    const json = serializeBundle([
      { id: "b", body: "second", createdAt: 1, updatedAt: 2 },
      { id: "a", body: "first", updatedAt: 5 },
      { id: "", body: "junk" },
      null,
    ], NOW);
    const data = JSON.parse(json);
    expect(data.format).toBe(BUNDLE_FORMAT);
    expect(data.version).toBe(BUNDLE_VERSION);
    expect(data.exportedAt).toBe(NOW);
    expect(data.notes).toEqual([
      { id: "a", body: "first", createdAt: 5, updatedAt: 5 },
      { id: "b", body: "second", createdAt: 1, updatedAt: 2 },
    ]);
  });

  it("round-trips through parseBundle", () => {
    const notes = [{ id: "x", body: "Hello\nworld", createdAt: 10, updatedAt: 20 }];
    expect(parseBundle(serializeBundle(notes, NOW))).toEqual({ notes, skipped: 0 });
  });
});

describe("parseBundle", () => {
  it("rejects non-JSON and non-Proofly files with user-facing messages", () => {
    expect(() => parseBundle("not json")).toThrow(/valid JSON/);
    expect(() => parseBundle('{"words":["a"]}')).toThrow(/isn't a Proofly notes export/);
    expect(() => parseBundle(JSON.stringify({ format: BUNDLE_FORMAT, version: 99, notes: [] })))
      .toThrow(/newer version/);
    expect(() => parseBundle(JSON.stringify({ format: BUNDLE_FORMAT, version: 1 })))
      .toThrow(/no notes list/);
  });

  it("skips malformed entries and keeps the newest of duplicate ids", () => {
    const { notes, skipped } = parseBundle(JSON.stringify({
      format: BUNDLE_FORMAT,
      version: 1,
      notes: [
        { id: "a", body: "old", updatedAt: 1 },
        { id: "a", body: "new", updatedAt: 3 },
        { id: "b", body: 42, updatedAt: 1 },     // body not a string
        { id: "c", body: "x" },                  // no updatedAt
        "garbage",
      ],
    }));
    expect(notes).toEqual([{ id: "a", body: "new", createdAt: 3, updatedAt: 3 }]);
    expect(skipped).toBe(3);
  });
});

describe("planImport", () => {
  const index = [{ id: "same", updatedAt: 10 }, { id: "older", updatedAt: 10 }, { id: "newer", updatedAt: 10 }];

  it("adds unknown ids, updates strictly-newer ones, leaves the rest", () => {
    const plan = planImport([
      { id: "fresh", updatedAt: 1 },
      { id: "same", updatedAt: 10 },
      { id: "older", updatedAt: 5 },
      { id: "newer", updatedAt: 11 },
    ], index);
    expect(plan.added.map((n) => n.id)).toEqual(["fresh"]);
    expect(plan.updated.map((n) => n.id)).toEqual(["newer"]);
    expect(plan.unchanged).toBe(2);
    expect(plan.toWrite.map((n) => n.id)).toEqual(["fresh", "newer"]);
  });

  it("describes the outcome for the status line", () => {
    expect(describeImport({ added: [1, 2], updated: [3], unchanged: 4 }, 1))
      .toBe("Imported 3 notes (2 new, 1 updated), 4 already up to date, 1 skipped (invalid).");
    expect(describeImport({ added: [1], updated: [], unchanged: 0 })).toBe("Imported 1 note (1 new).");
    expect(describeImport({ added: [], updated: [], unchanged: 2 })).toBe("Nothing to import, 2 already up to date.");
  });
});

describe("bundleFilename", () => {
  it("stamps the local date", () => {
    const d = new Date(2026, 0, 5);
    expect(bundleFilename(d.getTime())).toBe("proofly-notes-2026-01-05.json");
  });
});
