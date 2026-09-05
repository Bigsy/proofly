// background.js — the registration/permission reconciler, the teardown
// broadcast, adoption of grants into intent, and per-tab icon state. The SW
// is the most security-sensitive code in the repo: these tests pin the
// invariant that registrations always equal { intent ∩ granted } and that
// per-site scope never widens.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ALL_SITES_PATTERN, SITES_KEY } from "../lib/sites.js";
import {
  DICTIONARY_SYNC_SET, PAGE_ADAPTER_FLAGS_CHANGED, PAGE_DICTIONARY_CHANGED, PAGE_DICTIONARY_UPDATE,
  PAGE_PROOFING_SETTINGS_CHANGED, PAGE_RULE_DISABLE, PAGE_STORAGE_GET,
} from "../lib/storage-broker.js";
import { EDITOR_ADAPTER_FLAGS_KEY } from "../page/content/adapter-flags.js";
import {
  DICTIONARY_SETTINGS_KEY, LOCAL_DICTIONARY_KEY, loadDictionary,
} from "../lib/dictionary-store.js";
import {
  WEIRPACK_INDEX_KEY, WEIRPACK_KEY_PREFIX,
} from "../lib/weirpack-store.js";
import { WEIRPACK_SYNC_SETTINGS_KEY } from "../lib/weirpack-sync-settings.js";
import { loadBackgroundWorker, makeChromeWorkerStub, settle } from "./helpers/background-worker.js";

const GH = "https://github.com/*";
const EX = "https://example.com/*";

afterEach(() => {
  vi.unstubAllGlobals();
  delete globalThis.chrome;
});

describe("trusted storage boundary", () => {
  it("restricts both storage areas before serving a sanitized page snapshot", async () => {
    const stub = makeChromeWorkerStub({
      sync: {
        customDictionary: ["Proofly", 42, "Acme"],
        proofingSettings: { dialect: "british" },
        notesSyncSettings: {
          owner: "private-owner", repo: "private-notes", branch: "main", token: "github_pat_private",
        },
      },
      local: {
        "note:private": { id: "private", body: "never send this" },
        [EDITOR_ADAPTER_FLAGS_KEY]: { adapters: { quill: false } },
      },
    });
    const { handlePageStorageRequest } = await loadBackgroundWorker(stub);

    expect(stub.chrome.storage.sync.setAccessLevel)
      .toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
    expect(stub.chrome.storage.local.setAccessLevel)
      .toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });

    const response = await handlePageStorageRequest({ type: PAGE_STORAGE_GET });
    expect(response).toMatchObject({
      ok: true,
      dictionary: ["Acme", "Proofly"],
      proofingSettings: { dialect: "british" },
      editorAdapterFlags: { adapters: { quill: false } },
    });
    expect(JSON.stringify(response)).not.toContain("github_pat_private");
    expect(JSON.stringify(response)).not.toContain("never send this");
    expect(response).not.toHaveProperty("notesSyncSettings");
  });

  it("allows only validated dictionary operations through the page boundary", async () => {
    const stub = makeChromeWorkerStub({ sync: { customDictionary: ["Proofly"] } });
    const { handlePageStorageRequest } = await loadBackgroundWorker(stub);

    await expect(handlePageStorageRequest({
      type: PAGE_DICTIONARY_UPDATE,
      operation: "add",
      words: ["  Acme ", "two words", 42],
    })).resolves.toEqual({ ok: true, dictionary: ["Acme", "Proofly"] });
    expect(await loadDictionary()).toEqual(["Acme", "Proofly"]);
    expect(await stub.chrome.storage.sync.get("customDictionary"))
      .toEqual({ customDictionary: ["Proofly"] }); // untouched migration base

    await expect(handlePageStorageRequest({
      type: PAGE_DICTIONARY_UPDATE, operation: "replace", words: ["bad"],
    })).rejects.toThrow(/Unknown dictionary operation/);
  });

  it("serializes simultaneous local additions before writing one browser actor", async () => {
    const stub = makeChromeWorkerStub();
    const { handlePageStorageRequest } = await loadBackgroundWorker(stub);

    await Promise.all([
      handlePageStorageRequest({
        type: PAGE_DICTIONARY_UPDATE, operation: "add", words: ["alpha"],
      }),
      handlePageStorageRequest({
        type: PAGE_DICTIONARY_UPDATE, operation: "add", words: ["beta"],
      }),
    ]);

    expect(await loadDictionary()).toEqual(["alpha", "beta"]);
  });

  it("switches to a copied browser-only dictionary through the trusted broker", async () => {
    const stub = makeChromeWorkerStub({ sync: { customDictionary: ["Proofly"] } });
    const { handlePageStorageRequest } = await loadBackgroundWorker(stub);

    await expect(handlePageStorageRequest({
      type: DICTIONARY_SYNC_SET, enabled: false,
    })).resolves.toEqual({ ok: true, dictionary: ["Proofly"] });
    const local = await stub.chrome.storage.local.get([
      DICTIONARY_SETTINGS_KEY, LOCAL_DICTIONARY_KEY,
    ]);
    expect(local).toEqual({
      [DICTIONARY_SETTINGS_KEY]: { syncEnabled: false },
      [LOCAL_DICTIONARY_KEY]: ["Proofly"],
    });
  });

  it("broadcasts only sanitized changes needed by live content scripts", async () => {
    const stub = makeChromeWorkerStub({ tabs: [{ id: 7, url: "https://example.com/" }] });
    await loadBackgroundWorker(stub);

    await stub.chrome.storage.sync.set({ customDictionary: ["Proofly", 42] });
    await stub.chrome.storage.sync.set({ proofingSettings: { dialect: "canadian" } });
    await stub.chrome.storage.local.set({
      [EDITOR_ADAPTER_FLAGS_KEY]: { adapters: { quill: false } },
    });
    await settle();

    expect(stub.sentMessages).toHaveLength(3);
    const byType = Object.fromEntries(stub.sentMessages.map(({ tabId, message }) => [
      message.type, { tabId, message },
    ]));
    expect(byType[PAGE_DICTIONARY_CHANGED]).toEqual({
      tabId: 7,
      message: { type: PAGE_DICTIONARY_CHANGED, dictionary: ["Proofly"] },
    });
    expect(byType[PAGE_PROOFING_SETTINGS_CHANGED]).toEqual({
      tabId: 7,
      message: {
        type: PAGE_PROOFING_SETTINGS_CHANGED,
        proofingSettings: { dialect: "canadian" },
      },
    });
    expect(byType[PAGE_ADAPTER_FLAGS_CHANGED]).toEqual({
      tabId: 7,
      message: {
        type: PAGE_ADAPTER_FLAGS_CHANGED,
        editorAdapterFlags: expect.objectContaining({
          adapters: expect.objectContaining({ quill: false }),
        }),
      },
    });
  });
});

