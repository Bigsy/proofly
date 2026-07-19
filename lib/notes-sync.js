// lib/notes-sync.js — GitHub-backed notes sync.
// The merge core is pure; runSync wires it to notes-store, sync settings, and
// the Contents API.

import {
  deleteNote, getNote, listIndex, newId, replaceAllNotes, saveNote,
} from "./notes-store.js";
import { GitHubContentClient } from "./github-content.js";
import { deriveSnippet, deriveTitle } from "./notes.js";
import { loadSyncSettings } from "./sync-settings.js";

export const SYNC_STATE_KEY = "syncState";
export const SYNC_RECOVERY_BACKUP_KEY = "notesSyncRecoveryBackup";
export const SYNC_RECOVERY_LOCK_KEY = "notesSyncRecoveryLock";
export const REMOTE_SCHEMA_VERSION = 1;
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RECOVERY_LOCK_TTL_MS = 5 * 60 * 1000;

const notePath = (id) => `notes/${encodeURIComponent(id)}.json`;
const localStore = () => globalThis.chrome?.storage?.local ?? null;

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id) return null;
  const updatedAt = Number(entry.updatedAt);
  if (!Number.isFinite(updatedAt)) return null;
  if (entry.deleted) return { id: entry.id, deleted: true, updatedAt };
  return {
    id: entry.id,
    title: typeof entry.title === "string" ? entry.title : "",
    snippet: typeof entry.snippet === "string" ? entry.snippet : "",
    updatedAt,
  };
}

export function parseRemoteIndex(value) {
  const list = Array.isArray(value) ? value : value?.notes;
  if (!Array.isArray(list)) return [];
  return list.map(normalizeEntry).filter(Boolean);
}

export function serializeRemoteIndex(entries) {
  return JSON.stringify({
    schemaVersion: REMOTE_SCHEMA_VERSION,
    notes: entries.map(normalizeEntry).filter(Boolean),
  }, null, 2);
}

export function normalizeSyncState(value) {
  const synced = {};
  for (const [id, meta] of Object.entries(value?.synced ?? {})) {
    const updatedAt = Number(meta?.updatedAt);
    if (!id || !Number.isFinite(updatedAt)) continue;
    synced[id] = { updatedAt, ...(typeof meta.sha === "string" ? { sha: meta.sha } : {}) };
  }
  const tombstones = {};
  for (const [id, ts] of Object.entries(value?.tombstones ?? {})) {
    const deletedAt = Number(ts);
    if (id && Number.isFinite(deletedAt)) tombstones[id] = deletedAt;
  }
  return {
    synced,
    tombstones,
    ...(typeof value?.indexSha === "string" ? { indexSha: value.indexSha } : {}),
    ...(Number.isFinite(value?.lastSyncAt) ? { lastSyncAt: value.lastSyncAt } : {}),
  };
}

export async function loadSyncState() {
  const s = localStore();
  if (!s) return normalizeSyncState();
  try {
    const data = await s.get(SYNC_STATE_KEY);
    return normalizeSyncState(data?.[SYNC_STATE_KEY]);
  } catch {
    return normalizeSyncState();
  }
}

export async function saveSyncState(state) {
  const s = localStore();
  if (!s) return normalizeSyncState(state);
  const normalized = normalizeSyncState(state);
  await s.set({ [SYNC_STATE_KEY]: normalized });
  return normalized;
}

export async function recordTombstone(id, deletedAt = Date.now()) {
  if (!id) return null;
  const state = await loadSyncState();
  state.tombstones[id] = deletedAt;
  await saveSyncState(state);
  return state;
}

export async function loadRecoveryBackup() {
  const data = await localStore()?.get(SYNC_RECOVERY_BACKUP_KEY);
  const backup = data?.[SYNC_RECOVERY_BACKUP_KEY];
  return backup && typeof backup === "object" ? backup : null;
}

async function saveRecoveryBackup(backup) {
  const s = localStore();
  if (!s) throw new Error("Local storage is unavailable; recovery was not started");
  await s.set({ [SYNC_RECOVERY_BACKUP_KEY]: backup });
  return backup;
}

