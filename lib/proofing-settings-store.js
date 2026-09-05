import {
  DEFAULT_PROOFING_SETTINGS, parseProofingSettings, PROOFING_SETTINGS_KEY,
} from "./proofing-settings.js";
import {
  PAGE_PROOFING_SETTINGS_CHANGED, PAGE_RULE_DISABLE, PAGE_STORAGE_GET, requestPageStorage,
  usesPageStorageBroker, watchPageStorage,
} from "./storage-broker.js";

const store = () => globalThis.chrome?.storage?.sync ?? null;

export async function loadProofingSettings() {
  if (usesPageStorageBroker()) {
    try {
      const response = await requestPageStorage({ type: PAGE_STORAGE_GET });
      return parseProofingSettings(response.proofingSettings);
    } catch {
      return { ...DEFAULT_PROOFING_SETTINGS };
    }
  }
  const sync = store();
  if (!sync) return { ...DEFAULT_PROOFING_SETTINGS };
  try {
    const data = await sync.get(PROOFING_SETTINGS_KEY);
    return parseProofingSettings(data?.[PROOFING_SETTINGS_KEY]);
  } catch {
    return { ...DEFAULT_PROOFING_SETTINGS };
  }
}

export async function saveProofingSettings(value) {
  const sync = store();
  const data = await sync?.get(PROOFING_SETTINGS_KEY);
  const settings = parseProofingSettings({ ...data?.[PROOFING_SETTINGS_KEY], ...value });
  await store()?.set({ [PROOFING_SETTINGS_KEY]: settings });
  return settings;
}

export function onProofingSettingsChanged(callback) {
  if (usesPageStorageBroker()) {
    return watchPageStorage(PAGE_PROOFING_SETTINGS_CHANGED, (message) => {
      callback(parseProofingSettings(message.proofingSettings));
    });
  }
  const changed = globalThis.chrome?.storage?.onChanged;
  if (!changed?.addListener) return () => {};
  const listener = (changes, area) => {
    if (area === "sync" && changes?.[PROOFING_SETTINGS_KEY]) {
      callback(parseProofingSettings(changes[PROOFING_SETTINGS_KEY].newValue));
    }
  };
  changed.addListener(listener);
  return () => changed.removeListener(listener);
}

// Both extension and content contexts use the same serialized, narrow mutation.
export async function disableHarperRule(rule) {
  await requestPageStorage({ type: PAGE_RULE_DISABLE, rule });
}
