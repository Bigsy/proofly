// ui/sync-page.js — GitHub notes-sync section for the options page.
// Deps-injected like dictionary-page.js: DOM here, storage/network in deps.

export const CREATE_REPO_URL =
  "https://github.com/new?name=proofly-notes&description=Proofly+notes+sync&visibility=private";

export const CREATE_TOKEN_URL =
  "https://github.com/settings/personal-access-tokens/new?name=Proofly+notes+sync" +
  "&description=Lets+Proofly+read+and+write+your+notes+repo&contents=write&expires_in=none";

function repoValue(repo) {
  return repo?.full_name || (repo?.owner?.login && repo?.name ? `${repo.owner.login}/${repo.name}` : "");
}

function splitFullName(fullName) {
  const [owner, repo] = String(fullName ?? "").split("/");
  return owner && repo ? { owner, repo } : null;
}

function friendlyError(e) {
  const permissions = e?.permissions ? ` GitHub says this endpoint needs: ${e.permissions}.` : "";
  if (e?.status === 401) return "GitHub rejected the token. Create a fresh fine-grained token and paste it here.";
  if (e?.status === 403) return `The token is missing access. Make sure it has Contents: read/write for this repo.${permissions}`;
  if (e?.status === 404) return "GitHub could not see that repo. Reopen the token page and select the notes repo.";
  if (e?.retryableConflict || e?.status === 409 || e?.status === 422) {
    return "Sync couldn’t finish because the GitHub library changed at the same time. Your notes have been kept safe.";
  }
  return `Sync setup failed: ${e?.message || e}`;
}

const isWriteConflict = (value) => value?.scope !== "weirpacks" && (
  value?.status === 409
  || value?.status === 422
  || /does not match|sha mismatch/i.test(value?.message ?? "")
);

const plural = (count, noun = "note") => `${count} ${noun}${count === 1 ? "" : "s"}`;

function expiryText(expiration) {
  if (!expiration) return "";
  const ms = Date.parse(expiration) - Date.now();
  if (!Number.isFinite(ms)) return "";
  const days = Math.ceil(ms / (24 * 60 * 60 * 1000));
  if (days < 0) return "Token expired.";
  return `Token expires in ${days} day${days === 1 ? "" : "s"}.`;
}

