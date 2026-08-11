// Conflict-resistant persistence for the custom dictionary.
//
// The original format was one chrome.storage.sync array under
// `customDictionary`. Concurrent read-modify-write additions on two browsers
// could overwrite each other. V2 keeps that array as a read-only migration
// base, then gives every browser profile its own sharded change records:
//
//   customDictionaryActor:<local actor id>:<shard> ->
//     { v: 2, entries: [[word, addCounter|null, removedAddIds[]], ...] }
//
// Different browsers therefore never write the same sync item. Effective
// membership is an observed-remove set: a removal (including Clear all)
// records the exact add IDs it saw, so an unseen concurrent add survives.
// Fixed shards keep bulk operations to one set() without spending one of
// Chrome sync's 512 item slots per word. The per-browser counter makes every
// add ID unique without trusting wall clocks.

import { isValidWord } from "./dictionary.js";
import {
  DICTIONARY_SYNC_SET, PAGE_DICTIONARY_CHANGED, PAGE_DICTIONARY_UPDATE, PAGE_STORAGE_GET,
  requestPageStorage, usesPageStorageBroker, watchPageStorage,
} from "./storage-broker.js";

// Legacy V1 key. It remains readable as the migration base so an upgrade is
// lossless and does not need a risky delete/rewrite transaction.
export const DICTIONARY_KEY = "customDictionary";
export const LOCAL_DICTIONARY_KEY = "customDictionaryLocal";
export const DICTIONARY_SETTINGS_KEY = "customDictionarySettings";
export const DICTIONARY_ACTOR_KEY = "customDictionaryActorId";
export const DICTIONARY_COUNTER_KEY = "customDictionaryCounter";
export const DICTIONARY_RECORD_PREFIX = "customDictionaryActor:";
export const DICTIONARY_SHARD_COUNT = 32;

const syncStore = () => globalThis.chrome?.storage?.sync ?? null;
const localStore = () => globalThis.chrome?.storage?.local ?? null;

// Defensive read of the synced value (storage can hold anything): drop
// non-strings, trim, drop empties / whitespace-containing / over-long words,
// dedupe (case-sensitive — the lowercase-entry case rule in lib/dictionary.js
// makes "acme" subsume "Acme", which is harmless), sort for display.
export function asWordList(value) {
  if (!Array.isArray(value)) return [];
  const words = new Set();
  for (const v of value) {
    if (typeof v !== "string") continue;
    const w = v.trim();
    if (isValidWord(w)) words.add(w);
  }
  return [...words].sort((a, b) => a.localeCompare(b));
}

export function normalizeDictionarySettings(value) {
  return { syncEnabled: value?.syncEnabled !== false };
}

export async function loadDictionarySettings() {
  const local = localStore();
  if (!local) return { syncEnabled: true };
  try {
    const data = await local.get(DICTIONARY_SETTINGS_KEY);
    return normalizeDictionarySettings(data?.[DICTIONARY_SETTINGS_KEY]);
  } catch {
    return { syncEnabled: true };
  }
}

