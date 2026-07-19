// page/content/session.js — the per-field editing session: IME state, the
// lint-on-pause debounce, the geometry poll, mutation watching, and the
// adapter-backed text/caret/staleness/apply paths.
//
// The orchestrator (index.js) owns activation, the lint result, and the
// renderer; a session reaches back through the injected `host` for those.
// That seam keeps this module free of orchestrator state and unit-testable
// with a fake adapter/host (see test/page-session.test.js).
//
// Snapshot ownership rule (the whole module obeys it): a session NEVER keeps
// a snapshot. Every snapshot a session creates for its own use (currentText,
// resultIsCurrent, applyCorrection's reverify) is disposed before returning;
// snapshots handed to the orchestrator (takeSnapshot) belong to the caller.
//
// host contract:
//   gateOpen()               — the visibility/focus hard gate
//   isActiveSession(session) — session is the live one and no teardown ran
//   abortInFlight()          — invalidate the supersede slot
//   trackEdit(session)       — rebase any per-field temporary ignores
//   hidePopup() / clearOverlay()
//   clearResult()            — drop (and dispose) the orchestrator's result
//   tryRebase(session)       — attempt to rebase the result onto fresh text
//   requestRender()
//   deactivate()
//   runLint(session)
//   hasResult()              — a result is on screen
//   resultSnapshot()         — the current result's snapshot (or undefined)
//   debounceMs / pollMs

import { classifyMutationBatch, mutationAttributesFor } from "./adapters/contracts.js";
import { isSupportedFieldLanguage } from "./language.js";

// Which attribute changes re-map the model comes from the adapter contract
// (DEFAULT_MUTATION_ATTRIBUTES plus the adapter's declared extras) — the
// session holds no per-editor attribute knowledge.
export function createActiveMutationClassifier(adapter) {
  const attributes = mutationAttributesFor(adapter);
  return (record) => {
    if (record.type === "characterData") return "text";
    if (record.type === "childList") return "mapping";
    if (record.type === "attributes" && attributes.has(record.attributeName)) return "mapping";
    return "decoration";
  };
}

export function createRootWatcher(field, notify, classifyRecord) {
  const rootNode = field.getRootNode?.() ?? document;
  if (!globalThis.MutationObserver || !rootNode?.contains?.(field)) return () => {};
  const isInsideField = (node) => node === field || field.contains?.(node);
  const touchesField = (node) => isInsideField(node) || node?.contains?.(field);
  const isRelevantRecord = (record) => {
    if (record.type !== "childList") return isInsideField(record.target);
    if (isInsideField(record.target)) return true;
    for (const node of record.addedNodes ?? []) if (touchesField(node)) return true;
    for (const node of record.removedNodes ?? []) if (touchesField(node)) return true;
    return false;
  };
  const observer = new MutationObserver((records) => {
    if (!rootNode.contains(field) || !field.isConnected) {
      notify("detached");
      return;
    }
    const relevant = records.filter(isRelevantRecord);
    if (!relevant.length) return;
    const kind = classifyMutationBatch(relevant, classifyRecord);
    if (kind) notify(kind);
  });
  observer.observe(rootNode, {
    subtree: true,
    childList: true,
    characterData: true,
    characterDataOldValue: true,
    attributes: true,
    attributeOldValue: true,
  });
  return () => observer.disconnect();
}

// Belt-and-suspenders for position changes no event reports (Harper does the
// same): poll the field's geometry and re-render on change. Re-render ONLY.
function pollKey(field) {
  const r = field.getBoundingClientRect();
  return `${r.left},${r.top},${r.width},${r.height},${field.scrollTop},${field.scrollLeft}`;
}

export class EditorSession {
  constructor(field, adapter, host) {
    this.field = field;
    // Invariant: the orchestrator only constructs sessions for fields an
    // enabled adapter accepted, so `adapter` is always present — every session
    // path (text, caret, staleness, apply) goes through it.
    this.adapter = adapter;
    this.adapterId = adapter.id;
    this.host = host;
    this.imeState = "idle";
    this.debounceTimer = null;
    this.pollTimer = null;
    // The text the lint pipeline last took responsibility for (set whenever a
    // lint is scheduled) — onMutation compares against it to tell real edits
    // from text-preserving decoration churn. null = no lint scheduled yet.
    // NOTE: an applied fix's own mutation batch resolves through this compare
    // too (the apply dispatched `input` first, which re-scheduled and set
    // lastText) — so writeback batches need no special-casing, and crucially
    // they still reach the stale-mapping repair below. The old
    // ignoreNextMutationBatch() swallow broke that: the batch it ate was the
    // editor's post-apply normalization, leaving the result's snapshot stale
    // until the next unrelated mutation — clicks meanwhile found "stale
    // result" and refused to open the popup.
    this.lastText = null;
    this.lastPollKey = pollKey(field);
    this.unwatch = createRootWatcher(
      field,
      (kind) => this.onMutation(kind),
      createActiveMutationClassifier(adapter),
    );
  }

  isActive() {
    return this.host.isActiveSession(this);
  }

