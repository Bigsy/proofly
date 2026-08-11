// lib/dictionary-store.js against the chrome.storage stub — defensive reads,
// one-set()-per-bulk-op (the 120-writes/min sync budget), loud quota
// propagation, and the onChanged subscription contract (area-filtered,
// unsubscribable).

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addWord, addWords, clearDictionary, DICTIONARY_ACTOR_KEY, DICTIONARY_KEY,
  DICTIONARY_RECORD_PREFIX, DICTIONARY_SETTINGS_KEY, LOCAL_DICTIONARY_KEY,
  loadDictionary, mergeSyncedDictionary, onDictionaryChanged, removeWord, removeWords,
  setDictionarySyncEnabledDirect,
} from "../lib/dictionary-store.js";
import { installChromeStorageStub } from "./helpers/chrome-storage.js";

afterEach(() => {
  delete globalThis.chrome;
});

const sync = () => globalThis.chrome.storage.sync;

async function storedWords() {
  return loadDictionary();
}

describe("conflict-resistant merge", () => {
  it("keeps concurrent additions written by different browser actors", () => {
    const merged = mergeSyncedDictionary({
      [DICTIONARY_KEY]: ["legacy"],
      [`${DICTIONARY_RECORD_PREFIX}browser-a:1`]: { v: 2, entries: [["alpha", 1, []]] },
      [`${DICTIONARY_RECORD_PREFIX}browser-b:2`]: { v: 2, entries: [["beta", 1, []]] },
    });
    expect(merged.words).toEqual(["alpha", "beta", "legacy"]);
  });

  it("preserves an unseen concurrent re-add but honours a remove that observed it", () => {
    expect(mergeSyncedDictionary({
      [`${DICTIONARY_RECORD_PREFIX}browser-a:1`]: {
        v: 2, entries: [["Proofly", null, ["browser-b/4"]]],
      },
      [`${DICTIONARY_RECORD_PREFIX}browser-b:1`]: { v: 2, entries: [["Proofly", 5, []]] },
    }).words).toEqual(["Proofly"]);

    expect(mergeSyncedDictionary({
      [`${DICTIONARY_RECORD_PREFIX}browser-a:1`]: {
        v: 2, entries: [["Proofly", null, ["browser-b/5"]]],
      },
      [`${DICTIONARY_RECORD_PREFIX}browser-b:1`]: { v: 2, entries: [["Proofly", 5, []]] },
    }).words).toEqual([]);
  });

  it("clear removes every observed add while preserving an unseen concurrent add", () => {
    expect(mergeSyncedDictionary({
      [DICTIONARY_KEY]: ["legacy"],
      [`${DICTIONARY_RECORD_PREFIX}browser-a:1`]: {
        v: 2, entries: [
          ["legacy", null, ["v1"]],
          ["old", null, ["browser-b/2"]],
        ],
      },
      [`${DICTIONARY_RECORD_PREFIX}browser-b:1`]: {
        v: 2, entries: [["old", 2, []], ["concurrent", 3, []]],
      },
    }).words).toEqual(["concurrent"]);
  });
});

describe("loadDictionary — defensive reads", () => {
  it("cleans garbage from storage into a valid word list", async () => {
    installChromeStorageStub({
      [DICTIONARY_KEY]: [
        "Acme", 42, null, "  padded  ", "two words", "", "dup", "dup",
        "x".repeat(65), "zebra",
      ],
    });
    expect(await loadDictionary()).toEqual(["Acme", "dup", "padded", "zebra"]);
  });

  it("returns [] for a non-array value, a missing key, and a missing API", async () => {
    installChromeStorageStub({ [DICTIONARY_KEY]: { not: "an array" } });
    expect(await loadDictionary()).toEqual([]);

    installChromeStorageStub({});
    expect(await loadDictionary()).toEqual([]);

    delete globalThis.chrome;
    expect(await loadDictionary()).toEqual([]);
  });

  it("returns [] when the read rejects", async () => {
    installChromeStorageStub({});
    sync().get.mockRejectedValueOnce(new Error("boom"));
    expect(await loadDictionary()).toEqual([]);
  });
});

