// The transport choice is tiny and follows the GitHub credentials between
// signed-in Chromes. Pack bodies never live in this item.

export const WEIRPACK_SYNC_SETTINGS_KEY = "weirpackSyncSettings";

const store = () => globalThis.chrome?.storage?.sync ?? null;

export function normalizeWeirpackSyncSettings(value) {
  return {
    githubEnabled: value?.githubEnabled === true,
    hasUsedGitHub: value?.hasUsedGitHub === true || value?.githubEnabled === true,
  };
}

export async function loadWeirpackSyncSettings() {
  const sync = store();
  if (!sync) return normalizeWeirpackSyncSettings();
  try {
    const data = await sync.get(WEIRPACK_SYNC_SETTINGS_KEY);
    return normalizeWeirpackSyncSettings(data?.[WEIRPACK_SYNC_SETTINGS_KEY]);
  } catch {
    return normalizeWeirpackSyncSettings();
  }
}

export async function saveWeirpackSyncSettings(value) {
  const settings = normalizeWeirpackSyncSettings(value);
  await store()?.set({ [WEIRPACK_SYNC_SETTINGS_KEY]: settings });
  return settings;
}

export function onWeirpackSyncSettingsChanged(callback) {
  const changed = globalThis.chrome?.storage?.onChanged;
  if (!changed?.addListener) return () => {};
  const listener = (changes, area) => {
    if (area !== "sync" || !changes?.[WEIRPACK_SYNC_SETTINGS_KEY]) return;
    callback(normalizeWeirpackSyncSettings(changes[WEIRPACK_SYNC_SETTINGS_KEY].newValue));
  };
  changed.addListener(listener);
  return () => changed.removeListener(listener);
}
