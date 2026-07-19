import { isAdapterKind } from "./adapters/contracts.js";

export function validateSnapshot(snapshot) {
  const missing = [];
  if (!snapshot || typeof snapshot !== "object") {
    return { ok: false, missing: ["snapshot"] };
  }
  if (!snapshot.root) missing.push("root");
  if (typeof snapshot.text !== "string") missing.push("text");
  if (!isAdapterKind(snapshot.kind)) missing.push("kind");
  for (const key of ["rangeForSpan", "offsetForPoint", "isCurrent", "dispose"]) {
    if (typeof snapshot[key] !== "function") missing.push(key);
  }
  return { ok: missing.length === 0, missing };
}

export function assertSnapshot(snapshot) {
  const result = validateSnapshot(snapshot);
  if (!result.ok) {
    throw new TypeError(`Invalid editor snapshot: missing ${result.missing.join(", ")}`);
  }
  return snapshot;
}

export function spanWithinSnapshot(snapshot, start, end) {
  const s = Number(start);
  const e = Number(end);
  return Number.isInteger(s) && Number.isInteger(e)
    && s >= 0 && e >= s && e <= snapshot.text.length;
}