async function recoveryLocked() {
  const s = localStore();
  if (!s) return false;
  const data = await s.get(SYNC_RECOVERY_LOCK_KEY);
  const lock = data?.[SYNC_RECOVERY_LOCK_KEY];
  if (!lock || !Number.isFinite(lock.expiresAt)) return false;
  if (lock.expiresAt > Date.now()) return true;
  await s.remove(SYNC_RECOVERY_LOCK_KEY);
  return false;
}

async function withRecoveryLock(work) {
  const s = localStore();
  const id = globalThis.crypto?.randomUUID?.() ?? `recovery-${Date.now()}-${Math.random()}`;
  if (s) {
    await s.set({
      [SYNC_RECOVERY_LOCK_KEY]: { id, expiresAt: Date.now() + RECOVERY_LOCK_TTL_MS },
    });
  }
  try {
    return await work();
  } finally {
    if (s) {
      const current = await s.get(SYNC_RECOVERY_LOCK_KEY);
      if (current?.[SYNC_RECOVERY_LOCK_KEY]?.id === id) await s.remove(SYNC_RECOVERY_LOCK_KEY);
    }
  }
}

function byId(entries) {
  const map = new Map();
  for (const entry of entries ?? []) {
    const normalized = normalizeEntry(entry);
    if (normalized) map.set(normalized.id, normalized);
  }
  return map;
}

function moved(entry, base) {
  if (!entry) return false;
  if (!base) return true;
  return entry.updatedAt > base.updatedAt;
}

function newer(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  if (a.deleted && !b.deleted) return a;
  return a;
}

function prunedTombstones(tombstones, now) {
  const out = {};
  for (const [id, ts] of Object.entries(tombstones ?? {})) {
    if (now - ts <= TOMBSTONE_TTL_MS) out[id] = ts;
  }
  return out;
}