export function initSyncPage({
  els, settingsStore, discoverRepos, makeClient, runSync,
  inspectSyncRecovery, recoverNotesSync,
  diagnosticStore = {},
  recoveryStore = {},
}) {
  let settings = null;
  let repos = [];
  let token = "";
  let validateSeq = 0;
  let currentDiagnostic = null;
  let recoveryPreview = null;
  let pendingRecovery = null;
  let recoveryBackup = null;

  function setStatus(text, kind = "muted") {
    els.status.textContent = text;
    els.status.classList.toggle("error", kind === "error");
    els.status.classList.toggle("ok", kind === "ok");
    els.status.classList.toggle("warning", kind === "warning");
  }

  function renderConnectionAttention() {
    els.connected.classList.toggle("sync-connected--attention", !!settings && !!currentDiagnostic);
  }

  function renderDiagnostic(diagnostic) {
    currentDiagnostic = diagnostic;
    if (!els.diagnostic) return;
    if (!diagnostic) {
      els.diagnostic.hidden = true;
      if (els.diagnosticMessage) els.diagnosticMessage.textContent = "";
      else els.diagnostic.textContent = "";
      if (els.technicalText) els.technicalText.textContent = "";
      if (els.resolve) els.resolve.hidden = true;
      renderConnectionAttention();
      return;
    }
    const when = new Date(diagnostic.at).toLocaleString();
    const reason = isWriteConflict(diagnostic)
      ? "Sync couldn’t finish because the GitHub library changed at the same time. Your notes have been kept safe."
      : diagnostic.scope === "weirpacks"
        ? `Weirpack sync failed: ${diagnostic.message}`
        : friendlyError(diagnostic);
    const message = `Last sync attempt failed ${when}: ${reason}`;
    if (els.diagnosticMessage) {
      els.diagnosticMessage.textContent = message;
      if (els.technicalText) els.technicalText.textContent = diagnostic.message;
    } else {
      // Small fallback for embedders/tests using the pre-details markup.
      els.diagnostic.textContent = `${message} Technical details: ${diagnostic.message}`;
    }
    if (els.resolve) els.resolve.hidden = !isWriteConflict(diagnostic) || !recoverNotesSync;
    els.diagnostic.hidden = false;
    renderConnectionAttention();
  }

  async function noteSuccess() {
    await diagnosticStore.clearSyncDiagnostic?.();
    renderDiagnostic(null);
  }

  async function noteFailure(error) {
    const diagnostic = await diagnosticStore.recordSyncError?.(error);
    renderDiagnostic(diagnostic || { message: error?.message || String(error), status: error?.status, at: Date.now() });
  }

  function setBusy(busy) {
    els.token.disabled = busy;
    els.repoSelect.disabled = busy;
    els.syncNow.disabled = busy || !settings;
    els.disconnect.disabled = busy || !settings;
    for (const el of [
      els.resolve, els.repair, els.useGitHub, els.useLocal,
      els.cancelRecovery, els.confirmRecovery, els.closeRecovery,
    ]) {
      if (el) el.disabled = busy;
    }
  }

  function renderSettings() {
    els.token.value = settings?.token ? "••••••••••••••••" : "";
    els.repoSelect.textContent = "";
    els.repoWrap.hidden = true;
    els.connected.hidden = !settings;
    // Connected: the setup block (token field, helper links, manual steps) is
    // finished business — collapse it so the card is just status + actions.
    if (els.setup) els.setup.hidden = !!settings;
    els.syncNow.disabled = !settings;
    els.disconnect.disabled = !settings;
    if (settings) {
      els.connected.textContent = `Connected to ${settings.owner}/${settings.repo} (${settings.branch || "main"}).`;
    }
    renderConnectionAttention();
  }

  function updateBackupButton() {
    if (els.downloadBackup) els.downloadBackup.hidden = !recoveryBackup;
  }

  function closeRecovery() {
    pendingRecovery = null;
    if (els.recovery) els.recovery.hidden = true;
    if (els.recoveryChoices) els.recoveryChoices.hidden = false;
    if (els.recoveryConfirm) els.recoveryConfirm.hidden = true;
  }

  function showRecoveryChoices() {
    pendingRecovery = null;
    if (els.recoveryChoices) els.recoveryChoices.hidden = false;
    if (els.recoveryConfirm) els.recoveryConfirm.hidden = true;
  }

  async function openRecovery() {
    if (!settings || !inspectSyncRecovery || !els.recovery) return;
    setBusy(true);
    setStatus("Checking both libraries…");
    try {
      recoveryPreview = await inspectSyncRecovery({ settings });
      els.recoverySummary.textContent =
        `${plural(recoveryPreview.localCount)} on this device · ${plural(recoveryPreview.remoteCount)} on GitHub.`;
      els.recovery.hidden = false;
      showRecoveryChoices();
      setStatus("Connected — sync needs attention", "warning");
    } catch (error) {
      await noteFailure(error);
      setStatus("Connected — sync needs attention", "warning");
    } finally {
      setBusy(false);
    }
  }

  function confirmDirectionalRecovery(strategy) {
    if (!recoveryPreview || !els.recoveryConfirm) return;
    pendingRecovery = strategy;
    els.recoveryChoices.hidden = true;
    els.recoveryConfirm.hidden = false;
    if (strategy === "remote") {
      els.recoveryWarning.textContent =
        `Use GitHub on this device? ${plural(recoveryPreview.localOnly)} found only on this device will be removed from the library, and ${plural(recoveryPreview.changed, "shared version")} may be replaced.`;
      els.confirmRecovery.textContent = "Use GitHub notes";
    } else {
      els.recoveryWarning.textContent =
        `Replace GitHub with this device? ${plural(recoveryPreview.remoteOnly)} found only on GitHub will be removed from the synced library, and ${plural(recoveryPreview.changed, "shared version")} may be replaced. GitHub history remains available.`;
      els.confirmRecovery.textContent = "Replace GitHub";
    }
  }

  async function performRecovery(strategy) {
    if (!settings || !recoverNotesSync) return;
    setBusy(true);
    setStatus(strategy === "merge" ? "Repairing sync…" : "Creating backup and replacing library…");
    try {
      const result = await recoverNotesSync(strategy, { settings });
      await noteSuccess();
      recoveryBackup = await recoveryStore.loadRecoveryBackup?.();
      updateBackupButton();
      closeRecovery();
      if (strategy === "merge") {
        setStatus("Sync repaired. Both libraries were merged.", "ok");
      } else if (strategy === "remote") {
        setStatus(`Recovered from GitHub. ${plural(result.noteCount)} now on this device.`, "ok");
      } else {
        setStatus(`GitHub replaced safely with ${plural(result.noteCount)} from this device.`, "ok");
      }
    } catch (error) {
      // The recovery may have failed after its safety snapshot was written.
      // Surface that backup even though the operation itself did not finish.
      recoveryBackup = await recoveryStore.loadRecoveryBackup?.() ?? recoveryBackup;
      updateBackupButton();
      await noteFailure(error);
      setStatus("Repair failed — retry or choose another recovery option", "error");
    } finally {
      setBusy(false);
    }
  }

  function downloadRecoveryBackup() {
    if (!recoveryBackup || !globalThis.URL?.createObjectURL) return;
    const blob = new Blob([JSON.stringify(recoveryBackup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const stamp = new Date(recoveryBackup.createdAt).toISOString().replace(/[:.]/g, "-");
    anchor.href = url;
    anchor.download = `proofly-recovery-${stamp}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function renderRepoChoices() {
    els.repoSelect.textContent = "";
    for (const repo of repos) {
      const full = repoValue(repo);
      if (!full) continue;
      const opt = document.createElement("option");
      opt.value = full;
      opt.textContent = repo.private === false ? `${full} (public)` : full;
      els.repoSelect.appendChild(opt);
    }
    els.repoWrap.hidden = repos.length <= 1;
  }

  async function connectTo(fullName) {
    const parts = splitFullName(fullName);
    if (!parts) return setStatus("Choose a repository.", "error");
    setBusy(true);
    try {
      const candidate = { ...parts, branch: "main", token };
      const client = makeClient(candidate);
      const validated = await client.validate();
      settings = await settingsStore.saveSyncSettings(candidate);
      renderSettings();
      const result = await runSync({ settings, client });
      await noteSuccess();
      const extra = expiryText(validated.expiration);
      setStatus(result?.skipped ? "Sync is configured." : `Connected and synced. ${extra}`.trim(), "ok");
    } catch (e) {
      await noteFailure(e);
      setStatus(settings ? "Connected — sync needs attention" : friendlyError(e), settings ? "warning" : "error");
    } finally {
      setBusy(false);
    }
  }

  async function validateToken(value) {
    const seq = ++validateSeq;
    token = value.trim();
    if (!token || token.startsWith("••")) return;
    setBusy(true);
    setStatus("Checking token…");
    try {
      repos = (await discoverRepos(token)).filter((r) => repoValue(r));
      if (seq !== validateSeq) return;
      if (!repos.length) {
        renderRepoChoices();
        setStatus("No repositories are visible to this token. Reopen the token page and select proofly-notes.", "error");
        return;
      }
      renderRepoChoices();
      if (repos.length === 1) {
        await connectTo(repoValue(repos[0]));
      } else {
        setStatus("Choose the repo this token can access.");
      }
    } catch (e) {
      if (seq === validateSeq) setStatus(friendlyError(e), "error");
    } finally {
      if (seq === validateSeq) setBusy(false);
    }
  }

  let tokenTimer = null;
  els.token.addEventListener("input", () => {
    clearTimeout(tokenTimer);
    tokenTimer = setTimeout(() => validateToken(els.token.value), 250);
  });

  els.repoSelect.addEventListener("change", () => connectTo(els.repoSelect.value));

  els.syncNow.addEventListener("click", async () => {
    if (!settings) return;
    setBusy(true);
    setStatus("Syncing…");
    try {
      await runSync({ settings });
      await noteSuccess();
      setStatus("Synced just now.", "ok");
    } catch (e) {
      await noteFailure(e);
      setStatus("Connected — sync needs attention", "warning");
    } finally {
      setBusy(false);
    }
  });

  els.disconnect.addEventListener("click", async () => {
    await settingsStore.clearSyncSettings();
    settings = null;
    repos = [];
    token = "";
    renderSettings();
    await noteSuccess();
    closeRecovery();
    setStatus("Disconnected. Local notes were kept.");
  });

  els.resolve?.addEventListener("click", openRecovery);
  els.closeRecovery?.addEventListener("click", closeRecovery);
  els.cancelRecovery?.addEventListener("click", showRecoveryChoices);
  els.repair?.addEventListener("click", () => performRecovery("merge"));
  els.useGitHub?.addEventListener("click", () => confirmDirectionalRecovery("remote"));
  els.useLocal?.addEventListener("click", () => confirmDirectionalRecovery("local"));
  els.confirmRecovery?.addEventListener("click", () => pendingRecovery && performRecovery(pendingRecovery));
  els.downloadBackup?.addEventListener("click", downloadRecoveryBackup);

  els.createRepo.href = CREATE_REPO_URL;
  els.createToken.href = CREATE_TOKEN_URL;

  renderSettings();
  const ready = Promise.all([
    settingsStore.loadSyncSettings(),
    diagnosticStore.loadSyncDiagnostic?.(),
    recoveryStore.loadRecoveryBackup?.(),
  ]).then(([loaded, diagnostic, backup]) => {
    settings = loaded;
    recoveryBackup = backup;
    renderSettings();
    renderDiagnostic(settings ? diagnostic : null);
    updateBackupButton();
    if (settings && diagnostic) setStatus("Connected — sync needs attention", "warning");
    else setStatus(settings ? "Sync is configured." : "Optional. Notes stay on this device until you connect GitHub.", settings ? "ok" : "muted");
  });

  settingsStore.onSyncSettingsChanged?.((next) => {
    settings = next;
    renderSettings();
  });

  return { ready };
}
