// Harper Weirpack persistence.
//
// The default mode keeps each small archive in chrome.storage.sync. When the
// user opts into GitHub Weirpack sync, the working copy moves to
// chrome.storage.local (the extension has unlimitedStorage) and GitHub becomes
// the cross-device transport. Keeping the same keys in both areas makes the
// migration explicit and reversible without exposing pack bytes to pages.

import { loadWeirpackSyncSettings } from "./weirpack-sync-settings.js";

export const WEIRPACK_INDEX_KEY = "weirpackIndex";
export const WEIRPACK_KEY_PREFIX = "weirpack:";
export const WEIRPACK_TOMBSTONES_KEY = "weirpackTombstones";
export const MAX_WEIRPACK_FILE_BYTES = 5600;
export const MAX_GITHUB_WEIRPACK_FILE_BYTES = 25 * 1024 * 1024;
export const SYNC_ITEM_QUOTA_BYTES = 8192;

const syncStore = () => globalThis.chrome?.storage?.sync ?? null;
const localStore = () => globalThis.chrome?.storage?.local ?? null;
const encoder = new TextEncoder();

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanMetadata(value = {}) {
  return {
    author: cleanText(value.author, 120),
    version: cleanText(value.version, 40),
    description: cleanText(value.description, 500),
  };
}

function cleanUpdatedAt(value) {
  const updatedAt = Number(value);
  return Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : null;
}

export function asWeirpackIndex(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const entry of value) {
    const id = cleanText(entry?.id, 64);
    const name = cleanText(entry?.name, 160);
    const size = Number(entry?.size);
    if (!/^[a-f0-9]{32}$/u.test(id) || !name || seen.has(id)
      || !Number.isInteger(size) || size < 1 || size > MAX_GITHUB_WEIRPACK_FILE_BYTES) continue;
    seen.add(id);
    const updatedAt = cleanUpdatedAt(entry.updatedAt);
    result.push({
      id, name, size, ...cleanMetadata(entry),
      ...(updatedAt ? { updatedAt } : {}),
    });
  }
  return result;
}

export function normalizeWeirpackTombstones(value) {
  const result = {};
  for (const [id, raw] of Object.entries(value ?? {})) {
    const updatedAt = cleanUpdatedAt(raw);
    if (/^[a-f0-9]{32}$/u.test(id) && updatedAt) result[id] = updatedAt;
  }
  return result;
}

