// page/content/engine.js — silent in-page adapter over Proofly's shared,
// extension-owned Harper service. No Chrome AI API is touched here.

import { applyCorrections } from "../../lib/dictionary.js";
import { createHarperCoordinator } from "../../lib/harper-coordinator.js";

// Defensive validation at the surface boundary. The offscreen host already
// normalizes Harper's WASM objects, but a malformed runtime response must
// never place overlay boxes at invalid offsets.
export function normalizeCorrections(text, corrections) {
  const list = Array.isArray(corrections) ? corrections : [];
  return list.filter((c) => {
    if (!c || typeof c !== "object") return false;
    const s = Number(c.startIndex);
    const e = Number(c.endIndex);
    return Number.isFinite(s) && Number.isFinite(e)
      && s >= 0 && e >= s && e <= text.length
      && typeof (c.correction ?? "") === "string";
  });
}

// One engine per frame. Coordinators are retained by stable field scope so
// supersession is never global across tabs, frames, or independent editors.
export function createPageEngine({
  supersede,
  sendMessage,
  defaultScopeId = "page:active-field",
} = {}) {
  const coordinators = new Map();

  function coordinatorFor(scopeId) {
    const scope = typeof scopeId === "string" && scopeId ? scopeId : defaultScopeId;
    let coordinator = coordinators.get(scope);
    if (!coordinator) {
      coordinator = createHarperCoordinator({ scopeId: scope, sendMessage });
      coordinators.set(scope, coordinator);
    }
    return coordinator;
  }

  function capture(scopeId) {
    const req = supersede.begin();
    const batch = coordinatorFor(scopeId).capture({ isSnapshotCurrent: req.isCurrent });
    return { req, batch };
  }

  async function proofread(text, { scopeId } = {}) {
    if (typeof text !== "string") return null;
    const { req, batch } = capture(scopeId);
    try {
      const raw = await batch.lint(text);
      if (!batch.isCurrent() || raw == null) return null;
      const corrections = normalizeCorrections(text, raw);
      return { text, corrections, corrected: applyCorrections(text, corrections) };
    } catch {
      return null;
    } finally {
      req.release();
    }
  }

  // Results are deliberately sequential and incremental: after each window
  // except the last, the caller receives the completed prefix. One captured
  // coordinator batch means these windows do not supersede one another.
  async function proofreadWindows(windows, { onWindowResult, scopeId } = {}) {
    if (!Array.isArray(windows)) return null;
    const { req, batch } = capture(scopeId);
    try {
      const results = [];
      for (const win of windows) {
        const text = typeof win?.text === "string" ? win.text : "";
        const raw = await batch.lint(text);
        if (!batch.isCurrent() || raw == null) return null;
        const corrections = normalizeCorrections(text, raw);
        results.push({
          window: win,
          text,
          corrections,
          corrected: applyCorrections(text, corrections),
        });
        if (results.length < windows.length) onWindowResult?.(results.slice());
      }
      return results;
    } catch {
      return null;
    } finally {
      req.release();
    }
  }

  return { proofread, proofreadWindows };
}
