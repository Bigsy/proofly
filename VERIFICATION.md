# Harper rollout verification

Pinned engine: Harper 3.0.0. Last updated: 2026-10-27.

## Automated release gates

- `npm test`: canonical normalization, runtime protocol, one-worker creation
  mutex, complete configuration revisions, rule reapplication, stale results,
  both UI surfaces, rewrite isolation, and the reviewed real-Harper corpus.
- `npm run test:browser`: extension fixture coverage for textareas,
  contenteditable, frames, and supported rich-editor adapters.
- `npm run verify:harper`: 20 MiB installed, 9 MiB compressed, 1.5 s cold, and
  100 ms warm-4k budgets.
- `npm run lint` and `npm run pack:store`: source hygiene, pinned asset hashes,
  third-party notices, and upload archive contents.

The reviewed corpus is `test/fixtures/harper-reviewed-corpus.json`. It locks
policy outcomes rather than Harper's diagnostic prose, and explicitly records
the expected miss `I seen two loafs yesterday`.

The pinned corpus also locks Harper's advice contract: a 40-word sentence is
clean, a 41-word sentence produces a whole-span `LongSentences`/Readability
lint with no suggestion, and the reported 49-word reproducer is reduced to that
single diagnostic by normal overlap removal. With Proofly's managed
`LongSentences: false` override, the same text exposes nine actionable fixes.
Representative no-suggestion Grammar, Miscellaneous, Typo, Usage, and
Readability cases are covered. Quote spacing now provides two applicable
alternatives, and the corpus checks their normalized replacements and offsets.

## Advice and Long Sentences release checks

1. In the side panel, paste the reported 49-word sentence. Confirm there is no
   whole-sentence Readability underline and that the capitalization, spelling,
   and `some how` fixes are available.
2. Exercise `The city is famous its beaches.` and
   `I would argue that this is correct.` Confirm each advice item shows a
   friendly category and full explanation without a struck-through source or
   Apply action. For `She whispered "hurry"and left.`, confirm quote spacing
   offers applicable space-before/space-after alternatives.
3. Repeat on an opted-in page. Confirm **Dismiss for now** removes only that
   occurrence's underline without editing the text, while outside click and
   Escape remove only the popup and active tint. Type the same issue elsewhere
   and confirm its new occurrence is underlined.
4. Confirm advice-only results disable Apply all. For a mixed result, confirm
   the summary and Apply-all toast count only actual corrections.
5. Switch English dialects, reload the extension, and recreate the offscreen
   document. Recheck the reported sentence and a custom dictionary word: rule
   overrides and imported words must both survive linter recreation.

Implementation smoke result on 2026-07-16, using the dedicated Chrome Beta 151
profile and the packaged Harper runtime:

- The 241-unit reproducer showed nine actionable corrections and no
  whole-sentence Readability item.
- Formatting, missing-preposition, and hedging advice each showed the expected
  friendly category and full explanation with no fake deletion or Apply.
  Formatting advice was opened as a popup with its source text unchanged.
- After importing `senstence` into the custom dictionary and switching from
  British to American, the reproducer showed eight corrections: the dictionary
  word stayed suppressed and `LongSentences` stayed disabled. Reloading the
  extension recreated the offscreen service with the same result and revision.
- The selected extension page and active service worker reported no console
  warnings, errors, or issues. The temporary smoke extension was uninstalled
  afterward.
- The final GitHub opt-in was not granted: browser safety review requires
  explicit user authorization before giving the persistent test profile access
  to `https://github.com/*`. The complete in-page path instead passed all 22
  Chrome fixture tests; a live GitHub permission smoke remains the only manual
  follow-up.

## Measured baseline

On the development machine, `npm run verify:harper` measured 15.36 MiB
installed, 7.70 MiB compressed, 625 ms cold setup, and 25 ms for a warm
4,000-code-unit lint. The dedicated Chrome Beta 151 smoke run measured exactly
one offscreen document across three opted-in tabs. After unrelated tabs were
closed and the process tree settled, the dedicated profile used 1,827,632 KiB
(1,784.8 MiB) RSS across ten Chrome processes; the extension renderer accounted
for 417,696 KiB (407.9 MiB). Release budgets are 2.25 GiB for the full dedicated
Chrome tree and 512 MiB for the extension renderer under this three-tab smoke
load.

## Chrome Beta release result

Completed on Chrome Beta 151.0.7922.19 using the dedicated profile:

1. With Chrome AI unavailable, verify side-panel and opted-in-page Harper lint.
2. In British mode, verify `favourite` is clean and `colur` offers `colour`.
3. For `wierd`, select and apply the non-primary `wired` suggestion.
4. Verify punctuation and supported grammar while confirming no Chrome
   Proofreader session is created.