describe("writes", () => {
  it("addWords merges, trims, dedupes, sorts — in ONE set()", async () => {
    installChromeStorageStub({ [DICTIONARY_KEY]: ["zebra", "Acme"] });
    const result = await addWords(["  alpha ", "zebra", "two words", "beta", "beta"]);
    expect(result).toEqual(["Acme", "alpha", "beta", "zebra"]);
    expect(await storedWords()).toEqual(["Acme", "alpha", "beta", "zebra"]);
    expect(sync().set).toHaveBeenCalledTimes(1);
    expect(Object.keys(await sync().get(null)).some((key) => key.startsWith(DICTIONARY_RECORD_PREFIX)))
      .toBe(true);
  });

  it("addWord adds a single word and returns the resulting list", async () => {
    installChromeStorageStub({});
    expect(await addWord("Proofly")).toEqual(["Proofly"]);
    expect(await storedWords()).toEqual(["Proofly"]);
  });

  it("removeWords drops the given words in ONE set()", async () => {
    installChromeStorageStub({ [DICTIONARY_KEY]: ["a", "b", "c"] });
    expect(await removeWords(["a", "c", "not-present"])).toEqual(["b"]);
    expect(await storedWords()).toEqual(["b"]);
    expect(sync().set).toHaveBeenCalledTimes(1);
  });

  it("removeWord is case-sensitive (the case rule lives in matching, not storage)", async () => {
    installChromeStorageStub({ [DICTIONARY_KEY]: ["Acme", "acme"] });
    expect(await removeWord("acme")).toEqual(["Acme"]);
  });

  it("clearDictionary empties the list", async () => {
    installChromeStorageStub({ [DICTIONARY_KEY]: ["a", "b"] });
    expect(await clearDictionary()).toEqual([]);
    expect(await storedWords()).toEqual([]);
  });

  it("a quota rejection propagates to the caller — never truncates", async () => {
    installChromeStorageStub({ [DICTIONARY_KEY]: ["existing"] });
    sync().set.mockRejectedValueOnce(new Error("QUOTA_BYTES_PER_ITEM exceeded"));
    await expect(addWord("straw")).rejects.toThrow(/QUOTA/);
    expect(await storedWords()).toEqual(["existing"]); // untouched
  });
});

describe("onDictionaryChanged", () => {
  it("fires with the defensively-read new list on a sync write to our key", async () => {
    installChromeStorageStub({});
    const cb = vi.fn();
    onDictionaryChanged(cb);

    // Simulates any other context writing — another device via sync, the
    // options page, the other surface. Garbage rides along to prove the
    // callback re-reads defensively.
    await sync().set({ [DICTIONARY_KEY]: ["zebra", 42, "alpha"] });
    await vi.waitFor(() => expect(cb).toHaveBeenCalledTimes(1));
    expect(cb).toHaveBeenCalledWith(["alpha", "zebra"]);
  });

  it("ignores other keys and other areas", async () => {
    installChromeStorageStub({});
    const cb = vi.fn();
    onDictionaryChanged(cb);

    await sync().set({ customPrompts: [{ name: "x", instruction: "y" }] });
    await globalThis.chrome.storage.local.set({ [DICTIONARY_KEY]: ["local-noise"] });
    expect(cb).not.toHaveBeenCalled();
  });

  it("the returned unsubscribe stops callbacks", async () => {
    installChromeStorageStub({});
    const cb = vi.fn();
    const unsubscribe = onDictionaryChanged(cb);
    unsubscribe();

    await sync().set({ [DICTIONARY_KEY]: ["alpha"] });
    expect(cb).not.toHaveBeenCalled();
    expect(globalThis.chrome.storage.onChanged.listenerCount()).toBe(0);
  });

  it("is a no-op (but still unsubscribable) without the API", () => {
    delete globalThis.chrome;
    const unsubscribe = onDictionaryChanged(vi.fn());
    expect(unsubscribe).not.toThrow;
    unsubscribe();
  });
});

describe("per-browser sync setting", () => {
  it("defaults on, copies words locally when disabled, and keeps local edits off sync", async () => {
    installChromeStorageStub({ [DICTIONARY_KEY]: ["Proofly"] });

    await expect(setDictionarySyncEnabledDirect(false)).resolves.toEqual(["Proofly"]);
    const settingsData = await globalThis.chrome.storage.local.get(DICTIONARY_SETTINGS_KEY);
    const localData = await globalThis.chrome.storage.local.get(LOCAL_DICTIONARY_KEY);
    expect(settingsData[DICTIONARY_SETTINGS_KEY]).toEqual({ syncEnabled: false });
    expect(localData[LOCAL_DICTIONARY_KEY]).toEqual(["Proofly"]);

    await addWord("localword");
    expect(await loadDictionary()).toEqual(["localword", "Proofly"]);
    expect(await sync().get(DICTIONARY_KEY)).toEqual({ [DICTIONARY_KEY]: ["Proofly"] });
  });

  it("re-enabling merges local words with words learned by Chrome sync", async () => {
    installChromeStorageStub(
      { [DICTIONARY_KEY]: ["remote"] },
      {
        [DICTIONARY_SETTINGS_KEY]: { syncEnabled: false },
        [LOCAL_DICTIONARY_KEY]: ["local"],
        [DICTIONARY_ACTOR_KEY]: "browser-a",
      },
    );

    await expect(setDictionarySyncEnabledDirect(true)).resolves.toEqual(["local", "remote"]);
    expect(await loadDictionary()).toEqual(["local", "remote"]);
  });
});
