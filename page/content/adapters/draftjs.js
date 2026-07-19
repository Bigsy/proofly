import { createContentEditableSnapshot, hasEditableContent } from "./contenteditable.js";
import {
  asElement, createExecCommandApply, isEligibleEditableRoot, nextFrame, setSelectionAtModelOffset,
} from "./apply-kit.js";

export function isDraftJSRoot(el) {
  return !!el
    && el.nodeType === Node.ELEMENT_NODE
    && hasEditableContent(el)
    && el.classList?.contains("public-DraftEditor-content");
}

export function draftJSRoot(candidate) {
  const closest = asElement(candidate)?.closest?.(".public-DraftEditor-content");
  return isDraftJSRoot(closest) ? closest : null;
}

export function isEligibleDraftJSRoot(el) {
  return isDraftJSRoot(el) && isEligibleEditableRoot(el);
}

// Draft re-renders on the next frame; place the caret after that settles and
// nudge its selection bookkeeping with a document-level selectionchange.
export const applyDraftJSCorrection = createExecCommandApply({
  settleSelection: async (root, newCaret) => {
    await nextFrame(root);
    setSelectionAtModelOffset(root, newCaret);
    root.ownerDocument.dispatchEvent(new (root.ownerDocument.defaultView?.Event ?? Event)("selectionchange", {
      bubbles: false,
    }));
  },
});

export const draftJSAdapter = Object.freeze({
  id: "draftjs",
  match: (candidate) => !!draftJSRoot(candidate),
  root: draftJSRoot,
  isEligible: isEligibleDraftJSRoot,
  snapshot: createContentEditableSnapshot,
  apply: applyDraftJSCorrection,
});
