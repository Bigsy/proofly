// Unit tests for lib/notes-store.js — the chrome.storage.local CRUD layer:
// the body-then-index / index-then-body write ordering that makes divergence
// benign, the deterministic sorted index, the derived index entries, the
// missing-chrome no-ops, and the invisible-orphan-body guarantee.

import { afterEach, describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  deleteNote,
  getNote,
  listIndex,
  listNotes,
  mergeNotes,
  newId,
  replaceAllNotes,
  saveNote,
} from "../lib/notes-store.js";

// A chrome.storage.local stub that records the order of mutating operations so
// the ordering invariants are directly assertable. Mirrors the harness stub's
// structuredClone-both-ways behaviour.
function installLocal(initial = {}) {
  const data = structuredClone(initial);
  const ops = [];
  const local = {
    get: async (key) => {
      if (key == null) return structuredClone(data);
      if (Array.isArray(key)) {
        const out = {};
        for (const k of key) if (k in data) out[k] = structuredClone(data[k]);
        return out;
      }
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    set: async (items) => {
      ops.push({ op: "set", keys: Object.keys(items) });
      Object.assign(data, structuredClone(items));
    },
    remove: async (keys) => {
      const arr = Array.isArray(keys) ? keys : [keys];
      ops.push({ op: "remove", keys: arr });
      for (const k of arr) delete data[k];
    },
  };
  globalThis.chrome = { storage: { local } };
  return { data, ops };
}

afterEach(() => { delete globalThis.chrome; });

describe("saveNote", () => {
  it("writes the body FIRST, then the index entry (+ schemaVersion)", async () => {
    const { data, ops } = installLocal();
    await saveNote({ id: "n1", body: "Hello\nworld" }, 1000);

    // Body write precedes the index write.
    expect(ops).toEqual([
      { op: "set", keys: ["note:n1"] },
      { op: "set", keys: ["noteIndex", "schemaVersion"] },
    ]);
    expect(data["note:n1"]).toEqual({
      id: "n1", body: "Hello\nworld", createdAt: 1000, updatedAt: 1000,
    });
    expect(data.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("derives title/snippet into the index entry and bumps updatedAt", async () => {
    installLocal();
    await saveNote({ id: "n1", body: "My title\nthe body text", createdAt: 500 }, 2000);

    const [entry] = await listIndex();
    expect(entry).toEqual({
      id: "n1", title: "My title", snippet: "the body text", updatedAt: 2000,
    });
    // createdAt is preserved; updatedAt is the passed `now`.
    expect((await getNote("n1")).createdAt).toBe(500);
  });

  it("upserts in place — re-saving the same id replaces, never duplicates", async () => {
    installLocal();
    await saveNote({ id: "n1", body: "first" }, 1000);
    await saveNote({ id: "n1", body: "second", createdAt: 1000 }, 3000);

    const index = await listIndex();
    expect(index).toHaveLength(1);
    expect(index[0].title).toBe("second");
    expect((await getNote("n1")).body).toBe("second");
  });
});

describe("deleteNote", () => {
  it("removes the index entry FIRST, then the body", async () => {
    const { ops } = installLocal();
    await saveNote({ id: "n1", body: "doomed" }, 1000);
    ops.length = 0; // ignore the save's writes

    await deleteNote("n1");
    expect(ops).toEqual([
      { op: "set", keys: ["noteIndex", "schemaVersion"] },
      { op: "remove", keys: ["note:n1"] },
    ]);
    expect(await listIndex()).toEqual([]);
    expect(await getNote("n1")).toBeNull();
  });
});

describe("replaceAllNotes", () => {
  it("writes every replacement body, then the index, then removes obsolete bodies", async () => {
    const { data, ops } = installLocal();
    await saveNote({ id: "old", body: "Old" }, 100);
    ops.length = 0;

    await replaceAllNotes([
      { id: "new", body: "New title\nNew body", createdAt: 20, updatedAt: 200 },
    ]);

    expect(ops).toEqual([
      { op: "set", keys: ["note:new"] },
      { op: "set", keys: ["noteIndex", "schemaVersion"] },
      { op: "remove", keys: ["note:old"] },
    ]);
    expect(data["note:old"]).toBeUndefined();
    expect(data["note:new"]).toMatchObject({ id: "new", body: "New title\nNew body", updatedAt: 200 });
    expect(data.noteIndex).toEqual([
      { id: "new", title: "New title", snippet: "New body", updatedAt: 200 },
    ]);
  });
});

describe("listIndex sort order", () => {
  it("returns updatedAt desc, then id desc", async () => {
    installLocal();
    await saveNote({ id: "aaa", body: "a" }, 100);
    await saveNote({ id: "ccc", body: "c" }, 200);
    await saveNote({ id: "bbb", body: "b" }, 100); // ties aaa on updatedAt

    expect((await listIndex()).map((e) => e.id)).toEqual(["ccc", "bbb", "aaa"]);
  });
});

describe("missing chrome (jsdom / non-extension context)", () => {
  it("no-ops without throwing", async () => {
    delete globalThis.chrome;
    expect(await listIndex()).toEqual([]);
    expect(await getNote("anything")).toBeNull();
    expect(await saveNote({ id: "x", body: "y" }, 1)).toBeNull();
    await expect(deleteNote("x")).resolves.toBeUndefined();
  });
});

describe("orphan body (failed/partial write)", () => {
  it("a note with no index entry is invisible to the library but still readable", async () => {
    // Seed a body key with NO matching index entry — the only divergence the
    // write ordering can leave. It must not surface as a card or throw.
    installLocal({ "note:ghost": { id: "ghost", body: "boo", createdAt: 1, updatedAt: 1 } });

    expect(await listIndex()).toEqual([]);    // no phantom card
    expect((await getNote("ghost")).body).toBe("boo"); // body itself is intact
  });

  it("skips malformed index entries without breaking the list", async () => {
    installLocal({
      noteIndex: [null, 42, { title: "no id" }, { id: "ok", title: "Keep", snippet: "", updatedAt: 5 }],
    });
    expect((await listIndex()).map((e) => e.id)).toEqual(["ok"]);
  });
});

describe("newId", () => {
  it("returns a distinct opaque string each call", () => {
    const a = newId();
    const b = newId();
    expect(typeof a).toBe("string");
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});

describe("listNotes", () => {
  it("returns full records in index order, ignoring orphan bodies", async () => {
    installLocal({
      noteIndex: [
        { id: "old", title: "Old", snippet: "", updatedAt: 1 },
        { id: "new", title: "New", snippet: "", updatedAt: 2 },
      ],
      "note:old": { id: "old", body: "Old", createdAt: 1, updatedAt: 1 },
      "note:new": { id: "new", body: "New", createdAt: 2, updatedAt: 2 },
      "note:ghost": { id: "ghost", body: "boo", createdAt: 0, updatedAt: 0 },
    });
    expect((await listNotes()).map((n) => n.id)).toEqual(["new", "old"]);
  });

  it("is empty without chrome.storage", async () => {
    expect(await listNotes()).toEqual([]);
  });
});

describe("mergeNotes", () => {
  it("keeps the notes' own timestamps, writes bodies before the single index rewrite", async () => {
    const { data, ops } = installLocal({
      noteIndex: [{ id: "keep", title: "Keep", snippet: "", updatedAt: 5 }],
      "note:keep": { id: "keep", body: "Keep", createdAt: 5, updatedAt: 5 },
    });
    await mergeNotes([
      { id: "a", body: "A title\nbody", createdAt: 10, updatedAt: 20 },
      { id: "keep", body: "Keep v2", createdAt: 5, updatedAt: 30 },
      { id: "bad" },                       // no updatedAt → dropped
      { id: "a", body: "dup", updatedAt: 99 }, // duplicate id → dropped
    ]);
    expect(ops.map((o) => o.keys.join(","))).toEqual(["note:a", "note:keep", "noteIndex,schemaVersion"]);
    expect(data["note:a"]).toEqual({ id: "a", body: "A title\nbody", createdAt: 10, updatedAt: 20 });
    expect(data["note:keep"].updatedAt).toBe(30);
    expect((await listIndex()).map((e) => [e.id, e.title, e.updatedAt]))
      .toEqual([["keep", "Keep v2", 30], ["a", "A title", 20]]);
  });

  it("is a no-op for an empty batch", async () => {
    const { ops } = installLocal();
    expect(await mergeNotes([])).toEqual([]);
    expect(ops).toEqual([]);
  });
});
