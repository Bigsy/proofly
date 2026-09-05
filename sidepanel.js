// sidepanel.js — notes shell plus local Harper proofreading. Chrome's built-in
// AI is confined to explicit whole-text rewrites in rewrite.js.

import {
  displaySpan, findCorrectionAt, rebaseCorrectionsAfterSingleEdit,
} from "./lib/corrections.js";
import {
  applyCorrections, candidateWord, countAppliedCorrections, createMatcher,
  filterCorrections, isEligible,
} from "./lib/dictionary.js";
import { addWord, loadDictionary, onDictionaryChanged } from "./lib/dictionary-store.js";
import {
  disableHarperRule, loadProofingSettings, onProofingSettingsChanged, saveProofingSettings,
} from "./lib/proofing-settings-store.js";
import { deleteNote, getNote, listIndex, newId, saveNote } from "./lib/notes-store.js";
import { runSync } from "./lib/full-sync.js";
import { recordTombstone } from "./lib/notes-sync.js";
import { createHarperCoordinator } from "./lib/harper-coordinator.js";
import { clearSyncDiagnostic, recordSyncError } from "./lib/sync-diagnostics.js";
import { createSupersedeSlot } from "./lib/supersede.js";
import { initRewrite } from "./rewrite.js";
import { initLibrary } from "./ui/library.js";
import { initNotesRouter } from "./ui/notes-router.js";
import { initRender } from "./ui/render.js";
import { renderLibraryApiSetup } from "./ui/setup-help.js";
import { initSyncScheduler } from "./ui/sync-scheduler.js";
import { isApplicableCorrection } from "./ui/correction-card.js";

const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"),
  statusText: $("statusText"),
  backBtn: $("backBtn"),
  library: $("library"),
  editorView: $("editor-view"),
  docList: $("docList"),
  docSearch: $("docSearch"),
  docEmpty: $("docEmpty"),
  apiSetup: $("apiSetup"),
  syncStatusLine: $("syncStatusLine"),
  newDocBtn: $("newDocBtn"),
  editor: $("editor"),
  backdrop: $("backdrop"),
  highlights: $("highlights"),
  charCount: $("charCount"),
  undoBtn: $("undoBtn"),
  redoBtn: $("redoBtn"),
  proofingDialect: $("proofingDialect"),
  manageDictBtn: $("manageDictBtn"),
  empty: $("empty"),
  results: $("results"),
  summary: $("summary"),
  correctionsDrop: $("correctionsDrop"),
  correctionsList: $("correctionsList"),
  applyBtn: $("applyBtn"),
  rewriteDrop: $("rewriteDrop"),
  customPromptList: $("customPromptList"),
  newPromptBtn: $("newPromptBtn"),
  promptForm: $("promptForm"),
  promptName: $("promptName"),
  promptInstruction: $("promptInstruction"),
  promptSave: $("promptSave"),
  promptCancel: $("promptCancel"),
  promptError: $("promptError"),
  popup: $("popup"),
  toast: $("toast"),
  toastText: $("toastText"),
  toastUndo: $("toastUndo"),
};

let debounceTimer = null;
let toastTimer = null;        // auto-dismiss for the undo toast

// The shared supersede slot (see lib/supersede.js): proofread, rewrite, and
// the editor's input handler all share this ONE instance.
const supersede = createSupersedeSlot();
const panelScopeToken = globalThis.crypto?.randomUUID?.()
  ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

// The text + corrections currently reflected by the on-screen squiggles,
// plus the fully-corrected text (used by "Apply all corrections").
// currentCorrections is the FILTERED list (raw minus dictionary-suppressed) —
// every consumer below (squiggle click, cards, Apply) indexes it, so indices
// stay self-consistent with what's rendered. The raw list is kept so a
// dictionary change re-derives without re-proofreading (a Set lookup, not a
// model call).
let currentText = "";
let currentRawCorrections = [];
let currentCorrections = [];
let currentCorrected = "";

