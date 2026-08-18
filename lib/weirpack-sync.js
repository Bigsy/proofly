// GitHub-backed sync for immutable, content-addressed Harper Weirpacks.
// Metadata and tombstones use last-write-wins timestamps; bodies are written
// before the remote index and removed after it, so the index never points at a
// body this operation knowingly made unavailable.

import { GitHubContentClient } from "./github-content.js";
import { loadSyncSettings } from "./sync-settings.js";
import {
  asWeirpackIndex, clearChromeSyncedWeirpacks,
  loadWeirpacksFrom, loadWeirpackTombstones, MAX_WEIRPACK_FILE_BYTES,
  normalizeWeirpackTombstones, replaceLocalWeirpacks, saveSyncedWeirpack,
} from "./weirpack-store.js";
import {
  loadWeirpackSyncSettings, saveWeirpackSyncSettings,
} from "./weirpack-sync-settings.js";

export const REMOTE_WEIRPACK_INDEX_PATH = "weirpacks/index.json";
export const REMOTE_WEIRPACK_SCHEMA_VERSION = 1;
export const WEIRPACK_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const packPath = (id) => `weirpacks/${id}.weirpack`;

function normalizeRemoteEntry(value) {
  const id = typeof value?.id === "string" ? value.id : "";
  const updatedAt = Number(value?.updatedAt);
  if (!/^[a-f0-9]{32}$/u.test(id) || !Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  if (value.deleted) return { id, deleted: true, updatedAt };
  const [entry] = asWeirpackIndex([value]);
  return entry ? { ...entry, updatedAt } : null;
}

export function parseRemoteWeirpackIndex(value) {
  const list = Array.isArray(value) ? value : value?.packs;
  if (!Array.isArray(list)) return [];
  return list.map(normalizeRemoteEntry).filter(Boolean);
}

export function serializeRemoteWeirpackIndex(entries) {
  return JSON.stringify({
    schemaVersion: REMOTE_WEIRPACK_SCHEMA_VERSION,
    packs: (entries ?? []).map(normalizeRemoteEntry).filter(Boolean),
  }, null, 2);
}

function remoteIndexFromText(text) {
  if (!text) return [];
  try { return parseRemoteWeirpackIndex(JSON.parse(text)); } catch { return []; }
}

function stateMap(entries) {
  return new Map((entries ?? []).map((entry) => [entry.id, entry]));
}

function winner(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  if (a.deleted !== b.deleted) return a.deleted ? a : b;
  return a;
}

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function prunedStates(states, now) {
  return [...states.values()]
    .filter((entry) => !entry.deleted || now - entry.updatedAt <= WEIRPACK_TOMBSTONE_TTL_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

let inFlight = null;

export async function runWeirpackSync(deps = {}) {
  if (inFlight) return inFlight;
  inFlight = runWeirpackSyncOnce(deps).finally(() => { inFlight = null; });
  return inFlight;
}

async function runWeirpackSyncOnce(deps, attempt = 0) {
  const mode = deps.mode ?? await (deps.loadMode ?? loadWeirpackSyncSettings)();
  if (!deps.forceEnabled && !mode.githubEnabled) {
    return { ok: true, skipped: true, reason: "not-enabled" };
  }
  const settings = deps.settings ?? await (deps.loadSettings ?? loadSyncSettings)();
  if (!settings) return { ok: true, skipped: true, reason: "not-configured" };
  const client = deps.client ?? new GitHubContentClient({ ...settings, fetchImpl: deps.fetchImpl });
  const now = deps.now?.() ?? Date.now();

  const localPacks = await (deps.loadLocalPacks ?? (() => loadWeirpacksFrom("local")))();
  const tombstones = await (deps.loadTombstones ?? loadWeirpackTombstones)();
  const localStates = new Map();
  for (const pack of localPacks) {
    localStates.set(pack.id, { ...pack, updatedAt: pack.updatedAt ?? now });
  }
  for (const [id, updatedAt] of Object.entries(normalizeWeirpackTombstones(tombstones))) {
    localStates.set(id, winner(localStates.get(id), { id, deleted: true, updatedAt }));
  }

  const remoteFile = await client.getFile(REMOTE_WEIRPACK_INDEX_PATH);
  const remoteEntries = remoteIndexFromText(remoteFile?.content);
  const remoteStates = stateMap(remoteEntries);
  const merged = new Map();
  for (const id of new Set([...localStates.keys(), ...remoteStates.keys()])) {
    merged.set(id, winner(localStates.get(id), remoteStates.get(id)));
  }

  try {
    const packsById = new Map(localPacks.map((pack) => [pack.id, pack]));
    const originalPacksById = new Map(packsById);
    let pulled = 0;
    let pushed = 0;

    for (const state of merged.values()) {
      if (state.deleted) continue;
      let local = packsById.get(state.id);
      if (!local) {
        const file = await client.getFileBytes(packPath(state.id));
        if (!file || file.bytes.length !== state.size) {
          throw new Error(`GitHub is missing the Weirpack body for ${state.name}`);
        }
        local = { ...state, bytes: file.bytes };
        packsById.set(state.id, local);
        pulled += 1;
      } else if (remoteStates.get(state.id)?.deleted || !remoteStates.has(state.id)) {
        const current = await client.getFileBytes(packPath(state.id));
        if (!current) {
          await client.putFileBytes(packPath(state.id), local.bytes, {
            message: `Sync Proofly Weirpack ${state.name}`,
          });
          pushed += 1;
        } else if (!sameBytes(current.bytes, local.bytes)) {
          throw new Error(`GitHub Weirpack ${state.id} does not match its content id`);
        }
      }
    }

    const desiredEntries = prunedStates(merged, now);
    const desiredIndex = serializeRemoteWeirpackIndex(desiredEntries);
    if (!remoteFile || remoteFile.content !== desiredIndex) {
      await client.putFile(REMOTE_WEIRPACK_INDEX_PATH, desiredIndex, {
        sha: remoteFile?.sha,
        message: "Sync Proofly Weirpacks index",
      });
    }

    // Commit the local view only after every required body is available.
    const active = desiredEntries
      .filter((entry) => !entry.deleted)
      .map((entry) => ({ ...entry, bytes: packsById.get(entry.id).bytes }));
    const nextTombstones = Object.fromEntries(
      desiredEntries.filter((entry) => entry.deleted).map((entry) => [entry.id, entry.updatedAt]),
    );
    const changedLocal = pulled > 0 || active.length !== localPacks.length || active.some((entry) => {
      const before = originalPacksById.get(entry.id);
      return !before
        || before.name !== entry.name
        || before.author !== entry.author
        || before.version !== entry.version
        || before.description !== entry.description
        || before.updatedAt !== entry.updatedAt;
    });
    const tombstonesChanged = JSON.stringify(normalizeWeirpackTombstones(tombstones))
      !== JSON.stringify(nextTombstones);
    if (changedLocal || tombstonesChanged) {
      await (deps.replaceLocal ?? replaceLocalWeirpacks)(active, nextTombstones);
    }

    // The tombstone is already visible remotely, so body cleanup cannot leave
    // another device with an index entry whose archive is missing.
    let deletedRemote = 0;
    for (const entry of desiredEntries.filter((value) => value.deleted)) {
      const current = await client.getFileBytes(packPath(entry.id));
      if (!current) continue;
      await client.deleteFile(packPath(entry.id), {
        sha: current.sha,
        message: `Delete Proofly Weirpack ${entry.id}`,
      });
      deletedRemote += 1;
    }

    return {
      ok: true,
      changedLocal,
      pulled,
      pushed,
      deletedRemote,
      packCount: active.length,
    };
  } catch (error) {
    if (error?.retryableConflict && attempt < (deps.maxConflictRetries ?? 1)) {
      return runWeirpackSyncOnce(deps, attempt + 1);
    }
    if (error && typeof error === "object") error.syncScope = "weirpacks";
    throw error;
  }
}

export async function enableGitHubWeirpackSync(deps = {}) {
  const settings = deps.settings ?? await (deps.loadSettings ?? loadSyncSettings)();
  if (!settings) throw new Error("Connect GitHub before enabling Weirpack sync");
  const mode = await (deps.loadMode ?? loadWeirpackSyncSettings)();
  const now = deps.now?.() ?? Date.now();
  const syncedPacks = await (deps.loadSyncedPacks ?? (() => loadWeirpacksFrom("sync")))();
  const existingLocal = await (deps.loadLocalPacks ?? (() => loadWeirpacksFrom("local")))();
  // On a re-enable, Chrome is the working copy and retained local bodies are
  // only a cache from the previous GitHub session. On the first enable, merge
  // any recoverable local cache into the migration.
  const byId = new Map((mode.hasUsedGitHub ? [] : existingLocal).map((pack) => [pack.id, pack]));
  for (const pack of syncedPacks) byId.set(pack.id, { ...pack, updatedAt: now });

  let tombstones = {};
  const client = deps.client ?? new GitHubContentClient({ ...settings, fetchImpl: deps.fetchImpl });
  if (mode.hasUsedGitHub) {
    // Re-enabling after Chrome mode: the current Chrome index is authoritative
    // for removals made while GitHub sync was paused.
    const remoteFile = await client.getFile(REMOTE_WEIRPACK_INDEX_PATH);
    const chromeIds = new Set(syncedPacks.map(({ id }) => id));
    tombstones = Object.fromEntries(remoteIndexFromText(remoteFile?.content)
      .filter((entry) => !entry.deleted && !chromeIds.has(entry.id))
      .map((entry) => [entry.id, now]));
    for (const id of Object.keys(tombstones)) byId.delete(id);
  }

  await (deps.replaceLocal ?? replaceLocalWeirpacks)([...byId.values()], tombstones);
  const result = await runWeirpackSync({
    ...deps, settings, client, forceEnabled: true,
    mode: { githubEnabled: true, hasUsedGitHub: true },
  });
  await (deps.saveMode ?? saveWeirpackSyncSettings)({ githubEnabled: true, hasUsedGitHub: true });
  await (deps.clearSynced ?? clearChromeSyncedWeirpacks)();
  return result;
}

export async function disableGitHubWeirpackSync(deps = {}) {
  const packs = await (deps.loadLocalPacks ?? (() => loadWeirpacksFrom("local")))();
  const tooLarge = packs.find((pack) => pack.size > MAX_WEIRPACK_FILE_BYTES);
  if (tooLarge) {
    throw new Error(`${tooLarge.name} is too large for Chrome sync; remove it before switching back`);
  }
  await (deps.clearSynced ?? clearChromeSyncedWeirpacks)();
  for (const pack of packs) await (deps.saveSynced ?? saveSyncedWeirpack)(pack);
  await (deps.saveMode ?? saveWeirpackSyncSettings)({ githubEnabled: false, hasUsedGitHub: true });
  return { ok: true, packCount: packs.length };
}
