import { describe, expect, it } from "vitest";
import { createBridgeResponder } from "../page/content/bridge/main.js";
import { adapterForField, resolveAdapterRoot } from "../page/content/adapters/index.js";
import {
  CODEMIRROR_BRIDGE_REPLACE,
  codeMirrorAdapter,
  codeMirrorMode,
  codeMirrorRoot,
  isCodeMirrorRoot,
  isEligibleCodeMirrorRoot,
  isProseCodeMirrorMode,
} from "../page/content/adapters/codemirror.js";
import { assertAdapter } from "../page/content/adapters/contracts.js";

function cm6({ language = "markdown", html = "<div>I seen it.</div>" } = {}) {
  const shell = document.createElement("div");
  shell.className = "cm-editor";
  shell.dataset.language = language;
  const content = document.createElement("div");
  content.id = `cm6-${Math.random().toString(36).slice(2)}`;
  content.className = "cm-content";
  content.setAttribute("contenteditable", "true");
  content.setAttribute("role", "textbox");
  content.setAttribute("aria-multiline", "true");
  content.innerHTML = html;
  shell.append(content);
  document.body.append(shell);
  return content;
}

function cm5({ language = "markdown", html = "<pre>I seen it.</pre>" } = {}) {
  const shell = document.createElement("div");
  shell.className = "CodeMirror";
  shell.dataset.language = language;
  const input = document.createElement("textarea");
  const code = document.createElement("div");
  code.id = `cm5-${Math.random().toString(36).slice(2)}`;
  code.className = "CodeMirror-code";
  code.innerHTML = html;
  shell.append(input, code);
  document.body.append(shell);
  return { shell, input, code };
}

function installReplaceBridge() {
  return createBridgeResponder({
    handlers: {
      [CODEMIRROR_BRIDGE_REPLACE]: ({ rootId, start, end, replacement, expectedText, expectedResult }) => {
        const root = document.getElementById(rootId);
        const before = codeMirrorAdapter.snapshot(root).text;
        if (before.slice(start, end) !== expectedText) return { applied: false, text: before };
        root.textContent = expectedResult;
        return {
          applied: codeMirrorAdapter.snapshot(root).text === expectedResult,
          text: root.textContent,
          replacement,
        };
      },
    },
  });
}

describe("codemirror adapter", () => {
  it("satisfies the adapter contract and recognizes CM6 prose roots", () => {
    const root = cm6();
    expect(assertAdapter(codeMirrorAdapter)).toBe(codeMirrorAdapter);
    expect(isCodeMirrorRoot(root)).toBe(true);
    expect(isEligibleCodeMirrorRoot(root)).toBe(true);
    expect(codeMirrorMode(root)).toBe("markdown");
    expect(codeMirrorRoot(root.firstChild)).toBe(root);
    expect(adapterForField(root)).toBe(codeMirrorAdapter);
    expect(resolveAdapterRoot(root.firstChild)).toBe(root);
  });

  it("recognizes CM5 through its shell but normalizes to the visible code root", () => {
    const { input, code } = cm5();
    expect(isCodeMirrorRoot(code)).toBe(true);
    expect(isEligibleCodeMirrorRoot(code)).toBe(true);
    expect(codeMirrorRoot(input)).toBe(code);
    expect(resolveAdapterRoot(input)).toBe(code);
  });

  it("requires an explicit prose mode and refuses programming, mixed, and unknown modes", () => {
    expect(isProseCodeMirrorMode("markdown")).toBe(true);
    expect(isProseCodeMirrorMode("text/x-markdown")).toBe(true);
    expect(isProseCodeMirrorMode("javascript")).toBe(false);
    expect(isProseCodeMirrorMode("markdown javascript")).toBe(false);
    expect(isProseCodeMirrorMode("")).toBe(false);

    const programming = cm6({ language: "javascript" });
    const mixed = cm6({ language: "markdown javascript" });
    const unknown = cm6({ language: "unknown" });
    expect(adapterForField(programming)).toBe(null);
    expect(adapterForField(mixed)).toBe(null);
    expect(adapterForField(unknown)).toBe(null);
  });

  it("keeps rejected CM6 roots out of generic contenteditable", () => {
    const root = cm6({ language: "javascript" });
    expect(codeMirrorRoot(root)).toBe(root);
    expect(adapterForField(root)).toBe(null);
  });

  it("marks snapshots stale when the active mode stops being prose", () => {
    const root = cm6();
    const snapshot = codeMirrorAdapter.snapshot(root);
    expect(snapshot.text).toBe("I seen it.");
    expect(snapshot.isCurrent()).toBe(true);
    root.closest(".cm-editor").dataset.language = "javascript";
    expect(snapshot.isCurrent()).toBe(false);
  });

  it("applies through the capability bridge and verifies the visible mapping", async () => {
    const root = cm6({ html: "<div><span>I </span><strong>seen</strong><span> it.</span></div>" });
    const bridge = installReplaceBridge();
    const snapshot = codeMirrorAdapter.snapshot(root);
    try {
      await expect(codeMirrorAdapter.apply(root, snapshot, {
        startIndex: 2,
        endIndex: 6,
        correction: "saw",
      })).resolves.toEqual({ applied: true, newCaret: 5 });
      expect(codeMirrorAdapter.snapshot(root).text).toBe("I saw it.");
    } finally {
      bridge.dispose();
    }
  });
});
