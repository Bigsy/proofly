import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadWeirpacks, loadWeirpacksFrom, saveWeirpack,
  saveWeirpackTombstones, WEIRPACK_INDEX_KEY, weirpackContentId,
} from "../lib/weirpack-store.js";
import {
  disableGitHubWeirpackSync, enableGitHubWeirpackSync, REMOTE_WEIRPACK_INDEX_PATH,
  runWeirpackSync, serializeRemoteWeirpackIndex,
} from "../lib/weirpack-sync.js";
import { WEIRPACK_SYNC_SETTINGS_KEY } from "../lib/weirpack-sync-settings.js";
import { installChromeStorageStub } from "./helpers/chrome-storage.js";

const settings = { owner: "me", repo: "proofly", branch: "main", token: "secret" };

async function pack(bytes, overrides = {}) {
  const value = Uint8Array.from(bytes);
  return {
    id: await weirpackContentId(value),
    name: "terms.weirpack",
    size: value.length,
    author: "",
    version: "",
    description: "",
    updatedAt: 100,
    bytes: value,
    ...overrides,
  };
}

function emptyClient() {
  return {
    getFile: vi.fn(async () => null),
    getFileBytes: vi.fn(async () => null),
    putFile: vi.fn(async () => ({ sha: "index-sha" })),
    putFileBytes: vi.fn(async () => ({ sha: "pack-sha" })),
    deleteFile: vi.fn(async () => null),
  };
}

afterEach(() => { delete globalThis.chrome; });

describe("GitHub Weirpack sync", () => {
  it("pushes a locally cached pack body before publishing the remote index", async () => {
    installChromeStorageStub({}, {});
    const local = await pack([80, 75, 3, 4, 9]);
    const client = emptyClient();
    const calls = [];
    client.putFileBytes.mockImplementation(async (path) => { calls.push(`body:${path}`); return { sha: "body" }; });
    client.putFile.mockImplementation(async (path) => { calls.push(`index:${path}`); return { sha: "index" }; });

    const result = await runWeirpackSync({
      settings, client, forceEnabled: true, now: () => 200,
      loadLocalPacks: async () => [local],
      loadTombstones: async () => ({}),
      replaceLocal: vi.fn(async () => {}),
    });

    expect(result).toMatchObject({ pushed: 1, packCount: 1 });
    expect(calls).toEqual([
      `body:weirpacks/${local.id}.weirpack`,
      `index:${REMOTE_WEIRPACK_INDEX_PATH}`,
    ]);
    const published = JSON.parse(client.putFile.mock.calls[0][1]);
    expect(published.packs).toEqual([expect.objectContaining({ id: local.id, name: local.name })]);
  });

  it("downloads a remote binary pack into local extension storage", async () => {
    installChromeStorageStub({}, {});
    const remote = await pack([0, 255, 128, 1], { name: "binary.weirpack", updatedAt: 300 });
    const index = serializeRemoteWeirpackIndex([remote]);
    const client = emptyClient();
    client.getFile.mockResolvedValue({ sha: "index", content: index });
    client.getFileBytes.mockResolvedValue({ sha: "body", bytes: remote.bytes });

    await runWeirpackSync({ settings, client, forceEnabled: true, now: () => 400 });

    expect(await loadWeirpacksFrom("local")).toEqual([remote]);
    expect(client.putFile).not.toHaveBeenCalled();
  });

  it("publishes a tombstone before deleting its remote archive", async () => {
    installChromeStorageStub({}, {});
    const remote = await pack([1, 2, 3], { updatedAt: 100 });
    await saveWeirpackTombstones({ [remote.id]: 500 });
    const client = emptyClient();
    client.getFile.mockResolvedValue({
      sha: "index-old", content: serializeRemoteWeirpackIndex([remote]),
    });
    client.getFileBytes.mockResolvedValue({ sha: "body-old", bytes: remote.bytes });
    const calls = [];
    client.putFile.mockImplementation(async () => { calls.push("index"); return { sha: "index-new" }; });
    client.deleteFile.mockImplementation(async () => { calls.push("delete"); return null; });

    const result = await runWeirpackSync({ settings, client, forceEnabled: true, now: () => 600 });

    expect(calls).toEqual(["index", "delete"]);
    expect(result.deletedRemote).toBe(1);
    expect(JSON.parse(client.putFile.mock.calls[0][1]).packs)
      .toEqual([{ id: remote.id, deleted: true, updatedAt: 500 }]);
  });

  it("re-reads the index and retries a removal after a stale-sha conflict", async () => {
    installChromeStorageStub({}, {});
    const remote = await pack([1, 2, 3], { updatedAt: 100 });
    await saveWeirpackTombstones({ [remote.id]: 500 });
    const client = emptyClient();
    client.getFile
      .mockResolvedValueOnce({
        sha: "index-stale", content: serializeRemoteWeirpackIndex([remote]),
      })
      .mockResolvedValueOnce({
        sha: "index-current", content: serializeRemoteWeirpackIndex([remote]),
      });
    client.getFileBytes.mockResolvedValue({ sha: "body-old", bytes: remote.bytes });
    client.putFile
      .mockRejectedValueOnce(Object.assign(new Error("weirpacks/index.json does not match index-stale"), {
        retryableConflict: true,
        status: 422,
      }))
      .mockResolvedValueOnce({ sha: "index-new" });

    await expect(runWeirpackSync({
      settings, client, forceEnabled: true, now: () => 600,
    })).resolves.toMatchObject({ ok: true, deletedRemote: 1, packCount: 0 });

    expect(client.getFile).toHaveBeenCalledTimes(2);
    expect(client.putFile.mock.calls.map(([, , options]) => options.sha))
      .toEqual(["index-stale", "index-current"]);
  });

  it("migrates Chrome packs only after the first GitHub upload succeeds", async () => {
    installChromeStorageStub({}, {});
    const saved = await saveWeirpack({ name: "small.weirpack", bytes: Uint8Array.from([1, 2, 3]) });
    const client = emptyClient();

    await enableGitHubWeirpackSync({ settings, client, now: () => 700 });

    expect((await chrome.storage.sync.get(WEIRPACK_SYNC_SETTINGS_KEY))[WEIRPACK_SYNC_SETTINGS_KEY])
      .toEqual({ githubEnabled: true, hasUsedGitHub: true });
    expect((await chrome.storage.sync.get(WEIRPACK_INDEX_KEY))[WEIRPACK_INDEX_KEY]).toEqual([]);
    expect(await loadWeirpacks()).toEqual([
      expect.objectContaining({ id: saved.id, bytes: Uint8Array.from([1, 2, 3]) }),
    ]);
  });

  it("keeps GitHub mode enabled when a pack cannot fit back into Chrome sync", async () => {
    installChromeStorageStub({
      [WEIRPACK_SYNC_SETTINGS_KEY]: { githubEnabled: true, hasUsedGitHub: true },
    });
    const large = await pack(new Uint8Array(5601), { name: "large.weirpack" });

    await expect(disableGitHubWeirpackSync({ loadLocalPacks: async () => [large] }))
      .rejects.toThrow(/too large for Chrome sync/i);
    expect((await chrome.storage.sync.get(WEIRPACK_SYNC_SETTINGS_KEY))[WEIRPACK_SYNC_SETTINGS_KEY])
      .toEqual({ githubEnabled: true, hasUsedGitHub: true });
  });
});
