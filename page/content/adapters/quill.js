import { createContentEditableSnapshot, hasEditableContent } from "./contenteditable.js";
import { asElement, createExecCommandApply, isEligibleEditableRoot } from "./apply-kit.js";

export function isQuillRoot(el) {
  return !!el
    && el.nodeType === Node.ELEMENT_NODE
    && hasEditableContent(el)
    && el.classList?.contains("ql-editor")
    && !!el.closest?.(".ql-container");
}

export function quillRoot(candidate) {
  const closest = asElement(candidate)?.closest?.(".ql-editor");
  return isQuillRoot(closest) ? closest : null;
}

export function isEligibleQuillRoot(el) {
  return isQuillRoot(el) && isEligibleEditableRoot(el);
}

export const applyQuillCorrection = createExecCommandApply();

export const quillAdapter = Object.freeze({
  id: "quill",
  match: (candidate) => !!quillRoot(candidate),
  root: quillRoot,
  isEligible: isEligibleQuillRoot,
  snapshot: createContentEditableSnapshot,
  apply: applyQuillCorrection,
});
