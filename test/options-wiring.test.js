// options/options.js — wiring smoke test. The behaviour lives in
// ui/dictionary-page.js and ui/sync-page.js (covered by
// dictionary-page.test.js / sync-page.test.js with fake elements); the risk
// left in options.js is the binding itself drifting from options.html. So:
// evaluate the real entry module against the real page DOM and assert it
// reaches its rendered idle state without touching a missing element.

import { afterEach, describe, expect, it, vi } from "vitest";
import optionsHtml from "../options/options.html?raw";
import optionsSource from "../options/options.js?raw";
import { installChromeStorageStub } from "./helpers/chrome-storage.js";

const optionsBody = optionsHtml
  .match(/<body>([\s\S]*)<\/body>/)[1]
  .replace(/<script[\s\S]*?<\/script>/, "");

afterEach(() => {
  delete globalThis.chrome;
  document.body.innerHTML = "";
});

describe("options page wiring", () => {
  it("every element options.js binds exists in options.html", () => {
    const ids = [...optionsSource.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    document.body.innerHTML = optionsBody;
    for (const id of ids) {
      expect(document.getElementById(id), `#${id} referenced by options.js`).not.toBe(null);
    }
  });

  it("the entry module evaluates against the real DOM and renders the idle state", async () => {
    document.body.innerHTML = optionsBody;
    installChromeStorageStub({ customDictionary: ["Proofly"] });

    vi.resetModules();
    await import("../options/options.js");
    for (let i = 0; i < 50; i++) await Promise.resolve();

    // Dictionary side rendered the seeded word; sync side settled on the
    // not-connected state — both prove init ran to completion on this DOM.
    expect(document.getElementById("wordList").textContent).toContain("Proofly");
    expect(document.getElementById("dictEmpty").hidden).toBe(true);
    expect(document.getElementById("syncConnected").hidden).toBe(true);
  });
});
