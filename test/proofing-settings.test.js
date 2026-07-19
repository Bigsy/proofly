import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseProofingSettings, resolveDialect,
} from "../lib/proofing-settings.js";
import {
  loadProofingSettings, onProofingSettingsChanged, saveProofingSettings,
} from "../lib/proofing-settings-store.js";
import { installChromeStorageStub } from "./helpers/chrome-storage.js";

afterEach(() => { delete globalThis.chrome; });

describe("proofing settings", () => {
  it.each([
    ["en-US", "american"], ["en-GB", "british"], ["en_AU", "australian"],
    ["en-CA", "canadian"], ["en-IN", "indian"], ["fr-FR", "american"], ["", "american"],
  ])("maps Auto locale %s to %s", (locale, expected) => {
    expect(resolveDialect({ dialect: "auto" }, locale)).toBe(expected);
  });

  it("honours explicit dialects and safely defaults unknown values", () => {
    expect(resolveDialect({ dialect: "british" }, "en-US")).toBe("british");
    expect(parseProofingSettings({ dialect: "future-value" })).toEqual({ dialect: "auto" });
    expect(parseProofingSettings(null)).toEqual({ dialect: "auto" });
  });

  it("loads, saves, and subscribes through one sync key", async () => {
    installChromeStorageStub({ proofingSettings: { dialect: "canadian" } });
    expect(await loadProofingSettings()).toEqual({ dialect: "canadian" });
    const changed = vi.fn();
    const unsubscribe = onProofingSettingsChanged(changed);
    expect(await saveProofingSettings({ dialect: "indian" })).toEqual({ dialect: "indian" });
    expect(changed).toHaveBeenCalledWith({ dialect: "indian" });
    unsubscribe();
  });

  it("defaults quietly without storage or after a read failure", async () => {
    expect(await loadProofingSettings()).toEqual({ dialect: "auto" });
    installChromeStorageStub({});
    globalThis.chrome.storage.sync.get.mockRejectedValueOnce(new Error("sync unavailable"));
    expect(await loadProofingSettings()).toEqual({ dialect: "auto" });
  });
});
