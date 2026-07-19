// page/content/writeback.js — applying a fix into someone else's text field.
//
// The side panel writes via execCommand("insertText") to keep the native undo
// stack; on arbitrary pages the reliable path is the NATIVE value setter +
// a synthetic `input` event: frameworks with controlled inputs
// (React, Vue) shadow `value` with their own instance/prototype tracker, and
// writing through the original prototype setter then firing `input` is the
// well-known way to make them register a programmatic change instead of
// reverting it on their next render.

import { contentEditableAdapter, isContentEditableField } from "./adapters/contenteditable.js";
import { applyFormCorrection, createFormSnapshot, isFormField, setNativeValue } from "./adapters/form.js";
import { applyCorrections } from "../../lib/dictionary.js";

// Splice correction `c` into the field. `text` is the text the correction was
// computed against — if the field has moved on (user kept typing after the
// popup opened), the splice would corrupt their text, so refuse instead.
// Returns whether the write happened.
export function applyCorrectionToField(field, text, c) {
  if (isContentEditableField(field)) {
    const snapshot = contentEditableAdapter.snapshot(field);
    try {
      if (snapshot.text !== text) return false;
      return contentEditableAdapter.apply(field, snapshot, c).applied;
    } finally {
      snapshot.dispose();
    }
  }
  if (!isFormField(field) || (field.value ?? "") !== text) return false;
  const snapshot = createFormSnapshot(field);
  try {
    return applyFormCorrection(field, snapshot, c).applied;
  } finally {
    snapshot.dispose();
  }
}

export function applyCorrectionsToField(field, text, corrections) {
  const corrected = applyCorrections(text, corrections);
  if (corrected === text) return false;
  const wholeTextCorrection = { startIndex: 0, endIndex: text.length, correction: corrected };
  return applyCorrectionToField(field, text, wholeTextCorrection);
}

export { setNativeValue };
