# Proofly Privacy Policy

Last updated: September 5, 2026

Proofly is a Chrome extension for private, on-device proofreading. The extension
does not operate a server, does not sell user data, and does not use user data
for advertising.

## What Proofly Processes

Proofly processes the text you type or paste into its side-panel editor. If you
enable Proofly on a website, it also processes text from the focused editable
field on that site so it can show proofreading suggestions and apply fixes.
Website proofreading is off by default and must be enabled per site by the user.

Proofreading uses the packaged Harper 2.7.0 WebAssembly engine. It runs locally
inside the extension and makes no network request. Rewriting uses Chrome's
built-in on-device Rewriter API only after the user explicitly chooses a
rewrite action. Proofly does not send proofreading or rewriting text to Proofly
servers.

Proofly stores the following data in Chrome extension storage:

- Notes you create in the Docs library.
- A custom dictionary of words you choose to suppress.
- Harper Weirpack archives you choose to import.
- Saved custom rewrite prompts.
- Proofreading dialect and per-rule preferences (synced through Chrome).
- The list of sites where you have enabled Proofly.
- Optional GitHub sync settings, if you enable notes sync.

## Optional GitHub Notes Sync

Notes sync is off by default. If you enable it, Proofly sends your note JSON to
the GitHub repository you choose. The repository's visibility determines who
can access those notes, so using a private repository is recommended. Proofly
sends your user-provided GitHub personal access token to GitHub's API solely to
read and write that repository.

The token is stored in Chrome sync storage so your signed-in Chrome profiles can
reuse the same sync settings. Proofly restricts its local and sync storage areas
to trusted extension pages and the service worker. Website content scripts
receive only the dictionary words, proofing settings, and adapter flags needed
for in-page proofreading; they cannot read notes, imported Weirpacks, or GitHub
sync settings. This restriction does not encrypt the Chrome profile, so anyone
with profile access may still be able to read extension storage. Use a
fine-grained GitHub token scoped only to the notes repository with Contents
read/write access.

Disconnecting GitHub sync removes the saved token from Proofly and keeps your
local notes. It does not delete notes already stored in the GitHub repository.

## Data Sharing

Proofly does not share your proofreading or rewriting text with Proofly servers.
When optional GitHub sync is enabled, note data and the GitHub token are sent to
GitHub only to provide the sync feature you configured.

Chrome may sync extension storage, such as your custom dictionary, custom
prompts, proofreading preferences, imported Weirpacks, enabled-site list, and optional GitHub sync
settings, between Chrome profiles signed in to the same Google account
according to your Chrome sync settings.

## Permissions

Proofly requests only the Chrome extension permissions needed to provide its
features:

- `sidePanel`: opens the proofreading editor in Chrome's side panel.
- `offscreen`: hosts the single packaged Harper worker used for local linting.
- `storage` and `unlimitedStorage`: stores notes, settings, dictionary entries,
  imported Weirpacks, prompts, enabled-site intent, and sync state.
- `scripting`: injects the proofreading content script into sites you explicitly
  enable.
- `activeTab`: identifies the current tab for the toolbar menu and side-panel
  actions.
- Optional host permissions: requested one site at a time when you enable
  Proofly for that site. Proofly does not request broad host access at install.

## Limited Use

Proofly's use of information received from Chrome APIs adheres to the Chrome Web
Store User Data Policy, including the Limited Use requirements. Data accessed by
Proofly is used only to provide Proofly's proofreading, notes, dictionary,
settings, site opt-in, and optional sync features.

## Changes

Updates to this policy will be published on this page, and the date above will
be updated.
