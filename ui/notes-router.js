// ui/notes-router.js — the notes shell's state machine: the library view ⇄
// the editor view, debounced auto-save, and serialized navigation. Extracted
// from sidepanel.js with the same seam discipline as ui/library.js: no
// chrome.*, storage functions and view side-effects are injected.
//
// State it owns (nothing else may touch these):
//   current       — the open note: { id, createdAt, persisted } or null (library)
//   lastSavedBody — what's on disk for `current` (so opening never re-saves)
//   navigating    — one-line reentrancy guard so a double-click can't
//                   interleave two transitions

import { deriveTitle, sanitizeFilename } from "../lib/notes.js";

export function initNotesRouter({
  els,               // { editor, library, editorView, backBtn }
  store,             // { getNote, saveNote, listIndex, newId }
  now = () => Date.now(),
  saveDebounceMs = 1000,
  onResetResults,    // drop proofread/rewrite state before a doc swap
  onDocOpened,       // auto-proofread whatever doc is now open
  updateCharCount,
  onSaved,           // schedule a sync after a real save
  renderList,        // (index) => render the library cards
}) {
  let current = null;
  let lastSavedBody = "";
  let saveTimer = null;
  let navigating = false;

  const editorDirty = () => !!current && els.editor.value !== lastSavedBody;

  // ---------- auto-save ----------
  // Debounced while typing (separate timer from the proofread debounce) and
  // flushed on every navigation. A write happens only on a real change.
  function scheduleSave() {
    if (!current) return; // nothing open (we're in the library)
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, saveDebounceMs);
  }

  // Cancel the timer, read the CURRENT editor body, and persist only when it
  // differs from disk. A brand-new note that's never been saved and is still
  // blank is discarded; an EXISTING note emptied to blank is saved (stays as
  // an empty "Untitled note"). saveNote bumps updatedAt, so opening alone —
  // which never changes the body — never reorders the library.
  async function flushSave() {
    clearTimeout(saveTimer);
    if (!current) return;
    const body = els.editor.value;
    if (body === lastSavedBody) return;
    if (!current.persisted && !body.trim()) return;
    try {
      await store.saveNote({ id: current.id, body, createdAt: current.createdAt });
      current.persisted = true;
      lastSavedBody = body;
      onSaved?.();
    } catch { /* best-effort: a storage hiccup must not break the editor */ }
  }

  // ---------- view transitions ----------
  function showEditorView() {
    els.library.hidden = true;
    els.editorView.hidden = false;
    els.backBtn.hidden = false;
  }

  function showLibraryView() {
    els.editorView.hidden = true;
    els.library.hidden = false;
    els.backBtn.hidden = true;
  }

  async function renderLibrary() {
    onResetResults();
    current = null;
    showLibraryView();
    renderList(await store.listIndex());
  }

  // Open an existing note into the editor. A missing body (only possible via
  // a failed half-write — invisible orphan) degrades to a blank unsaved doc.
  async function openNote(id) {
    const note = await store.getNote(id);
    els.editor.value = note?.body ?? "";
    updateCharCount();
    onResetResults();
    current = note
      ? { id: note.id, createdAt: note.createdAt, persisted: true }
      : { id, createdAt: now(), persisted: false };
    lastSavedBody = els.editor.value;
    showEditorView();
    onDocOpened();
  }

  // Blank editor, fresh unpersisted note.
  function startNewDoc() {
    els.editor.value = "";
    updateCharCount();
    onResetResults();
    current = { id: store.newId(), createdAt: now(), persisted: false };
    lastSavedBody = "";
    showEditorView();
    onDocOpened(); // blank → placeholder, no proofread
  }

  // Adopt the editor's CURRENT text as a fresh, unsaved note. The editor is
  // blank on a real first run; the test harness may pre-seed it. Init-only —
  // it doesn't clobber the editor, unlike the "New doc" button.
  function startEditorWithCurrentText() {
    current = { id: store.newId(), createdAt: now(), persisted: false };
    lastSavedBody = "";
    showEditorView();
    onDocOpened();
  }

  // The sync scheduler pulled a fresh body for the OPEN note: refresh the
  // editor from storage without a navigation (the view doesn't change).
  async function reloadOpenNote(id) {
    const note = await store.getNote(id);
    if (!note) return;
    els.editor.value = note.body ?? "";
    lastSavedBody = els.editor.value;
    updateCharCount();
    onResetResults();
    onDocOpened();
  }

  // Navigation is serialized: each transition flushes the pending save first,
  // and the reentrancy guard stops a double-click interleaving two of them.
  async function navigate(action) {
    if (navigating) return;
    navigating = true;
    try {
      await flushSave();
      await action();
    } finally {
      navigating = false;
    }
  }

  // Download a note's body as a .txt via a transient <a download> — no extra
  // permission needed. Filename derives from the title (→ "Untitled note.txt"
  // when it sanitizes to empty).
  async function exportNote(id) {
    const note = await store.getNote(id);
    if (!note) return;
    const blob = new Blob([note.body ?? ""], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = sanitizeFilename(deriveTitle(note.body ?? ""));
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return {
    getOpenNote: () => current,
    editorDirty,
    scheduleSave,
    flushSave,
    navigate,
    openNote,
    startNewDoc,
    startEditorWithCurrentText,
    renderLibrary,
    reloadOpenNote,
    showLibraryView,
    exportNote,
  };
}
