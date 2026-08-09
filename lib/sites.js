// lib/sites.js — pure helpers for the per-site enable list.
// No chrome.*, no DOM (the lib/ rule): the popup and the background SW do
// their own chrome.storage/permissions calls and share just the derivations.
//
// The enabled list lives in chrome.storage.sync under ONE key as a
// { [originPattern]: true } map — the synced *intent*. Host-permission grants
// do NOT sync, so a site can be intended-on yet ungranted on this device;
// the effective state is always `intent && permissions.contains(...)`. A user
// may grant ALL_SITES_PATTERN once on a device, but intent remains per-site.
// (storage.sync caps one item at ~8 KB — thousands of origins fit; a set()
// past the quota rejects loudly rather than truncating.)

export const SITES_KEY = "enabledSites";
export const ALL_SITES_PATTERN = "*://*/*";

// Tab URL → the match pattern we request/register for, or null when the page
// can't host the feature (chrome://, extension pages, file:, …).
// Match patterns ignore ports, so the pattern is scheme + hostname only.
export function originPattern(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return `${u.protocol}//${u.hostname}/*`;
}

// "https://github.com/*" → "github.com", for UI labels.
export function patternLabel(pattern) {
  return pattern.replace(/^https?:\/\//, "").replace(/\/\*$/, "");
}

// Chrome match patterns ignore ports, but a pattern adopted from Chrome's
// site-access menu can carry one (e.g. "http://localhost:3000/*") while
// originPattern() never emits one — compare port-insensitively or a teardown
// broadcast for such a site never matches the page's own derivation.
export function samePattern(a, b) {
  const strip = (p) =>
    typeof p === "string" ? p.replace(/^(https?:\/\/[^/:]+):\d+(\/.*)?$/, "$1$2") : p;
  return strip(a) === strip(b);
}

// Defensive read of the synced map (storage can hold anything).
export function asSiteMap(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
