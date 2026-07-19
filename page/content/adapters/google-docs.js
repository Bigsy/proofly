// EXPERIMENTAL — NOT YET REGISTERED. createGoogleDocsBridgeAdapter() is not
// in EDITOR_ADAPTERS (adapters/index.js) and has no production caller: Google
// Docs support needs the MAIN-world responder (bridge/main.js) shipped and a
// docs.read/docs.replace handler implemented against the canvas editor, which
// hasn't happened. The snapshot/normalization layer below is covered by
// test/google-docs-adapter.test.js so the contract keeps working. To ship:
// wire a bridge client, register the adapter, and give bridge/main.js a
// production entry point.

import { spanWithinSnapshot } from "../snapshot.js";

export const GOOGLE_DOCS_BRIDGE_CAPABILITIES = Object.freeze([
  "docs.read",
  "docs.replace",
]);

export const DOCS_PARAGRAPH_SENTINEL = "\uE000";
export const DOCS_WIDGET_SENTINEL = "\uE001";

export function normalizeGoogleDocsText(rawText) {
  let text = "";
  const rawToLogical = [0];
  const logicalToRaw = [0];
  for (let i = 0; i < String(rawText ?? "").length; i += 1) {
    const raw = rawText[i];
    if (raw === DOCS_WIDGET_SENTINEL) {
      rawToLogical[i + 1] = text.length;
      continue;
    }
    const logical = raw === DOCS_PARAGRAPH_SENTINEL ? "\n" : raw;
    text += logical;
    rawToLogical[i + 1] = text.length;
    logicalToRaw[text.length] = i + 1;
  }
  return { text, rawToLogical, logicalToRaw };
}

export function createGoogleDocsSnapshot(root, payload = {}) {
  const normalized = payload.logicalText == null
    ? normalizeGoogleDocsText(payload.rawText ?? "")
    : { text: String(payload.logicalText), rawToLogical: [], logicalToRaw: [] };
  const text = normalized.text;
  const spans = Array.isArray(payload.spans) ? payload.spans : [];
  let disposed = false;

  const snapshot = {
    root,
    text,
    revision: `${payload.revision ?? ""}:${payload.layoutRevision ?? ""}`,
    kind: "framework",
    adapter: "google-docs",
    readOnly: payload.readOnly === true,
    visualOnly: payload.visualOnly === true,
    rawToLogical: normalized.rawToLogical,
    logicalToRaw: normalized.logicalToRaw,
    rangeForSpan(start, end) {
      if (!spanWithinSnapshot(snapshot, start, end)) return null;
      const match = spans.find((span) =>
        Number(span.start) <= start && Number(span.end) >= end && Array.isArray(span.rects));
      if (!match) return null;
      return {
        kind: "google-docs",
        root,
        start,
        end,
        rects: match.rects,
      };
    },
    offsetForPoint() {
      return Number.isInteger(payload.selectionOffset) ? payload.selectionOffset : null;
    },
    isCurrent() {
      return !disposed && payload.current !== false && root?.isConnected !== false;
    },
    dispose() {
      disposed = true;
    },
  };
  return snapshot;
}

export async function readGoogleDocsSnapshot(root, client) {
  const payload = await client.request("docs.read", {});
  return createGoogleDocsSnapshot(root, payload);
}

export async function applyGoogleDocsCorrection(root, snapshot, correction, client) {
  if (!snapshot?.isCurrent?.() || snapshot.root !== root || snapshot.readOnly || snapshot.visualOnly) {
    return { applied: false };
  }
  const start = Number(correction?.startIndex);
  const end = Number(correction?.endIndex);
  if (!spanWithinSnapshot(snapshot, start, end)) return { applied: false };

  const replacement = correction.correction ?? "";
  const expectedText = snapshot.text.slice(0, start) + replacement + snapshot.text.slice(end);
  try {
    await client.request("docs.replace", {
      start,
      end,
      replacement,
      expectedText: snapshot.text.slice(start, end),
      before: snapshot.text.slice(Math.max(0, start - 24), start),
      after: snapshot.text.slice(end, Math.min(snapshot.text.length, end + 24)),
      revision: snapshot.revision,
    });
  } catch {
    return { applied: false };
  }

  const next = await readGoogleDocsSnapshot(root, client);
  try {
    return next.text === expectedText
      ? { applied: true, newCaret: start + replacement.length }
      : { applied: false };
  } finally {
    next.dispose();
  }
}

export function createGoogleDocsBridgeAdapter(client) {
  return Object.freeze({
    id: "google-docs",
    match: (candidate) => !!candidate?.closest?.("[data-proofly-google-docs-root]"),
    root: (candidate) => candidate?.closest?.("[data-proofly-google-docs-root]") ?? null,
    isEligible: (root) => !!root && root.getAttribute?.("aria-hidden") !== "true",
    snapshot: (root) => readGoogleDocsSnapshot(root, client),
    apply: (root, snapshot, correction) => applyGoogleDocsCorrection(root, snapshot, correction, client),
  });
}
