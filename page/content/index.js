// page/content/index.js — lifecycle for the in-page proofreader: find the
// focused eligible field, lint it on pause, render squiggles, and wire the
// click → popup → Apply loop.
//
// Cost discipline: everything is focus- and visibility-scoped.
// Only the FOCUSED field is ever linted; engine calls are hard-gated on
// `visibilityState === "visible"` && `document.hasFocus()`; pending work is
// cancelled and the in-flight result invalidated the moment the tab hides; the
// 100 ms position poll only runs while a focused field has results on screen.
// Steady state for a background tab is this module's import and nothing else.
//
// Loaded as an ES module via the bootstrap's dynamic import() — it's a
// side-effect module like sidepanel.js: importing it wires the page once.

import {
  displaySpan, findCorrectionAt, rebaseCorrectionsAfterSingleEdit,
} from "../../lib/corrections.js";
import { candidateWord, createMatcher, filterCorrections, isEligible } from "../../lib/dictionary.js";
import { addWord, loadDictionary, onDictionaryChanged } from "../../lib/dictionary-store.js";
import { originPattern, samePattern } from "../../lib/sites.js";
import { onProofingSettingsChanged } from "../../lib/proofing-settings-store.js";
import { createSupersedeSlot } from "../../lib/supersede.js";
import { adapterForField } from "./adapters/index.js";
import {
  adapterEnabled, loadEditorAdapterFlags, normalizeEditorAdapterFlags, watchEditorAdapterFlags,
} from "./adapter-flags.js";
import { isEligibleField } from "./detect.js";
import { createPageEngine } from "./engine.js";
import { declaredFieldLanguage, isSupportedFieldLanguage } from "./language.js";
import { createOverlayRenderer } from "./highlights.js";
import { createProofreadWindowsForText, mergeWindowCorrections } from "./proofread-window.js";
import { eventBelongsToField, resolveActiveField, resolveFieldFromEvent } from "./resolve.js";
import { EditorSession } from "./session.js";

// Longer than the side panel's 700 ms: arbitrary pages can contain large
// editors, so lean further toward lint-on-pause.
export const PAGE_DEBOUNCE_MS = 1000;
const POLL_MS = 100;

const supersede = createSupersedeSlot();
const engine = createPageEngine({ supersede });
const renderer = createOverlayRenderer();
const fieldScopes = new WeakMap();
const frameScopeToken = globalThis.crypto?.randomUUID?.()
  ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let fieldScopeSequence = 0;
function scopeForField(field) {
  let scope = fieldScopes.get(field);
  if (!scope) {
    scope = `page:${frameScopeToken}:field:${++fieldScopeSequence}`;
    fieldScopes.set(field, scope);
  }
  return scope;
}

let activeSession = null;
// The lint result the squiggles reflect: { text, raw, corrections, snapshot }.
// Snapshot ownership: `result` is the ONLY owner of a kept snapshot — sessions
// never store one (see session.js). The dispose sites are clearResult(),
// runLint's early exits for snapshots the result never took, and commitResults'
// stale-mapping retake (which detaches the result first); nothing else may
// dispose, so a rendered result can never hold a disposed snapshot.
let result = null;
let renderQueued = false;
let torndown = false;

// jsdom (no pretendToBeVisual) lacks requestAnimationFrame; a timer keeps the
// same coalescing semantics under the test harness's fake timers.
const raf = globalThis.requestAnimationFrame?.bind(globalThis)
  ?? ((fn) => setTimeout(fn, 16));

// ---------- the visibility/focus hard gate ----------
// Real typing only happens in one visible, focused tab. Page-driven events in
// background tabs (synthetic `input`, mutations) must never reach the engine.
const gateOpen = () =>
  document.visibilityState === "visible" && document.hasFocus();

// ---------- custom dictionary ----------
// Synced word list the lint results are post-filtered through (the same seam
// as the side panel — see lib/dictionary.js). Loaded fire-and-forget at init:
// until storage answers we filter with the empty matcher — worst case a
// squiggle appears, then drops when the list lands below.
let dictWords = [];
let dictMatcher = createMatcher([]);
let unsubscribeDictionary = null;
let unsubscribeAdapterFlags = null;
let unsubscribeProofingSettings = null;