5. Trigger Rewrite explicitly and confirm Chrome AI starts only then.
6. Inspect console output, CSP/asset failures, exactly one offscreen worker,
   and behavior after extension reload.
7. Measure clean Chrome process memory with several opted-in tabs and record a
   numeric release budget here.
8. Re-capture store screenshots showing the final dialect and alternative-
   suggestion UI.

- A pre-page Chrome `Proofreader` trap recorded zero availability probes and
  zero sessions while real Harper returned corrections. An explicit Rewrite
  recorded exactly one `Rewriter.create()` call and produced rewritten text.
- British mode preserved `favourite`, proposed `colour` for `colur`, exposed
  all three `wierd` alternatives, preserved radio focus, and applied `wired`.
- Both an opted-in textarea and contenteditable produced three squiggles; the
  textarea applied the non-primary suggestion. Three opted-in tabs shared one
  offscreen document.
- A post-reload lint recreated one offscreen document and completed normally.
  The pre-reload service-worker target remained visible briefly to CDP but was
  non-responsive; the new worker was active.
- The selected extension page reported no console warnings, errors, or issues;
  all 24 observed extension resource requests returned HTTP 200.
- `npm run test:browser` passed all 21 Chrome Beta fixture tests in a clean
  temporary profile.
- Store editor, alternative-suggestion, and library screenshots were recaptured
  from the final UI and rebuilt at 1280×800. Store copy now names Harper rather
  than Chrome AI as the proofing engine.

## Rule settings verification — 2026-09-05

- `npm test`: 723 tests passed; focused rule UI tests also passed after the
  final singular/plural copy adjustment. Lint and `git diff --check` passed.
- Harper runtime budget verification and vendor hash checks passed.
- Browser fixtures in a fresh isolated Chrome Beta profile: 21/22 passed in
  the full run. DraftJS's cursor assertion returned offset 2 instead of 5;
  that test passed in isolated reruns on both unchanged HEAD and this change.
  Treat the full-run failure as an observed intermittent failure, not a clean
  full-suite pass. Sandbox browser launches aborted; the suite ran outside
  the sandbox without using the dedicated MCP profile.
- Real Chrome Beta smoke test used a temporary extension copy because the
  connected MCP server rejected the workspace install path. The copy was
  uninstalled before deletion. Settings displayed 823 runtime rules, search
  narrowed to Avoid Curses, and the page had no console warnings/errors.
- With Avoid Curses enabled, `He is shitting.` produced the screenshot's exact
  censoring/euphemism alternatives. Returning the control to Default removed
  that diagnostic; `sentnce` still produced `sentence`. Changing dialect to
  British preserved the saved rule choice, and reset preserved the dialect.
- Rule metadata uses the complete default catalogue: Harper's active
  `getLintConfig()` becomes sparse after applying overrides. Structured
  config supplies grouping, not resolved default states.

## Disable a rule from a suggestion — 2026-09-05

- `npm test`: 729 passed. New coverage verifies rule identity, normal dedup
  equivalence across the reviewed corpus, broker validation and serialized
  mutations, both popup actions, retry after a failed save, and closing a
  stale side-panel popup when preferences change.
- Browser fixtures: 21/22 passed; the previously observed DraftJS cursor
  assertion failed in the full run and passed in its isolated rerun.
- Lint, vendor hashes, and the updated performance gate passed. The gate now
  measures organizedLints, matching the service path: cold setup 537 ms and
  warm 4,000-character lint 23 ms in this run.
- Chrome Beta with real packaged Harper: the side-panel popup and the in-page
  popup on a disposable textarea both showed Rule: Avoid Curses. Turning the
  rule off saved AvoidCurses: false while retaining the British dialect,
  preserved the complete input, and left the sentnce spelling correction.
  The in-page popup closed and its underline count dropped from two to one.
- The temporary extension copy was used because the connected MCP server's
  workspace-root restriction rejects direct installation. It is removed after
  the smoke test; reload the actual development extension to use these changes.

- Final side-panel retest confirmed the stale popup closes, the text stays
  unchanged, and only the spelling correction remains. The in-page console
  was clean; the side panel logged an optional Chrome AI text-session service
  warning, which did not affect packaged Harper proofreading.

## Harper 2.10.0 upgrade — 2026-09-10

- Reviewed upstream v2.10.0 release notes and upgraded the exact npm pin from
  2.7.0, replacing the vendored JS/WASM assets and SHA-256 hashes. The packaged
  Apache-2.0 licence now attributes Automattic Inc.; notices match it.
