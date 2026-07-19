import { describe, expect, it, vi } from "vitest";
import {
  adapterEnabled,
  DEFAULT_EDITOR_ADAPTER_FLAGS,
  EDITOR_ADAPTER_FLAGS_KEY,
  loadEditorAdapterFlags,
  normalizeEditorAdapterFlags,
  watchEditorAdapterFlags,
} from "../page/content/adapter-flags.js";
import { installChromeStorageStub } from "./helpers/chrome-storage.js";

describe("editor adapter runtime flags", () => {
  it("defaults every shipped adapter on (flags are a kill switch, not a ramp)", () => {
    const flags = normalizeEditorAdapterFlags(null);
    expect(flags.enabled).toBe(true);
    expect(flags.debug).toBe(false);
    for (const [id, value] of Object.entries(flags.adapters)) {
      expect(value, `adapter default: ${id}`).toBe(true);
      expect(adapterEnabled(flags, id), `adapterEnabled: ${id}`).toBe(true);
    }
    expect(adapterEnabled(flags, "unknown-adapter")).toBe(false);
  });

  it("a global disable overrides per-adapter enables", () => {
    const flags = normalizeEditorAdapterFlags({ enabled: false });
    expect(flags.adapters.form).toBe(true);
    expect(adapterEnabled(flags, "form")).toBe(false);
  });

  it("normalizes malformed settings without losing known defaults", () => {
    const flags = normalizeEditorAdapterFlags({
      enabled: "yes",
      debug: true,
      adapters: { form: false, contenteditable: true, nope: true },
    });
    expect(flags.enabled).toBe(DEFAULT_EDITOR_ADAPTER_FLAGS.enabled);
    expect(flags.debug).toBe(true);
    expect(flags.adapters.form).toBe(false);
    expect(flags.adapters.contenteditable).toBe(true);
    expect(flags.adapters.nope).toBeUndefined();
  });

  it("loads from chrome.storage.local", async () => {
    installChromeStorageStub({}, {
      [EDITOR_ADAPTER_FLAGS_KEY]: { enabled: true, adapters: { contenteditable: true } },
    });
    const flags = await loadEditorAdapterFlags();
    expect(adapterEnabled(flags, "contenteditable")).toBe(true);
  });

  it("observes runtime changes and can be used to tear down the active session", async () => {
    const chrome = installChromeStorageStub();
    const teardown = vi.fn();
    const unwatch = watchEditorAdapterFlags((flags) => {
      if (!flags.enabled) teardown();
    }, { chromeApi: chrome });
    await chrome.storage.local.set({ [EDITOR_ADAPTER_FLAGS_KEY]: { enabled: true } });
    expect(teardown).not.toHaveBeenCalled();
    await chrome.storage.local.set({ [EDITOR_ADAPTER_FLAGS_KEY]: { enabled: false } });
    expect(teardown).toHaveBeenCalledTimes(1);
    unwatch();
    expect(chrome.storage.onChanged.listenerCount()).toBe(0);
  });
});