// ---------- temporary ignores ----------
// Dismiss is deliberately weaker than the dictionary: it remembers one
// occurrence in one textbox, in memory only. Markers are rebased as text is
// edited elsewhere, so the dismissed occurrence stays quiet while a newly
// typed occurrence of the same word can still be reported.
const temporaryIgnores = new WeakMap();

function sameDisplayedOccurrence(text, correction, marker) {
  const correctionSpan = displaySpan(text, correction);
  const markerSpan = displaySpan(text, marker);
  return !!correctionSpan && !!markerSpan
    && correctionSpan.start === markerSpan.start
    && correctionSpan.end === markerSpan.end;
}

function trackTemporaryIgnores(session) {
  const field = session?.field;
  const state = field && temporaryIgnores.get(field);
  if (!state) return;
  const text = session.currentText();
  if (text === state.text) return;
  const markers = rebaseCorrectionsAfterSingleEdit(state.text, state.markers, text);
  if (markers.length) temporaryIgnores.set(field, { text, markers });
  else temporaryIgnores.delete(field);
}

function rememberTemporaryIgnore(field, text, correction) {
  if (!field || !displaySpan(text, correction)) return false;
  const state = temporaryIgnores.get(field);
  const markers = state?.text === text ? [...state.markers] : [];
  const marker = {
    startIndex: correction.startIndex,
    endIndex: correction.endIndex,
  };
  if (!markers.some((kept) => sameDisplayedOccurrence(text, marker, kept))) markers.push(marker);
  temporaryIgnores.set(field, { text, markers });
  return true;
}

// ---------- adapter flags ----------
// The per-adapter kill switch (see adapter-flags.js). Activation is gated on
// the current flags everywhere a field resolves to an adapter; defaults apply
// until the async storage load lands (same fire-and-forget stance as the
// dictionary — the flag change handler settles any race).
let adapterFlags = normalizeEditorAdapterFlags(null);

// Swap the dictionary in and re-derive the rendered corrections from the kept
// raw list — a Set lookup, never a re-lint. Fires for the initial load, our
// own adds, the options page, and other devices via sync alike. The popup may
// be showing a correction that just got suppressed; it's transient — just
// hide it.
function applyDictionary(words) {
  dictWords = words;
  dictMatcher = createMatcher(words);
  if (!result) return;
  result = {
    ...result,
    corrections: visibleCorrections(
      result.text, result.raw, dictMatcher, result.snapshot, activeField(),
    ),
  };
  renderer.hidePopup();
  requestRender();
}

function activeField() {
  return activeSession?.field ?? null;
}

function clearResult() {
  result?.snapshot?.dispose?.();
  result = null;
}

function visibleCorrections(text, corrections, matcher, snapshot, field = activeField()) {
  const ignored = temporaryIgnores.get(field);
  const markers = ignored?.text === text ? ignored.markers : [];
  return filterCorrections(text, corrections, matcher)
    .filter((correction) =>
      !markers.some((marker) => sameDisplayedOccurrence(text, correction, marker)))
    .filter((correction) => !snapshot || snapshot.rangeForSpan(correction.startIndex, correction.endIndex));
}

function tryRebaseResult(session) {
  const previous = result;
  if (!previous?.raw?.length || !session?.adapter) return false;
  let snapshot = null;
  try {
    snapshot = session.adapter.snapshot(session.field);
    const text = snapshot.text;
    if (!text.trim()) return false;
    const raw = rebaseCorrectionsAfterSingleEdit(previous.text, previous.raw, text);
    if (!raw.length) return false;
    const corrections = visibleCorrections(text, raw, dictMatcher, snapshot, session.field);
    if (!corrections.length) return false;
    clearResult();
    result = { text, raw, corrections, snapshot };
    requestRender();
    return true;
  } finally {
    if (snapshot && result?.snapshot !== snapshot) snapshot.dispose();
  }
}

