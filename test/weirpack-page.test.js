import { beforeEach, describe, expect, it, vi } from "vitest";
import { initWeirpackPage } from "../ui/weirpack-page.js";

const $ = (id) => document.getElementById(id);

function elements() {
  document.body.innerHTML = `
    <label id="syncWrap" hidden><input id="syncToggle" type="checkbox"><span id="syncStatus"></span></label>
    <input id="file" type="file">
    <button id="import"></button>
    <span id="status"></span>
    <p id="empty"></p>
    <ul id="list"></ul>
  `;
  return {
    file: $("file"), importBtn: $("import"), status: $("status"),
    empty: $("empty"), list: $("list"), syncWrap: $("syncWrap"),
    syncToggle: $("syncToggle"), syncStatus: $("syncStatus"),
  };
}

function makeStore(initial = []) {
  let packs = initial;
  let listener = () => {};
  return {
    loadWeirpackIndex: vi.fn(async () => packs),
    saveWeirpack: vi.fn(async ({ name, bytes, manifest }) => {
      const entry = { id: "a".repeat(32), name, size: bytes.length, ...manifest };
      packs = [entry];
      listener(packs);
      return entry;
    }),
    removeWeirpack: vi.fn(async () => {
      packs = [];
      listener(packs);
      return packs;
    }),
    onWeirpacksChanged: vi.fn((callback) => {
      listener = callback;
      return () => {};
    }),
  };
}

beforeEach(() => { document.body.innerHTML = ""; });

describe("Weirpack options page", () => {
  it("validates, saves, and renders an imported pack", async () => {
    const els = elements();
    const store = makeStore();
    const validate = vi.fn(async () => ({
      author: "Bill", version: "1.0.0", description: "Acme vocabulary",
    }));
    const page = initWeirpackPage({ els, store, validate });
    await page.ready;
    const file = {
      name: "acme.weirpack",
      size: 4,
      arrayBuffer: async () => Uint8Array.from([80, 75, 3, 4]).buffer,
    };
    Object.defineProperty(els.file, "files", { configurable: true, value: [file] });

    els.file.dispatchEvent(new Event("change"));
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(validate).toHaveBeenCalledWith(Uint8Array.from([80, 75, 3, 4]));
    expect(store.saveWeirpack).toHaveBeenCalled();
    expect(els.list.textContent).toContain("acme.weirpack · Bill · v1.0.0");
    expect(els.list.textContent).toContain("Acme vocabulary");
    expect(els.status.textContent).toBe("Imported acme.weirpack.");
  });

  it("surfaces validation failures without saving", async () => {
    const els = elements();
    const store = makeStore();
    const validate = vi.fn(async () => { throw new Error("embedded tests failed"); });
    const page = initWeirpackPage({ els, store, validate });
    await page.ready;
    Object.defineProperty(els.file, "files", {
      configurable: true,
      value: [{
        name: "bad.weirpack", size: 1,
        arrayBuffer: async () => Uint8Array.from([1]).buffer,
      }],
    });

    els.file.dispatchEvent(new Event("change"));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(store.saveWeirpack).not.toHaveBeenCalled();
    expect(els.status.textContent).toContain("embedded tests failed");
    expect(els.status.classList.contains("error")).toBe(true);
  });

  it("shows the GitHub toggle only when connected and enables it through migration", async () => {
    const els = elements();
    const store = makeStore();
    store.maxWeirpackFileBytes = vi.fn(async () => 25 * 1024 * 1024);
    const enable = vi.fn(async () => ({ ok: true }));
    const page = initWeirpackPage({
      els,
      store,
      validate: vi.fn(),
      githubSettingsStore: {
        loadSyncSettings: vi.fn(async () => ({ owner: "me", repo: "proofly", token: "secret" })),
      },
      syncModeStore: {
        loadWeirpackSyncSettings: vi.fn(async () => ({ githubEnabled: false, hasUsedGitHub: false })),
      },
      syncActions: { enable },
    });
    await page.ready;

    expect(els.syncWrap.hidden).toBe(false);
    expect(els.syncStatus.textContent).toContain("5,600-byte");
    els.syncToggle.checked = true;
    els.syncToggle.dispatchEvent(new Event("change"));

    await vi.waitFor(() => expect(enable).toHaveBeenCalledWith({
      settings: { owner: "me", repo: "proofly", token: "secret" },
    }));
    await vi.waitFor(() => expect(els.status.textContent)
      .toBe("Weirpacks are now synced with GitHub."));
    expect(els.syncToggle.checked).toBe(true);
    expect(els.syncStatus.textContent).toContain("larger packs");
  });

  it("accepts a pack over the Chrome limit in GitHub mode and syncs it immediately", async () => {
    const els = elements();
    const store = makeStore();
    store.maxWeirpackFileBytes = vi.fn(async () => 25 * 1024 * 1024);
    const sync = vi.fn(async () => ({ ok: true }));
    const configured = { owner: "me", repo: "proofly", token: "secret" };
    const page = initWeirpackPage({
      els,
      store,
      validate: vi.fn(async () => ({})),
      githubSettingsStore: { loadSyncSettings: vi.fn(async () => configured) },
      syncModeStore: {
        loadWeirpackSyncSettings: vi.fn(async () => ({ githubEnabled: true, hasUsedGitHub: true })),
      },
      syncActions: { sync },
    });
    await page.ready;
    Object.defineProperty(els.file, "files", {
      configurable: true,
      value: [{
        name: "large.weirpack",
        size: 6_000,
        arrayBuffer: async () => Uint8Array.from([80, 75, 3, 4]).buffer,
      }],
    });

    els.file.dispatchEvent(new Event("change"));

    await vi.waitFor(() => expect(sync).toHaveBeenCalledWith({ settings: configured }));
    expect(store.saveWeirpack).toHaveBeenCalled();
    expect(els.status.textContent).toBe("Imported large.weirpack.");
  });
});