// Session-only dismissal is deliberately narrower than the dictionary: keep
// one occurrence quiet for the current note visit, in memory only. Markers
// rebase through unrelated edits so a newly typed occurrence is still linted.
let temporaryIgnores = { text: "", markers: [] };

function sameDisplayedOccurrence(text, correction, marker) {
  const correctionSpan = displaySpan(text, correction);
  const markerSpan = displaySpan(text, marker);
  return !!correctionSpan && !!markerSpan
    && correctionSpan.start === markerSpan.start
    && correctionSpan.end === markerSpan.end;
}

function trackTemporaryIgnores(text) {
  if (text === temporaryIgnores.text) return;
  const markers = rebaseCorrectionsAfterSingleEdit(
    temporaryIgnores.text, temporaryIgnores.markers, text,
  );
  temporaryIgnores = { text, markers };
}

// ---------- custom dictionary ----------
// Synced word list used both by the background-owned Harper configuration and
// by this immediate post-filter, so a dictionary add removes current issues
// without waiting for another lint.
let dictionary = { words: [], matcher: createMatcher([]) };

function setDictionary(words) {
  dictionary = { words, matcher: createMatcher(words) };
}

// Chrome rewriting remains a separate explicit feature. Its language hint is
// derived from the browser locale and is not governed by Harper's dialect.
const getRewriteLanguages = () => [navigator.language?.split("-")[0] || "en"];

// ---------- status helpers ----------
function setStatus(kind, text) {
  els.status.className = `status status--${kind}`;
  els.statusText.textContent = text;
}

const harper = createHarperCoordinator({
  scopeId: `sidepanel:${panelScopeToken}:editor`,
  onStatus({ state, error }) {
    if (state === "proofreading") setStatus("ok", "Proofreading locally…");
    else if (state === "ready") setStatus("ok", "Ready");
    else if (state === "error") {
      setStatus("error", `Proofreading unavailable: ${error?.message || "Harper failed"}`);
    }
  },
});

// ---------- core action ----------
async function runProofread() {
  const text = els.editor.value;
  if (!text.trim()) return showEmpty();
  const req = supersede.begin();
  const batch = harper.capture({
    isSnapshotCurrent: () => req.isCurrent() && els.editor.value === text,
  });
  try {
    const corrections = await batch.lint(text);
    if (!batch.isCurrent() || corrections == null) return;
    renderResult(text, { corrections });
  } finally {
    req.release();
  }
}

// ---------- undo-preserving writes ----------
// Every programmatic editor mutation goes through here so it lands on the
// textarea's NATIVE undo stack (Cmd+Z works afterwards). execCommand is
// deprecated, but this is a Chrome-only MV3 extension and "insertText" is
// the only write that pushes an undo entry — setRangeText/.value= do not.
//
// Contract: the write fires an `input` event (real from insertText, synthetic
// on the fallback path), so the shared input handler does its synchronous
// duties (clear stale squiggles, hide popup/toast, abort in-flight proofread,
// start debounce). This helper then owns the follow-up proofread: it cancels
// that debounce and runs immediately, keeping Apply's instant feedback.
// Callers must NOT call runProofread() themselves — one trigger path.
function replaceEditorText(newText) {
  const { selectionStart, scrollTop } = els.editor;
  els.editor.focus();
  els.editor.select();
  let ok;
  try {
    ok = document.execCommand("insertText", false, newText);
  } catch { ok = false; }
  if (!ok) {
    // No native undo entry here (jsdom, or a future Chrome that drops
    // execCommand) — but keep the same value + input-event flow.
    els.editor.value = newText;
    els.editor.dispatchEvent(new Event("input", { bubbles: true }));
  }
  // Restore cursor/scroll: insertText leaves the caret at the end and may
  // scroll there; put both roughly back where the user had them.
  const pos = Math.min(selectionStart, newText.length);
  els.editor.setSelectionRange(pos, pos);
  els.editor.scrollTop = scrollTop;
  syncScroll();
  clearTimeout(debounceTimer);
  runProofread();
}

