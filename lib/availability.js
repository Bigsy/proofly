// lib/availability.js — availability() with the retry-bare fallback.
//
// Both built-in AI APIs (Proofreader, Rewriter) take an options bag in
// availability(), but not every Chrome build accepts every option — a build
// that rejects the options gets retried bare rather than treated as
// unavailable. Throws only if BOTH calls reject; callers decide what that
// means (error status for the required Proofreader, stay-hidden for the
// optional Rewriter).
export async function availabilityWithFallback(api, opts) {
  try {
    return await api.availability(opts);
  } catch {
    return await api.availability();
  }
}
