// Side-panel Harper readiness. Chrome Proofreader availability and model
// download state must have no bearing on automatic proofreading.

import { describe, expect, it } from "vitest";
import { createMockProofreader } from "./helpers/mock-proofreader.js";
import { $, loadPage, tick, typeInEditor } from "./helpers/page.js";
import basic from "./fixtures/basic-grammar-spelling.json";

describe("packaged Harper readiness", () => {
  it("reports Harper ready without probing Chrome Proofreader", async () => {
    const mock = createMockProofreader({ availability: "unavailable" });
    await loadPage({ mock });

    expect($("statusText").textContent).toBe("Ready");
    expect($("status").className).toContain("status--ok");
    expect($("downloadBtn")).toBe(null);
    expect(mock.ledger.availabilityCalls).toEqual([]);
  });

  it("auto-lints pre-filled text regardless of Chrome model availability", async () => {
    const mock = createMockProofreader({ availability: "downloadable", results: [basic.result] });
    await loadPage({ text: basic.input, mock });

    expect(mock.ledger.availabilityCalls).toEqual([]);
    expect(mock.ledger.instances[0].proofreadCalls).toEqual([basic.input]);
    expect($("results").hidden).toBe(false);
    expect($("statusText").textContent).toBe("Ready");
  });

  it("lints automatically after the typing debounce with no download gesture", async () => {
    const mock = createMockProofreader({ availability: "downloading" });
    await loadPage({ mock });
    typeInEditor("A draft");
    await tick(700);

    expect(mock.ledger.instances[0].proofreadCalls).toEqual(["A draft"]);
    expect($("downloadBtn")).toBe(null);
  });

  it("surfaces a quiet Harper error without breaking the editor", async () => {
    const mock = createMockProofreader();
    mock.enqueue(() => { throw new Error("WASM unavailable"); });
    await loadPage({ text: "Still editable", mock });

    expect($("statusText").textContent).toBe("Proofreading unavailable: WASM unavailable");
    expect($("status").className).toContain("status--error");
    expect($("editor").value).toBe("Still editable");
  });
});
