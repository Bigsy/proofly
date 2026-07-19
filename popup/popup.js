// popup/popup.js — the toolbar menu: Open side panel, plus the
// per-site Enable/Disable toggle that drives the opt-in flow.
//
// Division of labour: on Enable this popup records the synced
// intent and fires chrome.permissions.request() — and that is ALL it does.
// The post-grant work (registerContentScripts + injecting into open tabs)
// lives in the SW's permissions.onAdded listener, because the native
// permission prompt can steal focus and close this popup, killing its
// scripts mid-flight. Intent is written BEFORE the request for the same
// reason — it must survive the popup dying.

import { asSiteMap, originPattern, patternLabel, SITES_KEY } from "../lib/sites.js";

const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"),
  statusText: $("statusText"),
  openPanel: $("openPanel"),
  manageDict: $("manageDict"),
  siteName: $("siteName"),
  siteToggle: $("siteToggle"),
  siteNote: $("siteNote"),
};

function setStatus(kind, text) {
  els.status.className = `status status--${kind}`;
  els.statusText.textContent = text;
}

async function readIntent() {
  try {
    const data = await chrome.storage.sync.get(SITES_KEY);
    return asSiteMap(data?.[SITES_KEY]);
  } catch {
    return {};
  }
}

async function writeIntent(pattern, on) {
  const map = await readIntent();
  if (on) map[pattern] = true;
  else delete map[pattern];
  // ~8 KB sync quota per item (thousands of origins); a set() past it rejects
  // loudly — surfaced via the catch in the click handler, never truncated.
  await chrome.storage.sync.set({ [SITES_KEY]: map });
}

// Captured once at load: sidePanel.open() must run inside the click gesture,
// so the tab id has to be in hand already.
let tab = null;
let pattern = null;

async function refreshSiteRow() {
  if (!pattern) {
    els.siteName.textContent = tab?.url ? "This page can't be proofread." : "";
    els.siteToggle.hidden = false;
    els.siteToggle.disabled = true;
    els.siteToggle.textContent = "Not available on this page";
    els.siteNote.hidden = true;
    return;
  }

  const [intentMap, granted] = await Promise.all([
    readIntent(),
    chrome.permissions.contains({ origins: [pattern] }),
  ]);
  const intended = !!intentMap[pattern];
  const effective = intended && granted; // intent syncs, grants don't

  els.siteName.textContent = patternLabel(pattern);
  els.siteToggle.hidden = false;
  els.siteToggle.disabled = false;
  els.siteToggle.textContent = effective
    ? "Disable Proofly on this site"
    : "Enable Proofly on this site";
  els.siteToggle.classList.toggle("item--primary", !effective);
  // Synced-but-ungranted (enabled on another device) — say so instead of
  // looking "already on but doing nothing".
  els.siteNote.hidden = !(intended && !granted);
  els.siteNote.textContent = "Enabled on another device — click to activate here.";
}

async function toggleSite() {
  els.siteToggle.disabled = true;
  try {
    const [intentMap, granted] = await Promise.all([
      readIntent(),
      chrome.permissions.contains({ origins: [pattern] }),
    ]);
    if (intentMap[pattern] && granted) {
      // Disable: drop intent, then the grant; the SW's permissions.onRemoved
      // unregisters the content script and tears down live tabs.
      await writeIntent(pattern, false);
      await chrome.permissions.remove({ origins: [pattern] });
    } else {
      await writeIntent(pattern, true);
      await chrome.permissions.request({ origins: [pattern] });
      // Granted or denied, the SW reconciles from intent + actual grants;
      // if we're still alive, just re-render whatever state resulted.
    }
  } catch {
    // Quota or permissions error — leave the row reflecting reality.
  }
  await refreshSiteRow();
}

els.openPanel.addEventListener("click", () => {
  if (!tab) return;
  // The popup click is the required user gesture; close once it's away.
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  window.close();
});

els.siteToggle.addEventListener("click", toggleSite);

// The custom dictionary lives on the options page (a real tab — see
// manifest options_ui.open_in_tab).
els.manageDict.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

(async function init() {
  // Harper ships inside Proofly; no browser API or model download gates the
  // site feature. Runtime failures degrade silently in the guest page.
  setStatus("ok", "Proofreading ready.");
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  pattern = tab?.url ? originPattern(tab.url) : null;
  await refreshSiteRow();
})();