// Transient "Applied N corrections — Undo" affordance. Cmd+Z works after any
// programmatic write, but users won't know — the toast tells them, for the
// big replacements (Apply all; later: rewrite). Single-fix applies skip it
// (a toast per fix would be noisy). The next user edit dismisses it (input
// handler); otherwise it auto-dismisses.
const TOAST_MS = 8000;
function showUndoToast(message) {
  els.toastText.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, TOAST_MS);
}

function hideToast() {
  els.toast.hidden = true;
  clearTimeout(toastTimer);
}

// Header ↶/↷ buttons mirror the native stack's state. queryCommandEnabled is
// deprecated-but-Chrome-only (same trade as insertText); anywhere it's
// missing the buttons just stay disabled.
function refreshUndoButtons() {
  let canUndo = false;
  let canRedo = false;
  try {
    canUndo = document.queryCommandEnabled("undo");
    canRedo = document.queryCommandEnabled("redo");
  } catch { /* leave both disabled */ }
  els.undoBtn.disabled = !canUndo;
  els.redoBtn.disabled = !canRedo;
}

// ---------- rendering ----------
// DOM building (backdrop squiggles, cards, popup) lives in ui/render.js;
// the current* result state stays HERE — renderResult below is the seam
// between proofreading and rendering.
const render = initRender({
  els,
  onApply: applyCorrection,
  onDisableRule: disableHarperRule,
  onSelectSuggestion: selectSuggestion,
  onAddToDictionary: addToDictionary,
  onDismiss: dismissCorrection,
  // The "Add to dictionary" affordance, bound to the current text. Injected
  // (rather than imported by ui/) to keep the established seam: result state
  // lives here, ui/ stays chrome-free and cycle-free.
  getCandidate: (c) => (isEligible(currentText, c) ? candidateWord(currentText, c) : null),
  syncScroll,
});

function selectSuggestion(i, replacement) {
  const correction = currentCorrections[i];
  if (!correction || typeof replacement !== "string") return;
  correction.correction = replacement;
  currentCorrected = applyCorrections(currentText, currentCorrections);
  els.applyBtn.disabled = currentCorrected === currentText;
}

function renderResult(original, result) {
  currentText = original;
  currentRawCorrections = Array.isArray(result?.corrections) ? result.corrections : [];
  rerenderFromRaw();
}

// The tail of renderResult, reusable when only the DICTIONARY changed: derive
// the filtered list from the raw corrections and render it everywhere —
// squiggles, cards, summary count, Apply-all state. Note currentCorrected is
// spliced from the filtered list (lib/dictionary.js applyCorrections), NOT
// taken from result.correctedInput: the model's corrected text includes the
// fixes the dictionary suppressed, and applying it would "fix" the user's
// word right back.
function rerenderFromRaw() {
  const corrections = filterCorrections(currentText, currentRawCorrections, dictionary.matcher)
    .filter((correction) => !temporaryIgnores.markers.some(
      (marker) => sameDisplayedOccurrence(currentText, correction, marker),
    ));
  currentCorrections = corrections;
  currentCorrected = applyCorrections(currentText, corrections);

  els.empty.hidden = true;
  els.results.hidden = false;

  const n = corrections.length;
  const correctionCount = corrections.filter(isApplicableCorrection).length;
  const adviceCount = n - correctionCount;
  if (n === 0) {
    els.summary.textContent = "No issues found";
  } else if (adviceCount === 0) {
    els.summary.textContent = `${correctionCount} correction${correctionCount === 1 ? "" : "s"} suggested.`;
  } else if (correctionCount === 0) {
    els.summary.textContent = `${adviceCount} writing suggestion${adviceCount === 1 ? "" : "s"}.`;
  } else {
    els.summary.textContent = `${correctionCount} correction${correctionCount === 1 ? "" : "s"} and ${adviceCount} writing suggestion${adviceCount === 1 ? "" : "s"}.`;
  }

  // Apply-all only acts on the result it was rendered with — any editor
  // mutation disables it (input handler) until the next result lands here.
  els.applyBtn.disabled = currentCorrected === currentText;

  // Nothing to expand when clean; otherwise leave the user's open/closed
  // choice alone (collapsed by default — the <details> ships closed).
  els.correctionsDrop.classList.toggle("is-empty", n === 0);
  if (n === 0) els.correctionsDrop.open = false;

  render.renderBackdrop(currentText, corrections);
  render.renderCorrections(currentText, corrections);
}

