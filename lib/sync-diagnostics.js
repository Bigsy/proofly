// Last notes-sync outcome for explaining background failures on the Settings
// page. Keep this local to the device and deliberately exclude request data,
// response bodies, repository settings, and credentials.

export const SYNC_DIAGNOSTIC_KEY = "notesSyncDiagnostic";

const store = () => globalThis.chrome?.storage?.local ?? null;
const sanitizeMessage = (message) => Array.from(message, (char) => {
  const codePoint = char.codePointAt(0);
  return codePoint <= 31 || codePoint === 127 ? " " : char;
}).join("").trim().slice(0, 300);

export function normalizeSyncDiagnostic(value) {
  if (!value || typeof value !== "object") return null;
  const message = typeof value.message === "string"
    ? sanitizeMessage(value.message)
    : "";
  const at = Number(value.at);
  const status = Number(value.status);
  if (!message || !Number.isFinite(at)) return null;
  return {
    message,
    at,
    ...(value.scope === "weirpacks" ? { scope: "weirpacks" } : {}),
    ...(Number.isInteger(status) && status > 0 ? { status } : {}),
  };
}

export async function recordSyncError(error, at = Date.now()) {
  const diagnostic = normalizeSyncDiagnostic({
    message: error?.message || String(error || "Unknown sync error"),
    status: error?.status,
    scope: error?.syncScope,
    at,
  });
  if (diagnostic) await store()?.set({ [SYNC_DIAGNOSTIC_KEY]: diagnostic });
  return diagnostic;
}

export async function loadSyncDiagnostic() {
  const data = await store()?.get(SYNC_DIAGNOSTIC_KEY);
  return normalizeSyncDiagnostic(data?.[SYNC_DIAGNOSTIC_KEY]);
}

export async function clearSyncDiagnostic() {
  await store()?.remove(SYNC_DIAGNOSTIC_KEY);
}
