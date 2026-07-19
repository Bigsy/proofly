# Fixtures — recorded Proofreader results

Each file pairs the editor `input` with the `result` that `proofread()` returned
for it. The mock (`test/helpers/mock-proofreader.js`) replays `result`; tests
assert what *our* code does with it.

Two kinds, distinguished by `_provenance` (and the `.synthetic` suffix):

- **Recorded** (`basic-grammar-spelling`, `insertion`, `clean`) — captured from
  the live Beta build (Chrome 150.0.7871.4, 2026-06-04) via the MCP dev loop
  (see the main README): `JSON.stringify` of the real result, not transcribed.
  **Don't hand-edit these** — re-record via the MCP loop instead. If a future build
  changes shapes, add new fixtures alongside; don't rewrite history.
- **Synthetic** (`*.synthetic.json`) — hand-constructed for edge cases the
  model won't reliably emit (overlapping spans, missing `types`).

Notes from the recorded build: `types` come through lowercase (`grammar`,
`spelling`, `punctuation`); `explanation` is **absent** even with
`includeCorrectionExplanations: true` — that option isn't honoured by every
build, which is exactly why the no-types degradation path needs testing.