// "Add to dictionary" from a popup or card: suppress the word NOW (optimistic
// in-memory add + re-filter + re-render — every squiggle for that word drops
// at once; that's the feedback, no toast), then persist. The onChanged
// round-trip just re-derives the same state. NEVER re-proofreads.
async function addToDictionary(i) {
  const word = candidateWord(currentText, currentCorrections[i] ?? {});
  if (!word) return;
  render.hidePopup();
  setDictionary([...dictionary.words, word]);
  if (currentRawCorrections.length && els.editor.value === currentText) rerenderFromRaw();
  try {
    await addWord(word);
  } catch (e) {
    // The side panel is our UI — quota errors are loud (engine.js stance).
    setStatus("error", `Couldn't save “${word}”: ${e.message || e}`);
  }
}

// Dismiss this occurrence without editing, persisting, or re-linting. Outside
// click and Escape still call hidePopup() and therefore remain plain closes.
function dismissCorrection(i) {
  const correction = currentCorrections[i];
  if (!correction || !displaySpan(currentText, correction)) {
    render.hidePopup();
    return;
  }
  if (temporaryIgnores.text !== currentText) {
    temporaryIgnores = { text: currentText, markers: [] };
  }
  const marker = { startIndex: correction.startIndex, endIndex: correction.endIndex };
  if (!temporaryIgnores.markers.some(
    (kept) => sameDisplayedOccurrence(currentText, marker, kept),
  )) temporaryIgnores.markers.push(marker);
  render.hidePopup();
  rerenderFromRaw();
}

// ---------- inline interaction (click squiggle → popup → apply) ----------
function syncScroll() {
  els.backdrop.scrollTop = els.editor.scrollTop;
  els.backdrop.scrollLeft = els.editor.scrollLeft;
}

// Apply a single correction by splicing it into the editor. The undo-
// preserving write fires `input` (hiding the popup, clearing squiggles) and
// re-proofreads immediately so the remaining indices stay correct. No toast
// here — Cmd+Z covers the single-fix case without the noise.
function applyCorrection(i) {
  const c = currentCorrections[i];
  if (!c) return;
  const start = Number(c.startIndex);
  const end = Number(c.endIndex);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return;

  replaceEditorText(
    currentText.slice(0, start) + (c.correction ?? "") + currentText.slice(end),
  );
}

// ---------- empty / unsupported states ----------
function showEmpty() {
  els.results.hidden = true;
  els.empty.hidden = false;
  els.empty.textContent = "Type something — Proofly proofreads as you type, on-device.";
}

// Setup/help states are DOM-built in ui/setup-help.js (no innerHTML). Chrome
// blocks page-initiated navigation to chrome:// URLs, so the Docs footer opens
// its flag links through chrome.tabs.create.
const openFlagUrl = (url) => globalThis.chrome.tabs.create({ url });
renderLibraryApiSetup(els.apiSetup, { openUrl: openFlagUrl });

// ---------- notes: view transitions ----------
// Drop everything derived from the last proofread/rewrite — the result state,
// squiggles, popup, toast — and cancel the debounced + in-flight work. Every
// navigation goes through here: openNote/startNewDoc swap the editor's value
// directly (no `input` event), so without this the previous note's state
// survives the transition. That state is actively dangerous, not just stale:
// a popup "Apply" splices `currentText` — the PREVIOUS note's body — into the
// editor (then auto-save persists it), and an in-flight proofread would land
// its squiggles on whatever doc is open by then.
function resetResultState() {
  supersede.invalidate();      // abort the in-flight proofread/rewrite…
  harper.invalidate();
  clearTimeout(debounceTimer); // …and cancel the one the debounce hasn't started
  currentText = "";
  currentRawCorrections = [];
  currentCorrections = [];
  currentCorrected = null;
  temporaryIgnores = { text: "", markers: [] };
  els.applyBtn.disabled = true;
  els.results.hidden = true;
  render.clearBackdrop();
  render.hidePopup();
  hideToast(); // its "Undo" maps to an edit of the note we're leaving
  setStatus("ok", "Ready");
}