- All 733 tests passed, including the unchanged reviewed 2.7.0 corpus; its
  original provenance is retained. All 24 browser regression tests passed
  outside the sandbox with temporary profiles (sandboxed Chrome aborted).
- Lint, vendor hash validation, store packaging, and diff whitespace checks
  passed. Runtime: 15.66 MiB installed, 7.82 MiB compressed, 585 ms cold setup,
  28 ms warm 4,000-character lint. An initial measurement alongside the test
  suites exceeded timing budgets; the isolated measurement above passed.

## Harper 2.13.0 upgrade — 2026-10-16

- Reviewed upstream [v2.11.0](https://github.com/Automattic/harper/releases/tag/v2.11.0),
  [v2.12.0](https://github.com/Automattic/harper/releases/tag/v2.12.0), and
  [v2.13.0](https://github.com/Automattic/harper/releases/tag/v2.13.0) releases.
  Updated the exact npm pin from 2.10.0 and refreshed the packaged JS/WASM
  through the vendor script with new SHA-256 hashes. The licence is unchanged.
- All 754 unit tests passed, including the unchanged reviewed 2.7.0 fixture.
  Updated the separate quote-spacing diagnostic expectation: upstream now
  supplies space-before/space-after replacements instead of advice only.
- Browser fixtures: 24/25 passed in the full run. The previously documented
  DraftJS selection assertion returned offset 2 instead of 5 and passed in
  isolation. Chrome aborted inside the sandbox; both completed runs used fresh
  temporary profiles outside it.
- Live Chrome Beta 157 smoke verified the real offscreen WorkerLinter path:
  `sentnce` offered `sentence`, quote spacing returned both alternatives, and
  the new `BareWithMe` rule changed `Please bare with me.` to
  `Please bear with me.`. The side panel reported Ready. Its console contained
  one optional Chrome AI text-session warning; Harper proofreading succeeded.
- Lint, vendor hashes, store packaging, and diff whitespace checks passed.
  Runtime: 19.56 MiB installed, 8.05 MiB compressed, 578 ms cold setup, and
  24 ms warm 4,000-character lint, all within the existing budgets.
- `make check-harper-update` confirmed the pin matches npm's live latest tag.

## Harper 3.0.0 upgrade — 2026-10-27

- Reviewed the [v3.0.0 release](https://github.com/Automattic/harper/releases/tag/v3.0.0)
  and its breaking [core dictionary change, #2630](https://github.com/Automattic/harper/pull/2630).
  The core replaces `WordId` with `CanonicalWordId` and `CaseFoldedWordId`;
  case-insensitive dictionary queries can return multiple orthographic variants,
  while exact-case queries identify a specific entry. This fixes capitalization
  collisions and words incorrectly flagged despite being in the dictionary.
  The breaking change is in the core API: the npm package's public TypeScript
  declarations, shipped JavaScript, and licence are byte-identical to 2.13.0.
  Proofly's JavaScript API calls need no v3 migration.
- Updated the exact npm pin and lockfile, refreshed the WASM through the existing
  vendor script with its new SHA-256 hash, and updated the user/store notices.
  The original reviewed 2.7.0 corpus remains unchanged and passes.
- Added real-runtime coverage for lower-case custom dictionary entries used in
  mixed casing, word removal, and Weirpacks across dialect changes and removal.
  This exposed an existing integration issue also reproducible on 2.13.0:
  `importWords()` discards loaded pack rules, and `setLintConfig()` replaces the
  active config. The service now imports words before loading packs and merges
  managed rule changes into the current config, preserving pack enablement.
- All 756 unit tests and all 25 browser tests passed on the final build. The
  first browser run hit the previously documented DraftJS cursor assertion;
  it passed in isolation and in the final full run. Chrome aborted inside the
  sandbox; completed browser runs used fresh temporary profiles outside it.
- Live Chrome Beta 157 verified the real offscreen WorkerLinter before and
  after extension reload: `sentnce` suggested `sentence`, the new `FuzzyLogic`
  rule suggested `fuzzy logic`, and `Pr`/`PR` remained accepted. A disposable
  worker verified custom words, managed overrides, pack validation, dialect
  switching, and removal without changing stored user settings. Status was
  Ready. The existing optional Chrome AI service warning remained; Harper also
  probed the unbundled slim WASM before successfully loading the packaged full
  WASM. No CSP failure blocked proofreading.
- Lint, vendor hashes, archive integrity/content checks, and diff whitespace
  checks passed. Runtime: 19.70 MiB installed, 8.09 MiB compressed, 490 ms cold
  setup, and 24 ms warm 4,000-character lint, all within the existing budgets.
- `make check-harper-update` confirms 3.0.0 matches npm's live latest tag.
