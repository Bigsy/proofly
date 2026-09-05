# Harper rollout verification

Pinned engine: Harper 2.7.0. Last updated: 2026-09-05.

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
Representative no-suggestion Formatting, Grammar, Miscellaneous, Typo, Usage,
and Readability cases are covered.

## Advice and Long Sentences release checks

1. In the side panel, paste the reported 49-word sentence. Confirm there is no
   whole-sentence Readability underline and that the capitalization, spelling,
   and `some how` fixes are available.
2. Exercise `She whispered "hurry"and left.`, `The city is famous its beaches.`,
   and `I would argue that this is correct.` Confirm each advice item shows a
   friendly category and full explanation without a struck-through source or
   Apply action.
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
