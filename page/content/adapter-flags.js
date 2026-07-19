import {
  PAGE_ADAPTER_FLAGS_CHANGED, PAGE_STORAGE_GET, requestPageStorage,
  usesPageStorageBroker, watchPageStorage,
} from "../../lib/storage-broker.js";

export const EDITOR_ADAPTER_FLAGS_KEY = "editorAdapterFlags";
export const EDITOR_ADAPTER_FLAGS_VERSION = 1;

// Defaults match shipped behavior: v0.1.2 went out with every adapter live
// (nothing enforced the old dark-launch defaults), so defaulting anything off
// here would be a silent regression. The flags are an enforced kill switch —
// flip one off in chrome.storage.local to disable an adapter at runtime.
export const DEFAULT_EDITOR_ADAPTER_FLAGS = Object.freeze({
  schemaVersion: EDITOR_ADAPTER_FLAGS_VERSION,
  enabled: true,
  debug: false,
  adapters: Object.freeze({
    form: true,
    contenteditable: true,
    prosemirror: true,
    "google-docs": true,
    ckeditor5: true,
    ckeditor4: true,
    quill: true,
    tinymce: true,
    lexical: true,
    slate: true,
    draftjs: true,
    trix: true,
    codemirror: true,
  }),
});

export function normalizeEditorAdapterFlags(value) {
  const raw = value && typeof value === "object" ? value : {};
  const rawAdapters = raw.adapters && typeof raw.adapters === "object" ? raw.adapters : {};
  const adapters = {};
  for (const [id, defaultValue] of Object.entries(DEFAULT_EDITOR_ADAPTER_FLAGS.adapters)) {
    adapters[id] = typeof rawAdapters[id] === "boolean" ? rawAdapters[id] : defaultValue;
  }
  return {
    schemaVersion: EDITOR_ADAPTER_FLAGS_VERSION,
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_EDITOR_ADAPTER_FLAGS.enabled,
    debug: typeof raw.debug === "boolean" ? raw.debug : DEFAULT_EDITOR_ADAPTER_FLAGS.debug,
    adapters,
  };
}

export function adapterEnabled(flags, id) {
  return !!flags?.enabled && !!flags?.adapters?.[id];
}

export async function loadEditorAdapterFlags({ storage = globalThis.chrome?.storage?.local } = {}) {
  if (usesPageStorageBroker()) {
    try {
      const response = await requestPageStorage({ type: PAGE_STORAGE_GET });
      return normalizeEditorAdapterFlags(response.editorAdapterFlags);
    } catch {
      return normalizeEditorAdapterFlags(null);
    }
  }
  try {
    const data = await storage?.get?.(EDITOR_ADAPTER_FLAGS_KEY);
    return normalizeEditorAdapterFlags(data?.[EDITOR_ADAPTER_FLAGS_KEY]);
  } catch {
    return normalizeEditorAdapterFlags(null);
  }
}

export function watchEditorAdapterFlags(onChange, { chromeApi = globalThis.chrome } = {}) {
  if (usesPageStorageBroker({ chromeApi })) {
    return watchPageStorage(PAGE_ADAPTER_FLAGS_CHANGED, (message) => {
      onChange(normalizeEditorAdapterFlags(message.editorAdapterFlags));
    }, { chromeApi });
  }
  const storage = chromeApi?.storage;
  const listener = (changes, area) => {
    if (area !== "local" || !changes?.[EDITOR_ADAPTER_FLAGS_KEY]) return;
    onChange(normalizeEditorAdapterFlags(changes[EDITOR_ADAPTER_FLAGS_KEY].newValue));
  };
  storage?.onChanged?.addListener?.(listener);
  return () => storage?.onChanged?.removeListener?.(listener);
}