// The seam a session reaches the orchestrator through — see the host contract
// in session.js.
const sessionHost = {
  gateOpen,
  isActiveSession: (session) => activeSession === session && !torndown,
  abortInFlight: () => supersede.invalidate(),
  trackEdit: trackTemporaryIgnores,
  hidePopup: () => renderer.hidePopup(),
  clearOverlay: () => renderer.clear(),
  clearResult,
  tryRebase: tryRebaseResult,
  requestRender: () => requestRender(),
  deactivate: () => deactivate(),
  runLint: (session) => runLint(session),
  hasResult: () => !!result,
  resultSnapshot: () => result?.snapshot,
  debounceMs: PAGE_DEBOUNCE_MS,
  pollMs: POLL_MS,
};

function applyAdapterFlags(flags) {
  adapterFlags = flags;
  if (activeSession && !adapterEnabled(flags, activeSession.adapterId)) deactivate();
  // A newly-enabled adapter picks up the already-focused field — without this
  // the flag only takes effect on the next refocus.
  if (!activeSession && !torndown) {
    const field = resolveActiveField(document, adapterFlags);
    if (field && isEligibleField(field, adapterFlags)) activate(field);
  }
}

// ---------- lint ----------
function scheduleLint() {
  activeSession?.scheduleLint();
}

async function runLint(session = activeSession) {
  const field = session?.field;
  if (!field || !session.isActive() || !gateOpen()) return;
  if (!field.isConnected) {
    deactivate();
    return;
  }
  // Re-checked per lint (not only at activation) so a mid-session `lang` swap
  // stops the linting without waiting for a refocus. Covers probe and create
  // alike: this is the engine's only caller.
  if (!isSupportedFieldLanguage(field)) {
    clearResult();
    renderer.clear();
    return;
  }
  const snapshot = session.takeSnapshot();
  const text = snapshot.text;
  if (!text.trim()) {
    snapshot.dispose();
    clearResult();
    renderer.clear();
    return;
  }
  const proofreadWindows = createProofreadWindowsForText(text, session.caretOffsetForSnapshot(snapshot));
  if (!proofreadWindows?.length) {
    snapshot.dispose();
    clearResult();
    renderer.clear();
    return;
  }
  // One commit path for the incremental per-window renders and the final
  // result. Keep the raw list and render the dictionary-filtered one. Click
  // lookup, popup, and applyFix all index result.corrections, so indices stay
  // self-consistent with what's on screen. Re-commits reuse the SAME snapshot
  // (retaking it if churn remapped nodes under an unchanged text), so only
  // dispose the previous result's when it isn't this one.
  let committed = false;
  let liveSnapshot = snapshot;
  const commitResults = (windowResults) => {
    if (torndown || session !== activeSession || !field.isConnected) return;
    if (!liveSnapshot.isCurrent()) {
      // Text-preserving DOM churn during the proofread (decoration spans
      // wrapping/unwrapping — Slack's composer does this constantly) remaps
      // nodes without changing the text: retake the mapping rather than drop
      // the finished result. A real text change still discards it.
      const fresh = session.takeSnapshot();
      if (fresh.text !== text) {
        fresh.dispose();
        return;
      }
      if (result?.snapshot === liveSnapshot) result = null; // detach before disposing
      liveSnapshot.dispose();
      liveSnapshot = fresh;
    }
    const raw = mergeWindowCorrections(windowResults);
    if (result?.snapshot === liveSnapshot) result = null;
    else clearResult();
    committed = true;
    result = {
      text,
      raw,
      corrections: visibleCorrections(text, raw, dictMatcher, liveSnapshot, field),
      snapshot: liveSnapshot,
      proofreadWindows,
    };
    requestRender();
  };
  // Multi-window lints render incrementally: each finished window's squiggles
  // land while the next window is still in flight, and a supersede or failure
  // late in the batch keeps what already rendered instead of discarding it.
  const windowResults = await engine.proofreadWindows(proofreadWindows, {
    onWindowResult: commitResults,
    scopeId: scopeForField(field),
  });
  // The first commit hands snapshot ownership to `result` — from then on
  // clearResult() (or a later commit's retake) is its dispose site (it may
  // already have run, e.g. a deactivate while the batch was in flight), so
  // never dispose it here. Before that, `liveSnapshot` is runLint's to free.
  const releaseSnapshot = () => {
    if (!committed) liveSnapshot.dispose();
  };
  if (!windowResults || torndown || session !== activeSession) { // null = superseded/unavailable/error
    releaseSnapshot();
    return;
  }
  if (!field.isConnected) {
    releaseSnapshot();
    deactivate();
    return;
  }
  commitResults(windowResults); // stale-but-text-identical mappings are retaken inside
  releaseSnapshot();
}

