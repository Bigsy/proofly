# Chrome Web Store assets

Final uploads (exact store dimensions, 24-bit PNG, no alpha):

| File | Store slot | Size |
| --- | --- | --- |
| `icon-128.png` | Store icon (alpha allowed here) | 128×128 |
| `small-promo-440x280.png` | Small promo tile | 440×280 |
| `marquee-1400x560.png` | Marquee promo tile | 1400×560 |
| `screenshot-1-editor-1280x800.png` | Screenshot 1 — editor + live underlines | 1280×800 |
| `screenshot-2-corrections-1280x800.png` | Screenshot 2 — corrections list | 1280×800 |
| `screenshot-3-library-1280x800.png` | Screenshot 3 — notes library | 1280×800 |

The extension icons in `../icons/` (16/48/128) are rendered from the same
source.

## Store privacy copy

Proofly should be described as offline and on-device: packaged Harper
WebAssembly performs proofreading, while Chrome AI is used only for an explicit
optional rewrite. The data-handling copy must include this carve-out: notes are stored locally unless the user
explicitly enables optional GitHub sync, in which case note JSON is sent only
to the private GitHub repository and account they configure with their own
fine-grained token. Proofly has no sync server, and proofreading/rewriting text
is not sent to Proofly servers.

Use `PRIVACY.md` as the public privacy policy, and `store/SUBMISSION.md` for
the Chrome Web Store privacy-field and reviewer-copy prompts.

## Packaging

Create a clean upload archive with:

```sh
npm run pack:store
```

The archive is written to `dist/` and intentionally excludes tests, node_modules,
MCP/agent files, IDE settings, store artwork sources, and other development-only
files.

## Sources / rebuilding

- `src/icon.svg` — master icon (used for 48 and 128).
- `src/icon-small.svg` — simplified variant with heavier strokes for 16/32 px.
- `src/build.py` — composes the tiles + screenshots: embeds the real UI
  captures from `work/ui-*.png` (base64) into SVG layouts, renders with
  `rsvg-convert`, flattens to 24-bit PNG with ImageMagick.

```sh
# icons
rsvg-convert -w 128 -h 128 src/icon.svg -o ../icons/icon128.png
rsvg-convert -w 48  -h 48  src/icon.svg -o ../icons/icon48.png
rsvg-convert -w 16  -h 16  src/icon-small.svg -o ../icons/icon16.png

# tiles + screenshots (needs work/icon256.png + work/ui-*.png)
rsvg-convert -w 256 -h 256 src/icon.svg -o work/icon256.png
python3 src/build.py
```

## Re-capturing the UI shots

The `work/ui-*.png` captures are real screenshots of the side panel taken in
the `proofly-chrome` MCP Chrome at a 420×760 viewport with
`deviceScaleFactor: 2` (so the PNGs are 840×1520). The flow: install the
extension, open `chrome-extension://<id>/sidepanel.html` in a tab, seed
`chrome.storage.local` with demo notes, type demo text with deliberate errors
into the editor, wait for "corrections suggested", screenshot.
