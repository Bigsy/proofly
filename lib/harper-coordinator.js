// lib/harper-coordinator.js — surface-neutral request/supersession logic for
// Proofly's extension-owned Harper service.

function defaultSendMessage(message) {
  return globalThis.chrome.runtime.sendMessage(message);
}

function validScopeId(scopeId) {
  return typeof scopeId === "string" && scopeId.trim() ? scopeId : null;
}

// A coordinator belongs to one independent editor/field. `capture()` acquires
// that scope's latest-only slot synchronously and returns a batch: the panel
// uses one lint per batch, while a long in-page document may lint many windows
// through the same batch without those windows superseding each other locally.
export function createHarperCoordinator({
  scopeId,
  sendMessage = defaultSendMessage,
  onStatus = () => {},
} = {}) {
  const scope = validScopeId(scopeId);
  if (!scope) throw new TypeError("Harper coordinator requires a stable scopeId");
  if (typeof sendMessage !== "function") throw new TypeError("sendMessage must be a function");

  let generation = 0;
  let requestSequence = 0;

  function invalidate() {
    generation += 1;
  }

  function capture({ isSnapshotCurrent = () => true } = {}) {
    const capturedGeneration = ++generation;
    const current = () => capturedGeneration === generation && isSnapshotCurrent();

    async function lint(text) {
      if (typeof text !== "string") throw new TypeError("Harper lint text must be a string");
      if (!current()) return null;

      onStatus({ state: "proofreading" });
      // A stale response normally means a newer request in this scope, in
      // which case `current()` prevents a retry. One retry covers a service
      // lifecycle race where the captured editor snapshot is still current.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const requestId = `${scope}:${++requestSequence}`;
        let response;
        try {
          response = await sendMessage({ type: "harper:lint", scopeId: scope, requestId, text });
        } catch (error) {
          if (current()) onStatus({ state: "error", error });
          return null;
        }
        if (!current()) return null;
        if (response?.type === "harper:stale") continue;
        if (response?.type === "harper:result" && response.requestId === requestId
          && Array.isArray(response.corrections)) {
          onStatus({ state: "ready" });
          return response.corrections;
        }
        const error = response?.type === "harper:error"
          ? response.error
          : { code: "invalid_response", message: "Invalid response from Harper" };
        onStatus({ state: "error", error });
        return null;
      }
      if (current()) {
        onStatus({
          state: "error",
          error: { code: "stale_response", message: "Harper request remained stale" },
        });
      }
      return null;
    }

    return { lint, isCurrent: current };
  }

  return { capture, invalidate };
}
