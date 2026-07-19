// Shared contract cases for the framework editor adapters. Every adapter's
// suite asserts the same things — contract shape, root recognition, winning
// over the generic contenteditable adapter, the exec-command writeback loop,
// stale-snapshot refusal, and the readonly/disabled/hidden refusal matrix —
// so those cases are registered from here. Adapter-specific quirks (nested
// editables, competing proofing plugins, Slack-shaped chrome) stay inline in
// each test file.
//
// Call inside the file's describe(): registerAdapterContractSuite({...}).

import { expect, it, vi } from "vitest";
import { adapterForField, resolveAdapterRoot } from "../../page/content/adapters/index.js";
import { assertAdapter } from "../../page/content/adapters/contracts.js";

export function registerAdapterContractSuite({
  adapter,
  editorName,           // used in test names, e.g. "Quill"
  build,                // (html?) => an eligible root attached to the DOM
  isRoot,
  isEligibleRoot,
  rootFor,              // the adapter's root-resolution helper
  chromeOnly = null,    // () => a marker-shaped element that must NOT match
  // The apply cases run when the adapter writes through the shared
  // exec-command path (quill/tinymce/lexical/slate/draftjs/ckeditor4/trix).
  execCommandApply = false,
  extraRefusals = [],   // additional (root) => void mutations that must refuse
}) {
  const richHtml = "<p><span>I </span><strong>seen</strong><span> it.</span></p>";
  const correction = { startIndex: 2, endIndex: 6, correction: "saw" };

  it(`satisfies the adapter contract and recognizes ${editorName} roots`, () => {
    const root = build();
    expect(assertAdapter(adapter)).toBe(adapter);
    expect(isRoot(root)).toBe(true);
    expect(isEligibleRoot(root)).toBe(true);
    expect(rootFor(root.firstChild)).toBe(root);
  });

  it(`wins over generic contenteditable for ${editorName} roots`, () => {
    const root = build();
    expect(adapterForField(root)).toBe(adapter);
    expect(resolveAdapterRoot(root.firstChild)).toBe(root);
  });

  if (chromeOnly) {
    it(`does not claim ${editorName}-shaped chrome without editability`, () => {
      const root = chromeOnly();
      expect(rootFor(root)).toBe(null);
      expect(adapterForField(root)).toBe(null);
    });
  }

  if (execCommandApply) {
    it("applies through the browser editing command and verifies the DOM mapping", async () => {
      const root = build(richHtml);
      const seen = vi.fn();
      const originalExecCommand = document.execCommand;
      document.execCommand = vi.fn((_command, _showUi, value) => {
        const selection = getSelection();
        const range = selection.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(value));
        root.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      });
      root.addEventListener("input", seen);
      const snapshot = adapter.snapshot(root);
      expect(snapshot.text).toBe("I seen it.");

      try {
        expect(await adapter.apply(root, snapshot, correction))
          .toEqual({ applied: true, newCaret: 5 });

        expect(document.execCommand).toHaveBeenCalledWith("insertText", false, "saw");
        expect(adapter.snapshot(root).text).toBe("I saw it.");
        expect(seen).toHaveBeenCalledTimes(1);
      } finally {
        document.execCommand = originalExecCommand;
      }
    });

    it("fails closed when the browser editing command is unavailable", async () => {
      const root = build();
      const originalExecCommand = document.execCommand;
      document.execCommand = undefined;
      const snapshot = adapter.snapshot(root);
      try {
        expect(await adapter.apply(root, snapshot, correction)).toEqual({ applied: false });
        expect(adapter.snapshot(root).text).toBe("I seen it.");
      } finally {
        document.execCommand = originalExecCommand;
      }
    });
  }

  it("refuses to apply against a stale snapshot", async () => {
    const root = build();
    const snapshot = adapter.snapshot(root);
    root.textContent = "The text moved on.";
    expect(await adapter.apply(root, snapshot, correction)).toEqual({ applied: false });
    expect(adapter.snapshot(root).text).toBe("The text moved on.");
  });

  it("refuses readonly, disabled, hidden, and non-editable roots", () => {
    const refusals = [
      (root) => root.setAttribute("aria-readonly", "true"),
      (root) => root.setAttribute("aria-disabled", "true"),
      (root) => root.setAttribute("aria-hidden", "true"),
      (root) => root.setAttribute("contenteditable", "false"),
      ...extraRefusals,
    ];
    for (const makeIneligible of refusals) {
      const root = build();
      makeIneligible(root);
      expect(adapterForField(root), makeIneligible.toString()).toBe(null);
    }
  });
}
