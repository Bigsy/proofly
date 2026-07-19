// jsdom gap: no `chrome` global. A stub of the chrome.storage subset the app
// uses — chrome.storage.sync (custom rewrite prompts, custom dictionary),
// chrome.storage.local (notes), and chrome.storage.onChanged. Shared by the
// side panel harness (helpers/page.js) and the content-script harness
// (helpers/content-page.js).
//
// Values are structuredClone'd both ways like the real (serializing) API, so
// tests catch mutate-by-reference bugs and exercise real round-trips.
//
// onChanged mirrors the real semantics the dictionary feature depends on:
// set()/remove() record {oldValue, newValue} per ACTUALLY-changed key and fire
// every listener with (changes, areaName) — including in the context that
// wrote, exactly like Chrome. A test can simulate "another device synced a
// change" by just writing via chrome.storage.sync.set() itself.

import { vi } from "vitest";

function makeOnChangedEmitter() {
  const listeners = new Set();
  return {
    addListener: vi.fn((fn) => listeners.add(fn)),
    removeListener: vi.fn((fn) => listeners.delete(fn)),
    hasListener: (fn) => listeners.has(fn),
    // Test seam: how many subscriptions are live (teardown tests assert 0).
    listenerCount: () => listeners.size,
    emit(changes, areaName) {
      for (const fn of [...listeners]) fn(changes, areaName);
    },
  };
}

export function makeStorageArea(initial = {}, { areaName, onChanged } = {}) {
  const data = structuredClone(initial);
  const fire = (changes) => {
    if (onChanged && Object.keys(changes).length) onChanged.emit(changes, areaName);
  };
  return {
    setAccessLevel: vi.fn(async () => {}),
    get: vi.fn(async (key) => {
      if (key == null) return structuredClone(data); // get-all
      if (Array.isArray(key)) {
        const out = {};
        for (const k of key) if (k in data) out[k] = structuredClone(data[k]);
        return out;
      }
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    }),
    set: vi.fn(async (items) => {
      const changes = {};
      for (const [k, v] of Object.entries(structuredClone(items))) {
        // Like Chrome: unchanged values don't appear in (or trigger) onChanged.
        if (k in data && JSON.stringify(data[k]) === JSON.stringify(v)) continue;
        changes[k] = k in data ? { oldValue: data[k], newValue: v } : { newValue: v };
        data[k] = v;
      }
      fire(changes);
    }),
    remove: vi.fn(async (keys) => {
      const changes = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        if (!(k in data)) continue;
        changes[k] = { oldValue: data[k] };
        delete data[k];
      }
      fire(changes);
    }),
  };
}

// Installs globalThis.chrome with sync + local areas sharing one onChanged
// emitter (the real API has one storage-wide event, discriminated by the
// areaName argument). Returns the chrome object for direct test access.
export function installChromeStorageStub(syncInitial = {}, localInitial = {}) {
  const onChanged = makeOnChangedEmitter();
  globalThis.chrome = {
    tabs: {
      create: vi.fn(async ({ url }) => ({ url })),
    },
    storage: {
      sync: makeStorageArea(syncInitial, { areaName: "sync", onChanged }),
      local: makeStorageArea(localInitial, { areaName: "local", onChanged }),
      onChanged,
    },
  };
  return globalThis.chrome;
}
