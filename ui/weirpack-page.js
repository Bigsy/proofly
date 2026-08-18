const displayName = (entry) => {
  const details = [entry.author, entry.version && `v${entry.version}`].filter(Boolean);
  return details.length ? `${entry.name} · ${details.join(" · ")}` : entry.name;
};

export function initWeirpackPage({
  els, store, validate, githubSettingsStore = {}, syncModeStore = {}, syncActions = {},
}) {
  let packs = [];
  let githubSettings = null;
  let syncMode = { githubEnabled: false };
  let busy = false;

  function report(message, isError = false) {
    els.status.textContent = message;
    els.status.classList.toggle("error", isError);
  }

  function draw() {
    els.list.textContent = "";
    els.empty.hidden = !!packs.length;
    for (const pack of packs) {
      const li = document.createElement("li");
      li.className = "weirpack";

      const details = document.createElement("div");
      details.className = "weirpack__details";
      const title = document.createElement("strong");
      title.textContent = displayName(pack);
      const meta = document.createElement("span");
      meta.textContent = pack.description || `${pack.size.toLocaleString()} bytes`;
      details.append(title, meta);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn--danger";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${pack.name}`);
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          packs = await store.removeWeirpack(pack.id);
          draw();
          await syncGitHubAfterChange(`Removed ${pack.name}.`);
        } catch (error) {
          remove.disabled = false;
          report(`Couldn't remove: ${error?.message || error}`, true);
        }
      });
      li.append(details, remove);
      els.list.append(li);
    }
  }

  function drawSyncMode() {
    if (!els.syncWrap || !els.syncToggle || !els.syncStatus) return;
    const connected = !!githubSettings;
    els.syncWrap.hidden = !connected && !syncMode.githubEnabled;
    els.syncToggle.checked = !!syncMode.githubEnabled;
    els.syncToggle.disabled = busy || !connected;
    if (syncMode.githubEnabled && !connected) {
      els.syncStatus.textContent = "GitHub is disconnected. Packs remain available on this browser but cannot sync.";
    } else if (syncMode.githubEnabled) {
      els.syncStatus.textContent = "On — larger packs are stored locally and synced through GitHub.";
    } else {
      els.syncStatus.textContent = "Off — packs use Chrome sync and its 5,600-byte per-pack limit.";
    }
  }

  async function syncGitHubAfterChange(successMessage) {
    if (!syncMode.githubEnabled || !githubSettings || !syncActions.sync) {
      report(successMessage);
      return;
    }
    report(`${successMessage} Syncing with GitHub…`);
    try {
      await syncActions.sync({ settings: githubSettings });
      report(successMessage);
    } catch (error) {
      report(`${successMessage} Saved here, but GitHub sync failed: ${error?.message || error}`, true);
    }
  }

  async function importSelected() {
    const [file] = els.file.files ?? [];
    els.file.value = "";
    if (!file) return;
    const limit = await (store.maxWeirpackFileBytes?.() ?? Number.POSITIVE_INFINITY);
    if (file.size > limit) {
      report(
        `That pack is too large to sync (${file.size.toLocaleString()} bytes; `
          + `maximum ${limit.toLocaleString()}).`,
        true,
      );
      return;
    }

    els.importBtn.disabled = true;
    report(`Checking ${file.name} with Harper…`);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const manifest = await validate(bytes);
      const saved = await store.saveWeirpack({ name: file.name, bytes, manifest });
      packs = [...packs.filter((pack) => pack.id !== saved.id), saved];
      draw();
      await syncGitHubAfterChange(`Imported ${file.name}.`);
    } catch (error) {
      report(`Couldn't import: ${error?.message || error}`, true);
    } finally {
      els.importBtn.disabled = false;
    }
  }

  els.importBtn.addEventListener("click", () => els.file.click());
  els.file.addEventListener("change", importSelected);
  store.onWeirpacksChanged((next) => {
    packs = next;
    draw();
  });

  els.syncToggle?.addEventListener("change", async () => {
    const wanted = els.syncToggle.checked;
    busy = true;
    drawSyncMode();
    report(wanted ? "Moving Weirpacks to GitHub…" : "Moving Weirpacks back to Chrome sync…");
    try {
      await (wanted ? syncActions.enable?.({ settings: githubSettings }) : syncActions.disable?.());
      syncMode = { ...syncMode, githubEnabled: wanted, hasUsedGitHub: true };
      packs = await store.loadWeirpackIndex();
      draw();
      report(wanted ? "Weirpacks are now synced with GitHub." : "Weirpacks are now synced with Chrome.");
    } catch (error) {
      syncMode = await syncModeStore.loadWeirpackSyncSettings?.() ?? syncMode;
      els.syncToggle.checked = !!syncMode.githubEnabled;
      report(`Couldn't change Weirpack sync: ${error?.message || error}`, true);
    } finally {
      busy = false;
      drawSyncMode();
    }
  });

  draw();
  const ready = Promise.all([
    store.loadWeirpackIndex(),
    githubSettingsStore.loadSyncSettings?.(),
    syncModeStore.loadWeirpackSyncSettings?.(),
  ]).then(([loaded, settings, mode]) => {
    packs = loaded;
    githubSettings = settings ?? null;
    syncMode = mode ?? syncMode;
    draw();
    drawSyncMode();
  });
  githubSettingsStore.onSyncSettingsChanged?.((settings) => {
    githubSettings = settings;
    drawSyncMode();
  });
  syncModeStore.onWeirpackSyncSettingsChanged?.(async (mode) => {
    syncMode = mode;
    packs = await store.loadWeirpackIndex();
    draw();
    drawSyncMode();
  });
  return { ready };
}
