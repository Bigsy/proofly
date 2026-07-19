import { describe, expect, it, vi } from "vitest";
import { initSyncPage } from "../ui/sync-page.js";

function mount() {
  document.body.innerHTML = `
    <a id="repo"></a>
    <a id="tokenLink"></a>
    <input id="token" />
    <label id="repoWrap" hidden><select id="repoSelect"></select></label>
    <p id="connected" hidden></p>
    <button id="syncNow"></button>
    <button id="disconnect"></button>
    <span id="status"></span>
    <div id="diagnostic" hidden>
      <p id="diagnosticMessage"></p>
      <button id="resolve" hidden></button>
      <code id="technical"></code>
    </div>
    <button id="downloadBackup" hidden></button>
    <section id="recovery" hidden>
      <p id="recoverySummary"></p>
      <div id="recoveryChoices">
        <button id="repair"></button>
        <button id="useGitHub"></button>
        <button id="useLocal"></button>
      </div>
      <div id="recoveryConfirm" hidden>
        <p id="recoveryWarning"></p>
        <button id="cancelRecovery"></button>
        <button id="confirmRecovery"></button>
      </div>
      <button id="closeRecovery"></button>
    </section>
  `;
  return {
    createRepo: document.getElementById("repo"),
    createToken: document.getElementById("tokenLink"),
    token: document.getElementById("token"),
    repoWrap: document.getElementById("repoWrap"),
    repoSelect: document.getElementById("repoSelect"),
    connected: document.getElementById("connected"),
    syncNow: document.getElementById("syncNow"),
    disconnect: document.getElementById("disconnect"),
    status: document.getElementById("status"),
    diagnostic: document.getElementById("diagnostic"),
    diagnosticMessage: document.getElementById("diagnosticMessage"),
    technicalText: document.getElementById("technical"),
    resolve: document.getElementById("resolve"),
    downloadBackup: document.getElementById("downloadBackup"),
    recovery: document.getElementById("recovery"),
    recoverySummary: document.getElementById("recoverySummary"),
    recoveryChoices: document.getElementById("recoveryChoices"),
    recoveryConfirm: document.getElementById("recoveryConfirm"),
    recoveryWarning: document.getElementById("recoveryWarning"),
    repair: document.getElementById("repair"),
    useGitHub: document.getElementById("useGitHub"),
    useLocal: document.getElementById("useLocal"),
    closeRecovery: document.getElementById("closeRecovery"),
    cancelRecovery: document.getElementById("cancelRecovery"),
    confirmRecovery: document.getElementById("confirmRecovery"),
  };
}

function settingsStore(initial = null) {
  let value = initial;
  return {
    loadSyncSettings: vi.fn(async () => value),
    saveSyncSettings: vi.fn(async (next) => { value = next; return next; }),
    clearSyncSettings: vi.fn(async () => { value = null; }),
    onSyncSettingsChanged: vi.fn(),
  };
}

