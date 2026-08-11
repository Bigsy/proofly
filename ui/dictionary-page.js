// ui/dictionary-page.js — the options page's dictionary manager: the word
// list (search, per-word remove, two-step Clear all), bulk paste, newline-
// delimited text import/export, and the Chrome-sync/local-only control.
//
// Wired by initDictionaryPage(deps), mirroring ui/library.js — deps are
// injected so the module is unit-testable without chrome (and the thin entry,
// options/options.js, stays trivial):
//   els   — element map (search, bulkInput, bulkBtn, bulkReport, list, empty,
//           meter, importFile, importBtn, exportBtn, transferStatus, clearBtn,
//           syncToggle, syncStatus)
//   store — { loadDictionary, addWords, removeWord, clearDictionary,
//           loadDictionarySettings, setDictionarySyncEnabled,
//           onDictionaryChanged, onDictionarySettingsChanged }
//
// Storage writes go through the store's conflict-resistant helpers: every
// bulk operation is ONE set(). Quota rejections still surface inline.

import { isValidWord } from "../lib/dictionary.js";
export const DICTIONARY_FILENAME = "proofly-dictionary.txt";

const QUOTA_ERROR =
  "Chrome's sync storage limit was reached — remove some words or turn dictionary sync off.";

export function initDictionaryPage({ els, store }) {
  let words = [];   // current sorted list (the store owns canonical order)
  let query = "";   // live search filter
  let clearArmed = false;
  let syncEnabled = true;

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
    els.exportBtn.disabled = !words.length;
  }

  function drawMeter() {
    const n = words.length;
    els.meter.textContent =
      `${n} word${n === 1 ? "" : "s"} · ${syncEnabled ? "Chrome sync on" : "This browser only"}`;
  }

  function drawSyncSetting() {
    if (!els.syncToggle) return;
    els.syncToggle.checked = syncEnabled;
    els.syncStatus.textContent = syncEnabled
      ? "On — Chrome carries saved words to your other signed-in Chromes when browser sync is enabled."
      : "Off — saved words stay in this browser profile.";
  }

  // ---------- inline feedback ----------
  function bulkReport(msg, isError = false) {
    els.bulkReport.textContent = msg;
    els.bulkReport.classList.toggle("error", isError);
  }

  function transferReport(msg, isError = false) {
    els.transferStatus.textContent = msg;
    els.transferStatus.classList.toggle("error", isError);
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

  // ---------- text import / export ----------
  // Import is additive: one entry per line, blank lines ignored. The normal
  // dictionary validation and ONE-write addWords path still own canonical
  // storage, so an import cannot bypass token limits or duplicate handling.
  async function importSelected() {
    const [file] = els.importFile.files ?? [];
    els.importFile.value = "";
    if (!file) return;

    els.importBtn.disabled = true;
    transferReport(`Importing ${file.name}…`);
    try {
      const lines = (await file.text())
        .replace(/^\uFEFF/u, "")
        .split(/\r\n?|\n/u)
        .map((line) => line.trim())
        .filter(Boolean);
      if (!lines.length) {
        transferReport("That file doesn't contain any words.", true);
        return;
      }

      const fresh = [];
      const seen = new Set(words);
      for (const line of lines) {
        if (!isValidWord(line) || seen.has(line)) continue;
        seen.add(line);
        fresh.push(line);
      }
      const skipped = lines.length - fresh.length;
      if (fresh.length) words = await store.addWords(fresh);
      transferReport(
        `Imported ${fresh.length}${skipped ? `, skipped ${skipped} (already present or invalid)` : ""}.`,
      );
      draw();
    } catch (e) {
      transferReport(isQuotaError(e) ? QUOTA_ERROR : `Couldn't import: ${e.message || e}`, true);
    } finally {
      els.importBtn.disabled = false;
    }
  }

  function exportDictionary() {
    if (!words.length) return;
    const blob = new Blob([`${words.join("\n")}\n`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = DICTIONARY_FILENAME;
    anchor.click();
    URL.revokeObjectURL(url);
    transferReport(`Exported ${words.length} word${words.length === 1 ? "" : "s"}.`);
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
  els.importBtn.addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", importSelected);
  els.exportBtn.addEventListener("click", exportDictionary);
  els.clearBtn.addEventListener("click", clearAll);
  els.syncToggle?.addEventListener("change", async () => {
    const wanted = els.syncToggle.checked;
    els.syncToggle.disabled = true;
    els.syncStatus.textContent = wanted ? "Turning Chrome sync on…" : "Keeping words on this browser…";
    try {
      words = await store.setDictionarySyncEnabled(wanted);
      syncEnabled = wanted;
      drawSyncSetting();
      draw();
    } catch (e) {
      els.syncToggle.checked = syncEnabled;
      drawSyncSetting();
      transferReport(`Couldn't change dictionary sync: ${e.message || e}`, true);
    } finally {
      els.syncToggle.disabled = false;
    }
  });

  // Live: edits from the side panel, the in-page popup, or another device via
  // sync re-render while the page is open. (Our own writes also round-trip
  // through this — harmless, idempotent.)
  store.onDictionaryChanged((list) => {
    words = list;
    draw();
  });
  store.onDictionarySettingsChanged?.((settings) => {
    syncEnabled = settings.syncEnabled;
    drawSyncSetting();
    drawMeter();
  });

  draw(); // empty-state + meter while the initial load is in flight
  drawSyncSetting();
  const ready = Promise.all([
    store.loadDictionary(),
    store.loadDictionarySettings?.() ?? { syncEnabled: true },
  ]).then(([list, settings]) => {
    words = list;
    syncEnabled = settings.syncEnabled;
    drawSyncSetting();
    draw();
  });

  // `ready` is a test seam: await it to know the initial render happened.
  return { ready };
}
