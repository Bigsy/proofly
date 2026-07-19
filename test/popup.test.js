// popup/popup.js — the toolbar menu's per-site toggle and model status. The
// invariant under test: on Enable, synced intent is written BEFORE
// chrome.permissions.request() fires (the native prompt can kill the popup
// mid-flight — the SW finishes the job from intent + the grant), and Disable
// mirrors it (intent dropped, then the grant).

import { afterEach, describe, expect, it, vi } from "vitest";
import popupHtml from "../popup/popup.html?raw";
import { SITES_KEY } from "../lib/sites.js";
import { installChromeStorageStub } from "./helpers/chrome-storage.js";

const GH = "https://github.com/*";

const popupBody = popupHtml
  .match(/<body>([\s\S]*)<\/body>/)[1]
  .replace(/<script[\s\S]*?<\/script>/, "");

let closeSpy = null;

async function loadPopup({
  url = "https://github.com/anthropics",
  intent = {},
  granted = [],
} = {}) {
  const seq = []; // interleaving of intent writes and permission calls
  const grantedSet = new Set(granted);

  document.body.innerHTML = popupBody;
  const chrome = installChromeStorageStub({ [SITES_KEY]: intent });
  const realSet = chrome.storage.sync.set;
  chrome.storage.sync.set = vi.fn(async (items) => {
    if (SITES_KEY in items) seq.push({ intent: items[SITES_KEY] });
    return realSet(items);
  });
  chrome.tabs = {
    query: vi.fn(async () => (url === null ? [] : [{ id: 1, url }])),
  };
  chrome.permissions = {
    contains: vi.fn(async ({ origins = [] } = {}) => origins.every((o) => grantedSet.has(o))),
    request: vi.fn(async ({ origins = [] } = {}) => {
      seq.push({ request: origins });
      for (const o of origins) grantedSet.add(o);
      return true;
    }),
    remove: vi.fn(async ({ origins = [] } = {}) => {
      seq.push({ remove: origins });
      for (const o of origins) grantedSet.delete(o);
      return true;
    }),
  };
  chrome.sidePanel = { open: vi.fn(async () => {}) };
  chrome.runtime = { openOptionsPage: vi.fn() };

  closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
  vi.resetModules();
  await import("../popup/popup.js");
  await settle();
  return { chrome, seq };
}

async function settle(hops = 50) {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

const $ = (id) => document.getElementById(id);

afterEach(() => {
  closeSpy?.mockRestore();
  closeSpy = null;
  delete globalThis.chrome;
  document.body.innerHTML = "";
});

describe("per-site toggle", () => {
  it("Enable writes synced intent BEFORE requesting the grant", async () => {
    const { seq } = await loadPopup();
    expect($("siteToggle").textContent).toBe("Enable Proofly on this site");
    expect($("siteName").textContent).toBe("github.com");

    $("siteToggle").click();
    await settle();

    expect(seq).toEqual([
      { intent: { [GH]: true } }, // intent must survive the popup dying…
      { request: [GH] },          // …when the native prompt steals focus
    ]);
    expect($("siteToggle").textContent).toBe("Disable Proofly on this site");
  });

  it("Disable drops intent, then the grant — the SW handles teardown from there", async () => {
    const { seq } = await loadPopup({ intent: { [GH]: true }, granted: [GH] });
    expect($("siteToggle").textContent).toBe("Disable Proofly on this site");
    expect($("siteNote").hidden).toBe(true);

    $("siteToggle").click();
    await settle();

    expect(seq).toEqual([
      { intent: {} },
      { remove: [GH] },
    ]);
    expect($("siteToggle").textContent).toBe("Enable Proofly on this site");
  });

  it("labels a synced-but-ungranted site instead of looking silently on", async () => {
    await loadPopup({ intent: { [GH]: true }, granted: [] });
    expect($("siteToggle").textContent).toBe("Enable Proofly on this site");
    expect($("siteNote").hidden).toBe(false);
    expect($("siteNote").textContent).toContain("another device");
  });

  it("disables the toggle on pages that can't host the feature", async () => {
    await loadPopup({ url: "chrome://extensions" });
    expect($("siteToggle").disabled).toBe(true);
    expect($("siteToggle").textContent).toBe("Not available on this page");
    expect($("siteName").textContent).toBe("This page can't be proofread.");
  });
});

describe("proofreading status", () => {
  it("reports proofreading ready without exposing the engine name", async () => {
    await loadPopup();
    expect($("statusText").textContent).toBe("Proofreading ready.");
  });
});

describe("menu actions", () => {
  it("Open side panel opens for the active tab inside the click gesture, then closes", async () => {
    const { chrome } = await loadPopup();
    $("openPanel").click();
    await settle();
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 1 });
    expect(closeSpy).toHaveBeenCalled();
  });

  it("Manage settings opens the options page", async () => {
    const { chrome } = await loadPopup();
    $("manageDict").click();
    expect(chrome.runtime.openOptionsPage).toHaveBeenCalled();
    expect(closeSpy).toHaveBeenCalled();
  });
});
