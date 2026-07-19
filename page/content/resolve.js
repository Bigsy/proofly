import { resolveAdapterRoot } from "./adapters/index.js";

function asElement(node) {
  if (!node) return null;
  if (node.nodeType === Node.ELEMENT_NODE) return node;
  return node.parentElement ?? null;
}

export function eventPath(event) {
  const path = event?.composedPath?.();
  if (Array.isArray(path) && path.length) return path;
  return event?.target ? [event.target] : [];
}

export function resolveFieldFromPath(path, flags) {
  for (const item of path ?? []) {
    const el = asElement(item);
    if (!el) continue;
    const root = resolveAdapterRoot(el, flags);
    if (root) return root;
  }
  return null;
}

export function resolveFieldFromEvent(event, flags) {
  return resolveFieldFromPath(eventPath(event), flags);
}

export function eventBelongsToField(event, field, flags) {
  if (!field) return false;
  const path = eventPath(event);
  if (path.includes(field)) return true;
  return resolveFieldFromPath(path, flags) === field;
}

export function deepActiveElement(root = document) {
  let active = root.activeElement ?? null;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

export function resolveActiveField(doc = document, flags) {
  const active = deepActiveElement(doc);
  return resolveFieldFromPath(active ? [active] : [], flags);
}
