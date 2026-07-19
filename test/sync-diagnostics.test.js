import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSyncDiagnostic, loadSyncDiagnostic, recordSyncError, SYNC_DIAGNOSTIC_KEY,
} from "../lib/sync-diagnostics.js";
import { installChromeStorageStub } from "./helpers/chrome-storage.js";

describe("sync diagnostics", () => {
  beforeEach(() => installChromeStorageStub());

  it("stores only a bounded safe error summary and clears it", async () => {
    await recordSyncError(Object.assign(new Error(`failed\n${"x".repeat(400)}`), { status: 503 }), 123);
    const diagnostic = await loadSyncDiagnostic();
    expect(diagnostic).toMatchObject({ status: 503, at: 123 });
    expect(diagnostic.message).not.toContain("\n");
    expect(diagnostic.message.length).toBe(300);
    expect((await chrome.storage.local.get(SYNC_DIAGNOSTIC_KEY))[SYNC_DIAGNOSTIC_KEY]).toEqual(diagnostic);

    await clearSyncDiagnostic();
    expect(await loadSyncDiagnostic()).toBeNull();
  });
});
