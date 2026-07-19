// Safe storage seam for code running as a content script. Chrome exposes
// storage.local and storage.sync to content scripts by default, but Proofly
// keeps both areas restricted to trusted extension contexts because they hold
// notes and the optional GitHub token. Content scripts ask the service worker
// only for the non-sensitive settings they need.

export const PAGE_STORAGE_GET = "proofly:page-storage:get";
export const PAGE_DICTIONARY_UPDATE = "proofly:page-storage:dictionary-update";
export const PAGE_DICTIONARY_CHANGED = "proofly:page-storage:dictionary-changed";
export const PAGE_PROOFING_SETTINGS_CHANGED = "proofly:page-storage:proofing-settings-changed";
export const PAGE_ADAPTER_FLAGS_CHANGED = "proofly:page-storage:adapter-flags-changed";

export function usesPageStorageBroker({
  chromeApi = globalThis.chrome,
  location = globalThis.location,
} = {}) {
  return !!chromeApi?.runtime?.id && location?.protocol !== "chrome-extension:";
}

export async function requestPageStorage(message, { chromeApi = globalThis.chrome } = {}) {
  const response = await chromeApi?.runtime?.sendMessage?.(message);
  if (response?.ok === true) return response;
  throw new Error(response?.error || "Proofly storage request failed");
}

export function watchPageStorage(type, callback, { chromeApi = globalThis.chrome } = {}) {
  const onMessage = chromeApi?.runtime?.onMessage;
  if (!onMessage?.addListener) return () => {};
  const listener = (message) => {
    if (message?.type === type) callback(message);
  };
  onMessage.addListener(listener);
  return () => onMessage.removeListener?.(listener);
}