function validCounter(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function validActor(value) {
  return typeof value === "string" && /^[a-z0-9-]{1,80}$/iu.test(value);
}

function validAddId(value) {
  if (value === "v1") return true;
  if (typeof value !== "string" || value.length > 110) return false;
  const slash = value.lastIndexOf("/");
  const rawCounter = value.slice(slash + 1);
  return validActor(value.slice(0, slash))
    && /^[1-9]\d*$/u.test(rawCounter)
    && validCounter(Number(rawCounter)) !== null;
}

function actorFromRecordKey(key) {
  if (!isRecordKey(key)) return null;
  const rest = key.slice(DICTIONARY_RECORD_PREFIX.length);
  const colon = rest.lastIndexOf(":");
  const actor = colon > 0 ? rest.slice(0, colon) : "";
  return validActor(actor) ? actor : null;
}

function parseRecord(value) {
  if (value?.v !== 2 || !Array.isArray(value.entries)) return [];
  const entries = [];
  for (const row of value.entries) {
    if (!Array.isArray(row) || row.length < 3) continue;
    const [rawWord, rawCounter, rawRemoved] = row;
    const [word] = asWordList([rawWord]);
    const counter = rawCounter === null ? null : validCounter(rawCounter);
    if (!word || (rawCounter !== null && counter === null) || !Array.isArray(rawRemoved)) continue;
    const removed = [...new Set(rawRemoved.filter(validAddId))].sort();
    entries.push([word, counter, removed]);
  }
  return entries;
}

function isRecordKey(key) {
  return typeof key === "string" && key.startsWith(DICTIONARY_RECORD_PREFIX);
}

function mergedDictionaryState(data) {
  const additions = new Map();
  const removals = new Map();

  for (const word of asWordList(data?.[DICTIONARY_KEY])) {
    additions.set(word, new Set(["v1"]));
  }

  for (const [key, value] of Object.entries(data ?? {})) {
    const actor = actorFromRecordKey(key);
    if (!actor) continue;
    for (const [word, counter, removed] of parseRecord(value)) {
      if (counter !== null) {
        if (!additions.has(word)) additions.set(word, new Set());
        additions.get(word).add(`${actor}/${counter}`);
      }
      if (removed.length) {
        if (!removals.has(word)) removals.set(word, new Set());
        for (const addId of removed) removals.get(word).add(addId);
      }
    }
  }

  const activeDots = new Map();
  for (const [word, addIds] of additions) {
    const removed = removals.get(word) ?? new Set();
    const active = new Set([...addIds].filter((id) => !removed.has(id)));
    if (active.size) activeDots.set(word, active);
  }
  return { words: asWordList([...activeDots.keys()]), activeDots };
}

// Pure merge seam used by tests and by every trusted context. Legacy words
// behave like one fixed V1 add ID, so V2 removes can suppress them safely.
export function mergeSyncedDictionary(data) {
  return { words: mergedDictionaryState(data).words };
}

async function loadSyncedDictionary() {
  const sync = syncStore();
  if (!sync) return [];
  try {
    return mergeSyncedDictionary(await sync.get(null)).words;
  } catch {
    return [];
  }
}

export async function loadDictionary() {
  if (usesPageStorageBroker()) {
    try {
      const response = await requestPageStorage({ type: PAGE_STORAGE_GET });
      return asWordList(response.dictionary);
    } catch {
      return [];
    }
  }
  const settings = await loadDictionarySettings();
  if (!settings.syncEnabled) {
    try {
      const data = await localStore()?.get(LOCAL_DICTIONARY_KEY);
      return asWordList(data?.[LOCAL_DICTIONARY_KEY]);
    } catch {
      return [];
    }
  }
  return loadSyncedDictionary();
}

function randomActorId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `actor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function actorId() {
  const local = localStore();
  if (!local) return randomActorId();
  try {
    const data = await local.get(DICTIONARY_ACTOR_KEY);
    if (validActor(data?.[DICTIONARY_ACTOR_KEY])) {
      return data[DICTIONARY_ACTOR_KEY];
    }
    const id = randomActorId();
    await local.set({ [DICTIONARY_ACTOR_KEY]: id });
    return id;
  } catch {
    return randomActorId();
  }
}

function wordShard(word) {
  // FNV-1a over UTF-16 code units: deterministic in every extension context.
  let hash = 0x811c9dc5;
  for (let i = 0; i < word.length; i++) {
    hash ^= word.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % DICTIONARY_SHARD_COUNT;
}

async function nextCounter(syncData, actor) {
  const local = localStore();
  let actorMax = 0;
  for (const [key, value] of Object.entries(syncData ?? {})) {
    if (actorFromRecordKey(key) !== actor) continue;
    for (const [, counter] of parseRecord(value)) actorMax = Math.max(actorMax, counter ?? 0);
  }
  let remembered = 0;
  try {
    const data = await local?.get(DICTIONARY_COUNTER_KEY);
    remembered = validCounter(data?.[DICTIONARY_COUNTER_KEY]) ?? 0;
  } catch { /* the actor's synced records still prevent ID reuse */ }
  const counter = Math.max(actorMax, remembered) + 1;
  await local?.set({ [DICTIONARY_COUNTER_KEY]: counter });
  return counter;
}

function recordKey(actor, shard) {
  return `${DICTIONARY_RECORD_PREFIX}${actor}:${shard}`;
}

async function mutateSyncedDictionary(operation, requested) {
  const sync = syncStore();
  if (!sync) return [];
  const data = await sync.get(null);
  const actor = await actorId();
  const merged = mergedDictionaryState(data);
  if (!["add", "remove", "clear"].includes(operation)) {
    throw new Error("Unknown dictionary operation");
  }

  const targets = operation === "clear"
    ? merged.words
    : asWordList(requested).filter((word) =>
      operation === "add" ? !merged.activeDots.has(word) : merged.activeDots.has(word));
  if (!targets.length) return merged.words;

  const counter = operation === "add" ? await nextCounter(data, actor) : null;
  const byShard = new Map();
  for (const word of targets) {
    const shard = wordShard(word);
    if (!byShard.has(shard)) byShard.set(shard, []);
    byShard.get(shard).push(word);
  }

  const writes = {};
  for (const [shard, changedWords] of byShard) {
    const key = recordKey(actor, shard);
    const entries = new Map(parseRecord(data[key]).map(([word, add, removed]) => [
      word, { add, removed: new Set(removed) },
    ]));
    for (const word of changedWords) {
      const entry = entries.get(word) ?? { add: null, removed: new Set() };
      if (operation === "add") entry.add = counter;
      else {
        for (const addId of merged.activeDots.get(word) ?? []) entry.removed.add(addId);
      }
      entries.set(word, entry);
    }
    writes[key] = {
      v: 2,
      entries: [...entries]
        .map(([word, entry]) => [word, entry.add, [...entry.removed].sort()])
        .sort(([a], [b]) => a.localeCompare(b)),
    };
  }
  await sync.set(writes);
  return loadSyncedDictionary();
}

async function mutateLocalDictionary(operation, requested) {
  const local = localStore();
  if (!local) return [];
  const data = await local.get(LOCAL_DICTIONARY_KEY);
  const current = asWordList(data?.[LOCAL_DICTIONARY_KEY]);
  let next;
  if (operation === "add") next = asWordList([...current, ...requested]);
  else if (operation === "remove") {
    const drop = new Set(asWordList(requested));
    next = current.filter((word) => !drop.has(word));
  } else if (operation === "clear") next = [];
  else throw new Error("Unknown dictionary operation");
  await local.set({ [LOCAL_DICTIONARY_KEY]: next });
  return next;
}

// Direct mutation seam for the service worker (the one writer per browser)
// and API-light tests. Extension pages/content scripts normally request this
// through the service worker so two local contexts cannot race one actor shard.
export async function updateDictionary(operation, words = []) {
  const requested = asWordList(Array.isArray(words) ? words : []);
  const settings = await loadDictionarySettings();
  return settings.syncEnabled
    ? mutateSyncedDictionary(operation, requested)
    : mutateLocalDictionary(operation, requested);
}

function hasMutationBroker() {
  return !!globalThis.chrome?.runtime?.id
    && typeof globalThis.chrome?.runtime?.sendMessage === "function";
}

async function requestDictionaryUpdate(operation, words) {
  if (hasMutationBroker()) {
    const response = await requestPageStorage({
      type: PAGE_DICTIONARY_UPDATE,
      operation,
      words: Array.isArray(words) ? words : [],
    });
    return asWordList(response.dictionary);
  }
  return updateDictionary(operation, words);
}

export const addWords = (words) => requestDictionaryUpdate("add", words);
export const addWord = (word) => addWords([word]);
export const removeWords = (words) => requestDictionaryUpdate("remove", words);
export const removeWord = (word) => removeWords([word]);
export const clearDictionary = () => requestDictionaryUpdate("clear", []);

export async function setDictionarySyncEnabledDirect(enabled) {
  const local = localStore();
  if (!local) return [];
  const nextEnabled = enabled !== false;
  const currentSettings = await loadDictionarySettings();
  if (currentSettings.syncEnabled === nextEnabled) return loadDictionary();

  if (!nextEnabled) {
    // Body before selector: interruption can only leave an unused backup,
    // never select local-only mode without a dictionary body.
    const words = await loadSyncedDictionary();
    await local.set({ [LOCAL_DICTIONARY_KEY]: words });
    await local.set({ [DICTIONARY_SETTINGS_KEY]: { syncEnabled: false } });
    return words;
  }

  // Re-enabling is deliberately additive: merge this browser's local words
  // into Chrome sync rather than deleting words learned on other browsers.
  const data = await local.get(LOCAL_DICTIONARY_KEY);
  const localWords = asWordList(data?.[LOCAL_DICTIONARY_KEY]);
  await mutateSyncedDictionary("add", localWords);
  await local.set({ [DICTIONARY_SETTINGS_KEY]: { syncEnabled: true } });
  return loadSyncedDictionary();
}

export async function setDictionarySyncEnabled(enabled) {
  if (hasMutationBroker()) {
    const response = await requestPageStorage({ type: DICTIONARY_SYNC_SET, enabled: enabled !== false });
    return asWordList(response.dictionary);
  }
  return setDictionarySyncEnabledDirect(enabled);
}

export function isDictionaryStorageChange(changes, area) {
  const keys = Object.keys(changes ?? {});
  if (area === "sync") return keys.some((key) => key === DICTIONARY_KEY || isRecordKey(key));
  return area === "local" && keys.some((key) =>
    key === LOCAL_DICTIONARY_KEY || key === DICTIONARY_SETTINGS_KEY);
}

// Subscribe to dictionary changes from ANY context — the other surface, the
// options page, or another device via sync — filtered to our key. The
// callback gets the new (defensively-read) list. Returns an unsubscribe
// function; the in-page teardown needs it.
export function onDictionaryChanged(callback) {
  if (usesPageStorageBroker()) {
    return watchPageStorage(PAGE_DICTIONARY_CHANGED, (message) => {
      callback(asWordList(message.dictionary));
    });
  }
  const onChanged = globalThis.chrome?.storage?.onChanged;
  if (!onChanged?.addListener) return () => {};
  const listener = (changes, area) => {
    if (!isDictionaryStorageChange(changes, area)) return;
    loadDictionary().then(callback).catch(() => {});
  };
  onChanged.addListener(listener);
  return () => onChanged.removeListener(listener);
}

export function onDictionarySettingsChanged(callback) {
  const onChanged = globalThis.chrome?.storage?.onChanged;
  if (!onChanged?.addListener) return () => {};
  const listener = (changes, area) => {
    if (area !== "local" || !changes?.[DICTIONARY_SETTINGS_KEY]) return;
    callback(normalizeDictionarySettings(changes[DICTIONARY_SETTINGS_KEY].newValue));
  };
  onChanged.addListener(listener);
  return () => onChanged.removeListener(listener);
}
