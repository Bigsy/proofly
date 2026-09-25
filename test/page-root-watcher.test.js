import { describe, expect, it, vi } from "vitest";
import { createActiveMutationClassifier, createRootWatcher } from "../page/content/session.js";

describe("active editor mutation watching", () => {
  it("observes text and attributes only inside the editor while still catching removal", async () => {
    document.body.innerHTML = '<main><div id="editor">Hello</div></main><aside>Updates</aside>';
    const editor = document.getElementById("editor");
    const aside = document.querySelector("aside");
    const delivered = vi.fn();
    const NativeObserver = globalThis.MutationObserver;
    const spy = vi.spyOn(globalThis, "MutationObserver").mockImplementation(function (callback) {
      return new NativeObserver((records) => {
        delivered(records);
        callback(records);
      });
    });
    const notify = vi.fn();
    const unwatch = createRootWatcher(editor, notify, createActiveMutationClassifier({}));
    try {
      aside.firstChild.data = "Another update";
      aside.setAttribute("class", "animated");
      await Promise.resolve();
      expect(delivered).not.toHaveBeenCalled();

      editor.firstChild.data = "Changed";
      await Promise.resolve();
      expect(notify).toHaveBeenLastCalledWith("text");
      editor.setAttribute("contenteditable", "false");
      await Promise.resolve();
      expect(notify).toHaveBeenLastCalledWith("mapping");
      editor.parentElement.remove();
      await Promise.resolve();
      expect(notify).toHaveBeenLastCalledWith("detached");
    } finally {
      unwatch();
      spy.mockRestore();
    }
  });

  it("detects removal of an outer host for an editor in nested shadow roots", async () => {
    const outer = document.createElement("div");
    document.body.appendChild(outer);
    const inner = document.createElement("div");
    outer.attachShadow({ mode: "open" }).appendChild(inner);
    const editor = document.createElement("textarea");
    inner.attachShadow({ mode: "open" }).appendChild(editor);
    const notify = vi.fn();
    const unwatch = createRootWatcher(editor, notify, createActiveMutationClassifier({}));
    try {
      outer.remove();
      await Promise.resolve();
      expect(notify).toHaveBeenCalledWith("detached");
    } finally {
      unwatch();
    }
  });
});
