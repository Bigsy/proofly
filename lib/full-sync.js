// One user-visible sync operation covers every opted-in GitHub data set.

import { runSync as runNotesSync } from "./notes-sync.js";
import { runWeirpackSync } from "./weirpack-sync.js";

export async function runSync(deps = {}) {
  const notes = await (deps.runNotesSync ?? runNotesSync)(deps);
  const weirpacks = await (deps.runWeirpackSync ?? runWeirpackSync)(deps);
  return {
    ...notes,
    skipped: notes.skipped && weirpacks.skipped,
    // The notes router uses this flag to decide whether to refresh/navigate
    // its view. Pack changes are handled by the background Harper listener.
    changedLocal: !!notes.changedLocal,
    changedWeirpacks: !!weirpacks.changedLocal,
    weirpacks,
  };
}
