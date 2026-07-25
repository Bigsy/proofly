import { beforeEach, describe, expect, it, vi } from "vitest";
import { initWeirpackPage } from "../ui/weirpack-page.js";

const $ = (id) => document.getElementById(id);

function elements() {
  document.body.innerHTML = `
    <input id="file" type="file">
    <button id="import"></button>
    <span id="status"></span>
    <p id="empty"></p>
    <ul id="list"></ul>
  `;
  return {
    file: $("file"), importBtn: $("import"), status: $("status"),
    empty: $("empty"), list: $("list"),
  };
}

function makeStore(initial = []) {
  let packs = initial;
  let listener = () => {};
  return {
    loadWeirpackIndex: vi.fn(async () => packs),
    saveWeirpack: vi.fn(async ({ name, bytes, manifest }) => {
      const entry = { id: "a".repeat(32), name, size: bytes.length, ...manifest };
      packs = [entry];
      listener(packs);
      return entry;
    }),
    removeWeirpack: vi.fn(async () => {
      packs = [];
      listener(packs);
      return packs;
    }),
    onWeirpacksChanged: vi.fn((callback) => {
      listener = callback;
      return () => {};
    }),
  };
}

beforeEach(() => { document.body.innerHTML = ""; });

describe("Weirpack options page", () => {
  it("validates, saves, and renders an imported pack", async () => {
    const els = elements();
    const store = makeStore();
    const validate = vi.fn(async () => ({
      author: "Bill", version: "1.0.0", description: "Doccla vocabulary",
    }));
    const page = initWeirpackPage({ els, store, validate });
    await page.ready;
    const file = {
      name: "doccla.weirpack",
      size: 4,
      arrayBuffer: async () => Uint8Array.from([80, 75, 3, 4]).buffer,
    };
    Object.defineProperty(els.file, "files", { configurable: true, value: [file] });

    els.file.dispatchEvent(new Event("change"));
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(validate).toHaveBeenCalledWith(Uint8Array.from([80, 75, 3, 4]));
    expect(store.saveWeirpack).toHaveBeenCalled();
    expect(els.list.textContent).toContain("doccla.weirpack · Bill · v1.0.0");
    expect(els.list.textContent).toContain("Doccla vocabulary");
    expect(els.status.textContent).toBe("Imported doccla.weirpack.");
  });

  it("surfaces validation failures without saving", async () => {
    const els = elements();
    const store = makeStore();
    const validate = vi.fn(async () => { throw new Error("embedded tests failed"); });
    const page = initWeirpackPage({ els, store, validate });
    await page.ready;
    Object.defineProperty(els.file, "files", {
      configurable: true,
      value: [{
        name: "bad.weirpack", size: 1,
        arrayBuffer: async () => Uint8Array.from([1]).buffer,
      }],
    });

    els.file.dispatchEvent(new Event("change"));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(store.saveWeirpack).not.toHaveBeenCalled();
    expect(els.status.textContent).toContain("embedded tests failed");
    expect(els.status.classList.contains("error")).toBe(true);
  });
});
