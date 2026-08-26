// ui/documents-page.js — the options page's "Documents" card: export every
// note as one JSON bundle, and import such a bundle additively (new notes are
// added, existing ones updated only when the file's copy is newer). Deps are
// injected like ui/dictionary-page.js:
//   els   — { count, importFile, importBtn, exportBtn, status }
//   store — { listIndex, listNotes, mergeNotes }
//   sync  — optional async () => boolean; pushes the merged library to GitHub
//           after an import and returns false when sync isn't configured

import { bundleFilename, describeImport, parseBundle, planImport, serializeBundle } from "../lib/notes-transfer.js";

export function initDocumentsPage({ els, store, sync, now = () => Date.now() }) {
  function report(message, isError = false) {
    els.status.textContent = message;
    els.status.classList.toggle("error", isError);
  }

  async function refresh() {
    const index = await store.listIndex();
    const n = index.length;
    els.count.textContent = `${n} note${n === 1 ? "" : "s"} on this browser`;
    els.exportBtn.disabled = !n;
  }

  async function exportAll() {
    const notes = await store.listNotes();
    const json = serializeBundle(notes, now());
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = bundleFilename(now());
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    report(`Exported ${notes.length} note${notes.length === 1 ? "" : "s"}.`);
  }

  // Mirrors ui/weirpack-page.js: the import itself already succeeded, so a
  // sync failure is reported as such rather than as a failed import.
  async function syncAfterImport(summary) {
    report(`${summary} Syncing with GitHub…`);
    try {
      const synced = await sync();
      report(synced ? `${summary} Synced with GitHub.` : summary);
    } catch (error) {
      report(`${summary} Saved here, but GitHub sync failed: ${error?.message || error}`, true);
    }
  }

  async function importSelected() {
    const [file] = els.importFile.files ?? [];
    els.importFile.value = "";
    if (!file) return;
    els.importBtn.disabled = true;
    report(`Importing ${file.name}…`);
    try {
      const { notes, skipped } = parseBundle(await file.text());
      const plan = planImport(notes, await store.listIndex());
      if (plan.toWrite.length) await store.mergeNotes(plan.toWrite);
      await refresh();
      const summary = describeImport(plan, skipped);
      if (plan.toWrite.length && sync) await syncAfterImport(summary);
      else report(summary);
    } catch (e) {
      report(`Couldn't import: ${e?.message || e}`, true);
    } finally {
      els.importBtn.disabled = false;
    }
  }

  els.importBtn.addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", importSelected);
  els.exportBtn.addEventListener("click", exportAll);

  const ready = refresh();
  return { ready, refresh };
}
