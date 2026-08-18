import { describe, expect, it, vi } from "vitest";
import { runSync } from "../lib/full-sync.js";

describe("combined GitHub sync", () => {
  it("runs notes and opted-in Weirpacks in one user-visible operation", async () => {
    const runNotesSync = vi.fn(async () => ({ ok: true, changedLocal: false }));
    const runWeirpackSync = vi.fn(async () => ({ ok: true, changedLocal: true, pulled: 1 }));

    await expect(runSync({ runNotesSync, runWeirpackSync })).resolves.toMatchObject({
      ok: true,
      changedLocal: false,
      changedWeirpacks: true,
      weirpacks: { pulled: 1 },
    });
    expect(runNotesSync).toHaveBeenCalledOnce();
    expect(runWeirpackSync).toHaveBeenCalledOnce();
  });

  it("is skipped only when both data sets are skipped", async () => {
    const runNotesSync = vi.fn(async () => ({ ok: true, skipped: true }));
    const runWeirpackSync = vi.fn(async () => ({ ok: true, skipped: false }));
    expect((await runSync({ runNotesSync, runWeirpackSync })).skipped).toBe(false);
  });
});
