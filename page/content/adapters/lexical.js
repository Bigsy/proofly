import { createContentEditableSnapshot, hasEditableContent } from "./contenteditable.js";
import { asElement, createExecCommandApply, isEligibleEditableRoot } from "./apply-kit.js";

export function isLexicalRoot(el) {
  return !!el
    && el.nodeType === Node.ELEMENT_NODE
    && hasEditableContent(el)
    && el.getAttribute?.("data-lexical-editor") === "true";
}

export function lexicalRoot(candidate) {
  const closest = asElement(candidate)?.closest?.("[data-lexical-editor='true']");
  return isLexicalRoot(closest) ? closest : null;
}

export function isEligibleLexicalRoot(el) {
  return isLexicalRoot(el) && isEligibleEditableRoot(el);
}

export const applyLexicalCorrection = createExecCommandApply();

export const lexicalAdapter = Object.freeze({
  id: "lexical",
  match: (candidate) => !!lexicalRoot(candidate),
  root: lexicalRoot,
  isEligible: isEligibleLexicalRoot,
  snapshot: createContentEditableSnapshot,
  apply: applyLexicalCorrection,
});