// ---------- render (geometry only — never re-lints) ----------
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  raf(() => {
    renderQueued = false;
    const field = activeField();
    if (!field || !result) return;
    if (!field.isConnected) {
      deactivate();
      return;
    }
    if (result.snapshot?.kind === "dom") renderer.renderSnapshot(field, result.snapshot, result.corrections);
    else renderer.render(field, result.text, result.corrections);
  });
}

// ---------- field activation ----------
function activate(field) {
  if (field === activeField()) return;
  deactivate();
  const adapter = adapterForField(field, adapterFlags);
  if (!adapter) return; // caller checked eligibility under the same flags
  activeSession = new EditorSession(field, adapter, sessionHost);
  trackTemporaryIgnores(activeSession);
  activeSession.startPoll();
  if (activeSession.currentText().trim()) scheduleLint();
}

function deactivate() {
  const session = activeSession;
  if (!session) return;
  activeSession = null;
  session.dispose();
  supersede.invalidate(); // abort anything in flight for the old field
  renderer.hidePopup();
  renderer.clear();
  clearResult();
}

// ---------- event handlers ----------
function onFocusIn(e) {
  const field = resolveFieldFromEvent(e, adapterFlags);
  if (field && isEligibleField(field, adapterFlags)) activate(field);
  else if (adapterFlags.debug) {
    if (!field) console.debug("[proofly] focusin resolved no enabled adapter root", e.target);
    else if (!isSupportedFieldLanguage(field)) {
      console.debug(`[proofly] field skipped: declared language "${declaredFieldLanguage(field)}" is unsupported`, field);
    }
  }
}

function onFocusOut(e) {
  // The popup keeps the field focused via preventDefault on mousedown, so a
  // real focusout means the user genuinely left the field.
  const session = activeSession;
  if (!session) return;
  // …except keyboard access: Tab moving focus into our own overlay (the
  // popup's buttons) is not "leaving the field" — deactivating here would
  // destroy the popup under the keyboard user.
  if (e.relatedTarget?.closest?.("#proofly-highlight-host")) return;
  if (eventBelongsToField(e, session.field, adapterFlags)) deactivate();
}

// Delegated `input` (capture, so page handlers can't stopPropagation it away):
// catches typing, paste, drag-drop, cut, autofill — everything.
function onInput(e) {
  const session = activeSession;
  if (!session || !eventBelongsToField(e, session.field, adapterFlags)) return;
  // Text changed: nothing in flight is valid any more, and the on-screen
  // squiggles point at old offsets — drop both now, re-lint on pause.
  session.input(e);
}

function onCompositionStart(e) {
  const session = activeSession;
  if (!session || !eventBelongsToField(e, session.field, adapterFlags)) return;
  session.compositionStart();
}

function onCompositionEnd(e) {
  const session = activeSession;
  if (!session || !eventBelongsToField(e, session.field, adapterFlags)) return;
  session.compositionEnd();
}

function onKeyUp(e) {
  const session = activeSession;
  if (!session || !eventBelongsToField(e, session.field, adapterFlags)) return;
  session.keyupFallback();
}