// Mirrors the old load-time behaviour for whatever doc just opened: proofread
// only when the model is ready AND there's text. A blank editor (new doc) shows
// the placeholder — no proofread. Merely-downloadable stays gated behind the
// Download button, so this never nags on open.
function autoProofreadCurrentDoc() {
  if (els.editor.value.trim()) runProofread();
  else showEmpty();
}

// The router owns the library ⇄ editor state machine and auto-save; the
// scheduler owns the debounced sync loop and its status line (both in ui/,
// deps-injected). The `library`/`sync` references inside the injected
// closures resolve lazily — all three exist before any callback can fire.
const router = initNotesRouter({
  els,
  store: { getNote, saveNote, listIndex, newId },
  onResetResults: () => resetResultState(),
  onDocOpened: () => autoProofreadCurrentDoc(),
  updateCharCount: () => updateCharCount(),
  onSaved: () => sync.schedule(),
  renderList: (index) => library.render(index),
});

const library = initLibrary({
  els,
  onOpen: (id) => router.navigate(() => router.openNote(id)),
  onNew: () => router.navigate(router.startNewDoc),
  onDelete: async (id) => {
    await recordTombstone(id);
    await deleteNote(id);
    library.render(await listIndex());
    sync.syncNow();
  },
  onExport: (id) => router.exportNote(id),
});

const sync = initSyncScheduler({
  statusEl: els.syncStatusLine,
  runSync,
  getOpenNote: () => router.getOpenNote(),
  isEditorDirty: () => router.editorDirty(),
  isEditorBlank: () => !els.editor.value.trim(),
  isLibraryVisible: () => !els.library.hidden,
  refreshList: async () => library.render(await listIndex()),
  openLibrary: () => router.renderLibrary(),
  reloadOpenNote: (id) => router.reloadOpenNote(id),
  onSyncError: recordSyncError,
  onSyncSuccess: clearSyncDiagnostic,
});

els.backBtn.addEventListener("click", () => router.navigate(router.renderLibrary));

// Best-effort flush on panel close. Async chrome.storage.local writes can't be
// *guaranteed* to land here — the typing debounce + the Back flush cover the
// common case; this is documented, not promised.
window.addEventListener("pagehide", () => { router.flushSave(); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") router.flushSave();
});

// ---------- wiring ----------
function updateCharCount() {
  els.charCount.textContent = `${els.editor.value.length} chars`;
}

// Proofreading runs automatically: debounced on every edit, and once on load
// when the editor already has text (see init).
const DEBOUNCE_MS = 700;
function scheduleAuto() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runProofread, DEBOUNCE_MS);
}

els.editor.addEventListener("input", () => {
  updateCharCount();
  trackTemporaryIgnores(els.editor.value);
  render.hidePopup();
  hideToast(); // an edit means the toast's "Undo" no longer maps to one action
  // Text changed: invalidate the in-flight proofread NOW, not when the next
  // run starts — the seq bump makes a stale render impossible, the abort
  // stops wasting the model on a result nobody wants.
  supersede.invalidate();
  harper.invalidate();
  // …and drop the now-stale result state until the next proofread lands:
  // squiggles, and the Apply-all action — its corrected text refers to text
  // that no longer exists in the editor. Raw corrections too, so a dictionary
  // change in the stale window can't re-render them.
  currentRawCorrections = [];
  currentCorrections = [];
  currentCorrected = null;
  els.applyBtn.disabled = true;
  render.clearBackdrop();
  refreshUndoButtons();
  scheduleAuto();
  router.scheduleSave(); // debounced auto-save of the open note (no-op in the library)
});

