// Structural contracts for the Phase 0 adapter engine. These helpers are
// deliberately small: they document the boundary without changing today's
// production eligibility or writeback paths.

export const ADAPTER_KINDS = Object.freeze(["form", "dom", "framework"]);
export const MUTATION_CLASSES = Object.freeze(["text", "mapping", "decoration", "detached"]);

export function isAdapterKind(kind) {
  return ADAPTER_KINDS.includes(kind);
}

export function isMutationClass(value) {
  return MUTATION_CLASSES.includes(value);
}

// Attribute changes that re-map any adapter's text model ("mapping"
// mutations): editability and visibility toggles, plus `lang` (a swap to an
// unsupported declared language must stop the linting — the re-lint this
// triggers ends at runLint's language gate). Adapters whose mapping depends
// on more (e.g. codemirror's language/mode attributes) declare the extras via
// `mutationAttributes` on the adapter.
export const DEFAULT_MUTATION_ATTRIBUTES = Object.freeze([
  "contenteditable",
  "hidden",
  "inert",
  "lang",
  "aria-hidden",
  "aria-readonly",
  "readonly",
  "disabled",
]);

export function mutationAttributesFor(adapter) {
  return new Set([...DEFAULT_MUTATION_ATTRIBUTES, ...(adapter?.mutationAttributes ?? [])]);
}

export function validateAdapter(adapter) {
  const missing = [];
  for (const key of ["id", "match", "root", "isEligible", "snapshot", "apply"]) {
    if (key === "id") {
      if (!adapter || typeof adapter.id !== "string" || !adapter.id) missing.push(key);
    } else if (typeof adapter?.[key] !== "function") {
      missing.push(key);
    }
  }
  if (adapter?.watch != null && typeof adapter.watch !== "function") missing.push("watch");
  // Optional declared capabilities (see index.js EditorSession for consumers):
  // reverifyByText — the editor redraws decorations without changing text, so
  // a stale DOM mapping may be revalidated by comparing snapshot text.
  // mutationAttributes — extra attribute names whose changes re-map the model.
  if (adapter?.reverifyByText != null && typeof adapter.reverifyByText !== "boolean") missing.push("reverifyByText");
  if (adapter?.mutationAttributes != null
    && !(Array.isArray(adapter.mutationAttributes) && adapter.mutationAttributes.every((a) => typeof a === "string"))) {
    missing.push("mutationAttributes");
  }
  return { ok: missing.length === 0, missing };
}

export function assertAdapter(adapter) {
  const result = validateAdapter(adapter);
  if (!result.ok) {
    throw new TypeError(`Invalid editor adapter: missing ${result.missing.join(", ")}`);
  }
  return adapter;
}

export function classifyMutationBatch(records, classifyRecord) {
  const canonical = canonicalizeMutationRecords(records);
  if (!canonical.length) return null;
  let strongest = "decoration";
  for (const record of canonical) {
    const next = classifyRecord(record);
    if (next === "detached") return "detached";
    if (next === "text") strongest = "text";
    else if (next === "mapping") {
      if (strongest !== "text") strongest = "mapping";
    }
    else if (next !== "decoration") {
      throw new TypeError(`Unknown mutation class: ${String(next)}`);
    }
  }
  return strongest;
}

export function canonicalizeMutationRecords(records) {
  const attributes = new Map();
  const characterData = new Map();
  const childLists = new Map();
  const passthrough = [];

  for (const record of records ?? []) {
    if (record.type === "attributes") {
      const key = `${nodeKey(record.target)}\u0000${record.attributeName ?? ""}`;
      if (!attributes.has(key)) attributes.set(key, record);
    } else if (record.type === "characterData") {
      const key = nodeKey(record.target);
      if (!characterData.has(key)) characterData.set(key, record);
    } else if (record.type === "childList") {
      const key = nodeKey(record.target);
      const bucket = childLists.get(key) ?? { record, added: new Set(), removed: new Set() };
      for (const node of record.addedNodes ?? []) {
        if (bucket.removed.has(node)) bucket.removed.delete(node);
        else bucket.added.add(node);
      }
      for (const node of record.removedNodes ?? []) {
        if (bucket.added.has(node)) bucket.added.delete(node);
        else bucket.removed.add(node);
      }
      childLists.set(key, bucket);
    } else if (record) {
      passthrough.push(record);
    }
  }

  const out = [];
  for (const record of attributes.values()) {
    const current = record.target?.getAttribute?.(record.attributeName);
    if (current !== record.oldValue) out.push(record);
  }
  for (const record of characterData.values()) {
    if (record.target?.data !== record.oldValue) out.push(record);
  }
  for (const bucket of childLists.values()) {
    if (bucket.added.size || bucket.removed.size) out.push(bucket.record);
  }
  return out.concat(passthrough);
}

const nodeIds = new WeakMap();
let nextNodeId = 1;
function nodeKey(node) {
  if (!node || (typeof node !== "object" && typeof node !== "function")) return String(node);
  if (!nodeIds.has(node)) nodeIds.set(node, nextNodeId++);
  return String(nodeIds.get(node));
}
