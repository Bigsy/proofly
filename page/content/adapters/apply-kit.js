// Shared apply primitives for the editor adapters. Every framework adapter's
// writeback is the same skeleton — guard the snapshot, capture scroll, mutate
// through a page-visible channel, verify the resulting text, restore caret and
// scroll — with only the mutation channel differing. The skeleton lives here;
// adapters keep their selectors and quirks.
//
// Import cycle note: this module and contenteditable.js import each other
// (the kit needs the snapshot walker; the contenteditable adapter needs these
// primitives). That's safe — both sides export function declarations and only
// call across the boundary at runtime, never during module evaluation.

import { createContentEditableSnapshot } from "./contenteditable.js";
import { spanWithinSnapshot } from "../snapshot.js";

export function asElement(candidate) {
  if (!candidate) return null;
  return candidate.nodeType === Node.ELEMENT_NODE ? candidate : candidate.parentElement;
}

// The eligibility tail shared by every framework adapter: a root the page has
// marked non-editable, readonly, disabled, or hidden (itself or via an
// ancestor) must never be proofread.
export function isEligibleEditableRoot(el) {
  if (el.getAttribute?.("contenteditable") === "false") return false;
  if (el.getAttribute?.("aria-readonly") === "true") return false;
  if (el.getAttribute?.("aria-disabled") === "true") return false;
  if (el.getAttribute?.("aria-hidden") === "true" || el.closest?.("[aria-hidden='true']")) return false;
  if (el.closest?.("[contenteditable='false']")) return false;
  return true;
}

export function setSelectionRange(root, range) {
  const sel = root.ownerDocument?.defaultView?.getSelection?.();
  if (!sel) return false;
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}

export function setSelectionAtModelOffset(root, offset) {
  const snapshot = createContentEditableSnapshot(root);
  try {
    const range = snapshot.rangeForSpan(offset, offset);
    if (!range) return;
    setSelectionRange(root, range);
  } finally {
    snapshot.dispose();
  }
}

export function textEquals(root, expected) {
  const next = createContentEditableSnapshot(root);
  try {
    return next.text === expected;
  } finally {
    next.dispose();
  }
}

export function captureScroll(root) {
  const win = root.ownerDocument?.defaultView;
  return {
    rootTop: root.scrollTop,
    rootLeft: root.scrollLeft,
    win,
    winX: win?.scrollX ?? 0,
    winY: win?.scrollY ?? 0,
  };
}

export function restoreScroll(root, scroll) {
  root.scrollTop = scroll.rootTop;
  root.scrollLeft = scroll.rootLeft;
  if (!scroll.win?.scrollTo) return;
  if (scroll.winX === 0 && scroll.winY === 0) return;
  try { scroll.win.scrollTo(scroll.winX, scroll.winY); } catch { /* jsdom/not implemented */ }
}

export function nextFrame(root) {
  const win = root.ownerDocument?.defaultView ?? globalThis;
  return new Promise((resolve) => {
    const raf = win.requestAnimationFrame ?? ((fn) => win.setTimeout(fn, 16));
    raf(() => resolve());
  });
}

export function staticTargetRange(range) {
  const StaticRangeCtor = range.startContainer.ownerDocument?.defaultView?.StaticRange ?? globalThis.StaticRange;
  if (typeof StaticRangeCtor !== "function") return null;
  try {
    return new StaticRangeCtor({
      startContainer: range.startContainer,
      startOffset: range.startOffset,
      endContainer: range.endContainer,
      endOffset: range.endOffset,
    });
  } catch {
    return null;
  }
}

export function createBeforeInputEvent(root, replacement, range) {
  const win = root.ownerDocument?.defaultView ?? globalThis;
  const EventCtor = typeof win.InputEvent === "function" ? win.InputEvent : win.Event;
  const event = new EventCtor("beforeinput", {
    bubbles: true,
    cancelable: true,
    inputType: "insertReplacementText",
    data: replacement,
  });
  const targetRange = staticTargetRange(range);
  if (targetRange) {
    try {
      Object.defineProperty(event, "getTargetRanges", {
        configurable: true,
        value: () => [targetRange],
      });
    } catch {
      /* Some engines expose a non-configurable method; the event works without it. */
    }
  }
  return event;
}

// The stale/span-validation preamble every apply starts with. Returns the
// working set for the edit, or null when the correction must be refused
// (stale snapshot, wrong root, span out of bounds, unmappable range).
export function guardedApply(root, snapshot, correction) {
  if (!snapshot?.isCurrent?.() || snapshot.root !== root) return null;
  const start = Number(correction?.startIndex);
  const end = Number(correction?.endIndex);
  if (!spanWithinSnapshot(snapshot, start, end)) return null;
  const range = snapshot.rangeForSpan(start, end);
  if (!range) return null;
  const replacement = correction.correction ?? "";
  const expected = snapshot.text.slice(0, start) + replacement + snapshot.text.slice(end);
  return { start, end, range, replacement, expected };
}

// Select the span and replace it through the browser editing command — the
// channel framework editors observe as a native edit. Fails closed when
// there's no selection or no execCommand.
export function execCommandInsert(root, range, replacement) {
  if (!setSelectionRange(root, range)) return false;
  if (typeof root.ownerDocument?.execCommand !== "function") return false;
  root.ownerDocument.execCommand("insertText", false, replacement);
  return true;
}

// The whole select-range → execCommand("insertText") → verify → restore-caret
// → restore-scroll apply shared by quill/tinymce/lexical/slate/ckeditor4.
// `settleSelection(root, newCaret)` (draftjs) replaces the default caret
// restore and makes the returned apply async — some editors re-render on a
// frame boundary before the caret can be placed.
export function createExecCommandApply({ settleSelection } = {}) {
  if (settleSelection) {
    return async function apply(root, snapshot, correction) {
      const guard = guardedApply(root, snapshot, correction);
      if (!guard) return { applied: false };
      const scroll = captureScroll(root);
      try {
        if (!execCommandInsert(root, guard.range, guard.replacement)) return { applied: false };
        if (!textEquals(root, guard.expected)) return { applied: false };
        const newCaret = guard.start + guard.replacement.length;
        await settleSelection(root, newCaret);
        return { applied: true, newCaret };
      } finally {
        restoreScroll(root, scroll);
      }
    };
  }
  return function apply(root, snapshot, correction) {
    const guard = guardedApply(root, snapshot, correction);
    if (!guard) return { applied: false };
    const scroll = captureScroll(root);
    try {
      if (!execCommandInsert(root, guard.range, guard.replacement)) return { applied: false };
      if (!textEquals(root, guard.expected)) return { applied: false };
      const newCaret = guard.start + guard.replacement.length;
      setSelectionAtModelOffset(root, newCaret);
      return { applied: true, newCaret };
    } finally {
      restoreScroll(root, scroll);
    }
  };
}
