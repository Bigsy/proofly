import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadWeirpackIndex, loadWeirpacks, MAX_WEIRPACK_FILE_BYTES, onWeirpacksChanged,
  removeWeirpack, saveWeirpack, WEIRPACK_INDEX_KEY, WEIRPACK_KEY_PREFIX,
} from "../lib/weirpack-store.js";
import { installChromeStorageStub } from "./helpers/chrome-storage.js";

afterEach(() => { delete globalThis.chrome; });

describe("synced Weirpack store", () => {
  it("writes the archive before its index entry and round-trips bytes", async () => {
    installChromeStorageStub();
    const bytes = Uint8Array.from([80, 75, 3, 4, 9]);
    const saved = await saveWeirpack({
      name: "doccla.weirpack",
      bytes,
      manifest: { author: "Bill", version: "1.0.0", description: "Doccla terms" },
    });

    const calls = chrome.storage.sync.set.mock.calls;
    expect(Object.keys(calls[0][0])[0]).toBe(`${WEIRPACK_KEY_PREFIX}${saved.id}`);
    expect(Object.keys(calls[1][0])).toEqual([WEIRPACK_INDEX_KEY]);
    expect(await loadWeirpackIndex()).toEqual([saved]);
    expect(await loadWeirpacks()).toEqual([{ ...saved, bytes }]);
  });

  it("hides an entry before removing its archive and notifies index subscribers", async () => {
    installChromeStorageStub();
    const saved = await saveWeirpack({
      name: "one.weirpack", bytes: Uint8Array.from([1, 2, 3]),
    });
    const changed = vi.fn();
    const unsubscribe = onWeirpacksChanged(changed);
    chrome.storage.sync.set.mockClear();

    await expect(removeWeirpack(saved.id)).resolves.toEqual([]);
    expect(chrome.storage.sync.set).toHaveBeenCalledWith({ [WEIRPACK_INDEX_KEY]: [] });
    expect(chrome.storage.sync.remove)
      .toHaveBeenCalledWith(`${WEIRPACK_KEY_PREFIX}${saved.id}`);
    expect(changed).toHaveBeenCalledWith([]);
    unsubscribe();
  });

  it("rejects packs too large for a synced item", async () => {
    installChromeStorageStub();
    await expect(saveWeirpack({
      name: "large.weirpack",
      bytes: new Uint8Array(MAX_WEIRPACK_FILE_BYTES + 1),
    })).rejects.toThrow(/sync limit/i);
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it("ignores index entries whose body is missing or corrupt", async () => {
    const id = "0123456789abcdef0123456789abcdef";
    installChromeStorageStub({
      [WEIRPACK_INDEX_KEY]: [{
        id, name: "missing.weirpack", size: 3, author: "", version: "", description: "",
      }],
    });
    expect(await loadWeirpacks()).toEqual([]);
  });
});