describe("initSyncPage", () => {
  it("auto-connects when a token can see exactly one repo", async () => {
    vi.useFakeTimers();
    const els = mount();
    const store = settingsStore();
    const client = { validate: vi.fn(async () => ({ expiration: "" })) };
    const runSync = vi.fn(async () => ({ ok: true }));

    const page = initSyncPage({
      els,
      settingsStore: store,
      discoverRepos: vi.fn(async () => [{ full_name: "me/proofly-notes", private: true }]),
      makeClient: vi.fn(() => client),
      runSync,
    });
    await page.ready;

    els.token.value = "github_pat_test";
    els.token.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(250);
    await Promise.resolve();

    expect(store.saveSyncSettings).toHaveBeenCalledWith({
      owner: "me",
      repo: "proofly-notes",
      branch: "main",
      token: "github_pat_test",
    });
    expect(runSync).toHaveBeenCalledTimes(1);
    expect(els.connected.hidden).toBe(false);
    expect(els.repoWrap.hidden).toBe(true);
    expect(els.status.textContent).toContain("Connected and synced");
  });

  it("shows a repository dropdown when the token can see several repos", async () => {
    vi.useFakeTimers();
    const els = mount();
    const store = settingsStore();

    const page = initSyncPage({
      els,
      settingsStore: store,
      discoverRepos: vi.fn(async () => [
        { full_name: "me/one", private: true },
        { full_name: "me/two", private: true },
      ]),
      makeClient: vi.fn(() => ({ validate: vi.fn(async () => ({})) })),
      runSync: vi.fn(async () => ({ ok: true })),
    });
    await page.ready;

    els.token.value = "github_pat_test";
    els.token.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(250);
    await Promise.resolve();

    expect(els.repoWrap.hidden).toBe(false);
    expect([...els.repoSelect.options].map((o) => o.value)).toEqual(["me/one", "me/two"]);
    expect(els.status.textContent).toContain("Choose the repo");
  });

  it("shows the last automatic sync failure and clears it after a retry", async () => {
    const els = mount();
    const store = settingsStore({ owner: "me", repo: "notes", branch: "main", token: "secret" });
    const diagnostics = {
      loadSyncDiagnostic: vi.fn(async () => ({ status: 403, message: "Resource not accessible", at: 1_700_000_000_000 })),
      recordSyncError: vi.fn(),
      clearSyncDiagnostic: vi.fn(async () => {}),
    };
    const page = initSyncPage({
      els,
      settingsStore: store,
      diagnosticStore: diagnostics,
      discoverRepos: vi.fn(),
      makeClient: vi.fn(),
      runSync: vi.fn(async () => ({ ok: true })),
    });
    await page.ready;

    expect(els.diagnostic.hidden).toBe(false);
    expect(els.diagnostic.textContent).toContain("token is missing access");
    expect(els.diagnostic.textContent).toContain("Resource not accessible");

    els.syncNow.click();
    await vi.waitFor(() => expect(diagnostics.clearSyncDiagnostic).toHaveBeenCalled());
    expect(els.diagnostic.hidden).toBe(true);
  });

  it("offers a mocked, confirmed GitHub recovery for repeated sha conflicts", async () => {
    const els = mount();
    const configured = { owner: "me", repo: "notes", branch: "main", token: "secret" };
    const store = settingsStore(configured);
    const diagnostics = {
      loadSyncDiagnostic: vi.fn(async () => ({
        status: 422,
        message: "index.json does not match abc123",
        at: 1_700_000_000_000,
      })),
      recordSyncError: vi.fn(),
      clearSyncDiagnostic: vi.fn(async () => {}),
    };
    const inspectSyncRecovery = vi.fn(async () => ({
      localCount: 5,
      remoteCount: 6,
      localOnly: 2,
      remoteOnly: 3,
      changed: 1,
    }));
    const recoverNotesSync = vi.fn(async () => ({ ok: true, strategy: "remote", noteCount: 6 }));
    const backup = { createdAt: 1_700_000_000_000, strategy: "remote" };
    const recoveryStore = {
      loadRecoveryBackup: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(backup),
    };

    const page = initSyncPage({
      els,
      settingsStore: store,
      diagnosticStore: diagnostics,
      recoveryStore,
      discoverRepos: vi.fn(),
      makeClient: vi.fn(),
      runSync: vi.fn(),
      inspectSyncRecovery,
      recoverNotesSync,
    });
    await page.ready;

    expect(els.status.textContent).toBe("Connected — sync needs attention");
    expect(els.connected.classList.contains("sync-connected--attention")).toBe(true);
    expect(els.diagnosticMessage.textContent).toContain("Your notes have been kept safe");
    expect(els.technicalText.textContent).toBe("index.json does not match abc123");
    expect(els.resolve.hidden).toBe(false);

    els.resolve.click();
    await vi.waitFor(() => expect(inspectSyncRecovery).toHaveBeenCalledWith({ settings: configured }));
    expect(els.recovery.hidden).toBe(false);
    expect(els.recoverySummary.textContent).toBe("5 notes on this device · 6 notes on GitHub.");

    els.useGitHub.click();
    expect(els.recoveryConfirm.hidden).toBe(false);
    expect(els.recoveryWarning.textContent).toContain("2 notes found only on this device");
    expect(recoverNotesSync).not.toHaveBeenCalled();

    els.confirmRecovery.click();
    await vi.waitFor(() => expect(recoverNotesSync).toHaveBeenCalledWith("remote", { settings: configured }));
    await vi.waitFor(() => expect(els.status.textContent)
      .toBe("Recovered from GitHub. 6 notes now on this device."));
    expect(diagnostics.clearSyncDiagnostic).toHaveBeenCalled();
    expect(els.diagnostic.hidden).toBe(true);
    expect(els.downloadBackup.hidden).toBe(false);
    expect(els.recovery.hidden).toBe(true);
  });

  it("starts the recommended repair immediately and makes a failure visible", async () => {
    const els = mount();
    const configured = { owner: "me", repo: "notes", branch: "main", token: "secret" };
    let rejectRepair;
    const recoverNotesSync = vi.fn(() => new Promise((resolve, reject) => { rejectRepair = reject; }));
    const diagnostics = {
      loadSyncDiagnostic: vi.fn(async () => ({ status: 422, message: "sha mismatch", at: 1_700_000_000_000 })),
      recordSyncError: vi.fn(async (error) => ({ status: error.status, message: error.message, at: 1_700_000_000_001 })),
      clearSyncDiagnostic: vi.fn(),
    };
    const page = initSyncPage({
      els,
      settingsStore: settingsStore(configured),
      diagnosticStore: diagnostics,
      recoveryStore: { loadRecoveryBackup: vi.fn(async () => null) },
      discoverRepos: vi.fn(),
      makeClient: vi.fn(),
      runSync: vi.fn(),
      inspectSyncRecovery: vi.fn(async () => ({
        localCount: 3, remoteCount: 3, localOnly: 0, remoteOnly: 0, changed: 1,
      })),
      recoverNotesSync,
    });
    await page.ready;

    els.resolve.click();
    await vi.waitFor(() => expect(els.recovery.hidden).toBe(false));
    els.repair.click();
    expect(recoverNotesSync).toHaveBeenCalledWith("merge", { settings: configured });
    expect(els.status.textContent).toBe("Repairing sync…");
    expect(els.repair.disabled).toBe(true);

    rejectRepair(Object.assign(new Error("index.json does not match latest sha"), { status: 422 }));
    await vi.waitFor(() => expect(els.status.textContent)
      .toBe("Repair failed — retry or choose another recovery option"));
    expect(els.repair.disabled).toBe(false);
    expect(els.technicalText.textContent).toContain("does not match latest sha");
  });
});
