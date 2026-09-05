// background.js — config/lifecycle for the in-page feature and the routing
// seam to the extension's single offscreen Harper worker.
//
// The toolbar action no longer opens the side panel directly — it opens the
// popup menu (manifest `action.default_popup`), a deliberate UX change.
// "Open side panel" lives in that menu now.
//
// Permission model: the synced enable list is *intent*; host
// permission grants are per-device and do NOT sync. Effective on-state =
// intent && granted, reconciled here on startup, on storage changes, and on
// permission grant/removal — so a synced-but-ungranted site is never
// silently broken (the popup labels it "enabled on another device").

import { asSiteMap, originPattern, patternLabel, SITES_KEY } from "./lib/sites.js";
import {
  isDictionaryStorageChange, loadDictionary, setDictionarySyncEnabledDirect, updateDictionary,
} from "./lib/dictionary-store.js";
import {
  parseProofingSettings, PROOFING_SETTINGS_KEY, resolveDialect,
} from "./lib/proofing-settings.js";
import {
  configurationRevision, effectiveRuleOverrides, parseRuleOverrides,
} from "./lib/harper-rules.js";
import {
  DEFAULT_EDITOR_ADAPTER_FLAGS, EDITOR_ADAPTER_FLAGS_KEY, normalizeEditorAdapterFlags,
} from "./page/content/adapter-flags.js";
import {
  isWeirpackStorageChange, loadWeirpacks,
} from "./lib/weirpack-store.js";
import { WEIRPACK_SYNC_SETTINGS_KEY } from "./lib/weirpack-sync-settings.js";
import {
  DICTIONARY_SYNC_SET, PAGE_ADAPTER_FLAGS_CHANGED, PAGE_DICTIONARY_CHANGED, PAGE_DICTIONARY_UPDATE,
  PAGE_PROOFING_SETTINGS_CHANGED, PAGE_RULE_DISABLE, PAGE_STORAGE_GET,
} from "./lib/storage-broker.js";

const HARPER_OFFSCREEN_URL = "offscreen.html";
let ruleMutationTail = Promise.resolve();
let harperCreationPromise = null;
let harperOperationTail = Promise.resolve();
let dictionaryMutationTail = Promise.resolve();

// Notes and the optional GitHub token live in extension storage. Chrome makes
// local/sync storage available to content scripts by default, so lock both
// areas to extension pages and the service worker before any storage work.
export const storageAccessReady = Promise.all([
  chrome.storage.sync.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
]).catch((error) => {
  console.error("storage access restriction failed:", error);
});

function enqueueHarperOperation(operation) {
  const result = harperOperationTail.then(operation, operation);
  harperOperationTail = result.catch(() => {});
  return result;
}

export async function ensureHarperOffscreen() {
  if (harperCreationPromise) return harperCreationPromise;
  harperCreationPromise = (async () => {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(HARPER_OFFSCREEN_URL)],
    });
    if (contexts.length) return;
    await chrome.offscreen.createDocument({
      url: HARPER_OFFSCREEN_URL,
      reasons: ["WORKERS"],
      justification: "Run Proofly's packaged Harper WASM worker locally",
    });
  })();
  try {
    await harperCreationPromise;
  } finally {
    harperCreationPromise = null;
  }
}

async function hasHarperOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(HARPER_OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === PAGE_RULE_DISABLE
    || message?.type === PAGE_STORAGE_GET
    || message?.type === PAGE_DICTIONARY_UPDATE
    || message?.type === DICTIONARY_SYNC_SET) {
    handlePageStorageRequest(message)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (!message?.type?.startsWith("harper:") || message.target === "harper:offscreen") {
    return undefined;
  }
  forwardHarperRequest(message)
    .then(sendResponse)
    .catch((error) => sendResponse({
      type: "harper:error",
      requestId: message.requestId ?? null,
      error: { code: "offscreen_unavailable", message: String(error?.message || error) },
    }));
  return true;
});

