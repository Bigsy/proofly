// Service-worker harness — evaluates background.js (a side-effect module,
// like sidepanel.js/page/content/index.js) against a scripted `chrome` stub
// covering the SW surface: scripting registration (with Chrome's real
// duplicate/nonexistent-ID throw semantics — the reconcile overlap bug this
// suite guards against only shows up under them), permissions, tabs, action,
// and the runtime/storage events. Storage areas reuse the shared stub.
//
// jsdom lacks OffscreenCanvas/createImageBitmap, so grayIcons() always falls
// back to null (colour icon + OFF badge) — icon tests assert that fallback
// path, never ImageData.

import { vi } from "vitest";
import { makeStorageArea } from "./chrome-storage.js";

function makeEmitter() {
  const listeners = new Set();
  return {
    addListener: vi.fn((fn) => listeners.add(fn)),
    removeListener: vi.fn((fn) => listeners.delete(fn)),
    hasListener: (fn) => listeners.has(fn),
    async emit(...args) {
      for (const fn of [...listeners]) await fn(...args);
    },
  };
}

// pattern "https://host/*" ⊇ url — the only registration match shape the SW uses.
function urlMatches(pattern, url) {
  return typeof url === "string" && pattern.endsWith("/*")
    && url.startsWith(pattern.slice(0, -1));
}

export function makeChromeWorkerStub({
  sync = {},
  local = {},
  granted = [],
  registered = [],
  tabs = [],
  locale = "en-US",
} = {}) {
  const onChanged = makeEmitter();
  const registry = new Map(registered.map((s) => [s.id, structuredClone(s)]));
  const origins = new Set(granted);
  const tabList = tabs.map((t) => ({ ...t }));
  const sentMessages = [];      // every tabs.sendMessage: { tabId, message }
  const injected = [];          // every scripting.executeScript call
  const actionCalls = [];       // every chrome.action.* call: { method, args }
  const offscreenDocuments = [];
  const runtimeMessages = [];
  const hasOrigin = (origin) => origins.has(origin)
    || (origin !== "*://*/*" && origins.has("*://*/*"));

  const chrome = {
    storage: {
      sync: makeStorageArea(sync, { areaName: "sync", onChanged }),
      local: makeStorageArea(local, { areaName: "local", onChanged }),
      onChanged,
    },
    permissions: {
      onAdded: makeEmitter(),
      onRemoved: makeEmitter(),
      getAll: vi.fn(async () => ({ origins: [...origins] })),
      contains: vi.fn(async ({ origins: asked = [] } = {}) =>
        asked.every(hasOrigin)),
    },
    scripting: {
      getRegisteredContentScripts: vi.fn(async () =>
        [...registry.values()].map((s) => structuredClone(s))),
      registerContentScripts: vi.fn(async (scripts) => {
        for (const s of scripts) {
          if (registry.has(s.id)) throw new Error(`Duplicate script ID '${s.id}'`);
        }
        for (const s of scripts) registry.set(s.id, structuredClone(s));
      }),
      unregisterContentScripts: vi.fn(async ({ ids = [] } = {}) => {
        for (const id of ids) {
          if (!registry.has(id)) throw new Error(`Nonexistent script ID '${id}'`);
        }
        for (const id of ids) registry.delete(id);
      }),
      executeScript: vi.fn(async (call) => {
        injected.push(structuredClone(call));
        return [];
      }),
    },
    tabs: {
      onActivated: makeEmitter(),
      onUpdated: makeEmitter(),
      query: vi.fn(async (filter = {}) =>
        (filter.url ? tabList.filter((t) => urlMatches(filter.url, t.url)) : [...tabList])
          .map((t) => ({ ...t }))),
      get: vi.fn(async (tabId) => {
        const tab = tabList.find((t) => t.id === tabId);
        if (!tab) throw new Error(`No tab with id ${tabId}`);
        return { ...tab };
      }),
      sendMessage: vi.fn(async (tabId, message) => {
        sentMessages.push({ tabId, message: structuredClone(message) });
      }),
    },
    action: Object.fromEntries(
      ["setIcon", "setBadgeText", "setBadgeBackgroundColor", "setTitle"].map((method) => [
        method,
        vi.fn(async (args) => { actionCalls.push({ method, args: structuredClone(args) }); }),
      ]),
    ),
    runtime: {
      onInstalled: makeEmitter(),
      onStartup: makeEmitter(),
      onMessage: makeEmitter(),
      getURL: (path) => `chrome-extension://proofly-test/${path}`,
      getContexts: vi.fn(async () => offscreenDocuments.map((documentUrl) => ({ documentUrl }))),
      sendMessage: vi.fn(async (message) => {
        runtimeMessages.push(structuredClone(message));
        if (message.type === "harper:configure") {
          return {
            type: "harper:configured",
            dialect: message.dialect,
            configurationRevision: message.configurationRevision,
          };
        }
        if (message.type === "harper:lint") {
          return { type: "harper:result", requestId: message.requestId, corrections: [] };
        }
        return { type: "harper:status", state: "ready" };
      }),
    },
    i18n: { getUILanguage: vi.fn(() => locale) },
    offscreen: {
      createDocument: vi.fn(async ({ url }) => {
        offscreenDocuments.push(`chrome-extension://proofly-test/${url}`);
      }),
    },
  };

  return {
    chrome,
    registryIds: () => [...registry.keys()].sort(),
    registration: (id) => structuredClone(registry.get(id) ?? null),
    grant: (o) => origins.add(o),
    revoke: (o) => origins.delete(o),
    sentMessages,
    injected,
    actionCalls,
    offscreenDocuments,
    runtimeMessages,
    // The last action state applied to a tab: { setBadgeText: {...}, ... }
    lastActionByTab(tabId) {
      const out = {};
      for (const { method, args } of actionCalls) {
        if (args?.tabId === tabId) out[method] = args;
      }
      return out;
    },
  };
}

// Import background.js fresh against the given stub. The module's top-level
// reconcile + icon refresh run on import; settle() lets them finish.
export async function loadBackgroundWorker(stub) {
  globalThis.chrome = stub.chrome;
  // grayIcons' fetch of a chrome-extension:// URL must fail fast and
  // deterministically in jsdom (its catch → colour-icon fallback).
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
  vi.resetModules();
  const mod = await import("../../background.js");
  await settle();
  return mod;
}

export async function settle(hops = 50) {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}
