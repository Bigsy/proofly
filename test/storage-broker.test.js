import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addWord, loadDictionary, onDictionaryChanged,
} from "../lib/dictionary-store.js";
import {
  loadProofingSettings, onProofingSettingsChanged,
} from "../lib/proofing-settings-store.js";
import {
  PAGE_ADAPTER_FLAGS_CHANGED, PAGE_DICTIONARY_CHANGED, PAGE_DICTIONARY_UPDATE,
  PAGE_PROOFING_SETTINGS_CHANGED, PAGE_STORAGE_GET,
} from "../lib/storage-broker.js";
import {
  loadEditorAdapterFlags, watchEditorAdapterFlags,
} from "../page/content/adapter-flags.js";

function installBroker() {
  const listeners = new Set();
  const snapshot = {
    ok: true,
    dictionary: ["Acme"],
    proofingSettings: { dialect: "british" },
    editorAdapterFlags: { adapters: { quill: false } },
  };
  globalThis.chrome = {
    runtime: {
      id: "proofly-test",
      sendMessage: vi.fn(async (message) => {
        if (message.type === PAGE_STORAGE_GET) return snapshot;
        if (message.type === PAGE_DICTIONARY_UPDATE) {
          return { ok: true, dictionary: ["Acme", ...message.words] };
        }
        return { ok: false, error: "unexpected request" };
      }),
      onMessage: {
        addListener: vi.fn((listener) => listeners.add(listener)),
        removeListener: vi.fn((listener) => listeners.delete(listener)),
      },
    },
    // Calls to these methods would fail after setAccessLevel in Chrome. Keep
    // them as tripwires: brokered content-script code must never touch them.
    storage: {
      sync: {
        get: vi.fn(() => { throw new Error("restricted sync storage"); }),
        set: vi.fn(() => { throw new Error("restricted sync storage"); }),
      },
      local: {
        get: vi.fn(() => { throw new Error("restricted local storage"); }),
      },
      onChanged: {
        addListener: vi.fn(() => { throw new Error("restricted storage event"); }),
      },
    },
  };
  return {
    emit(message) {
      for (const listener of [...listeners]) listener(message);
    },
    listenerCount: () => listeners.size,
  };
}

afterEach(() => {
  delete globalThis.chrome;
});

describe("content-script storage broker", () => {
  it("loads and mutates only through runtime messages", async () => {
    installBroker();

    expect(await loadDictionary()).toEqual(["Acme"]);
    expect(await loadProofingSettings()).toEqual({ dialect: "british" });
    expect(await loadEditorAdapterFlags()).toMatchObject({ adapters: { quill: false } });
    expect(await addWord("Proofly")).toEqual(["Acme", "Proofly"]);

    expect(globalThis.chrome.runtime.sendMessage.mock.calls.map(([message]) => message.type))
      .toEqual([PAGE_STORAGE_GET, PAGE_STORAGE_GET, PAGE_STORAGE_GET, PAGE_DICTIONARY_UPDATE]);
    expect(globalThis.chrome.storage.sync.get).not.toHaveBeenCalled();
    expect(globalThis.chrome.storage.local.get).not.toHaveBeenCalled();
  });

  it("subscribes to sanitized service-worker broadcasts and unsubscribes", () => {
    const broker = installBroker();
    const dictionary = vi.fn();
    const proofing = vi.fn();
    const adapters = vi.fn();
    const unsubscribe = [
      onDictionaryChanged(dictionary),
      onProofingSettingsChanged(proofing),
      watchEditorAdapterFlags(adapters),
    ];

    broker.emit({ type: PAGE_DICTIONARY_CHANGED, dictionary: ["Proofly", 42] });
    broker.emit({ type: PAGE_PROOFING_SETTINGS_CHANGED, proofingSettings: { dialect: "indian" } });
    broker.emit({ type: PAGE_ADAPTER_FLAGS_CHANGED, editorAdapterFlags: { adapters: { quill: false } } });

    expect(dictionary).toHaveBeenCalledWith(["Proofly"]);
    expect(proofing).toHaveBeenCalledWith({ dialect: "indian" });
    expect(adapters).toHaveBeenCalledWith(expect.objectContaining({
      adapters: expect.objectContaining({ quill: false }),
    }));
    expect(broker.listenerCount()).toBe(3);

    unsubscribe.forEach((fn) => fn());
    expect(broker.listenerCount()).toBe(0);
  });
});
