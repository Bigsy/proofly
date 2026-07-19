import { createContentEditableSnapshot, hasEditableContent } from "./contenteditable.js";
import { asElement, createExecCommandApply, isEligibleEditableRoot } from "./apply-kit.js";

export function isCKEditor4Root(el) {
  return !!el
    && el.nodeType === Node.ELEMENT_NODE
    && hasEditableContent(el)
    && el.classList?.contains("cke_editable")
    && !el.classList?.contains("cke_nested_editable");
}

export function ckeditor4Root(candidate) {
  let cur = asElement(candidate);
  const nested = cur?.closest?.(".cke_nested_editable");
  if (nested) cur = nested.parentElement;
  while (cur && cur.nodeType === Node.ELEMENT_NODE) {
    if (isCKEditor4Root(cur)) return cur;
    cur = cur.parentElement;
  }
  const closest = asElement(candidate)?.closest?.(".cke_editable");
  return isCKEditor4Root(closest) ? closest : null;
}

export function isEligibleCKEditor4Root(el) {
  return isCKEditor4Root(el) && isEligibleEditableRoot(el);
}

export const applyCKEditor4Correction = createExecCommandApply();

export const ckeditor4Adapter = Object.freeze({
  id: "ckeditor4",
  match: (candidate) => !!ckeditor4Root(candidate),
  root: ckeditor4Root,
  isEligible: isEligibleCKEditor4Root,
  snapshot: createContentEditableSnapshot,
  apply: applyCKEditor4Correction,
});