// Click in the field → which correction is under the caret? → popup.
function onClick(e) {
  const field = activeField();
  const session = activeSession;
  if (!session || !eventBelongsToField(e, field, adapterFlags) || !result) return;
  if (!session.resultIsCurrent(result)) {
    // A stale mapping whose repair hasn't landed yet (decoration churn,
    // post-apply normalization) is fixable right here: rebase onto a fresh
    // snapshot. Refuse only when the text truly moved on.
    if (!tryRebaseResult(session) || !session.resultIsCurrent(result)) {
      if (adapterFlags.debug) console.debug("[proofly] click ignored: result is stale");
      return;
    }
  }
  const pos = session.caretOffset();
  if (pos == null) {
    if (adapterFlags.debug) console.debug("[proofly] click ignored: caret offset unresolved");
    return;
  }
  const i = findCorrectionAt(result.text, result.corrections, pos);
  if (i >= 0) {
    const c = result.corrections[i];
    renderer.showPopup(result.text, c, i, e.clientX, e.clientY, {
      onApply: applyFix,
      onSelectSuggestion: selectFixSuggestion,
      // Only suppressible corrections get the button — eligibility is decided
      // here so highlights.js stays dumb about dictionary logic.
      onAddToDictionary: isEligible(result.text, c) ? addFixToDictionary : undefined,
      onDismiss: dismissFix,
    });
  } else {
    renderer.hidePopup();
  }
}

function selectFixSuggestion(i, replacement) {
  const correction = result?.corrections?.[i];
  if (!correction || typeof replacement !== "string") return;
  correction.correction = replacement;
}

// "Add to dictionary" from the in-page popup: optimistic re-filter +
// re-render NOW (every squiggle for the word drops at once — that's the
// feedback), then persist. Storage failure is SILENT — we're a guest in the
// page (the engine.js degrade stance); the word still holds for this page's
// lifetime via the in-memory list.
function addFixToDictionary(i) {
  const res = result;
  renderer.hidePopup();
  if (!res) return;
  const word = candidateWord(res.text, res.corrections[i] ?? {});
  if (!word) return;
  applyDictionary([...dictWords, word]);
  addWord(word).catch(() => { /* silent degrade */ });
}

// Dismiss only this occurrence for this textbox. It does not touch storage,
// the editor value, or the model; the kept raw result is simply re-filtered.
// Outside click and Escape call renderer.hidePopup() directly and therefore
// remain non-mutating close gestures.
function dismissFix(i) {
  const field = activeField();
  const res = result;
  const correction = res?.corrections?.[i];
  if (!field || !res || !correction
    || !rememberTemporaryIgnore(field, res.text, correction)) {
    renderer.hidePopup();
    return;
  }
  result = {
    ...res,
    corrections: visibleCorrections(res.text, res.raw, dictMatcher, res.snapshot, field),
  };
  renderer.hidePopup();
  requestRender();
}

async function applyFix(i) {
  const field = activeField();
  const session = activeSession;
  const res = result;
  renderer.hidePopup();
  if (!field || !res) return;
  const c = res.corrections[i];
  if (!c || !session || !(await session.applyCorrection(res, c))) return;
  if (activeSession !== session || activeField() !== field) return;
  // The write's `input` event already rebased + re-scheduled (onInput); lint
  // again immediately so the remaining squiggles return without the full
  // pause — same instant-feedback contract as the side panel's Apply. The
  // write's mutation batch needs no swallowing: it sees an unchanged
  // lastText and resolves as text-preserving (repairing the mapping if the
  // editor normalized DOM around our splice).
  session?.clearDebounce();
  runLint(session);
}

// Scroll ANYWHERE (page, the field itself, any scroll container — capture
// phase sees them all, no ancestor walking needed) moves the field on screen.
function onAnyScroll() {
  if (!activeField()) return;
  renderer.hidePopup();
  requestRender();
}

function onResize() {
  if (activeField()) requestRender();
}

