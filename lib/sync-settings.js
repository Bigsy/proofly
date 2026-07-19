// lib/sync-settings.js — synced GitHub notes-sync settings.
// Stored as one small chrome.storage.sync item so a second signed-in Chrome can
// start syncing without another setup pass. The token is user-provided and
// scoped to one private repo; callers surface that trade-off in UI copy.

export const SYNC_SETTINGS_KEY = "notesSyncSettings";

const store = () => globalThis.chrome?.storage?.sync ?? null;

export function normalizeSyncSettings(value) {
  if (!value || typeof value !== "object") return null;
  const token = typeof value.token === "string" ? value.token.trim() : "";
  const owner = typeof value.owner === "string" ? value.owner.trim() : "";
  const repo = typeof value.repo === "string" ? value.repo.trim() : "";
  const branch = typeof value.branch === "string" && value.branch.trim()
    ? value.branch.trim()
    : "main";
  if (!token || !owner || !repo) return null;
  return { owner, repo, branch, token };
}

export async function loadSyncSettings() {
  const s = store();
  if (!s) return null;
  try {
    const data = await s.get(SYNC_SETTINGS_KEY);
    return normalizeSyncSettings(data?.[SYNC_SETTINGS_KEY]);
  } catch {
    return null;
  }
}

export async function saveSyncSettings(settings) {
  const s = store();
  if (!s) return null;
  const normalized = normalizeSyncSettings(settings);
  if (!normalized) throw new Error("Sync settings need a token, owner, and repo.");
  await s.set({ [SYNC_SETTINGS_KEY]: normalized });
  return normalized;
}

export async function clearSyncSettings() {
  await store()?.remove(SYNC_SETTINGS_KEY);
}

export function onSyncSettingsChanged(callback) {
  const onChanged = globalThis.chrome?.storage?.onChanged;
  if (!onChanged?.addListener) return () => {};
  const listener = (changes, area) => {
    if (area !== "sync" || !changes?.[SYNC_SETTINGS_KEY]) return;
    callback(normalizeSyncSettings(changes[SYNC_SETTINGS_KEY].newValue));
  };
  onChanged.addListener(listener);
  return () => onChanged.removeListener(listener);
}