// Click a squiggle → show the suggestion popup. selectionStart gives the offset.
els.editor.addEventListener("click", (e) => {
  const i = findCorrectionAt(currentText, currentCorrections, els.editor.selectionStart);
  if (i >= 0) render.showPopup(currentText, currentCorrections[i], i, e.clientX, e.clientY);
  else render.hidePopup();
});

els.editor.addEventListener("scroll", () => {
  syncScroll();
  render.hidePopup();
});

// The custom dictionary's management UI is the options page (a real tab).
// Guarded: the jsdom harness has chrome.storage but no chrome.runtime.
els.manageDictBtn.addEventListener("click", () => {
  globalThis.chrome?.runtime?.openOptionsPage?.();
});

els.applyBtn.addEventListener("click", () => {
  if (currentCorrected == null) return; // stale — disabled, but belt-and-braces
  const n = countAppliedCorrections(currentText, currentCorrections); // before input clears it
  replaceEditorText(currentCorrected);
  showUndoToast(`Applied ${n} correction${n === 1 ? "" : "s"}`);
});

// Whole-text rewrite (presets + saved custom prompts) — wired and
// availability-gated by the rewrite module (rewrite.js). It shares the
// supersede slot (a rewrite aborts an in-flight proofread and vice versa)
// and writes through replaceEditorText (one trigger path).
initRewrite({
  els,
  supersede,
  replaceEditorText,
  setStatus,
  showUndoToast,
  getInputLangs: getRewriteLanguages,
  cancelPendingProofread: () => clearTimeout(debounceTimer),
});

// Undo/redo issue native editing commands, which need the textarea focused:
// preventDefault() on mousedown keeps focus from moving to the button, and
// the explicit focus() covers activation paths with no mousedown (keyboard).
// These act on the NATIVE stack — they'll step back through the user's own
// typing too, like a word-processor toolbar undo; the toast is the
// action-scoped "undo Proofly's last apply" affordance.
els.toastUndo.addEventListener("mousedown", (e) => e.preventDefault());
els.toastUndo.addEventListener("click", () => {
  els.editor.focus();
  document.execCommand("undo");
  hideToast();
});

for (const [btn, cmd] of [[els.undoBtn, "undo"], [els.redoBtn, "redo"]]) {
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", () => {
    els.editor.focus();
    document.execCommand(cmd);
    // A successful command fires `input` (which refreshes too); this keeps
    // the buttons honest when there was nothing to undo/redo.
    refreshUndoButtons();
  });
}

els.proofingDialect.addEventListener("change", () => {
  saveProofingSettings({ dialect: els.proofingDialect.value }).catch(() => {});
});

// ---------- init ----------
(async function init() {
  updateCharCount();
  refreshUndoButtons();
  els.proofingDialect.value = (await loadProofingSettings()).dialect;
  onProofingSettingsChanged(({ dialect }) => {
    render.hidePopup(); // Old popup indices must not address the refreshed result.
    els.proofingDialect.value = dialect;
    if (!els.editorView.hidden && els.editor.value.trim()) runProofread();
  });

  // Harper is packaged with the extension and initializes lazily on the first
  // lint. Chrome AI availability only gates the separate Rewrite controls.
  setStatus("ok", "Ready");

  // Load the dictionary BEFORE the first auto-proofread (one get — a race
  // guard so the first render is already filtered, no squiggle flash), then
  // follow changes from any context: the options page, the in-page surface,
  // another device via sync. A change re-derives from the kept raw
  // corrections — never re-proofreads — but only while the editor still shows
  // the text those corrections describe.
  setDictionary(await loadDictionary());
  onDictionaryChanged((words) => {
    setDictionary(words);
    if (currentRawCorrections.length && els.editor.value === currentText) rerenderFromRaw();
  });

  const index = await listIndex();
  if (index.length) {
    // Stored notes → open the library.
    router.showLibraryView();
    library.render(index);
  } else {
    // No stored notes → straight into a blank editor (fixed requirement #1).
    // The harness may have pre-seeded editor text; auto-proofread it on load
    // when the model's ready, mirroring the old demo-text behaviour.
    router.startEditorWithCurrentText();
  }

  sync.syncNow();
})();
