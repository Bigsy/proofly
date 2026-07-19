# Chrome Web Store Submission Notes

This file is reviewer/dashboard copy for Proofly. Keep it consistent with
`manifest.json`, `README.md`, and `PRIVACY.md`.

## Single Purpose

Proofly provides private, on-device proofreading and writing assistance in
Chrome. It proofreads text in the side-panel editor and, after per-site user
opt-in, in editable fields on websites. It also includes a local notes library,
a custom dictionary, rewrite prompts, and optional user-configured GitHub sync
for notes.

## Permission Justifications

`sidePanel`: Opens the main Proofly editor and notes library in Chrome's side
panel.

`offscreen`: Hosts one extension-owned Harper WebAssembly worker so the side
panel and opted-in pages share a local proofreading engine without keeping a
visible page open.

`storage`: Saves notes, custom dictionary entries, custom rewrite prompts,
enabled-site intent, options, sync settings, and sync state. Both storage areas
are restricted to trusted extension contexts; the opted-in website content
script receives only its sanitized dictionary/settings subset from the service
worker and cannot read notes or GitHub credentials.

`unlimitedStorage`: Allows the local notes library to store user-created notes
without Chrome's small extension local-storage quota becoming the limiting
factor.

`scripting`: Registers and injects Proofly's content script only on sites the
user explicitly enables, so Proofly can read the focused editable field, render
underlines, and apply the user's selected correction.

`activeTab`: Lets the toolbar popup identify the current tab and open the side
panel or request site access in response to the user's click.

`optional_host_permissions` (`*://*/*`): Allows Proofly to request access to the
specific site the user enables from the toolbar. Access is requested per origin,
not at install time, and broad grants are ignored by the extension's site-access
logic.

## Remote Code Declaration

Select: No, this extension does not execute remote code.

Proofly's extension logic, Harper 2.4.0 JavaScript, and Harper's WebAssembly
runtime are packaged in the extension. Optional GitHub sync
uses GitHub's Contents API to read and write user note JSON in the repository
the user configures. That remote data is not executable code.

## Data Usage Disclosure

Proofly handles user-provided content: text typed into the side-panel editor,
saved notes, custom dictionary words, custom rewrite prompts, enabled-site
preferences, and optional GitHub sync settings. If the user enables Proofly on a
website, Proofly reads the focused editable field on that enabled site to
provide proofreading suggestions and apply user-selected fixes.

Proofreading runs locally through packaged Harper WebAssembly and makes no
network request. Rewriting uses Chrome's built-in on-device Rewriter API only
after an explicit user action. Proofly does not send either text to Proofly
servers.

Notes sync is optional and off by default. If the user enables it, Proofly sends
note JSON and the user-provided fine-grained GitHub token to GitHub only to read
and write the private repository selected by the user. Proofly has no sync
server.

## Suggested Privacy Form Answers

Data collected:

- Website content: only editable-field text on sites the user explicitly enables.
- User activity: enabled-site preferences and extension settings.
- Authentication information: GitHub personal access token, only if the user
  enables GitHub notes sync.
- User content: notes, dictionary entries, custom prompts, and editor text.

Data use certifications:

- Data is used only for Proofly's single purpose and related features.
- Data is not sold.
- Data is not used or transferred for personalized advertising.
- Humans do not read user data except where required by the user's explicit
  action with GitHub sync or by applicable law.
- Data is transmitted securely when optional GitHub sync communicates with
  GitHub over HTTPS.

## Reviewer Test Instructions

1. Install the extension.
2. Open the toolbar popup and choose "Open side panel".
3. Type `wierd colur`. Proofly should immediately show local Harper suggestions;
   no Chrome AI model or flag is required. Set Dialect to British and verify
   `colur` offers `colour`.
4. Open the `wierd` suggestion and choose the non-primary `wired` alternative,
   then apply it.
5. To test site opt-in, open a normal website with a text field, click the
   toolbar popup, choose "Enable Proofly on this site", approve Chrome's host
   permission prompt, then type into the field.
6. To test optional sync, open Settings, create or select a private GitHub
   repository, paste a fine-grained token with Contents read/write access for
   that repository only, and click Sync now.

## Upload Package

Run:

```sh
npm run pack:store
```

Upload the zip written to `dist/`, not the repository root.