export async function pageStorageSnapshot() {
  await storageAccessReady;
  const [dictionary, syncData, localData] = await Promise.all([
    loadDictionary(),
    chrome.storage.sync.get(PROOFING_SETTINGS_KEY),
    chrome.storage.local.get(EDITOR_ADAPTER_FLAGS_KEY),
  ]);
  return {
    dictionary,
    proofingSettings: parseProofingSettings(syncData?.[PROOFING_SETTINGS_KEY]),
    editorAdapterFlags: normalizeEditorAdapterFlags(
      localData?.[EDITOR_ADAPTER_FLAGS_KEY] ?? DEFAULT_EDITOR_ADAPTER_FLAGS,
    ),
  };
}

export async function handlePageStorageRequest(message) {
  if (message?.type === PAGE_RULE_DISABLE) {
    if (typeof message.rule !== "string"
      || !Object.hasOwn(parseRuleOverrides({ [message.rule]: false }), message.rule)) {
      throw new Error("Invalid Harper rule");
    }
    const operation = async () => {
      await storageAccessReady;
      const data = await chrome.storage.sync.get(PROOFING_SETTINGS_KEY);
      const settings = parseProofingSettings(data?.[PROOFING_SETTINGS_KEY]);
      settings.ruleOverrides = { ...settings.ruleOverrides, [message.rule]: false };
      await chrome.storage.sync.set({ [PROOFING_SETTINGS_KEY]: settings });
      return { ok: true };
    };
    const result = ruleMutationTail.then(operation, operation);
    ruleMutationTail = result.catch(() => {});
    return result;
  }
  if (message?.type === PAGE_STORAGE_GET) {
    return { ok: true, ...await pageStorageSnapshot() };
  }
  if (message?.type !== PAGE_DICTIONARY_UPDATE && message?.type !== DICTIONARY_SYNC_SET) {
    throw new Error("Unknown page storage request");
  }

  await storageAccessReady;
  const operation = async () => {
    if (message.type === DICTIONARY_SYNC_SET) {
      return setDictionarySyncEnabledDirect(message.enabled !== false);
    }
    if (!["add", "remove", "clear"].includes(message.operation)) {
      throw new Error("Unknown dictionary operation");
    }
    return updateDictionary(message.operation, message.words);
  };
  const dictionary = dictionaryMutationTail.then(operation, operation);
  dictionaryMutationTail = dictionary.catch(() => {});
  const result = await dictionary;
  return { ok: true, dictionary: result };
}

async function storedHarperConfiguration() {
  await storageAccessReady;
  const [words, data, storedWeirpacks] = await Promise.all([
    loadDictionary(),
    chrome.storage.sync.get(PROOFING_SETTINGS_KEY),
    loadWeirpacks(),
  ]);
  const settings = parseProofingSettings(data?.[PROOFING_SETTINGS_KEY]);
  const config = {
    dialect: resolveDialect(settings, chrome.i18n.getUILanguage()),
    words,
    ruleOverrides: effectiveRuleOverrides(settings.ruleOverrides),
    weirpacks: storedWeirpacks.map(({ id, bytes }) => ({ id, bytes: Array.from(bytes) })),
  };
  return { ...config, configurationRevision: configurationRevision(config) };
}

async function sendToHarper(message) {
  await ensureHarperOffscreen();
  return chrome.runtime.sendMessage({ ...message, target: "harper:offscreen" });
}

async function configureHarperFromStorageNow() {
  const config = await storedHarperConfiguration();
  return sendToHarper({ type: "harper:configure", ...config });
}

export function configureHarperFromStorage() {
  return enqueueHarperOperation(configureHarperFromStorageNow);
}

export function forwardHarperRequest(message) {
  if (!["harper:lint", "harper:rules"].includes(message?.type)) return sendToHarper(message);
  return enqueueHarperOperation(async () => {
    let configured = await configureHarperFromStorageNow();
    if (configured?.type === "harper:error") return configured;
    let result = await sendToHarper({
      ...message,
      dialect: configured.dialect,
      configurationRevision: configured.configurationRevision,
    });
    if (result?.type === "harper:error" && result.error?.code === "stale_configuration") {
      configured = await configureHarperFromStorageNow();
      if (configured?.type === "harper:error") return configured;
      result = await sendToHarper({
        ...message,
        dialect: configured.dialect,
        configurationRevision: configured.configurationRevision,
      });
    }
    return result;
  });
}