describe("reconcile: registrations = intent ∩ granted", () => {
  it("registers exactly the intended-and-granted sites on worker spin-up", async () => {
    const stub = makeChromeWorkerStub({
      sync: { [SITES_KEY]: { [GH]: true, [EX]: true } },
      granted: [GH], // example.com intended on another device, not granted here
    });
    await loadBackgroundWorker(stub);

    expect(stub.registryIds()).toEqual([`proofly-page:${GH}`]);
    const reg = stub.registration(`proofly-page:${GH}`);
    expect(reg.matches).toEqual([GH]);
    expect(reg.js).toEqual(["page/content/bootstrap.js"]);
    expect(reg.allFrames).toBe(true);
    expect(reg.matchOriginAsFallback).toBe(true);
    expect(reg.runAt).toBe("document_idle");
  });

  it("treats an all-site grant as permission for each intended site", async () => {
    const stub = makeChromeWorkerStub({
      sync: { [SITES_KEY]: { [GH]: true, [EX]: true } },
      granted: [ALL_SITES_PATTERN],
    });
    await loadBackgroundWorker(stub);

    expect(stub.registryIds()).toEqual([
      `proofly-page:${EX}`,
      `proofly-page:${GH}`,
    ]);
  });

  it("removes stale and drifted registrations, leaves foreign ids alone", async () => {
    const stale = { // ours, but intent is gone
      id: `proofly-page:${EX}`, matches: [EX], js: ["page/content/bootstrap.js"],
      runAt: "document_idle", allFrames: true, matchOriginAsFallback: true,
    };
    const drifted = { // ours and intended, but registered with an old shape
      id: `proofly-page:${GH}`, matches: [GH], js: ["old/entry.js"],
      runAt: "document_idle", allFrames: true, matchOriginAsFallback: true,
    };
    const foreign = { id: "some-other-extension-script", matches: ["<all_urls>"], js: ["x.js"] };
    const stub = makeChromeWorkerStub({
      sync: { [SITES_KEY]: { [GH]: true } },
      granted: [GH, EX],
      registered: [stale, drifted, foreign],
    });
    await loadBackgroundWorker(stub);

    expect(stub.registryIds()).toEqual([`proofly-page:${GH}`, "some-other-extension-script"]);
    expect(stub.registration(`proofly-page:${GH}`).js).toEqual(["page/content/bootstrap.js"]);
  });

  it("serializes overlapping reconcile triggers — no Duplicate/Nonexistent script ID throws", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const stub = makeChromeWorkerStub({ granted: [GH] });
      await loadBackgroundWorker(stub);
      // One user action fans out: the sync write fires storage.onChanged AND
      // the events below, all reconciling concurrently.
      stub.grant(GH);
      await Promise.all([
        stub.chrome.storage.sync.set({ [SITES_KEY]: { [GH]: true } }),
        stub.chrome.permissions.onAdded.emit({ origins: [GH] }),
        stub.chrome.runtime.onStartup.emit(),
      ]);
      await settle();

      expect(stub.registryIds()).toEqual([`proofly-page:${GH}`]);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});

describe("Harper offscreen lifecycle", () => {
  it("uses one creation promise for concurrent callers and reuses the document", async () => {
    const stub = makeChromeWorkerStub();
    const { ensureHarperOffscreen } = await loadBackgroundWorker(stub);

    await Promise.all([ensureHarperOffscreen(), ensureHarperOffscreen(), ensureHarperOffscreen()]);
    await ensureHarperOffscreen();

    expect(stub.chrome.offscreen.createDocument).toHaveBeenCalledTimes(1);
    expect(stub.offscreenDocuments).toEqual([
      "chrome-extension://proofly-test/offscreen.html",
    ]);
  });

  it("stamps lint requests from synced Auto dialect and dictionary state", async () => {
    const stub = makeChromeWorkerStub({
      locale: "en-GB",
      sync: { proofingSettings: { dialect: "auto" }, customDictionary: ["Proofly", "Acme"] },
    });
    const { forwardHarperRequest } = await loadBackgroundWorker(stub);
    const result = await forwardHarperRequest({ type: "harper:lint", requestId: 7, text: "colur" });

    const [configure, lint] = stub.runtimeMessages;
    expect(configure).toMatchObject({
      type: "harper:configure", target: "harper:offscreen", dialect: "british",
      words: ["Acme", "Proofly"],
      ruleOverrides: { LongSentences: false, AvoidCurses: false },
      weirpacks: [],
    });
    expect(lint).toMatchObject({
      type: "harper:lint", target: "harper:offscreen", requestId: 7,
      dialect: "british", configurationRevision: configure.configurationRevision,
    });
    expect(result).toEqual({ type: "harper:result", requestId: 7, corrections: [] });
  });

  it("passes complete synced Weirpack bytes only to the trusted Harper host", async () => {
    const id = "0123456789abcdef0123456789abcdef";
    const bytes = [80, 75, 3, 4];
    const stub = makeChromeWorkerStub({
      sync: {
        [WEIRPACK_INDEX_KEY]: [{
          id, name: "acme.weirpack", size: bytes.length,
          author: "Bill", version: "1.0.0", description: "",
        }],
        [`${WEIRPACK_KEY_PREFIX}${id}`]: {
          data: btoa(String.fromCharCode(...bytes)),
        },
      },
    });
    const { forwardHarperRequest, handlePageStorageRequest } = await loadBackgroundWorker(stub);
    await forwardHarperRequest({ type: "harper:lint", requestId: 8, text: "acme" });

    expect(stub.runtimeMessages[0]).toMatchObject({
      type: "harper:configure",
      weirpacks: [{ id, bytes }],
    });
    const pageSnapshot = await handlePageStorageRequest({ type: PAGE_STORAGE_GET });
    expect(pageSnapshot).not.toHaveProperty("weirpacks");
    expect(JSON.stringify(pageSnapshot)).not.toContain("acme.weirpack");
  });

  it("configures Harper from the local working copy in GitHub Weirpack mode", async () => {
    const id = "0123456789abcdef0123456789abcdef";
    const bytes = [80, 75, 3, 4, 5];
    const stub = makeChromeWorkerStub({
      sync: {
        [WEIRPACK_SYNC_SETTINGS_KEY]: { githubEnabled: true, hasUsedGitHub: true },
      },
      local: {
        [WEIRPACK_INDEX_KEY]: [{
          id, name: "large.weirpack", size: bytes.length,
          author: "", version: "", description: "", updatedAt: 10,
        }],
        [`${WEIRPACK_KEY_PREFIX}${id}`]: { data: btoa(String.fromCharCode(...bytes)) },
      },
    });
    const { forwardHarperRequest } = await loadBackgroundWorker(stub);

    await forwardHarperRequest({ type: "harper:lint", requestId: 9, text: "term" });

    expect(stub.runtimeMessages[0]).toMatchObject({
      type: "harper:configure",
      weirpacks: [{ id, bytes }],
    });
  });

  it("reconfigures an existing worker on dictionary/settings changes without creating one eagerly", async () => {
    const stub = makeChromeWorkerStub();
    const { ensureHarperOffscreen } = await loadBackgroundWorker(stub);

    await stub.chrome.storage.sync.set({ customDictionary: ["Proofly"] });
    await settle();
    expect(stub.chrome.offscreen.createDocument).not.toHaveBeenCalled();

    await ensureHarperOffscreen();
    stub.runtimeMessages.length = 0;
    await stub.chrome.storage.sync.set({ proofingSettings: { dialect: "indian" } });
    await settle();
    expect(stub.runtimeMessages.at(-1)).toMatchObject({
      type: "harper:configure", dialect: "indian", words: ["Proofly"],
    });
  });

  it("reconfigures and retries stale_configuration once inside the background boundary", async () => {
    const stub = makeChromeWorkerStub({ sync: { proofingSettings: { dialect: "british" } } });
    const { forwardHarperRequest } = await loadBackgroundWorker(stub);
    let lintCalls = 0;
    stub.chrome.runtime.sendMessage.mockImplementation(async (message) => {
      if (message.type === "harper:configure") {
        return {
          type: "harper:configured",
          dialect: message.dialect,
          configurationRevision: message.configurationRevision,
        };
      }
      lintCalls += 1;
      if (lintCalls === 1) {
        return { type: "harper:error", requestId: message.requestId, error: { code: "stale_configuration" } };
      }
      return { type: "harper:result", requestId: message.requestId, corrections: [] };
    });

    expect(await forwardHarperRequest({ type: "harper:lint", scopeId: "panel", requestId: 9, text: "bad" }))
      .toEqual({ type: "harper:result", requestId: 9, corrections: [] });
    expect(stub.chrome.runtime.sendMessage.mock.calls.map(([message]) => message.type))
      .toEqual(["harper:configure", "harper:lint", "harper:configure", "harper:lint"]);
  });

  it("contains storage-driven reconfiguration failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const stub = makeChromeWorkerStub();
      const { ensureHarperOffscreen } = await loadBackgroundWorker(stub);
      await ensureHarperOffscreen();
      stub.chrome.runtime.sendMessage.mockRejectedValue(new Error("offscreen went away"));

      await stub.chrome.storage.sync.set({ customDictionary: ["Proofly"] });
      await settle();

      expect(warn).toHaveBeenCalledWith(
        "Harper storage reconfiguration failed:", expect.any(Error),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("permissions.onAdded", () => {
  it("adopts a per-site grant into synced intent, registers, and injects into open tabs", async () => {
    const stub = makeChromeWorkerStub({
      tabs: [
        { id: 1, url: "https://github.com/anthropics" },
        { id: 2, url: "https://example.com/" },
      ],
    });
    await loadBackgroundWorker(stub);

    stub.grant(GH);
    await stub.chrome.permissions.onAdded.emit({ origins: [GH] });
    await settle();

    const { [SITES_KEY]: intent } = await stub.chrome.storage.sync.get(SITES_KEY);
    expect(intent).toEqual({ [GH]: true });
    expect(stub.registryIds()).toEqual([`proofly-page:${GH}`]);
    // Injected into the already-open github tab only, all frames.
    expect(stub.injected).toEqual([{
      target: { tabId: 1, allFrames: true },
      files: ["page/content/bootstrap.js"],
    }]);
  });

  it("never adopts broad grants — per-site scope must not widen", async () => {
    const stub = makeChromeWorkerStub();
    await loadBackgroundWorker(stub);

    stub.grant("*://*/*");
    stub.grant("https://*/*");
    await stub.chrome.permissions.onAdded.emit({ origins: ["*://*/*", "https://*/*"] });
    await settle();

    expect(await stub.chrome.storage.sync.get(SITES_KEY)).toEqual({});
    expect(stub.registryIds()).toEqual([]);
    expect(stub.injected).toEqual([]);
  });

  it("uses a broad grant to activate existing synced intent without widening it", async () => {
    const stub = makeChromeWorkerStub({
      sync: { [SITES_KEY]: { [GH]: true } },
      tabs: [
        { id: 1, url: "https://github.com/anthropics" },
        { id: 2, url: "https://example.com/" },
      ],
    });
    await loadBackgroundWorker(stub);

    stub.grant(ALL_SITES_PATTERN);
    await stub.chrome.permissions.onAdded.emit({ origins: [ALL_SITES_PATTERN] });
    await settle();

    expect(await stub.chrome.storage.sync.get(SITES_KEY))
      .toEqual({ [SITES_KEY]: { [GH]: true } });
    expect(stub.registryIds()).toEqual([`proofly-page:${GH}`]);
    expect(stub.injected).toEqual([{
      target: { tabId: 1, allFrames: true },
      files: ["page/content/bootstrap.js"],
    }]);
  });
});

describe("disable paths", () => {
  it("permission removal unregisters and broadcasts teardown to every tab", async () => {
    const stub = makeChromeWorkerStub({
      sync: { [SITES_KEY]: { [GH]: true } },
      granted: [GH],
      tabs: [{ id: 1, url: "https://github.com/x" }, { id: 2, url: "https://example.com/" }],
    });
    await loadBackgroundWorker(stub);
    expect(stub.registryIds()).toEqual([`proofly-page:${GH}`]);

    stub.revoke(GH);
    await stub.chrome.permissions.onRemoved.emit({ origins: [GH] });
    await settle();

    expect(stub.registryIds()).toEqual([]);
    // Broadcast (can't query by URL — the permission is gone): both tabs get
    // the message, each content script checks the pattern itself.
    expect(stub.sentMessages).toEqual([
      { tabId: 1, message: { type: "proofly:teardown", pattern: GH } },
      { tabId: 2, message: { type: "proofly:teardown", pattern: GH } },
    ]);
  });

  it("expands removal of broad access into per-site teardown messages", async () => {
    const stub = makeChromeWorkerStub({
      sync: { [SITES_KEY]: { [GH]: true, [EX]: true } },
      granted: [ALL_SITES_PATTERN],
      tabs: [{ id: 1, url: "https://github.com/x" }, { id: 2, url: "https://example.com/" }],
    });
    await loadBackgroundWorker(stub);
    expect(stub.registryIds()).toHaveLength(2);

    stub.revoke(ALL_SITES_PATTERN);
    await stub.chrome.permissions.onRemoved.emit({ origins: [ALL_SITES_PATTERN] });
    await settle();

    expect(stub.registryIds()).toEqual([]);
    expect(stub.sentMessages).toEqual([
      { tabId: 1, message: { type: "proofly:teardown", pattern: GH } },
      { tabId: 1, message: { type: "proofly:teardown", pattern: EX } },
      { tabId: 2, message: { type: "proofly:teardown", pattern: GH } },
      { tabId: 2, message: { type: "proofly:teardown", pattern: EX } },
    ]);
  });

  it("intent dropped on another device unregisters here and tears down live tabs", async () => {
    const stub = makeChromeWorkerStub({
      sync: { [SITES_KEY]: { [GH]: true } },
      granted: [GH],
      tabs: [{ id: 7, url: "https://github.com/x" }],
    });
    await loadBackgroundWorker(stub);
    expect(stub.registryIds()).toEqual([`proofly-page:${GH}`]);

    await stub.chrome.storage.sync.set({ [SITES_KEY]: {} }); // synced from elsewhere
    await settle();

    expect(stub.registryIds()).toEqual([]);
    expect(stub.sentMessages).toEqual([
      { tabId: 7, message: { type: "proofly:teardown", pattern: GH } },
    ]);
  });

  it("injects newly synced intent immediately when broad access already exists", async () => {
    const stub = makeChromeWorkerStub({
      granted: [ALL_SITES_PATTERN],
      tabs: [{ id: 7, url: "https://github.com/x" }],
    });
    await loadBackgroundWorker(stub);

    await stub.chrome.storage.sync.set({ [SITES_KEY]: { [GH]: true } });
    await settle();

    expect(stub.registryIds()).toEqual([`proofly-page:${GH}`]);
    expect(stub.injected).toEqual([{
      target: { tabId: 7, allFrames: true },
      files: ["page/content/bootstrap.js"],
    }]);
  });

  it("ignores non-sync storage areas and unrelated keys", async () => {
    const stub = makeChromeWorkerStub({
      sync: { [SITES_KEY]: { [GH]: true } },
      granted: [GH],
      tabs: [{ id: 1, url: "https://github.com/x" }],
    });
    await loadBackgroundWorker(stub);

    await stub.chrome.storage.local.set({ notesSyncSettings: { owner: "x" } });
    await stub.chrome.storage.sync.set({ someOtherKey: 1 });
    await settle();

    expect(stub.registryIds()).toEqual([`proofly-page:${GH}`]);
    expect(stub.sentMessages).toEqual([]);
  });
});

describe("per-tab icon state", () => {
  it("shows the ON state (colour icon, no badge, host in the title) on enabled sites", async () => {
    const stub = makeChromeWorkerStub({
      sync: { [SITES_KEY]: { [GH]: true } },
      granted: [GH],
      tabs: [{ id: 1, url: "https://github.com/anthropics" }],
    });
    await loadBackgroundWorker(stub);

    const state = stub.lastActionByTab(1);
    expect(state.setIcon.path).toBeTruthy(); // colour icons
    expect(state.setBadgeText.text).toBe("");
    expect(state.setTitle.title).toContain("github.com");
  });

  it("shows OFF (badge) for ungranted, unintended, and un-proofreadable tabs alike", async () => {
    const stub = makeChromeWorkerStub({
      sync: { [SITES_KEY]: { [GH]: true, [EX]: true } },
      granted: [GH],
      tabs: [
        { id: 2, url: "https://example.com/" }, // intended, not granted here
        { id: 3, url: "https://other.net/" },   // neither
        { id: 4, url: "chrome://extensions" },  // can't host the feature
      ],
    });
    await loadBackgroundWorker(stub);

    for (const tabId of [2, 3, 4]) {
      const state = stub.lastActionByTab(tabId);
      expect(state.setBadgeText.text, `tab ${tabId}`).toBe("OFF");
      // jsdom has no OffscreenCanvas — gray generation falls back to colour.
      expect(state.setIcon.path).toBeTruthy();
    }
  });

  it("updates the icon when a tab navigates or is activated", async () => {
    const stub = makeChromeWorkerStub({
      sync: { [SITES_KEY]: { [GH]: true } },
      granted: [GH],
      tabs: [{ id: 5, url: "https://other.net/" }],
    });
    await loadBackgroundWorker(stub);
    expect(stub.lastActionByTab(5).setBadgeText.text).toBe("OFF");

    await stub.chrome.tabs.onUpdated.emit(5, { url: "https://github.com/pull/1" }, {
      id: 5, url: "https://github.com/pull/1",
    });
    await settle();
    expect(stub.lastActionByTab(5).setBadgeText.text).toBe("");

    stub.actionCalls.length = 0;
    await stub.chrome.tabs.onActivated.emit({ tabId: 5 });
    await settle();
    // onActivated re-reads the tab from chrome.tabs — still other.net there.
    expect(stub.lastActionByTab(5).setBadgeText.text).toBe("OFF");
  });
});

it("serializes rule disables, preserves other preferences, and returns no private data", async () => {
  const stub = makeChromeWorkerStub({ sync: {
    proofingSettings: { dialect: "british", ruleOverrides: { FutureRule: true } },
    notesSyncSettings: { token: "private" },
  } });
  const { handlePageStorageRequest, forwardHarperRequest } = await loadBackgroundWorker(stub);
  expect(await Promise.all(["AvoidCurses", "SpellCheck"].map((rule) =>
    handlePageStorageRequest({ type: PAGE_RULE_DISABLE, rule, dialect: "american" })))).toEqual([{ ok: true }, { ok: true }]);
  expect(await stub.chrome.storage.sync.get("proofingSettings")).toEqual({ proofingSettings: {
    dialect: "british", ruleOverrides: { FutureRule: true, AvoidCurses: false, SpellCheck: false },
  } });
  await forwardHarperRequest({ type: "harper:lint", requestId: 99, text: "test" });
  expect(stub.runtimeMessages.filter((m) => m.type === "harper:configure").at(-1).ruleOverrides)
    .toMatchObject({ AvoidCurses: false, SpellCheck: false, LongSentences: false });
  for (const rule of [null, "", "__proto__", "not a rule", 123]) {
    await expect(handlePageStorageRequest({ type: PAGE_RULE_DISABLE, rule })).rejects.toThrow("Invalid Harper rule");
  }
});
