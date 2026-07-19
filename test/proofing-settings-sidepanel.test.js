import { afterEach, describe, expect, it } from "vitest";
import { $, loadPage, settle } from "./helpers/page.js";

afterEach(() => { document.documentElement.innerHTML = ""; });

describe("side-panel dialect setting", () => {
  it("loads the persisted choice and saves user changes", async () => {
    await loadPage({ storage: { proofingSettings: { dialect: "british" } } });
    expect($("proofingDialect").value).toBe("british");

    $("proofingDialect").value = "australian";
    $("proofingDialect").dispatchEvent(new Event("change", { bubbles: true }));
    await settle();

    expect(await chrome.storage.sync.get("proofingSettings"))
      .toEqual({ proofingSettings: { dialect: "australian" } });

    await chrome.storage.sync.set({ proofingSettings: { dialect: "canadian" } });
    expect($("proofingDialect").value).toBe("canadian");
  });
});