  clearDebounce() {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  invalidate({ clear = true } = {}) {
    this.clearDebounce();
    this.host.abortInFlight();
    if (clear) {
      this.host.clearResult();
      this.host.hidePopup();
      this.host.clearOverlay();
    }
  }

  invalidateForEdit() {
    this.clearDebounce();
    this.host.abortInFlight();
    this.host.hidePopup();
    this.host.trackEdit?.(this);
    if (!this.host.tryRebase(this)) {
      this.host.clearResult();
      this.host.clearOverlay();
    }
  }

  // A fresh snapshot for the caller to own (the lint result). The session
  // keeps no reference — disposing it is the caller's job.
  takeSnapshot() {
    return this.adapter.snapshot(this.field);
  }

  currentText() {
    const snapshot = this.adapter.snapshot(this.field);
    try {
      return snapshot.text;
    } finally {
      snapshot.dispose();
    }
  }

  resultIsCurrent(res) {
    if (!res?.snapshot) return false;
    if (res.snapshot.isCurrent()) return true;
    if (!this.adapter.reverifyByText) return false;
    const snapshot = this.adapter.snapshot(this.field);
    try {
      return snapshot.text === res.text;
    } finally {
      snapshot.dispose();
    }
  }

  caretOffset() {
    return this.caretOffsetForSnapshot(this.host.resultSnapshot());
  }

  caretOffsetForSnapshot(snapshot) {
    if (!snapshot) return null;
    if (snapshot.kind === "dom") {
      const sel = this.field.ownerDocument?.defaultView?.getSelection?.();
      if (!sel?.rangeCount) return null;
      const range = sel.getRangeAt(0);
      if (!this.field.contains(range.startContainer)) return null;
      return snapshot.offsetForPoint(range.startContainer, range.startOffset);
    }
    return snapshot.offsetForPoint(this.field, 0);
  }

  async applyCorrection(res, correction) {
    if (!res?.snapshot) return false;
    if (this.adapter.reverifyByText && !res.snapshot.isCurrent()) {
      const snapshot = this.adapter.snapshot(this.field);
      try {
        if (snapshot.text !== res.text) return false;
        return (await this.adapter.apply(this.field, snapshot, correction)).applied;
      } finally {
        snapshot.dispose();
      }
    }
    return (await this.adapter.apply(this.field, res.snapshot, correction)).applied;
  }

  scheduleLint() {
    this.clearDebounce();
    if (!this.isActive() || !this.host.gateOpen()) return;
    this.lastText = this.currentText();
    this.debounceTimer = setTimeout(() => this.host.runLint(this), this.host.debounceMs);
  }

  startPoll() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      if (!this.isActive() || !this.host.hasResult() || !this.host.gateOpen()) return;
      if (!this.field.isConnected) {
        this.host.deactivate();
        return;
      }
      const key = pollKey(this.field);
      if (key !== this.lastPollKey) {
        this.lastPollKey = key;
        this.host.requestRender();
      }
    }, this.host.pollMs);
  }

  stopPoll() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  resetIme() {
    this.imeState = "idle";
  }

  compositionStart() {
    if (this.imeState === "composing") return;
    this.imeState = "composing";
    this.invalidate();
  }

  compositionEnd() {
    if (this.imeState === "composing") this.imeState = "awaiting-commit";
  }

  input(event) {
    if (event?.isComposing === true) {
      if (this.imeState === "idle") this.compositionStart();
      return;
    }
    const wasAwaitingCommit = this.imeState === "awaiting-commit";
    this.imeState = "idle";
    this.invalidateForEdit();
    this.scheduleLint();
    return wasAwaitingCommit;
  }

  keyupFallback() {
    if (this.imeState !== "awaiting-commit") return;
    this.imeState = "idle";
    this.invalidateForEdit();
    this.scheduleLint();
  }

  onMutation(kind) {
    if (!this.isActive()) return;
    if (kind === "detached") {
      this.host.deactivate();
      return;
    }
    if (kind === "decoration") return;
    if (!this.adapter.isEligible(this.field)) {
      this.host.deactivate();
      return;
    }
    // Text-preserving churn — decoration spans wrapping/unwrapping around
    // unchanged text (Slack's composer does this constantly): the pipeline's
    // scheduled/committed state still matches the field, so don't abort the
    // in-flight proofread or reset the debounce (doing so starved linting
    // forever — squiggles froze after the first commit). Just refresh the
    // result's node mapping so rendering/apply track the new DOM. A `lang`
    // swap to an unsupported language must still stop the linting (the
    // re-lint ends at runLint's language gate), so it never takes the skip.
    if (this.lastText !== null
      && this.currentText() === this.lastText
      && isSupportedFieldLanguage(this.field)) {
      const resultSnapshot = this.host.resultSnapshot();
      if (resultSnapshot && !resultSnapshot.isCurrent()) this.host.tryRebase(this);
      return;
    }
    this.invalidateForEdit();
    this.scheduleLint();
  }

  dispose() {
    this.resetIme();
    this.clearDebounce();
    this.stopPoll();
    this.unwatch?.();
    this.unwatch = null;
  }
}
