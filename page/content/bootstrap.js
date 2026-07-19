// page/content/bootstrap.js — the registered content script. Chrome injects
// registered content scripts as CLASSIC scripts (never ES modules), so this
// is a one-line trampoline into the real, module-based entry. The dynamic
// import() only resolves because page/content/* (and the lib/ + ui/ modules
// it imports) are web_accessible_resources — that's the sole reason the WAR
// manifest entry exists; don't "simplify" either away.
//
// The WAR entry does NOT set use_dynamic_url (tempting as fingerprinting
// resistance): with it on, getURL() here returns the dynamic GUID origin
// and Chrome fails the module fetch outright ("Failed to fetch dynamically
// imported module…", verified on Beta 150, 2026-06-10). Static URLs make the
// files probeable by any page — the same trade every overlay extension ships.
//
// The guard covers the enable flow's double delivery: the SW both registers
// this script (future page loads) and executeScript()s it into already-open
// tabs — a tab can get both. import() caches by URL anyway; the flag just
// keeps the second run from re-resolving the chain.
(() => {
  if (window.__prooflyPageLoaded) return;
  window.__prooflyPageLoaded = true;
  import(chrome.runtime.getURL("page/content/index.js")).catch(() => {
    // Silent degrade: never throw into someone else's page.
  });
})();
