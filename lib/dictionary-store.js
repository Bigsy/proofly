// lib/dictionary-store.js — persistence for the custom dictionary, a thin
// async wrapper over chrome.storage.sync (the enabledSites / customPrompts
// pattern: synced intent under ONE key). Guards a missing API the same way
// lib/notes-store.js does, so jsdom and non-extension contexts don't throw.
//
// Storage shape: a sorted, deduped array of single-token strings —
//   "customDictionary" -> ["Acme", "Gemini", "Proofly", ...]
//
// The ~8 KB per-item sync quota fits 1000+ words; a set() past it REJECTS
// loudly (surfaced in the options page UI), never truncates. Conflicts are
// last-write-wins on the single key: two devices adding different words in
// the same sync window can lose one — rare, self-healing (add it again),
// same stance as enabledSites. Every bulk operation is ONE set(): sync allows
// ~120 writes/min, which a per-word loop from a bulk paste could trip; a
// single write can't.

import { isValidWord } from "./dictionary.js";
import {
  PAGE_DICTIONARY_CHANGED, PAGE_DICTIONARY_UPDATE, PAGE_STORAGE_GET,
  requestPageStorage, usesPageStorageBroker, watchPageStorage,
} from "./storage-broker.js";

export const DICTIONARY_KEY = "customDictionary";

// chrome.storage.sync, or null in jsdom / a non-extension page.
const store = () => globalThis.chrome?.storage?.sync ?? null;

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

export async function loadDictionary() {
  if (usesPageStorageBroker()) {
    try {
      const response = await requestPageStorage({ type: PAGE_STORAGE_GET });
      return asWordList(response.dictionary);
    } catch {
      return [];
    }
  }
  const s = store();
  if (!s) return [];
  try {
    const data = await s.get(DICTIONARY_KEY);
    return asWordList(data?.[DICTIONARY_KEY]);
  } catch {
    return [];
  }
}

// One set() for the whole list. Quota rejections propagate to the caller —
// the side panel and options page surface them; the in-page surface swallows
// them (silent-degrade stance, see page/content/index.js).
async function writeDictionary(list) {
  await store()?.set({ [DICTIONARY_KEY]: list });
  return list;
}

// Each mutation is read-modify-write at interaction time and returns the
// resulting list, so callers can update optimistically.
export async function addWords(words) {
  if (usesPageStorageBroker()) {
    const response = await requestPageStorage({
      type: PAGE_DICTIONARY_UPDATE,
      operation: "add",
      words: Array.isArray(words) ? words : [],
    });
    return asWordList(response.dictionary);
  }
  const current = await loadDictionary();
  const merged = asWordList([...current, ...(Array.isArray(words) ? words : [])]);
  return writeDictionary(merged);
}

export const addWord = (word) => addWords([word]);

export async function removeWords(words) {
  if (usesPageStorageBroker()) {
    const response = await requestPageStorage({
      type: PAGE_DICTIONARY_UPDATE,
      operation: "remove",
      words: Array.isArray(words) ? words : [],
    });
    return asWordList(response.dictionary);
  }
  const drop = new Set(Array.isArray(words) ? words : []);
  const current = await loadDictionary();
  return writeDictionary(current.filter((w) => !drop.has(w)));
}

export const removeWord = (word) => removeWords([word]);

export const clearDictionary = async () => {
  if (usesPageStorageBroker()) {
    const response = await requestPageStorage({
      type: PAGE_DICTIONARY_UPDATE,
      operation: "clear",
      words: [],
    });
    return asWordList(response.dictionary);
  }
  return writeDictionary([]);
};

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
    if (area !== "sync" || !changes?.[DICTIONARY_KEY]) return;
    callback(asWordList(changes[DICTIONARY_KEY].newValue));
  };
  onChanged.addListener(listener);
  return () => onChanged.removeListener(listener);
}
