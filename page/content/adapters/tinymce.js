import { createContentEditableSnapshot, hasEditableContent } from "./contenteditable.js";
import { asElement, createExecCommandApply, isEligibleEditableRoot } from "./apply-kit.js";

const ROOT_CLASS = "mce-content-body";
const COMPETING_PROOFING_SELECTOR = [
  ".mce-spellchecker-word",
  ".tox-spelling-error",
  ".tox-grammar-error",
  "[data-mce-spellchecker]",
  "[data-mce-grammar]",
].join(",");

export function hasTinyMCEProofingPluginState(el) {
  return !!el?.matches?.(COMPETING_PROOFING_SELECTOR)
    || !!el?.querySelector?.(COMPETING_PROOFING_SELECTOR)
    || el?.getAttribute?.("data-mce-spellchecker-active") === "true"
    || el?.getAttribute?.("data-mce-grammar-active") === "true";
}

export function isTinyMCERoot(el) {
  return !!el
    && el.nodeType === Node.ELEMENT_NODE
    && hasEditableContent(el)
    && el.classList?.contains(ROOT_CLASS);
}

export function tinyMCERoot(candidate) {
  const closest = asElement(candidate)?.closest?.(`.${ROOT_CLASS}`);
  return isTinyMCERoot(closest) ? closest : null;
}

export function isEligibleTinyMCERoot(el) {
  if (!isTinyMCERoot(el)) return false;
  if (!isEligibleEditableRoot(el)) return false;
  if (hasTinyMCEProofingPluginState(el)) return false;
  return true;
}

export const applyTinyMCECorrection = createExecCommandApply();

export const tinyMCEAdapter = Object.freeze({
  id: "tinymce",
  match: (candidate) => !!tinyMCERoot(candidate),
  root: tinyMCERoot,
  isEligible: isEligibleTinyMCERoot,
  snapshot: createContentEditableSnapshot,
  apply: applyTinyMCECorrection,
});
