// Shared content-script limits. Keep size policy in one place so future
// browser evidence can change the value without creating a second offset space.

export const MAX_EDITOR_CODE_UNITS = 4_000;
export const MAX_EDITOR_CODE_UNITS_PROVENANCE =
  "Benchmarked 2026-07-01 on Chrome Beta 150 (macOS, 10-core/32GB, Gemini Nano on-device). "
  + "Hard API limit: proofread() throws QuotaExceededError ('The input is too large') at 64k chars "
  + "and the service intermittently cancels (AbortError) from ~16k up. Quality limit binds first: "
  + "on error-dense prose (~26 errors/1000 chars) recall is ~100% at 1-2k, 94-99% at 4k, 76% at 6k, "
  + "56% at 8k, 22% at 16k — the model plateaus near ~120 corrections per call, and sparse planted "
  + "errors confirm it silently under-reports on large inputs rather than failing. Latency at 4k is "
  + "~4-14s per call (output-dominated), which lint-on-pause plus incremental window rendering absorbs. "
  + "4k keeps recall >=94% while staying far from the cancellation zone.";
