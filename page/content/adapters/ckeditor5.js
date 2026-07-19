import { createContentEditableSnapshot, hasEditableContent } from "./contenteditable.js";
import {
  asElement, captureScroll, createBeforeInputEvent, guardedApply, isEligibleEditableRoot,
  nextFrame, restoreScroll, setSelectionAtModelOffset, setSelectionRange, textEquals,
} from "./apply-kit.js";

const ROOT_SELECTOR = ".ck-editor__editable";
const NESTED_SELECTOR = ".ck-editor__nested-editable";

export function isCKEditor5Root(el) {
  return !!el
    && el.nodeType === Node.ELEMENT_NODE
    && hasEditableContent(el)
    && el.classList?.contains("ck-editor__editable")
    && !el.classList?.contains("ck-editor__nested-editable");
}

export function ckeditor5Root(candidate) {
  let cur = asElement(candidate);
  const nested = cur?.closest?.(NESTED_SELECTOR);
  if (nested) cur = nested.parentElement;
  while (cur && cur.nodeType === Node.ELEMENT_NODE) {
    if (isCKEditor5Root(cur)) return cur;
    cur = cur.parentElement;
  }
  const closest = asElement(candidate)?.closest?.(ROOT_SELECTOR);
  return isCKEditor5Root(closest) ? closest : null;
}

export function isEligibleCKEditor5Root(el) {
  return isCKEditor5Root(el) && isEligibleEditableRoot(el);
}

// CKEditor 5 consumes the edit through its own beforeinput handling rather
// than execCommand, and needs a frame between selection and beforeinput for
// its selection observer to catch up — hence the async variant built from the
// same kit primitives.
export async function applyCKEditor5Correction(root, snapshot, correction) {
  const guard = guardedApply(root, snapshot, correction);
  if (!guard) return { applied: false };
  const scroll = captureScroll(root);
  try {
    if (!setSelectionRange(root, guard.range)) return { applied: false };
    root.ownerDocument.dispatchEvent(new (root.ownerDocument.defaultView?.Event ?? Event)("selectionchange", {
      bubbles: false,
    }));
    await nextFrame(root);
    if (!snapshot.isCurrent()) return { applied: false };
    root.dispatchEvent(createBeforeInputEvent(root, guard.replacement, guard.range));
    await nextFrame(root);
    if (!textEquals(root, guard.expected)) return { applied: false };
    const newCaret = guard.start + guard.replacement.length;
    setSelectionAtModelOffset(root, newCaret);
    root.dispatchEvent(new (root.ownerDocument?.defaultView?.Event ?? Event)("input", { bubbles: true }));
    return { applied: true, newCaret };
  } finally {
    restoreScroll(root, scroll);
  }
}

export const ckeditor5Adapter = Object.freeze({
  id: "ckeditor5",
  match: (candidate) => !!ckeditor5Root(candidate),
  root: ckeditor5Root,
  isEligible: isEligibleCKEditor5Root,
  snapshot: createContentEditableSnapshot,
  apply: applyCKEditor5Correction,
});
