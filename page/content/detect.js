// page/content/detect.js — the field-eligibility predicate for the in-page
// feature: a field is eligible when an (enabled) editor adapter claims it as
// its root AND the field doesn't declare a language the engine can't proofread
// (see language.js for the policy). Form fields, contenteditable textboxes,
// and the framework editors are all decided by the adapters in ./adapters —
// this module holds no per-editor knowledge. Kept as its own module so the
// eligibility matrix can be unit-tested without loading the orchestrator.

import { adapterForField } from "./adapters/index.js";
import { isSupportedFieldLanguage } from "./language.js";

export function isEligibleField(el, flags) {
  return isSupportedFieldLanguage(el) && !!adapterForField(el, flags);
}