export function planSync(localIndex, localTombstones, syncState, remoteIndex, options = {}) {
  const now = options.now ?? Date.now();
  const local = byId(localIndex);
  const remote = byId(parseRemoteIndex(remoteIndex));
  const bases = normalizeSyncState(syncState).synced;
  const tombstones = prunedTombstones(localTombstones ?? {}, now);

  const pulls = [];
  const pushes = [];
  const localDeletes = [];
  const remoteDeletes = [];
  const conflicts = []; // both sides moved: { id, winner: "local"|"remote" }
  const merged = new Map();
  const ids = new Set([...local.keys(), ...remote.keys(), ...Object.keys(tombstones), ...Object.keys(bases)]);

  for (const id of ids) {
    const l = local.get(id) ?? null;
    const r = remote.get(id) ?? null;
    const localDel = tombstones[id] ? { id, deleted: true, updatedAt: tombstones[id] } : null;
    const base = bases[id] ?? null;
    const localState = newer(l, localDel);
    const remoteState = r;

    if (localState?.deleted && (!remoteState || localState.updatedAt >= remoteState.updatedAt)) {
      remoteDeletes.push({ id, updatedAt: localState.updatedAt });
      merged.set(id, localState);
      continue;
    }

    if (remoteState?.deleted && (!localState || remoteState.updatedAt >= localState.updatedAt)) {
      if (l) localDeletes.push({ id, updatedAt: remoteState.updatedAt });
      merged.set(id, remoteState);
      continue;
    }

    if (l && !r) {
      pushes.push(l);
      merged.set(id, l);
      continue;
    }
    if (!l && r && !r.deleted) {
      pulls.push(r);
      merged.set(id, r);
      continue;
    }
    if (!l && !r) continue;

    const localMoved = moved(l, base);
    const remoteMoved = moved(r, base);
    if (localMoved && !remoteMoved) {
      pushes.push(l);
      merged.set(id, l);
    } else if (remoteMoved && !localMoved) {
      pulls.push(r);
      merged.set(id, r);
    } else if (localMoved && remoteMoved) {
      // Newer updatedAt wins the id; the loser is NOT silently dropped —
      // runSync preserves its body as a "(conflict)" copy (cheap insurance
      // against real data loss when two devices edited the same note).
      if (l.updatedAt >= r.updatedAt) {
        pushes.push(l);
        merged.set(id, l);
        conflicts.push({ id, winner: "local" });
      } else {
        pulls.push(r);
        merged.set(id, r);
        conflicts.push({ id, winner: "remote" });
      }
    } else {
      merged.set(id, l ?? r);
    }
  }

  const newIndex = [...merged.values()]
    .filter((e) => !e.deleted || now - e.updatedAt <= TOMBSTONE_TTL_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

  const newSyncState = normalizeSyncState(syncState);
  newSyncState.tombstones = tombstones;
  return { pulls, pushes, localDeletes, remoteDeletes, conflicts, newIndex, newSyncState };
}

function indexFromText(text) {
  if (!text) return [];
  try { return parseRemoteIndex(JSON.parse(text)); } catch { return []; }
}

function activeEntries(entries) {
  return parseRemoteIndex(entries).filter((entry) => !entry.deleted);
}

async function localSnapshot(deps = {}) {
  const index = await (deps.listIndex ?? listIndex)();
  const notes = [];
  for (const entry of index) {
    const note = await (deps.getNote ?? getNote)(entry.id);
    if (note) notes.push(note);
  }
  return { index, notes };
}

async function remoteSnapshot(client, remoteFile) {
  const indexFile = remoteFile === undefined ? await client.getFile("index.json") : remoteFile;
  const index = indexFromText(indexFile?.content);
  const notes = [];
  for (const entry of activeEntries(index)) {
    const file = await client.getFile(notePath(entry.id));
    if (!file) throw new Error(`GitHub is missing the note body for ${entry.id}`);
    let note;
    try { note = JSON.parse(file.content); } catch { throw new Error(`GitHub note ${entry.id} is not valid JSON`); }
    if (!note || note.id !== entry.id || typeof note.body !== "string" || !Number.isFinite(note.updatedAt)) {
      throw new Error(`GitHub note ${entry.id} has an invalid shape`);
    }
    notes.push({ note, sha: file.sha });
  }
  return { indexFile, index, notes };
}

function recoveryCounts(localIndex, remoteIndex) {
  const local = byId(localIndex);
  const remote = byId(activeEntries(remoteIndex));
  const localOnly = [...local.keys()].filter((id) => !remote.has(id));
  const remoteOnly = [...remote.keys()].filter((id) => !local.has(id));
  const changed = [...local.keys()].filter((id) => {
    const other = remote.get(id);
    return other && other.updatedAt !== local.get(id).updatedAt;
  });
  return {
    localCount: local.size,
    remoteCount: remote.size,
    localOnly: localOnly.length,
    remoteOnly: remoteOnly.length,
    changed: changed.length,
  };
}

export async function inspectSyncRecovery(deps = {}) {
  const settings = deps.settings ?? await (deps.loadSettings ?? loadSyncSettings)();
  if (!settings) return { skipped: true, reason: "not-configured" };
  const client = deps.client ?? new GitHubContentClient({ ...settings, fetchImpl: deps.fetchImpl });
  const localIndex = await (deps.listIndex ?? listIndex)();
  const remoteFile = await client.getFile("index.json");
  return {
    ...recoveryCounts(localIndex, indexFromText(remoteFile?.content)),
    owner: settings.owner,
    repo: settings.repo,
    branch: settings.branch || "main",
  };
}

function makeRemoteIndex(plan) {
  return parseRemoteIndex(plan.newIndex)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

let inFlight = null;

export async function runSync(deps = {}) {
  if (inFlight) return inFlight;
  inFlight = runSyncOnce(deps).finally(() => { inFlight = null; });
  return inFlight;
}

async function replaceLocalFromRemote(deps, remote, nowTs) {
  const records = remote.notes.map(({ note }) => note);
  await (deps.replaceAllNotes ?? replaceAllNotes)(records);
  const synced = {};
  for (const { note, sha } of remote.notes) {
    synced[note.id] = { updatedAt: note.updatedAt, sha };
  }
  await (deps.saveState ?? saveSyncState)({
    synced,
    tombstones: {},
    ...(remote.indexFile?.sha ? { indexSha: remote.indexFile.sha } : {}),
    lastSyncAt: nowTs,
  });
  return { ok: true, strategy: "remote", noteCount: records.length, lastSyncAt: nowTs };
}

function sameRemoteNote(file, note) {
  if (!file) return false;
  try {
    const value = JSON.parse(file.content);
    return value?.id === note.id
      && value?.body === note.body
      && value?.createdAt === note.createdAt
      && value?.updatedAt === note.updatedAt;
  } catch {
    return false;
  }
}

async function replaceRemoteFromLocal(deps, client, local, nowTs, attempt = 0) {
  const maxRetries = deps.maxConflictRetries ?? 2;
  try {
    const pushed = {};
    for (const note of local.notes) {
      const current = await client.getFile(notePath(note.id));
      if (sameRemoteNote(current, note)) {
        pushed[note.id] = { updatedAt: note.updatedAt, sha: current.sha };
        continue;
      }
      const result = await client.putFile(notePath(note.id), JSON.stringify(note, null, 2), {
        sha: current?.sha,
        message: `Recover Proofly note ${note.id} from this device`,
      });
      pushed[note.id] = { updatedAt: note.updatedAt, sha: result.sha };
    }

    // This read is intentionally immediately before the authoritative index
    // write. GitHub's Contents API requires the current blob sha.
    const latestIndexFile = await client.getFile("index.json");
    const latestRemoteIndex = indexFromText(latestIndexFile?.content);
    const localIds = new Set(local.notes.map((note) => note.id));
    const desiredIndex = serializeRemoteIndex(local.index.filter((entry) => localIds.has(entry.id)));
    let indexSha = latestIndexFile?.sha;
    if (!latestIndexFile || latestIndexFile.content !== desiredIndex) {
      const result = await client.putFile("index.json", desiredIndex, {
        sha: latestIndexFile?.sha,
        message: "Recover Proofly notes index from this device",
      });
      indexSha = result.sha;
    }

    // Once the index no longer references GitHub-only notes their bodies are
    // harmless orphans. Delete them afterwards so an interrupted recovery can
    // never leave index cards pointing at missing files.
    for (const entry of activeEntries(latestRemoteIndex)) {
      if (localIds.has(entry.id)) continue;
      const current = await client.getFile(notePath(entry.id));
      if (current) {
        await client.deleteFile(notePath(entry.id), {
          sha: current.sha,
          message: `Remove GitHub-only Proofly note ${entry.id} after recovery`,
        });
      }
    }

    await (deps.saveState ?? saveSyncState)({
      synced: pushed,
      tombstones: {},
      ...(indexSha ? { indexSha } : {}),
      lastSyncAt: nowTs,
    });
    return { ok: true, strategy: "local", noteCount: local.notes.length, lastSyncAt: nowTs };
  } catch (error) {
    if (error?.retryableConflict && attempt < maxRetries) {
      return replaceRemoteFromLocal(deps, client, local, nowTs, attempt + 1);
    }
    throw error;
  }
}

function recoveryIndex(notes) {
  return notes.map((note) => ({
    id: note.id,
    title: deriveTitle(note.body),
    snippet: deriveSnippet(note.body),
    updatedAt: note.updatedAt,
  }));
}

function mergeRecoverySnapshots(local, remote, deps = {}) {
  const localNotes = new Map(local.notes.map((note) => [note.id, note]));
  const remoteNotes = new Map(remote.notes.map(({ note }) => [note.id, note]));
  const reservedIds = new Set([...localNotes.keys(), ...remoteNotes.keys()]);
  const notes = [];
  let conflictsPreserved = 0;

  function conflictId() {
    let id;
    do { id = (deps.newId ?? newId)(); } while (reservedIds.has(id));
    reservedIds.add(id);
    return id;
  }

  for (const id of [...reservedIds]) {
    const localNote = localNotes.get(id);
    const remoteNote = remoteNotes.get(id);
    if (!localNote) {
      notes.push(remoteNote);
      continue;
    }
    if (!remoteNote) {
      notes.push(localNote);
      continue;
    }
    if (localNote.body === remoteNote.body) {
      notes.push(localNote.updatedAt >= remoteNote.updatedAt ? localNote : remoteNote);
      continue;
    }

    const localWins = localNote.updatedAt >= remoteNote.updatedAt;
    const winner = localWins ? localNote : remoteNote;
    const loser = localWins ? remoteNote : localNote;
    notes.push(winner, {
      ...loser,
      id: conflictId(),
      body: `(conflict) ${loser.body}`,
    });
    conflictsPreserved += 1;
  }

  return { notes, index: recoveryIndex(notes), conflictsPreserved };
}

export async function recoverNotesSync(strategy, deps = {}) {
  if (!["merge", "remote", "local"].includes(strategy)) {
    throw new TypeError(`Unknown notes sync recovery strategy: ${strategy}`);
  }
  return withRecoveryLock(async () => {
    const settings = deps.settings ?? await (deps.loadSettings ?? loadSyncSettings)();
    if (!settings) return { ok: true, skipped: true, reason: "not-configured" };
    const client = deps.client ?? new GitHubContentClient({ ...settings, fetchImpl: deps.fetchImpl });
    const local = await localSnapshot(deps);
    const remote = await remoteSnapshot(client);
    const nowTs = deps.now?.() ?? Date.now();
    const backup = {
      createdAt: nowTs,
      strategy,
      repository: `${settings.owner}/${settings.repo}`,
      branch: settings.branch || "main",
      local: { index: local.index, notes: local.notes },
      remote: {
        index: remote.index,
        notes: remote.notes.map(({ note }) => note),
      },
    };
    await (deps.saveBackup ?? saveRecoveryBackup)(backup);

    if (strategy === "remote") return replaceLocalFromRemote(deps, remote, nowTs);
    if (strategy === "local") return replaceRemoteFromLocal(deps, client, local, nowTs);

    // A repair deliberately does not reuse the ordinary three-way run. A
    // stale baseline is one cause of the sha wedge this flow exists to fix.
    // Build a lossless canonical library from the two snapshots, publish it
    // using freshly-read shas, then replace local storage and commit the new
    // baseline only after both sides succeeded.
    const merged = mergeRecoverySnapshots(local, remote, deps);
    let recoveredState = null;
    const result = await replaceRemoteFromLocal({
      ...deps,
      maxConflictRetries: deps.maxConflictRetries ?? 2,
      saveState: async (state) => { recoveredState = state; return state; },
    }, client, merged, nowTs);
    await (deps.replaceAllNotes ?? replaceAllNotes)(merged.notes);
    await (deps.saveState ?? saveSyncState)(recoveredState);
    return {
      ...result,
      strategy: "merge",
      changedLocal: true,
      conflictsPreserved: merged.conflictsPreserved,
    };
  });
}

// Keep the losing side of a both-moved conflict as its own "(conflict)" note
// instead of silently dropping the older edit. The copy is a plain local
// note — the next sync pushes it like any other. Copy-BEFORE-overwrite
// ordering: a mid-run failure can at worst re-create the copy on retry (a
// benign duplicate); the reverse order could lose the edit for good.
async function preserveConflictCopy(deps, loser, fallbackCreatedAt) {
  const body = typeof loser?.body === "string" ? loser.body : "";
  if (!body.trim()) return;
  await (deps.saveNote ?? saveNote)({
    id: (deps.newId ?? newId)(),
    body: `(conflict) ${body}`, // first line derives the title → visibly marked
    createdAt: loser.createdAt ?? fallbackCreatedAt,
  }, loser.updatedAt);
}

async function runSyncOnce(deps, attempt = 0) {
  const settings = deps.settings ?? await (deps.loadSettings ?? loadSyncSettings)();
  if (!settings) return { ok: true, skipped: true, reason: "not-configured" };
  if (!deps.ignoreRecoveryLock && await recoveryLocked()) {
    return { ok: true, skipped: true, reason: "recovery-in-progress" };
  }

  const client = deps.client ?? new GitHubContentClient({ ...settings, fetchImpl: deps.fetchImpl });
  const state = await (deps.loadState ?? loadSyncState)();
  const localIndex = await (deps.listIndex ?? listIndex)();
  const remoteFile = await client.getFile("index.json");
  const remoteIndex = indexFromText(remoteFile?.content);
  const nowTs = deps.now?.() ?? Date.now();
  const plan = planSync(localIndex, state.tombstones, state, remoteIndex, { now: nowTs });
  const conflictWinners = new Map(plan.conflicts.map((c) => [c.id, c.winner]));
  const skipPullIds = new Set(typeof deps.skipPullIds === "function" ? deps.skipPullIds() : deps.skipPullIds ?? []);
  const effectivePulls = plan.pulls.filter((e) => !skipPullIds.has(e.id));
  const skippedPulls = plan.pulls.filter((e) => skipPullIds.has(e.id)).map((e) => e.id);
  const nextState = normalizeSyncState(state);
  nextState.indexSha = remoteFile?.sha;

  try {
    for (const entry of effectivePulls) {
      const file = await client.getFile(notePath(entry.id));
      if (!file) continue;
      const note = JSON.parse(file.content);
      if (conflictWinners.get(entry.id) === "remote") {
        const loser = await (deps.getNote ?? getNote)(entry.id);
        if (loser && (loser.body ?? "") !== (note.body ?? "")) {
          await preserveConflictCopy(deps, loser, nowTs);
        }
      }
      await (deps.saveNote ?? saveNote)(note, note.updatedAt);
      nextState.synced[entry.id] = { updatedAt: note.updatedAt, sha: file.sha };
      delete nextState.tombstones[entry.id];
    }

    for (const entry of plan.localDeletes) {
      await (deps.deleteNote ?? deleteNote)(entry.id);
      delete nextState.synced[entry.id];
    }

    for (const entry of plan.pushes) {
      const note = await (deps.getNote ?? getNote)(entry.id);
      if (!note) continue;
      if (conflictWinners.get(entry.id) === "local") {
        const remoteLoser = await client.getFile(notePath(entry.id));
        try {
          const parsed = remoteLoser ? JSON.parse(remoteLoser.content) : null;
          if (parsed && (parsed.body ?? "") !== (note.body ?? "")) {
            await preserveConflictCopy(deps, parsed, nowTs);
          }
        } catch { /* unparseable remote body — nothing worth preserving */ }
      }
      const result = await client.putFile(notePath(entry.id), JSON.stringify(note, null, 2), {
        sha: state.synced?.[entry.id]?.sha,
        message: `Sync Proofly note ${entry.id}`,
      });
      nextState.synced[entry.id] = { updatedAt: note.updatedAt, sha: result.sha };
      delete nextState.tombstones[entry.id];
    }

    for (const entry of plan.remoteDeletes) {
      await client.deleteFile(notePath(entry.id), {
        sha: state.synced?.[entry.id]?.sha,
        message: `Delete Proofly note ${entry.id}`,
      });
      delete nextState.synced[entry.id];
    }

    const mergedIndex = makeRemoteIndex(plan);
    for (const entry of plan.remoteDeletes) delete nextState.tombstones[entry.id];

    // Write the index whenever its CONTENT is out of date, not merely when
    // this run pushed something: a previous run may have pushed note files
    // and then failed on the index (its shas are persisted, so the re-run
    // plans no pushes) — the index write is still owed or other devices
    // never learn about those notes.
    const desiredIndex = serializeRemoteIndex(mergedIndex);
    if (!remoteFile || remoteFile.content !== desiredIndex) {
      const indexResult = await client.putFile("index.json", desiredIndex, {
        sha: remoteFile?.sha,
        message: "Sync Proofly notes index",
      });
      nextState.indexSha = indexResult.sha;
    }
    nextState.lastSyncAt = deps.now?.() ?? Date.now();
    await (deps.saveState ?? saveSyncState)(nextState);
    return {
      ok: true,
      changedLocal: effectivePulls.length > 0 || plan.localDeletes.length > 0,
      pulledIds: effectivePulls.map((e) => e.id),
      skippedPulls,
      pushed: plan.pushes.length,
      deletedRemote: plan.remoteDeletes.length,
      deletedLocal: plan.localDeletes.length,
      lastSyncAt: nextState.lastSyncAt,
    };
  } catch (e) {
    // Earlier steps of this run already happened: pushed notes moved their
    // remote files to NEW shas, pulls landed locally. Persist what they
    // earned before bailing — the retry (and every later sync) re-reads
    // state from storage, and a re-push with the pre-run sha would 409
    // forever (the stale-sha wedge). lastSyncAt stays unset: the run never
    // claims success. A persistence failure must not mask the sync error.
    try { await (deps.saveState ?? saveSyncState)(nextState); } catch { /* keep e */ }
    // Retrying once handles the common index/note race; a second mid-stream
    // conflict surfaces for the next user-triggered sync rather than looping
    // commits indefinitely.
    if (e.retryableConflict && attempt < (deps.maxConflictRetries ?? 1)) {
      return runSyncOnce(deps, attempt + 1);
    }
    throw e;
  }
}
