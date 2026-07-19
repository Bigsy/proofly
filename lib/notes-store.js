// lib/notes-store.js — persistence for the notes library, a thin async wrapper
// over chrome.storage.local. Guards a missing API the same way rewrite.js's
// promptStore() does (returns empty / no-ops when chrome.storage is absent), so
// jsdom and non-extension contexts don't throw.
//
// Storage shape (one key per note keeps frequent auto-saves cheap — saving
// rewrites one body, not a giant array):
//   "note:<id>"     -> { id, body, createdAt, updatedAt }   (the full record)
//   "noteIndex"     -> [{ id, title, snippet, updatedAt }]  (lightweight cards)
//   "schemaVersion" -> number                               (migration hook)
//
// title/snippet are DERIVED from the body at save time (see lib/notes.js) and
// denormalised into the index so the library renders without loading any body.

import { compareByRecency, deriveSnippet, deriveTitle } from "./notes.js";

const INDEX_KEY = "noteIndex";
const SCHEMA_KEY = "schemaVersion";
export const SCHEMA_VERSION = 1;

const noteKey = (id) => `note:${id}`;

// chrome.storage.local, or null in jsdom / a non-extension page.
const store = () => globalThis.chrome?.storage?.local ?? null;

// Opaque, never-parsed note id. UUIDs sort arbitrarily but stably (the index
// tie-breaks on id), so equal-timestamp notes never flap. crypto.randomUUID is
// present in the extension and modern test runtimes; the fallback keeps a
// non-extension context from throwing.
export function newId() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function validEntry(e) {
  return !!e && typeof e === "object" && typeof e.id === "string" && !!e.id;
}

// Raw index array (unsorted, unfiltered), or [] on any miss / failure.
async function readIndex(s) {
  try {
    const data = await s.get(INDEX_KEY);
    const list = data?.[INDEX_KEY];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// The library's view of the world: index entries, sorted (updatedAt desc, then
// id desc). Simple and deterministic — no reconciliation/self-heal. Divergence
// is made structurally benign by the write ordering in saveNote/deleteNote: the
// only thing a failed write can leave is an orphan body with no index entry,
// which is invisible here (and harmless). An index entry pointing at a missing
// body is impossible by construction.
export async function listIndex() {
  const s = store();
  if (!s) return [];
  return (await readIndex(s)).filter(validEntry).slice().sort(compareByRecency);
}

// The full record for an open note, or null if absent.
export async function getNote(id) {
  const s = store();
  if (!s) return null;
  try {
    const data = await s.get(noteKey(id));
    const note = data?.[noteKey(id)];
    return note && typeof note === "object" ? note : null;
  } catch {
    return null;
  }
}

// Upsert a note: re-derive title/snippet, stamp updatedAt (= `now`, injected so
// callers stay deterministic), and write the body FIRST, then the index entry.
// That order means a half-completed save can only orphan a body (invisible),
// never produce a card that opens to nothing. Returns the saved record, or null
// when storage is absent.
export async function saveNote(note, now = Date.now()) {
  const s = store();
  if (!s) return null;
  const { id } = note;
  const body = typeof note.body === "string" ? note.body : "";
  const createdAt = Number.isFinite(note.createdAt) ? note.createdAt : now;
  const record = { id, body, createdAt, updatedAt: now };

  await s.set({ [noteKey(id)]: record });

  const entry = { id, title: deriveTitle(body), snippet: deriveSnippet(body), updatedAt: now };
  const index = (await readIndex(s)).filter((e) => validEntry(e) && e.id !== id);
  index.push(entry);
  await s.set({ [INDEX_KEY]: index, [SCHEMA_KEY]: SCHEMA_VERSION });

  return record;
}

// Delete a note: remove the index entry FIRST, then the body — the mirror of
// saveNote's ordering, so a half-completed delete also only ever orphans a body.
export async function deleteNote(id) {
  const s = store();
  if (!s) return;
  const index = (await readIndex(s)).filter((e) => validEntry(e) && e.id !== id);
  await s.set({ [INDEX_KEY]: index, [SCHEMA_KEY]: SCHEMA_VERSION });
  await s.remove(noteKey(id));
}

// Replace the visible library as one recovery operation. Every incoming body
// lands before the authoritative index, and obsolete bodies are removed only
// after that index is safe. A failure therefore still has the same benign
// shape as ordinary saves/deletes: at worst there are invisible orphan bodies,
// never cards that open to a missing note.
export async function replaceAllNotes(notes) {
  const s = store();
  if (!s) return [];

  const records = [];
  const seen = new Set();
  for (const note of notes ?? []) {
    if (!note || typeof note.id !== "string" || !note.id || seen.has(note.id)) continue;
    const updatedAt = Number(note.updatedAt);
    if (!Number.isFinite(updatedAt)) continue;
    const body = typeof note.body === "string" ? note.body : "";
    records.push({
      id: note.id,
      body,
      createdAt: Number.isFinite(note.createdAt) ? note.createdAt : updatedAt,
      updatedAt,
    });
    seen.add(note.id);
  }

  for (const record of records) await s.set({ [noteKey(record.id)]: record });

  const index = records.map((record) => ({
    id: record.id,
    title: deriveTitle(record.body),
    snippet: deriveSnippet(record.body),
    updatedAt: record.updatedAt,
  }));
  await s.set({ [INDEX_KEY]: index, [SCHEMA_KEY]: SCHEMA_VERSION });

  const previous = await s.get(null);
  const obsolete = Object.keys(previous ?? {})
    .filter((key) => key.startsWith("note:") && !seen.has(key.slice("note:".length)));
  if (obsolete.length) await s.remove(obsolete);
  return records;
}
