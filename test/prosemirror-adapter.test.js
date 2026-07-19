import { describe, expect, it, vi } from "vitest";
import {
  isEligibleProseMirrorRoot,
  isProseMirrorRoot,
  prosemirrorAdapter,
  proseMirrorRoot,
} from "../page/content/adapters/prosemirror.js";
import { registerAdapterContractSuite } from "./helpers/adapter-suite.js";

function prosemirror(html = "<p>I seen it.</p>") {
  const el = document.createElement("div");
  el.className = "ProseMirror";
  el.setAttribute("contenteditable", "true");
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

describe("prosemirror adapter", () => {
  registerAdapterContractSuite({
    adapter: prosemirrorAdapter,
    editorName: "ProseMirror",
    build: prosemirror,
    isRoot: isProseMirrorRoot,
    isEligibleRoot: isEligibleProseMirrorRoot,
    rootFor: proseMirrorRoot,
    // ProseMirror delegates to the contenteditable beforeinput apply, not the
    // exec-command path — the DOM-mapping apply case lives below.
    execCommandApply: false,
  });

  it("delegates snapshot and writeback to the proven DOM mapping contract", () => {
    const root = prosemirror("<p><span>I </span><strong>seen</strong><span> it.</span></p>");
    const seen = vi.fn();
    root.addEventListener("input", seen);
    const snapshot = prosemirrorAdapter.snapshot(root);
    expect(snapshot.text).toBe("I seen it.");

    expect(prosemirrorAdapter.apply(root, snapshot, {
      startIndex: 2,
      endIndex: 6,
      correction: "saw",
    })).toEqual({ applied: true, newCaret: 5 });

    expect(prosemirrorAdapter.snapshot(root).text).toBe("I saw it.");
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("treats ignored ProseMirror widgets as no model text and preserves them on apply", () => {
    const root = prosemirror('<p>I <span contenteditable="false" data-pm-widget="drag">::</span>seen it.</p>');
    const snapshot = prosemirrorAdapter.snapshot(root);
    expect(snapshot.text).toBe("I seen it.");

    expect(prosemirrorAdapter.apply(root, snapshot, {
      startIndex: 2,
      endIndex: 6,
      correction: "saw",
    })).toEqual({ applied: true, newCaret: 5 });

    expect(root.querySelector("[data-pm-widget]").textContent).toBe("::");
    expect(prosemirrorAdapter.snapshot(root).text).toBe("I saw it.");
  });

  it("skips ProseMirror trailing break chrome", () => {
    const root = prosemirror('<p>I seen it.<br class="ProseMirror-trailingBreak"></p>');
    const snapshot = prosemirrorAdapter.snapshot(root);
    expect(snapshot.text).toBe("I seen it.");
  });
});