const BOOTSTRAP_JS = "page/content/bootstrap.js";
const SCRIPT_ID_PREFIX = "proofly-page:";
const scriptId = (pattern) => `${SCRIPT_ID_PREFIX}${pattern}`;
const contentScriptForPattern = (pattern) => ({
  id: scriptId(pattern),
  matches: [pattern],
  js: [BOOTSTRAP_JS],
  runAt: "document_idle",
  allFrames: true, // one engine per matching frame
  matchOriginAsFallback: true, // cover about:blank/srcdoc frames that inherit the page origin
});

// A per-site pattern as the popup/we create them ("https://host/*") — the
// shape we adopt into intent when a grant arrives (e.g. via Chrome's
// puzzle-piece site-access menu). Broad grants like *://*/* are ignored.
const PER_SITE_PATTERN = /^https?:\/\/[^/*]+\/\*$/;

async function readIntent() {
  try {
    await storageAccessReady;
    const data = await chrome.storage.sync.get(SITES_KEY);
    return asSiteMap(data?.[SITES_KEY]);
  } catch {
    return {};
  }
}

async function grantedIntentPatterns(intent) {
  const patterns = Object.keys(intent)
    .filter((pattern) => !!intent[pattern] && PER_SITE_PATTERN.test(pattern));
  const checks = await Promise.all(patterns.map(async (pattern) => ({
    pattern,
    granted: await chrome.permissions.contains({ origins: [pattern] }),
  })));
  return checks.filter(({ granted }) => granted).map(({ pattern }) => pattern);
}

// ---------- content-script registration ----------
// Keep registrations equal to { intended ∩ granted }. Idempotent per run, but
// must not OVERLAP: every trigger calls reconcile(), and a single user action
// fans out to several at once — e.g. the popup writing the sync store both
// wakes the worker (the top-level reconcile() below) AND fires
// storage.onChanged. Two concurrent runs read the same
// getRegisteredContentScripts() snapshot, then both register/unregister the
// same ids — the loser throws "Duplicate script ID" / "Nonexistent script ID".
// So reconcile() queues onto a chain; reconcileOnce() holds the real work.
let reconcileTail = Promise.resolve();
function reconcile() {
  reconcileTail = reconcileTail.then(reconcileOnce, reconcileOnce);
  return reconcileTail;
}

async function reconcileOnce() {
  try {
    const intent = await readIntent();
    // permissions.contains() understands that a broad *://*/* grant satisfies
    // each individual intended origin; getAll() only returns the broad token.
    const want = new Set(await grantedIntentPatterns(intent));

    const registered = await chrome.scripting.getRegisteredContentScripts();
    const ours = registered.filter((s) => s.id.startsWith(SCRIPT_ID_PREFIX));

    const toRemove = ours
      .filter((s) => {
        const pattern = s.id.slice(SCRIPT_ID_PREFIX.length);
        return !want.has(pattern) || !registrationMatches(s, contentScriptForPattern(pattern));
      })
      .map((s) => s.id);
    if (toRemove.length) {
      await chrome.scripting.unregisterContentScripts({ ids: toRemove });
    }

    const currentAfterRemoval = new Set(
      ours
        .filter((s) => !toRemove.includes(s.id))
        .map((s) => s.id),
    );
    const toAdd = [...want].filter((p) => !currentAfterRemoval.has(scriptId(p)));
    if (toAdd.length) {
      await chrome.scripting.registerContentScripts(toAdd.map(contentScriptForPattern));
    }
  } catch (err) {
    console.error("reconcile failed:", err);
  }
}

function registrationMatches(actual, expected) {
  return actual.runAt === expected.runAt
    && actual.allFrames === expected.allFrames
    && actual.matchOriginAsFallback === expected.matchOriginAsFallback
    && sameItems(actual.matches, expected.matches)
    && sameItems(actual.js, expected.js);
}

function sameItems(a = [], b = []) {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

// Registration only covers FUTURE page loads; this injects into the tabs the
// user already has open on a just-enabled origin (the query-by-URL needs the
// host permission we were just granted).
async function injectIntoOpenTabs(pattern) {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: pattern });
  } catch {
    return;
  }
  for (const tab of tabs) {
    chrome.scripting
      .executeScript({ target: { tabId: tab.id, allFrames: true }, files: [BOOTSTRAP_JS] })
      .catch(() => { /* chrome error pages etc. — ignore */ });
  }
}

