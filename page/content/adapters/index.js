import { adapterEnabled } from "../adapter-flags.js";
import { contentEditableAdapter } from "./contenteditable.js";
import { ckeditor4Adapter } from "./ckeditor4.js";
import { ckeditor5Adapter } from "./ckeditor5.js";
import { codeMirrorAdapter } from "./codemirror.js";
import { draftJSAdapter } from "./draftjs.js";
import { formAdapter } from "./form.js";
import { lexicalAdapter } from "./lexical.js";
import { prosemirrorAdapter } from "./prosemirror.js";
import { quillAdapter } from "./quill.js";
import { slateAdapter } from "./slate.js";
import { tinyMCEAdapter } from "./tinymce.js";
import { trixAdapter } from "./trix.js";

export const EDITOR_ADAPTERS = Object.freeze([
  formAdapter,
  prosemirrorAdapter,
  ckeditor5Adapter,
  ckeditor4Adapter,
  quillAdapter,
  tinyMCEAdapter,
  lexicalAdapter,
  slateAdapter,
  draftJSAdapter,
  trixAdapter,
  codeMirrorAdapter,
  contentEditableAdapter,
]);

// `flags` (normalized editor adapter flags) gates which adapters may match;
// omitted = ungated, for unit tests that address adapters directly. A gated
// adapter is skipped, not terminal: a quill-shaped field with quill flagged
// off still falls through to the generic contenteditable adapter.
function adapterAllowed(adapter, flags) {
  if (!flags) return true;
  if (adapterEnabled(flags, adapter.id)) return true;
  if (flags.debug) console.debug(`[proofly] adapter "${adapter.id}" is disabled by flag`);
  return false;
}

export function adapterForField(field, flags) {
  for (const adapter of EDITOR_ADAPTERS) {
    if (!adapter.match(field)) continue;
    if (!adapterAllowed(adapter, flags)) continue;
    const root = adapter.root(field);
    if (root === field && adapter.isEligible(root)) return adapter;
    if (flags?.debug) console.debug(`[proofly] adapter "${adapter.id}" matched but the field is not an eligible root`, field);
  }
  return null;
}

export function resolveAdapterRoot(candidate, flags) {
  for (const adapter of EDITOR_ADAPTERS) {
    if (!adapter.match(candidate)) continue;
    if (!adapterAllowed(adapter, flags)) continue;
    const root = adapter.root(candidate);
    if (root && adapter.isEligible(root)) return root;
  }
  return null;
}