export function bytesToBase64(value) {
  const bytes = value instanceof Uint8Array ? value : Uint8Array.from(value ?? []);
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(value) {
  if (typeof value !== "string" || !value) throw new TypeError("Invalid Weirpack data");
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function weirpackContentId(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function itemBytes(key, value) {
  return encoder.encode(key).length + encoder.encode(JSON.stringify(value)).length;
}

function areaStore(area) {
  return area === "local" ? localStore() : syncStore();
}

async function activeArea() {
  return (await loadWeirpackSyncSettings()).githubEnabled ? "local" : "sync";
}

export async function maxWeirpackFileBytes() {
  return (await loadWeirpackSyncSettings()).githubEnabled
    ? MAX_GITHUB_WEIRPACK_FILE_BYTES
    : MAX_WEIRPACK_FILE_BYTES;
}

export async function loadWeirpackIndexFrom(area) {
  const store = areaStore(area);
  if (!store) return [];
  try {
    const data = await store.get(WEIRPACK_INDEX_KEY);
    return asWeirpackIndex(data?.[WEIRPACK_INDEX_KEY]);
  } catch {
    return [];
  }
}

export async function loadWeirpackIndex() {
  return loadWeirpackIndexFrom(await activeArea());
}

export async function loadWeirpacksFrom(area) {
  const store = areaStore(area);
  if (!store) return [];
  const index = await loadWeirpackIndexFrom(area);
  if (!index.length) return [];
  try {
    const keys = index.map(({ id }) => `${WEIRPACK_KEY_PREFIX}${id}`);
    const data = await store.get(keys);
    const packs = [];
    for (const entry of index) {
      const record = data?.[`${WEIRPACK_KEY_PREFIX}${entry.id}`];
      try {
        const bytes = base64ToBytes(record?.data);
        if (bytes.length !== entry.size) continue;
        packs.push({ ...entry, bytes });
      } catch {
        // A partial/corrupt body stays invisible until sync or re-import repairs it.
      }
    }
    return packs;
  } catch {
    return [];
  }
}

export async function loadWeirpacks() {
  return loadWeirpacksFrom(await activeArea());
}

async function saveToArea(area, pack = {}) {
  const { name, bytes: value, manifest = {}, updatedAt = Date.now() } = pack;
  const store = areaStore(area);
  if (!store) throw new Error(`${area === "local" ? "Local" : "Chrome sync"} storage is unavailable`);
  const bytes = value instanceof Uint8Array ? value : Uint8Array.from(value ?? []);
  if (!bytes.length) throw new Error("The Weirpack is empty");
  const limit = area === "local" ? MAX_GITHUB_WEIRPACK_FILE_BYTES : MAX_WEIRPACK_FILE_BYTES;
  if (bytes.length > limit) {
    const label = area === "local" ? "GitHub sync" : "Chrome sync";
    throw new Error(`Weirpack exceeds the ${limit.toLocaleString()}-byte ${label} limit`);
  }

  const id = await weirpackContentId(bytes);
  const metadata = cleanMetadata({ ...pack, ...manifest });
  const entry = {
    id,
    name: cleanText(name, 160) || "Unnamed.weirpack",
    size: bytes.length,
    ...metadata,
    updatedAt: cleanUpdatedAt(updatedAt) ?? Date.now(),
  };
  const key = `${WEIRPACK_KEY_PREFIX}${id}`;
  const record = { data: bytesToBase64(bytes) };
  if (area === "sync" && itemBytes(key, record) > SYNC_ITEM_QUOTA_BYTES) {
    throw new Error("Weirpack exceeds Chrome's 8 KB sync item quota");
  }

  const current = await loadWeirpackIndexFrom(area);
  const next = [...current.filter((item) => item.id !== id), entry];
  if (area === "sync" && itemBytes(WEIRPACK_INDEX_KEY, next) > SYNC_ITEM_QUOTA_BYTES) {
    throw new Error("Weirpack index exceeds Chrome's 8 KB sync item quota");
  }
  await store.set({ [key]: record });
  await store.set({ [WEIRPACK_INDEX_KEY]: next });
  if (area === "local") {
    const tombstones = await loadWeirpackTombstones();
    if (tombstones[id]) {
      delete tombstones[id];
      await saveWeirpackTombstones(tombstones);
    }
  }
  return entry;
}

export async function saveWeirpack(value) {
  return saveToArea(await activeArea(), value);
}

export async function saveLocalWeirpack(value) {
  return saveToArea("local", value);
}

export async function saveSyncedWeirpack(value) {
  return saveToArea("sync", value);
}

export async function loadWeirpackTombstones() {
  const local = localStore();
  if (!local) return {};
  try {
    const data = await local.get(WEIRPACK_TOMBSTONES_KEY);
    return normalizeWeirpackTombstones(data?.[WEIRPACK_TOMBSTONES_KEY]);
  } catch {
    return {};
  }
}

export async function saveWeirpackTombstones(value) {
  const tombstones = normalizeWeirpackTombstones(value);
  await localStore()?.set({ [WEIRPACK_TOMBSTONES_KEY]: tombstones });
  return tombstones;
}

export async function removeWeirpack(id) {
  if (!/^[a-f0-9]{32}$/u.test(id)) throw new Error("Invalid Weirpack id");
  const area = await activeArea();
  const store = areaStore(area);
  if (!store) throw new Error("Weirpack storage is unavailable");
  const current = await loadWeirpackIndexFrom(area);
  const next = current.filter((entry) => entry.id !== id);
  await store.set({ [WEIRPACK_INDEX_KEY]: next });
  if (area === "local") {
    const tombstones = await loadWeirpackTombstones();
    tombstones[id] = Date.now();
    await saveWeirpackTombstones(tombstones);
  }
  await store.remove(`${WEIRPACK_KEY_PREFIX}${id}`);
  return next;
}

export async function replaceLocalWeirpacks(packs, tombstones = {}) {
  const local = localStore();
  if (!local) throw new Error("Local storage is unavailable");
  const existing = await loadWeirpackIndexFrom("local");
  const normalized = [];
  const keep = new Set();
  const records = {};
  for (const pack of packs ?? []) {
    const bytes = pack.bytes instanceof Uint8Array ? pack.bytes : Uint8Array.from(pack.bytes ?? []);
    const [entry] = asWeirpackIndex([{ ...pack, size: bytes.length }]);
    if (!entry || await weirpackContentId(bytes) !== entry.id) {
      throw new Error(`Weirpack ${pack?.name || pack?.id || "archive"} has invalid content`);
    }
    const saved = { ...entry, updatedAt: cleanUpdatedAt(pack.updatedAt) ?? Date.now() };
    normalized.push(saved);
    keep.add(entry.id);
    records[`${WEIRPACK_KEY_PREFIX}${entry.id}`] = { data: bytesToBase64(bytes) };
  }
  if (Object.keys(records).length) await local.set(records);
  await local.set({
    [WEIRPACK_INDEX_KEY]: normalized,
    [WEIRPACK_TOMBSTONES_KEY]: normalizeWeirpackTombstones(tombstones),
  });
  const obsolete = existing.filter(({ id }) => !keep.has(id)).map(({ id }) => `${WEIRPACK_KEY_PREFIX}${id}`);
  if (obsolete.length) await local.remove(obsolete);
  return normalized;
}

export async function clearChromeSyncedWeirpacks() {
  const sync = syncStore();
  if (!sync) return;
  const index = await loadWeirpackIndexFrom("sync");
  await sync.set({ [WEIRPACK_INDEX_KEY]: [] });
  if (index.length) await sync.remove(index.map(({ id }) => `${WEIRPACK_KEY_PREFIX}${id}`));
}

export function onWeirpacksChanged(callback) {
  const changed = globalThis.chrome?.storage?.onChanged;
  if (!changed?.addListener) return () => {};
  const listener = async (changes, area) => {
    if ((area !== "sync" && area !== "local") || !changes?.[WEIRPACK_INDEX_KEY]) return;
    callback(await loadWeirpackIndex());
  };
  changed.addListener(listener);
  return () => changed.removeListener(listener);
}

export function isWeirpackStorageChange(changes) {
  return !!changes && Object.keys(changes).some((key) =>
    key === WEIRPACK_INDEX_KEY
      || key === WEIRPACK_TOMBSTONES_KEY
      || key.startsWith(WEIRPACK_KEY_PREFIX));
}