// Disabling can't query tabs by URL (the permission is already gone), so
// broadcast to every tab; only our own content scripts hear it, and each one
// checks the pattern against its own location before tearing down.
async function broadcastTeardown(patterns) {
  if (!patterns.length) return;
  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  for (const tab of tabs) {
    for (const pattern of patterns) {
      chrome.tabs
        .sendMessage(tab.id, { type: "proofly:teardown", pattern })
        .catch(() => { /* no content script in that tab — expected */ });
    }
  }
}

async function broadcastPageStorage(message) {
  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, message)
      .catch(() => { /* no content script in that tab — expected */ });
  }
}

// ---------- per-tab icon state ----------
// Gray icon + OFF badge where Proofly isn't enabled, full colour where it is
// (the uBlock/Dark Reader affordance). Needs no extra permissions: without
// host permission tab.url is simply undefined, which correctly reads as
// "not enabled here".
const COLOR_ICONS = { 16: "icons/icon16.png", 48: "icons/icon48.png", 128: "icons/icon128.png" };

// Grayscale ImageData computed once from the shipped PNGs — no extra assets.
let grayIconsPromise = null;
function grayIcons() {
  grayIconsPromise ??= (async () => {
    try {
      const out = {};
      for (const [size, path] of Object.entries(COLOR_ICONS)) {
        const blob = await (await fetch(chrome.runtime.getURL(path))).blob();
        const bitmap = await createImageBitmap(blob);
        const n = Number(size);
        const canvas = new OffscreenCanvas(n, n);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bitmap, 0, 0, n, n);
        const img = ctx.getImageData(0, 0, n, n);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          const luma = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          d[i] = d[i + 1] = d[i + 2] = luma;
          d[i + 3] *= 0.6; // fade like a disabled control
        }
        out[size] = img;
      }
      return out;
    } catch {
      return null; // fall back to the colour icon (badge still signals OFF)
    }
  })();
  return grayIconsPromise;
}

async function updateTabIcon(tabId, url) {
  try {
    const pattern = url ? originPattern(url) : null;
    let on = false;
    if (pattern) {
      const [intent, granted] = await Promise.all([
        readIntent(),
        chrome.permissions.contains({ origins: [pattern] }),
      ]);
      on = !!intent[pattern] && granted;
    }
    if (on) {
      await chrome.action.setIcon({ tabId, path: COLOR_ICONS });
      await chrome.action.setBadgeText({ tabId, text: "" });
      await chrome.action.setTitle({
        tabId,
        title: `Proofly — on for ${patternLabel(pattern)}`,
      });
    } else {
      const gray = await grayIcons();
      await chrome.action.setIcon(gray ? { tabId, imageData: gray } : { tabId, path: COLOR_ICONS });
      await chrome.action.setBadgeText({ tabId, text: "OFF" });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#8b91a3" });
      await chrome.action.setTitle({
        tabId,
        title: "Proofly — off on this site (click to enable)",
      });
    }
  } catch {
    /* tab closed mid-update — ignore */
  }
}

async function refreshAllTabIcons() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  for (const tab of tabs) updateTabIcon(tab.id, tab.url);
}

// ---------- events ----------
chrome.runtime.onInstalled.addListener(() => {
  reconcile().then(refreshAllTabIcons);
});
chrome.runtime.onStartup.addListener(() => {
  reconcile().then(refreshAllTabIcons);
});

// The popup's Enable wrote intent then requested the grant; the post-grant
// work happens HERE (the native prompt can kill the popup mid-flight). A
// grant from Chrome's own site-access menu lands here too — adopt it as
// intent so the two paths share this one code path.
chrome.permissions.onAdded.addListener(async ({ origins }) => {
  if (!origins?.length) return;
  try {
    const intent = await readIntent();
    let changed = false;
    for (const o of origins) {
      if (PER_SITE_PATTERN.test(o) && !intent[o]) {
        intent[o] = true;
        changed = true;
      }
    }
    if (changed) await chrome.storage.sync.set({ [SITES_KEY]: intent });
    await reconcile();
    // A broad grant is permission only, never broad intent. Activate and inject
    // the already-synced per-site intentions it now satisfies. A newly adopted
    // exact grant is injected by storage.onChanged, avoiding a double bootstrap.
    if (!changed) {
      for (const pattern of await grantedIntentPatterns(intent)) {
        await injectIntoOpenTabs(pattern);
      }
    }
    await refreshAllTabIcons();
  } catch (err) {
    console.error("permissions.onAdded handling failed:", err);
  }
});

