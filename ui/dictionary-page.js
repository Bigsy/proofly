// ui/dictionary-page.js — the options page's dictionary manager: the word
// list (search, per-word remove, two-step Clear all), bulk paste, and the
// sync-quota meter.
//
// Wired by initDictionaryPage(deps), mirroring ui/library.js — deps are
// injected so the module is unit-testable without chrome (and the thin entry,
// options/options.js, stays trivial):
//   els   — element map (search, bulkInput, bulkBtn, bulkReport, list, empty,
//           meter, clearBtn)
//   store — { loadDictionary, addWords, removeWord, clearDictionary,
//           onDictionaryChanged } (lib/dictionary-store.js or a test stub)
//
// Storage writes go through the store's read-modify-write helpers: every bulk
// operation is ONE set(). A quota rejection (the ~8 KB per-item sync cap)
// propagates from the store and surfaces as an inline error naming the limit.

import { isValidWord } from "../lib/dictionary.js";
import { DICTIONARY_KEY } from "../lib/dictionary-store.js";

// chrome.storage.sync's QUOTA_BYTES_PER_ITEM: key length + JSON-stringified
// value, capped at 8192 bytes. Mirrored here for the meter — reading the real
// constant would need chrome at module scope.
export const SYNC_QUOTA_BYTES = 8192;

const QUOTA_ERROR =
  "Over Chrome's sync storage limit (~8 KB for the whole dictionary) — remove some words first.";

export function initDictionaryPage({ els, store }) {
  let words = [];   // current sorted list (the store owns canonical order)
  let query = "";   // live search filter
  let clearArmed = false;

  // ---------- rendering ----------
  function draw() {
    disarmClear();
    const list = els.list;
    list.textContent = "";

    const matches = words.filter((w) => w.toLowerCase().includes(query.trim().toLowerCase()));
    const searching = !!query.trim();

    els.empty.hidden = !!matches.length;
    els.empty.textContent = searching
      ? "No words match your search."
      : "No words yet — add the names and jargon Proofly keeps flagging.";

    for (const word of matches) {
      const li = document.createElement("li");
      li.className = "word";

      const text = document.createElement("span");
      text.className = "word__text";
      text.textContent = word;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "word__remove";
      remove.textContent = "×";
      remove.title = `Remove “${word}”`;
      remove.setAttribute("aria-label", `Remove “${word}”`);
      remove.addEventListener("click", () => removeOne(word));

      li.append(text, remove);
      list.appendChild(li);
    }

    drawMeter();
    els.clearBtn.disabled = !words.length;
  }

  // "N words · ~X KB of 8 KB sync quota" — the same arithmetic Chrome bills:
  // key length + JSON size of the value.
  function drawMeter() {
    const bytes = DICTIONARY_KEY.length
      + new TextEncoder().encode(JSON.stringify(words)).length;
    const kb = (bytes / 1024).toFixed(1);
    const n = words.length;
    els.meter.textContent =
      `${n} word${n === 1 ? "" : "s"} · ~${kb} KB of ${SYNC_QUOTA_BYTES / 1024} KB sync quota`;
  }

  // ---------- inline feedback ----------
  function bulkReport(msg, isError = false) {
    els.bulkReport.textContent = msg;
    els.bulkReport.classList.toggle("error", isError);
  }

  const isQuotaError = (e) => /quota/i.test(e?.message ?? "");

  // ---------- bulk add ----------
  // "One word per line" (any whitespace separates), validated per token,
  // deduped within the paste and against the existing list — ONE set().
  async function addBulk() {
    const tokens = els.bulkInput.value.split(/\s+/u).filter(Boolean);
    if (!tokens.length) return bulkReport("Paste some words first.", true);

    const fresh = [];
    const seen = new Set(words);
    for (const t of tokens) {
      if (!isValidWord(t) || seen.has(t)) continue;
      seen.add(t);
      fresh.push(t);
    }
    const skipped = tokens.length - fresh.length;

    try {
      if (fresh.length) words = await store.addWords(fresh);
      els.bulkInput.value = "";
      bulkReport(
        `Added ${fresh.length}${skipped ? `, skipped ${skipped} (already present or invalid)` : ""}.`,
      );
      draw();
    } catch (e) {
      bulkReport(isQuotaError(e) ? QUOTA_ERROR : `Couldn't save: ${e.message || e}`, true);
    }
  }

  // ---------- remove / clear ----------
  async function removeOne(word) {
    try {
      words = await store.removeWord(word);
      draw();
    } catch (e) {
      bulkReport(`Couldn't remove: ${e.message || e}`, true);
    }
  }

  function disarmClear() {
    clearArmed = false;
    els.clearBtn.textContent = "Clear all";
    els.clearBtn.classList.remove("btn--confirm");
  }

  // Two-step inline confirm, the library's delete pattern — no native dialog.
  async function clearAll() {
    if (!clearArmed) {
      clearArmed = true;
      els.clearBtn.textContent = "Confirm clear all";
      els.clearBtn.classList.add("btn--confirm");
      return;
    }
    try {
      words = await store.clearDictionary();
      draw();
    } catch (e) {
      disarmClear();
      bulkReport(`Couldn't clear: ${e.message || e}`, true);
    }
  }

  // ---------- wiring ----------
  els.search.addEventListener("input", () => {
    query = els.search.value;
    draw();
  });
  els.bulkBtn.addEventListener("click", addBulk);
  els.clearBtn.addEventListener("click", clearAll);

  // Live: edits from the side panel, the in-page popup, or another device via
  // sync re-render while the page is open. (Our own writes also round-trip
  // through this — harmless, idempotent.)
  store.onDictionaryChanged((list) => {
    words = list;
    draw();
  });

  draw(); // empty-state + meter while the initial load is in flight
  const ready = store.loadDictionary().then((list) => {
    words = list;
    draw();
  });

  // `ready` is a test seam: await it to know the initial render happened.
  return { ready };
}
