// lib/notes-transfer.js — the "export all / import" bundle for the notes
// library: a single JSON file carrying every note with its timestamps, so a
// round trip (export → import on another browser) reproduces the library
// exactly, and re-importing the same file is a no-op.
//
// Pure module (no DOM, no chrome): serialize/parse the format, and plan the
// merge against the current index. Persistence is lib/notes-store.js's
// mergeNotes; the options-page wiring is ui/documents-page.js.
//
// Bundle shape:
//   { format: "proofly-notes", version: 1, exportedAt,
//     notes: [{ id, body, createdAt, updatedAt }] }

export const BUNDLE_FORMAT = "proofly-notes";
export const BUNDLE_VERSION = 1;

// Download filename: "proofly-notes-2026-08-26.json" (local date).
export function bundleFilename(now = Date.now()) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, "0");
  return `proofly-notes-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
}

// Full note records → the bundle as a JSON string. Malformed records (no id)
// are dropped rather than written, so an export never produces an unimportable
// file. Order is by id so the output is byte-stable for the same library.
export function serializeBundle(notes, now = Date.now()) {
  const out = [];
  for (const n of notes ?? []) {
    if (!n || typeof n.id !== "string" || !n.id) continue;
    const updatedAt = Number.isFinite(n.updatedAt) ? n.updatedAt : now;
    out.push({
      id: n.id,
      body: typeof n.body === "string" ? n.body : "",
      createdAt: Number.isFinite(n.createdAt) ? n.createdAt : updatedAt,
      updatedAt,
    });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify({ format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exportedAt: now, notes: out }, null, 2);
}

// Bundle text → { notes, skipped }. Throws a user-facing Error when the file
// isn't a Proofly notes bundle at all; individual malformed entries are
// counted in `skipped` rather than failing the whole import. Duplicate ids
// within one file keep the most recently updated copy.
export function parseBundle(text) {
  let data;
  try {
    data = JSON.parse(String(text ?? ""));
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  if (!data || typeof data !== "object" || data.format !== BUNDLE_FORMAT) {
    throw new Error("That file isn't a Proofly notes export.");
  }
  if (!Number.isInteger(data.version) || data.version > BUNDLE_VERSION) {
    throw new Error("That export was made by a newer version of Proofly.");
  }
  if (!Array.isArray(data.notes)) throw new Error("That export contains no notes list.");

  const byId = new Map();
  let skipped = 0;
  for (const n of data.notes) {
    const updatedAt = Number(n?.updatedAt);
    if (!n || typeof n !== "object" || typeof n.id !== "string" || !n.id
      || typeof n.body !== "string" || !Number.isFinite(updatedAt)) {
      skipped += 1;
      continue;
    }
    const createdAt = Number(n.createdAt);
    const note = {
      id: n.id,
      body: n.body,
      createdAt: Number.isFinite(createdAt) ? createdAt : updatedAt,
      updatedAt,
    };
    const prev = byId.get(note.id);
    if (!prev || prev.updatedAt < note.updatedAt) byId.set(note.id, note);
  }
  return { notes: [...byId.values()], skipped };
}

// Decide what an import does to the current library, without touching it.
// Import is additive, last-write-wins per note:
//   added    — ids not in the local index
//   updated  — ids present locally whose incoming updatedAt is strictly newer
//   unchanged — everything else (older or identical), left alone
// `index` is the local index (needs only id + updatedAt per entry).
export function planImport(incoming, index) {
  const local = new Map((index ?? []).map((e) => [e.id, e.updatedAt]));
  const added = [];
  const updated = [];
  let unchanged = 0;
  for (const note of incoming ?? []) {
    if (!local.has(note.id)) added.push(note);
    else if (note.updatedAt > local.get(note.id)) updated.push(note);
    else unchanged += 1;
  }
  return { added, updated, unchanged, toWrite: [...added, ...updated] };
}

// "Imported 3 notes (2 new, 1 updated), 4 already up to date, 1 skipped."
export function describeImport({ added, updated, unchanged }, skipped = 0) {
  const count = added.length + updated.length;
  const parts = [];
  if (count) {
    const detail = [];
    if (added.length) detail.push(`${added.length} new`);
    if (updated.length) detail.push(`${updated.length} updated`);
    parts.push(`Imported ${count} note${count === 1 ? "" : "s"} (${detail.join(", ")})`);
  } else {
    parts.push("Nothing to import");
  }
  if (unchanged) parts.push(`${unchanged} already up to date`);
  if (skipped) parts.push(`${skipped} skipped (invalid)`);
  return `${parts.join(", ")}.`;
}