chrome.permissions.onRemoved.addListener(async ({ origins }) => {
  if (!origins?.length) return;
  const intent = await readIntent();
  const stillGranted = new Set(await grantedIntentPatterns(intent));
  await reconcile();
  // Removing a broad grant reports *://*/*, which content pages cannot compare
  // to their per-site pattern. Expand it to the intended sites that lost access.
  const lost = Object.keys(intent)
    .filter((pattern) => !!intent[pattern] && !stillGranted.has(pattern));
  await broadcastTeardown(lost);
  await refreshAllTabIcons();
});

// Sync changes from other devices (or the popup): re-reconcile, and tear
// down live tabs for any site whose intent was just switched off.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === "local") {
    if (changes[EDITOR_ADAPTER_FLAGS_KEY]) {
      await broadcastPageStorage({
        type: PAGE_ADAPTER_FLAGS_CHANGED,
        editorAdapterFlags: normalizeEditorAdapterFlags(
          changes[EDITOR_ADAPTER_FLAGS_KEY].newValue,
        ),
      });
    }
    if (isDictionaryStorageChange(changes, area)) {
      await broadcastPageStorage({
        type: PAGE_DICTIONARY_CHANGED,
        dictionary: await loadDictionary(),
      });
      if (await hasHarperOffscreen()) {
        await configureHarperFromStorage().catch((error) => {
          console.warn("Harper storage reconfiguration failed:", error);
        });
      }
    }
    if (isWeirpackStorageChange(changes) && await hasHarperOffscreen()) {
      await configureHarperFromStorage().catch((error) => {
        console.warn("Harper Weirpack reconfiguration failed:", error);
      });
    }
    return;
  }
  if (area !== "sync") return;
  if (changes[SITES_KEY]) {
    const before = asSiteMap(changes[SITES_KEY].oldValue);
    const after = asSiteMap(changes[SITES_KEY].newValue);
    const dropped = Object.keys(before).filter((p) => !after[p]);
    const added = Object.keys(after).filter((p) => after[p] && !before[p]);
    await reconcile();
    // With an existing broad grant, enabling a new site does not fire
    // permissions.onAdded. Inject it into already-open tabs from intent alone.
    const newlyEffective = await grantedIntentPatterns(
      Object.fromEntries(added.map((pattern) => [pattern, true])),
    );
    for (const pattern of newlyEffective) await injectIntoOpenTabs(pattern);
    await broadcastTeardown(dropped);
    await refreshAllTabIcons();
  }
  const dictionaryChanged = isDictionaryStorageChange(changes, area);
  if (dictionaryChanged) {
    await broadcastPageStorage({
      type: PAGE_DICTIONARY_CHANGED,
      dictionary: await loadDictionary(),
    });
  }
  if (changes[PROOFING_SETTINGS_KEY]) {
    await broadcastPageStorage({
      type: PAGE_PROOFING_SETTINGS_CHANGED,
      proofingSettings: parseProofingSettings(changes[PROOFING_SETTINGS_KEY].newValue),
    });
  }
  if ((dictionaryChanged || changes[PROOFING_SETTINGS_KEY]
      || changes[WEIRPACK_SYNC_SETTINGS_KEY] || isWeirpackStorageChange(changes))
    && await hasHarperOffscreen()) {
    await configureHarperFromStorage().catch((error) => {
      console.warn("Harper storage reconfiguration failed:", error);
    });
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    updateTabIcon(tabId, tab.url);
  } catch {
    /* tab gone */
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading" || changeInfo.url) updateTabIcon(tabId, tab.url);
});

// Cover the worker's own spin-up too (e.g. after idle eviction) so icon
// state doesn't lag behind reality.
reconcile().then(refreshAllTabIcons);
