import { createContentEditableSnapshot, hasEditableContent } from "./contenteditable.js";
import { asElement, createExecCommandApply, isEligibleEditableRoot } from "./apply-kit.js";

export function isSlateRoot(el) {
  return !!el
    && el.nodeType === Node.ELEMENT_NODE
    && hasEditableContent(el)
    && el.getAttribute?.("data-slate-editor") === "true";
}

export function slateRoot(candidate) {
  const closest = asElement(candidate)?.closest?.("[data-slate-editor='true']");
  return isSlateRoot(closest) ? closest : null;
}

export function isEligibleSlateRoot(el) {
  return isSlateRoot(el) && isEligibleEditableRoot(el);
}

export const applySlateCorrection = createExecCommandApply();

export const slateAdapter = Object.freeze({
  id: "slate",
  match: (candidate) => !!slateRoot(candidate),
  root: slateRoot,
  isEligible: isEligibleSlateRoot,
  snapshot: createContentEditableSnapshot,
  apply: applySlateCorrection,
});
