// lib/supersede.js — the shared request slot.

// Shared supersede slot for the panel's async requests — proofread, rewrite,
// and the editor's input handler all share ONE sequence number and ONE
// in-flight AbortController. Whoever begins (or invalidates) bumps the
// sequence and aborts the previous request: the seq check makes a stale
// render impossible, the abort actually stops the on-device inference,
// freeing the model for the newer request sooner.
export function createSupersedeSlot() {
  let seq = 0;        // guards against out-of-order async results
  let current = null; // AbortController for the in-flight request (superseded → abort)

  return {
    // Start a new request: supersede (abort) the in-flight one and hand the
    // caller its own id + signal.
    begin() {
      const id = ++seq;
      current?.abort();
      const abort = new AbortController();
      current = abort;
      return {
        id,
        signal: abort.signal,
        // Still the newest request? (false → a newer one superseded this)
        isCurrent: () => id === seq,
        // Wind-down (finally): clear the slot's controller unless a newer
        // request already took it over.
        release() { if (current === abort) current = null; },
      };
    },
    // Bump-and-abort without starting a request — the input handler's
    // "text changed: nothing in flight is valid any more".
    invalidate() {
      seq++;
      current?.abort();
    },
  };
}
