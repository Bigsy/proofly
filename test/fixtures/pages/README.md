# Browser-level fixture pages

Committed pages for exercising the **in-page proofreading** feature
(`page/content/*`) in a real Chrome — the layout- and browser-behaviour-
sensitive things jsdom cannot cover: underline geometry, scroll tracking,
the containing-block trap, and write-back into a controlled input. They gate
the Phase 1/2 exit criteria.

| Page | Exercises |
| --- | --- |
| `textarea.html` | the plain Phase-1 happy path (mirror overlay on a wrapping field) |
| `input.html` | single-line `<input>` (no wrap, horizontal scroll, vertical centring) |
| `contenteditable.html` | Phase 2 (Highlight API; overlay fallback under webdriver) |
| `scroll-container.html` | underlines tracking scroll inside an `overflow: auto` ancestor |
| `transformed-ancestor.html` | `position: fixed` containing-block trap (`transform` ancestor) |
| `controlled-input.html` | React-style value tracker — Apply must use the native setter |
| `iframe-parent.html` / `iframe-child.html` | same-origin `allFrames` injection, exactly one engine per frame |
| `iframe-fallback-parent.html` | `about:blank` / `srcdoc` origin-fallback frame injection, exactly one engine per frame |
| `rich-editor-gated.html` | ordinary rich-editor fixture for the default-off adapter gate |

## Running them

Serve over localhost (match patterns can't express `file://` opt-in):

```bash
python3 -m http.server 8907 -d test/fixtures/pages
```

then enable Proofly for `http://localhost` — either by hand via the toolbar
popup (one native prompt), or for MCP automation temporarily add
`"host_permissions": ["http://localhost/*"]` to `manifest.json` (unpacked
extensions auto-grant install-time host permissions, no prompt). **That edit
is dev-only — never commit or ship it.**

Every page exposes `window.__fixture` with an `inputEvents` counter (and the
controlled page, a change log) so a driven session can assert write-back
fired real `input` events, not just mutated `.value`.

Note: under the MCP harness `navigator.webdriver` is true, so contenteditable
runs exercise the overlay *fallback*; the Highlight-API path needs a manual
pass in a normal Chrome launch (`tools/dev-chrome.sh`).
