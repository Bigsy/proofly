import {
  applyContentEditableCorrection,
  createContentEditableSnapshot,
  hasEditableContent,
} from "./contenteditable.js";
import { isEligibleEditableRoot } from "./apply-kit.js";

export function isProseMirrorRoot(el) {
  return !!el
    && el.nodeType === Node.ELEMENT_NODE
    && hasEditableContent(el)
    && el.classList?.contains("ProseMirror");
}

export function proseMirrorRoot(candidate) {
  let cur = candidate?.nodeType === Node.ELEMENT_NODE ? candidate : candidate?.parentElement;
  while (cur && cur.nodeType === Node.ELEMENT_NODE) {
    if (isProseMirrorRoot(cur)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

export function isEligibleProseMirrorRoot(el) {
  return isProseMirrorRoot(el) && isEligibleEditableRoot(el);
}

export const prosemirrorAdapter = Object.freeze({
  id: "prosemirror",
  match: (candidate) => !!proseMirrorRoot(candidate),
  root: proseMirrorRoot,
  isEligible: isEligibleProseMirrorRoot,
  snapshot: createContentEditableSnapshot,
  apply: applyContentEditableCorrection,
  // ProseMirror redraws decoration DOM without changing the text, which
  // invalidates the snapshot's node mapping; a result may be revalidated (and
  // re-applied through a fresh snapshot) when the text still matches.
  reverifyByText: true,
});