function onVisibilityChange() {
  if (document.visibilityState === "hidden") {
    // Hard gate: cancel the pending debounce, invalidate in-flight work, suspend
    // the poll — a hidden tab must cost nothing.
    activeSession?.resetIme();
    activeSession?.clearDebounce();
    supersede.invalidate();
    activeSession?.stopPoll();
  } else if (activeSession) {
    activeSession.startPoll();
    requestRender();
    // A lint cancelled by hiding left the field unproofread — catch up.
    if (activeSession.currentText() !== (result?.text ?? null)) scheduleLint();
  }
}

// document.hasFocus() is the other half of the gate: window blur (another
// app/window) cancels like hiding; window focus re-schedules the catch-up.
function onWindowBlur() {
  activeSession?.resetIme();
  activeSession?.clearDebounce();
  supersede.invalidate();
}

function onWindowFocus() {
  const field = activeField();
  if (field && activeSession.currentText() !== (result?.text ?? null)) scheduleLint();
}

// ---------- wiring / teardown ----------
function init() {
  // Fire-and-forget dictionary load (see applyDictionary above), plus the
  // cross-context change subscription — unsubscribed in teardown so a
  // disabled site's script goes fully inert.
  loadDictionary().then((words) => { if (!torndown) applyDictionary(words); });
  unsubscribeDictionary = onDictionaryChanged((words) => applyDictionary(words));
  unsubscribeProofingSettings = onProofingSettingsChanged(() => {
    if (!activeSession || torndown) return;
    // The selected dialect governs both surfaces. Drop old-dialect squiggles
    // immediately; background configuration and the following lint are
    // serialized against the current storage snapshot.
    activeSession.invalidate();
    scheduleLint();
  });
  loadEditorAdapterFlags().then((flags) => { if (!torndown) applyAdapterFlags(flags); });
  unsubscribeAdapterFlags = watchEditorAdapterFlags((flags) => { if (!torndown) applyAdapterFlags(flags); });

  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", onFocusOut);
  document.addEventListener("input", onInput, true);
  document.addEventListener("compositionstart", onCompositionStart, true);
  document.addEventListener("compositionend", onCompositionEnd, true);
  document.addEventListener("keyup", onKeyUp, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("scroll", onAnyScroll, { capture: true, passive: true });
  window.addEventListener("resize", onResize);
  window.addEventListener("blur", onWindowBlur);
  window.addEventListener("focus", onWindowFocus);

  // Already focused in an eligible field when we inject (e.g. right after the
  // user enables the site)? Pick it up without waiting for a refocus.
  const field = resolveActiveField(document, adapterFlags);
  if (field && isEligibleField(field, adapterFlags)) activate(field);
}

// Full teardown — the SW sends this when the user disables the site (the
// registration is gone, but this tab's script is already running).
export function teardownPageProofly() {
  if (torndown) return;
  torndown = true;
  deactivate();
  unsubscribeDictionary?.();
  unsubscribeAdapterFlags?.();
  unsubscribeProofingSettings?.();
  unsubscribeDictionary = null;
  unsubscribeAdapterFlags = null;
  unsubscribeProofingSettings = null;
  document.removeEventListener("focusin", onFocusIn);
  document.removeEventListener("focusout", onFocusOut);
  document.removeEventListener("input", onInput, true);
  document.removeEventListener("compositionstart", onCompositionStart, true);
  document.removeEventListener("compositionend", onCompositionEnd, true);
  document.removeEventListener("keyup", onKeyUp, true);
  document.removeEventListener("click", onClick, true);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  window.removeEventListener("scroll", onAnyScroll, { capture: true });
  window.removeEventListener("resize", onResize);
  window.removeEventListener("blur", onWindowBlur);
  window.removeEventListener("focus", onWindowFocus);
  renderer.destroy();
}

if (globalThis.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    // Disable is a BROADCAST (the SW has already lost the host permission it
    // would need to find this tab by URL), so check the pattern is ours.
    // Port-insensitively: an adopted pattern may carry a port, our own
    // derivation never does (see samePattern).
    if (msg?.type === "proofly:teardown"
      && (!msg.pattern || samePattern(msg.pattern, originPattern(location.href)))) {
      teardownPageProofly();
    }
  });
}

init();
