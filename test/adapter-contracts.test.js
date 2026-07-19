import { describe, expect, it } from "vitest";
import {
  assertAdapter,
  canonicalizeMutationRecords,
  classifyMutationBatch,
  DEFAULT_MUTATION_ATTRIBUTES,
  mutationAttributesFor,
  validateAdapter,
} from "../page/content/adapters/contracts.js";
import { codeMirrorAdapter } from "../page/content/adapters/codemirror.js";
import { prosemirrorAdapter } from "../page/content/adapters/prosemirror.js";
import { assertSnapshot, spanWithinSnapshot, validateSnapshot } from "../page/content/snapshot.js";

describe("adapter contract validation", () => {
  it("accepts the required adapter surface", () => {
    const adapter = {
      id: "form",
      match: () => true,
      root: (el) => el,
      isEligible: () => true,
      snapshot: () => null,
      apply: () => ({ applied: false }),
    };
    expect(validateAdapter(adapter)).toEqual({ ok: true, missing: [] });
    expect(assertAdapter(adapter)).toBe(adapter);
  });

  it("reports missing adapter methods", () => {
    expect(validateAdapter({ id: "" }).missing).toEqual([
      "id", "match", "root", "isEligible", "snapshot", "apply",
    ]);
    expect(() => assertAdapter({ id: "x" })).toThrow("Invalid editor adapter");
  });

  it("validates the optional declared capabilities", () => {
    const base = {
      id: "x",
      match: () => true,
      root: (el) => el,
      isEligible: () => true,
      snapshot: () => null,
      apply: () => ({ applied: false }),
    };
    expect(validateAdapter({ ...base, reverifyByText: true, mutationAttributes: ["data-mode"] }).ok).toBe(true);
    expect(validateAdapter({ ...base, reverifyByText: "yes" }).missing).toEqual(["reverifyByText"]);
    expect(validateAdapter({ ...base, mutationAttributes: "data-mode" }).missing).toEqual(["mutationAttributes"]);
    expect(validateAdapter({ ...base, mutationAttributes: [42] }).missing).toEqual(["mutationAttributes"]);
  });

  it("merges declared mutation attributes over the shared default set", () => {
    const merged = mutationAttributesFor(codeMirrorAdapter);
    for (const attr of DEFAULT_MUTATION_ATTRIBUTES) expect(merged.has(attr), attr).toBe(true);
    expect(merged.has("data-codemirror-language")).toBe(true);
    expect(merged.has("data-mode")).toBe(true);
    // Adapters without declarations get exactly the default set.
    expect([...mutationAttributesFor(prosemirrorAdapter)].sort())
      .toEqual([...DEFAULT_MUTATION_ATTRIBUTES].sort());
    // The reverify capability rides the contract, not orchestrator id checks.
    expect(prosemirrorAdapter.reverifyByText).toBe(true);
  });
});

describe("snapshot contract validation", () => {
  it("accepts a snapshot shape and checks spans in UTF-16 offsets", () => {
    const root = document.createElement("textarea");
    const snapshot = {
      root,
      text: "I seen it.",
      revision: "r1",
      kind: "form",
      rangeForSpan: () => null,
      offsetForPoint: () => null,
      isCurrent: () => true,
      dispose: () => {},
    };
    expect(validateSnapshot(snapshot)).toEqual({ ok: true, missing: [] });
    expect(assertSnapshot(snapshot)).toBe(snapshot);
    expect(spanWithinSnapshot(snapshot, 2, 6)).toBe(true);
    expect(spanWithinSnapshot(snapshot, 6, 2)).toBe(false);
    expect(spanWithinSnapshot(snapshot, 0, 999)).toBe(false);
  });
});

describe("mutation canonicalization", () => {
  it("drops net-zero attribute and character-data changes", () => {
    const el = document.createElement("div");
    el.setAttribute("data-x", "old");
    const text = document.createTextNode("old");
    const records = [
      { type: "attributes", target: el, attributeName: "data-x", oldValue: "old" },
      { type: "characterData", target: text, oldValue: "old" },
    ];
    expect(canonicalizeMutationRecords(records)).toEqual([]);
  });

  it("collapses mutation records into one strongest class", () => {
    const el = document.createElement("div");
    el.setAttribute("data-x", "new");
    const records = [
      { type: "attributes", target: el, attributeName: "data-x", oldValue: "old" },
      { type: "childList", target: el, addedNodes: [document.createElement("span")], removedNodes: [] },
    ];
    const result = classifyMutationBatch(records, (record) =>
      record.type === "childList" ? "mapping" : "decoration");
    expect(result).toBe("mapping");
  });

  it("keeps text as strongest when a batch also contains mapping changes", () => {
    const el = document.createElement("div");
    const text = document.createTextNode("new");
    const child = document.createElement("span");
    const records = [
      { type: "characterData", target: text, oldValue: "old" },
      { type: "childList", target: el, addedNodes: [child], removedNodes: [] },
    ];
    const result = classifyMutationBatch(records, (record) =>
      record.type === "characterData" ? "text" : "mapping");
    expect(result).toBe("text");
  });

  it("cancels add/remove pairs in one child-list batch", () => {
    const parent = document.createElement("div");
    const child = document.createElement("span");
    const records = [
      { type: "childList", target: parent, addedNodes: [child], removedNodes: [] },
      { type: "childList", target: parent, addedNodes: [], removedNodes: [child] },
    ];
    expect(canonicalizeMutationRecords(records)).toEqual([]);
  });
});
