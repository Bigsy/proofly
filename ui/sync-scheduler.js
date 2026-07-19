// ui/sync-scheduler.js — the debounced notes-sync loop and its status line.
// Deps-injected like ui/render.js/ui/library.js: no chrome.*, no imports back
// into the entry. The scheduler decides WHEN to sync and how to surface the
// outcome; what a sync means for the open view comes back through the
// injected hooks (the notes router owns those).
//
// The dirty-editor rule lives here: the currently open note is never pulled
// over unsaved editor text (skipPullIds) — the next scheduled sync resolves
// it after the local save wins the debounce.

// Auth failures get their own message — "check Settings" is actionable for a
// bad/expired token in a way it isn't for a flaky network, and 401/403 is the
// one class the user can fix from Settings. Everything else stays coarse.
export function syncErrorMessage(e) {
  if (e?.status === 401 || e?.status === 403) {
    return "Sync error — GitHub token rejected (update it in Settings)";
  }
  if (e?.status === 404) return "Sync error — repo not found (check Settings)";
  return "Sync error — check Settings";
}

export function initSyncScheduler({
  statusEl,          // the library header's status line (may be null)
  runSync,           // lib/notes-sync runSync
  debounceMs = 3000,
  getOpenNote,       // () => { id, persisted } | null — null in the library
  isEditorDirty,     // () => editor text !== last saved body
  isEditorBlank,     // () => editor holds only whitespace
  isLibraryVisible,  // () => the library view is showing
  refreshList,       // async () => re-render the library card list
  openLibrary,       // async () => navigate to the (re-rendered) library
  reloadOpenNote,    // async (id) => refresh the editor from storage
  onSyncError = () => {},
  onSyncSuccess = () => {},
}) {
  let timer = null;

  function setStatus(text, isError = false) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.hidden = !text;
    statusEl.classList.toggle("library__sync--error", isError);
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => syncNow(), debounceMs);
  }

  async function syncNow() {
    clearTimeout(timer);
    const openId = getOpenNote()?.id;
    const skipPullIds = isEditorDirty() && openId ? [openId] : [];
    try {
      const result = await runSync({ skipPullIds });
      if (result.skipped) return;
      await onSyncSuccess();
      setStatus("Synced just now");
      if (!result.changedLocal) return;

      if (isLibraryVisible()) {
        await refreshList();
        return;
      }

      // A blank never-saved doc is just a parked editor — a sync that brought
      // notes in should land the user in the library, not hide them.
      const open = getOpenNote();
      if (open && !open.persisted && isEditorBlank() && !isEditorDirty()) {
        await openLibrary();
        return;
      }

      if (openId && result.pulledIds?.includes(openId) && !isEditorDirty()) {
        await reloadOpenNote(openId);
      }
    } catch (e) {
      try { await onSyncError(e); } catch { /* diagnostics must not mask sync */ }
      setStatus(syncErrorMessage(e), true);
    }
  }

  return { schedule, syncNow, setStatus };
}
