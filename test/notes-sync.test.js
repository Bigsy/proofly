import { describe, expect, it, vi } from "vitest";
import { saveNote } from "../lib/notes-store.js";
import {
  inspectSyncRecovery,
  loadRecoveryBackup,
  loadSyncState,
  planSync,
  recoverNotesSync,
  recordTombstone,
  runSync,
  saveSyncState,
  serializeRemoteIndex,
  SYNC_RECOVERY_BACKUP_KEY,
  SYNC_RECOVERY_LOCK_KEY,
  TOMBSTONE_TTL_MS,
} from "../lib/notes-sync.js";
import { installChromeStorageStub } from "./helpers/chrome-storage.js";

const now = 1_000_000;
const entry = (id, updatedAt, extra = {}) => ({ id, title: id, snippet: "", updatedAt, ...extra });

describe("planSync", () => {
  it("pushes a local edit when remote is still at the base", () => {
    const plan = planSync(
      [entry("n1", 20)],
      {},
      { synced: { n1: { updatedAt: 10, sha: "sha" } } },
      [entry("n1", 10)],
      { now },
    );
    expect(plan.pushes.map((e) => e.id)).toEqual(["n1"]);
    expect(plan.pulls).toEqual([]);
  });

  it("pulls a remote edit when local is still at the base", () => {
    const plan = planSync(
      [entry("n1", 10)],
      {},
      { synced: { n1: { updatedAt: 10, sha: "sha" } } },
      [entry("n1", 20)],
      { now },
    );
    expect(plan.pulls.map((e) => e.id)).toEqual(["n1"]);
    expect(plan.pushes).toEqual([]);
  });

  it("resolves concurrent edits by updatedAt", () => {
    const plan = planSync(
      [entry("n1", 30)],
      {},
      { synced: { n1: { updatedAt: 10, sha: "sha" } } },
      [entry("n1", 20)],
      { now },
    );
    expect(plan.pushes.map((e) => e.id)).toEqual(["n1"]);
  });

  it("turns a local tombstone into a remote delete and keeps it in the merged index", () => {
    const plan = planSync(
      [],
      { n1: 50 },
      { synced: { n1: { updatedAt: 40, sha: "sha" } } },
      [entry("n1", 40)],
      { now: 60 },
    );
    expect(plan.remoteDeletes).toEqual([{ id: "n1", updatedAt: 50 }]);
    expect(plan.newIndex).toContainEqual({ id: "n1", deleted: true, updatedAt: 50 });
  });

  it("applies a newer remote tombstone locally", () => {
    const plan = planSync(
      [entry("n1", 40)],
      {},
      { synced: { n1: { updatedAt: 40, sha: "sha" } } },
      [{ id: "n1", deleted: true, updatedAt: 50 }],
      { now: 60 },
    );
    expect(plan.localDeletes).toEqual([{ id: "n1", updatedAt: 50 }]);
  });

  it("prunes old tombstones", () => {
    const plan = planSync(
      [],
      { n1: now - TOMBSTONE_TTL_MS - 1 },
      { synced: {} },
      [],
      { now },
    );
    expect(plan.remoteDeletes).toEqual([]);
    expect(plan.newIndex).toEqual([]);
    expect(plan.newSyncState.tombstones).toEqual({});
  });
});

describe("sync state helpers", () => {
  it("records tombstones in chrome.storage.local", async () => {
    installChromeStorageStub();
    await recordTombstone("n1", 123);
    expect((await loadSyncState()).tombstones).toEqual({ n1: 123 });
  });
});

describe("runSync", () => {
  it("pulls remote notes and preserves their updatedAt", async () => {
    installChromeStorageStub();
    const remoteNote = { id: "n1", body: "Remote title\nbody", createdAt: 5, updatedAt: 77 };
    const client = {
      getFile: vi.fn(async (path) => {
        if (path === "index.json") {
          return { sha: "index-sha", content: serializeRemoteIndex([entry("n1", 77)]) };
        }
        if (path === "notes/n1.json") return { sha: "note-sha", content: JSON.stringify(remoteNote) };
        return null;
      }),
      putFile: vi.fn(),
      deleteFile: vi.fn(),
    };

    const result = await runSync({
      settings: { owner: "me", repo: "proofly-notes", token: "tok", branch: "main" },
      client,
      now: () => now,
    });

    expect(result).toMatchObject({ ok: true, changedLocal: true, pulledIds: ["n1"] });
    const stored = await globalThis.chrome.storage.local.get(["note:n1", "noteIndex"]);
    expect(stored["note:n1"]).toMatchObject(remoteNote);
    expect(stored.noteIndex[0]).toMatchObject({ id: "n1", updatedAt: 77 });
    expect(client.putFile).not.toHaveBeenCalled();
    expect((await loadSyncState()).synced.n1).toEqual({ updatedAt: 77, sha: "note-sha" });
  });

  it("pushes local notes, then writes the remote index last", async () => {
    installChromeStorageStub();
    await saveNote({ id: "n1", body: "Local title", createdAt: 1 }, 88);
    const calls = [];
    const client = {
      getFile: vi.fn(async () => null),
      putFile: vi.fn(async (path) => {
        calls.push(path);
        return { sha: `${path}-sha` };
      }),
      deleteFile: vi.fn(),
    };

    await runSync({
      settings: { owner: "me", repo: "proofly-notes", token: "tok", branch: "main" },
      client,
      now: () => now,
    });

    expect(calls).toEqual(["notes/n1.json", "index.json"]);
    expect((await loadSyncState()).synced.n1).toEqual({ updatedAt: 88, sha: "notes/n1.json-sha" });
  });

  it("deletes remote note bodies using the retained synced sha", async () => {
    installChromeStorageStub();
    await saveSyncState({
      synced: { n1: { updatedAt: 40, sha: "note-sha" } },
      tombstones: { n1: 50 },
      indexSha: "index-sha",
    });
    const client = {
      getFile: vi.fn(async (path) => {
        if (path === "index.json") {
          return { sha: "index-sha", content: serializeRemoteIndex([entry("n1", 40)]) };
        }
        return null;
      }),
      putFile: vi.fn(async () => ({ sha: "new-index-sha" })),
      deleteFile: vi.fn(async () => null),
    };

    await runSync({
      settings: { owner: "me", repo: "proofly-notes", token: "tok", branch: "main" },
      client,
      now: () => now,
    });

    expect(client.deleteFile).toHaveBeenCalledWith("notes/n1.json", {
      sha: "note-sha",
      message: "Delete Proofly note n1",
    });
    const indexBody = JSON.parse(client.putFile.mock.calls.at(-1)[1]);
    expect(indexBody.notes).toContainEqual({ id: "n1", deleted: true, updatedAt: 50 });
    const state = await loadSyncState();
    expect(state.synced.n1).toBeUndefined();
    expect(state.tombstones.n1).toBeUndefined();
  });

  it("keeps the shas earned by attempt-0 pushes across the 409 retry (no permanent wedge)", async () => {
    // The race: our note PUT lands (file moves to a new sha), then the
    // index PUT 409s because another device wrote index.json first. The
    // retry re-reads sync state — if attempt 0's fresh note shas were never
    // persisted, the retry (and every future sync) re-pushes with the OLD
    // sha and 409s forever.
    installChromeStorageStub();
    await saveSyncState({ synced: { n1: { updatedAt: 40, sha: "old-sha" } }, tombstones: {} });
    await saveNote({ id: "n1", body: "Local edit", createdAt: 1 }, 88);

    let remoteNoteSha = "old-sha"; // GitHub's sha check on notes/n1.json
    let pushCount = 0;
    let indexConflicted = false;
    const client = {
      getFile: vi.fn(async (path) => {
        if (path === "index.json") {
          // Attempt 0 sees the stale index; the retry sees the other
          // device's index (which doesn't know our note).
          return indexConflicted
            ? { sha: "index-2", content: serializeRemoteIndex([entry("other", 50)]) }
            : { sha: "index-1", content: serializeRemoteIndex([entry("n1", 40)]) };
        }
        return null;
      }),
      putFile: vi.fn(async (path, content, { sha } = {}) => {
        if (path === "notes/n1.json") {
          if (sha !== remoteNoteSha) {
            throw Object.assign(new Error("sha mismatch"), { retryableConflict: true });
          }
          remoteNoteSha = `push-${++pushCount}-sha`;
          return { sha: remoteNoteSha };
        }
        if (!indexConflicted) {
          indexConflicted = true;
          throw Object.assign(new Error("index conflict"), { retryableConflict: true });
        }
        return { sha: "index-3" };
      }),
      deleteFile: vi.fn(),
    };

    const result = await runSync({
      settings: { owner: "me", repo: "proofly-notes", token: "tok", branch: "main" },
      client,
      now: () => now,
    });

    expect(result.ok).toBe(true);
    // The retry pushed with the sha attempt 0 earned, not the stale one.
    const notePuts = client.putFile.mock.calls.filter(([p]) => p === "notes/n1.json");
    expect(notePuts.map(([, , opts]) => opts.sha)).toEqual(["old-sha", "push-1-sha"]);
    expect((await loadSyncState()).synced.n1).toEqual({ updatedAt: 88, sha: "push-2-sha" });
  });

  it("a second mid-stream conflict surfaces, and the NEXT sync finishes the owed index write", async () => {
    installChromeStorageStub();
    await saveSyncState({ synced: { n1: { updatedAt: 40, sha: "old-sha" } }, tombstones: {} });
    await saveNote({ id: "n1", body: "Local edit", createdAt: 1 }, 88);

    let remoteNoteSha = "old-sha";
    let pushCount = 0;
    let indexPutAllowed = false;
    const conflict = () => Object.assign(new Error("conflict"), { retryableConflict: true });
    const client = {
      getFile: vi.fn(async (path) =>
        path === "index.json"
          ? { sha: "index-x", content: serializeRemoteIndex([entry("n1", 40)]) }
          : null),
      putFile: vi.fn(async (path, content, { sha } = {}) => {
        if (path === "notes/n1.json") {
          if (sha !== remoteNoteSha) throw conflict();
          remoteNoteSha = `push-${++pushCount}-sha`;
          return { sha: remoteNoteSha };
        }
        if (!indexPutAllowed) throw conflict(); // both attempts conflict
        return { sha: "index-final" };
      }),
      deleteFile: vi.fn(),
    };
    const deps = {
      settings: { owner: "me", repo: "proofly-notes", token: "tok", branch: "main" },
      client,
      now: () => now,
    };

    await expect(runSync(deps)).rejects.toMatchObject({ retryableConflict: true });
    // Attempt 0's push sha survived the failed run; the retry planned no
    // re-push (the note is already up there) and only the index is owed.
    expect((await loadSyncState()).synced.n1).toEqual({ updatedAt: 88, sha: "push-1-sha" });
    expect(pushCount).toBe(1);

    // The next user-triggered sync writes the still-stale index and settles —
    // without churning another commit onto the note file.
    indexPutAllowed = true;
    const result = await runSync(deps);
    expect(result.ok).toBe(true);
    expect(pushCount).toBe(1);
    const indexBody = JSON.parse(client.putFile.mock.calls.at(-1)[1]);
    expect(indexBody.notes).toContainEqual(expect.objectContaining({ id: "n1", updatedAt: 88 }));
    expect((await loadSyncState()).indexSha).toBe("index-final");
  });

  it("skips pulling ids the caller protects (the dirty open note) and reports them", async () => {
    installChromeStorageStub();
    const remote = (id, body, updatedAt) =>
      JSON.stringify({ id, body, createdAt: 1, updatedAt });
    const client = {
      getFile: vi.fn(async (path) => {
        if (path === "index.json") {
          // Sorted as this code always writes it (updatedAt desc) so a
          // pull-only sync sees identical content and owes no index write.
          return { sha: "index-sha", content: serializeRemoteIndex([entry("n2", 80), entry("n1", 70)]) };
        }
        if (path === "notes/n1.json") return { sha: "s1", content: remote("n1", "one", 70) };
        if (path === "notes/n2.json") return { sha: "s2", content: remote("n2", "two", 80) };
        return null;
      }),
      putFile: vi.fn(),
      deleteFile: vi.fn(),
    };

    const result = await runSync({
      settings: { owner: "me", repo: "proofly-notes", token: "tok", branch: "main" },
      client,
      skipPullIds: () => ["n1"],
      now: () => now,
    });

    expect(result).toMatchObject({ ok: true, pulledIds: ["n2"], skippedPulls: ["n1"] });
    expect(client.putFile).not.toHaveBeenCalled(); // pull-only: no index churn
    const stored = await globalThis.chrome.storage.local.get(["note:n1", "note:n2"]);
    expect(stored["note:n1"]).toBeUndefined(); // untouched — editor owns it
    expect(stored["note:n2"]).toMatchObject({ id: "n2", body: "two" });
    // n1 stays unsynced so the next run (after the local save) resolves it.
    const state = await loadSyncState();
    expect(state.synced.n1).toBeUndefined();
    expect(state.synced.n2).toEqual({ updatedAt: 80, sha: "s2" });
  });

  it("a mid-pull network failure surfaces, keeps completed pulls, and corrupts no state", async () => {
    installChromeStorageStub();
    const client = {
      getFile: vi.fn(async (path) => {
        if (path === "index.json") {
          return { sha: "index-sha", content: serializeRemoteIndex([entry("a", 70), entry("b", 80)]) };
        }
        if (path === "notes/a.json") {
          return { sha: "sa", content: JSON.stringify({ id: "a", body: "A", createdAt: 1, updatedAt: 70 }) };
        }
        throw new TypeError("Failed to fetch"); // note b: network dies
      }),
      putFile: vi.fn(),
      deleteFile: vi.fn(),
    };

    await expect(runSync({
      settings: { owner: "me", repo: "proofly-notes", token: "tok", branch: "main" },
      client,
      now: () => now,
    })).rejects.toThrow("Failed to fetch");

    // Note a landed locally; nothing pretends b synced.
    const stored = await globalThis.chrome.storage.local.get(["note:a", "note:b"]);
    expect(stored["note:a"]).toMatchObject({ id: "a", body: "A" });
    expect(stored["note:b"]).toBeUndefined();
    const state = await loadSyncState();
    expect(state.synced.b).toBeUndefined();
    expect(state.lastSyncAt).toBeUndefined(); // the run never claimed success
  });

  it("preserves the local loser of a both-moved conflict as a '(conflict)' copy before pulling", async () => {
    installChromeStorageStub();
    await saveSyncState({ synced: { n1: { updatedAt: 10, sha: "base-sha" } }, tombstones: {} });
    await saveNote({ id: "n1", body: "Local edit", createdAt: 1 }, 20); // local moved…
    const client = {
      getFile: vi.fn(async (path) => {
        if (path === "index.json") {
          return { sha: "index-sha", content: serializeRemoteIndex([entry("n1", 30)]) }; // …remote moved later
        }
        if (path === "notes/n1.json") {
          return { sha: "s1", content: JSON.stringify({ id: "n1", body: "Remote edit", createdAt: 1, updatedAt: 30 }) };
        }
        return null;
      }),
      putFile: vi.fn(async () => ({ sha: "x" })),
      deleteFile: vi.fn(),
    };

    await runSync({
      settings: { owner: "me", repo: "proofly-notes", token: "tok", branch: "main" },
      client,
      newId: () => "copy-1",
      now: () => now,
    });

    const stored = await globalThis.chrome.storage.local.get(["note:n1", "note:copy-1"]);
    expect(stored["note:n1"]).toMatchObject({ body: "Remote edit" }); // newer side won the id
    expect(stored["note:copy-1"]).toMatchObject({ body: "(conflict) Local edit", updatedAt: 20 });
  });

  it("preserves the remote loser of a both-moved conflict before pushing over it", async () => {
    installChromeStorageStub();
    await saveSyncState({ synced: { n1: { updatedAt: 10, sha: "note-sha" } }, tombstones: {} });
    await saveNote({ id: "n1", body: "Local edit", createdAt: 1 }, 30); // local is newer
    const client = {
      getFile: vi.fn(async (path) => {
        if (path === "index.json") {
          return { sha: "index-sha", content: serializeRemoteIndex([entry("n1", 20)]) };
        }
        if (path === "notes/n1.json") {
          return { sha: "note-sha", content: JSON.stringify({ id: "n1", body: "Remote edit", createdAt: 1, updatedAt: 20 }) };
        }
        return null;
      }),
      putFile: vi.fn(async () => ({ sha: "new" })),
      deleteFile: vi.fn(),
    };

    await runSync({
      settings: { owner: "me", repo: "proofly-notes", token: "tok", branch: "main" },
      client,
      newId: () => "copy-2",
      now: () => now,
    });

    const stored = await globalThis.chrome.storage.local.get(["note:n1", "note:copy-2"]);
    expect(stored["note:n1"]).toMatchObject({ body: "Local edit" });
    expect(stored["note:copy-2"]).toMatchObject({ body: "(conflict) Remote edit", updatedAt: 20 });
  });

  it("skips the conflict copy when both sides converged on identical bodies", async () => {
    installChromeStorageStub();
    await saveSyncState({ synced: { n1: { updatedAt: 10, sha: "base-sha" } }, tombstones: {} });
    await saveNote({ id: "n1", body: "Same text", createdAt: 1 }, 20);
    const client = {
      getFile: vi.fn(async (path) => {
        if (path === "index.json") {
          return { sha: "index-sha", content: serializeRemoteIndex([entry("n1", 30)]) };
        }
        if (path === "notes/n1.json") {
          return { sha: "s1", content: JSON.stringify({ id: "n1", body: "Same text", createdAt: 1, updatedAt: 30 }) };
        }
        return null;
      }),
      putFile: vi.fn(async () => ({ sha: "x" })),
      deleteFile: vi.fn(),
    };

    await runSync({
      settings: { owner: "me", repo: "proofly-notes", token: "tok", branch: "main" },
      client,
      newId: () => { throw new Error("no copy should be created"); },
      now: () => now,
    });

    const index = (await globalThis.chrome.storage.local.get("noteIndex")).noteIndex;
    expect(index.map((e) => e.id)).toEqual(["n1"]);
  });

  it("retries once on a sha conflict", async () => {
    installChromeStorageStub();
    await saveNote({ id: "n1", body: "Local", createdAt: 1 }, 88);
    const conflict = Object.assign(new Error("conflict"), { retryableConflict: true });
    const client = {
      getFile: vi.fn(async () => null),
      putFile: vi.fn()
        .mockRejectedValueOnce(conflict)
        .mockResolvedValueOnce({ sha: "note-sha" })
        .mockResolvedValueOnce({ sha: "index-sha" }),
      deleteFile: vi.fn(),
    };

    await runSync({
      settings: { owner: "me", repo: "proofly-notes", token: "tok", branch: "main" },
      client,
      now: () => now,
    });

    expect(client.getFile).toHaveBeenCalledTimes(2);
    expect(client.putFile).toHaveBeenCalledTimes(3);
  });
});

describe("sync recovery", () => {
  const settings = { owner: "me", repo: "proofly-notes", token: "tok", branch: "main" };
  const remoteBody = (id, body, updatedAt) => ({ id, body, createdAt: 1, updatedAt });

  it("inspects both indexes without downloading note bodies", async () => {
    installChromeStorageStub();
    await saveNote({ id: "shared", body: "Local shared", createdAt: 1 }, 20);
    await saveNote({ id: "local", body: "Local only", createdAt: 1 }, 30);
    const client = {
      getFile: vi.fn(async (path) => path === "index.json"
        ? { sha: "index", content: serializeRemoteIndex([entry("shared", 25), entry("remote", 40)]) }
        : null),
    };

    await expect(inspectSyncRecovery({ settings, client })).resolves.toMatchObject({
      localCount: 2,
      remoteCount: 2,
      localOnly: 1,
      remoteOnly: 1,
      changed: 1,
      owner: "me",
      repo: "proofly-notes",
    });
    expect(client.getFile).toHaveBeenCalledTimes(1);
  });

  it("uses GitHub as authoritative only after backing up both libraries", async () => {
    installChromeStorageStub();
    await saveNote({ id: "local", body: "Local only", createdAt: 1 }, 20);
    await saveSyncState({ synced: { local: { updatedAt: 10, sha: "old" } }, tombstones: { gone: 15 } });
    const githubNote = remoteBody("remote", "GitHub note", 50);
    const client = {
      getFile: vi.fn(async (path) => {
        if (path === "index.json") {
          return { sha: "index-github", content: serializeRemoteIndex([entry("remote", 50)]) };
        }
        if (path === "notes/remote.json") return { sha: "remote-sha", content: JSON.stringify(githubNote) };
        return null;
      }),
    };

    const result = await recoverNotesSync("remote", { settings, client, now: () => now });

    expect(result).toMatchObject({ ok: true, strategy: "remote", noteCount: 1 });
    const stored = await globalThis.chrome.storage.local.get(["note:local", "note:remote"]);
    expect(stored["note:local"]).toBeUndefined();
    expect(stored["note:remote"]).toMatchObject(githubNote);
    expect(await loadSyncState()).toEqual({
      synced: { remote: { updatedAt: 50, sha: "remote-sha" } },
      tombstones: {},
      indexSha: "index-github",
      lastSyncAt: now,
    });
    expect(await loadRecoveryBackup()).toMatchObject({
      strategy: "remote",
      repository: "me/proofly-notes",
      local: { notes: [expect.objectContaining({ id: "local", body: "Local only" })] },
      remote: { notes: [expect.objectContaining({ id: "remote", body: "GitHub note" })] },
    });
  });

  it("repairs by merging both sides and keeps the pre-merge snapshot", async () => {
    installChromeStorageStub();
    await saveNote({ id: "local", body: "Local note", createdAt: 1 }, 20);
    const githubNote = remoteBody("remote", "GitHub note", 50);
    const client = {
      getFile: vi.fn(async (path) => {
        if (path === "index.json") {
          return { sha: "index-before", content: serializeRemoteIndex([entry("remote", 50)]) };
        }
        if (path === "notes/remote.json") return { sha: "remote-sha", content: JSON.stringify(githubNote) };
        return null;
      }),
      putFile: vi.fn(async (path) => ({ sha: path === "index.json" ? "index-after" : "local-sha" })),
      deleteFile: vi.fn(),
    };

    const result = await recoverNotesSync("merge", { settings, client, now: () => now });

    expect(result).toMatchObject({
      ok: true,
      strategy: "merge",
      noteCount: 2,
      conflictsPreserved: 0,
    });
    const stored = await globalThis.chrome.storage.local.get(["note:local", "note:remote"]);
    expect(stored["note:local"]).toMatchObject({ body: "Local note" });
    expect(stored["note:remote"]).toMatchObject({ body: "GitHub note" });
    expect(await loadRecoveryBackup()).toMatchObject({
      strategy: "merge",
      local: { notes: [expect.objectContaining({ id: "local" })] },
      remote: { notes: [expect.objectContaining({ id: "remote" })] },
    });
  });

  it("keeps the newer shared note and publishes the losing edit as a conflict copy", async () => {
    installChromeStorageStub();
    await saveNote({ id: "shared", body: "Local draft", createdAt: 1 }, 30);
    const githubNote = remoteBody("shared", "Remote draft", 40);
    const client = {
      getFile: vi.fn(async (path) => {
        if (path === "index.json") {
          return { sha: "index-before", content: serializeRemoteIndex([entry("shared", 40)]) };
        }
        if (path === "notes/shared.json") {
          return { sha: "shared-sha", content: JSON.stringify(githubNote, null, 2) };
        }
        return null;
      }),
      putFile: vi.fn(async (path) => ({ sha: path === "index.json" ? "index-after" : "copy-sha" })),
      deleteFile: vi.fn(),
    };

    const result = await recoverNotesSync("merge", {
      settings,
      client,
      newId: () => "conflict-copy",
      now: () => now,
    });

    expect(result).toMatchObject({ noteCount: 2, conflictsPreserved: 1 });
    const stored = await globalThis.chrome.storage.local.get(["note:shared", "note:conflict-copy"]);
    expect(stored["note:shared"]).toMatchObject({ body: "Remote draft", updatedAt: 40 });
    expect(stored["note:conflict-copy"]).toMatchObject({ body: "(conflict) Local draft", updatedAt: 30 });
    expect(client.putFile).toHaveBeenCalledWith(
      "notes/conflict-copy.json",
      expect.stringContaining("(conflict) Local draft"),
      expect.objectContaining({ message: "Recover Proofly note conflict-copy from this device" }),
    );
  });

  it("writes local bodies, refetches the index sha, publishes the index, then removes remote-only bodies", async () => {
    installChromeStorageStub();
    await saveNote({ id: "local", body: "This device wins", createdAt: 1 }, 60);
    const calls = [];
    let indexReads = 0;
    const client = {
      getFile: vi.fn(async (path) => {
        calls.push(`get:${path}`);
        if (path === "index.json") {
          indexReads += 1;
          return {
            sha: indexReads === 1 ? "index-backup" : "index-current",
            content: serializeRemoteIndex([entry("remote", 40)]),
          };
        }
        if (path === "notes/remote.json") {
          return { sha: "remote-current", content: JSON.stringify(remoteBody("remote", "Remote only", 40)) };
        }
        return null;
      }),
      putFile: vi.fn(async (path, content, options) => {
        calls.push(`put:${path}`);
        if (path === "index.json") {
          expect(options.sha).toBe("index-current");
          return { sha: "index-final" };
        }
        return { sha: "local-final" };
      }),
      deleteFile: vi.fn(async (path, options) => {
        calls.push(`delete:${path}`);
        expect(options.sha).toBe("remote-current");
      }),
    };

    const result = await recoverNotesSync("local", { settings, client, now: () => now });

    expect(result).toMatchObject({ ok: true, strategy: "local", noteCount: 1 });
    expect(calls.indexOf("put:notes/local.json")).toBeLessThan(calls.indexOf("put:index.json"));
    expect(calls.indexOf("put:index.json")).toBeLessThan(calls.indexOf("delete:notes/remote.json"));
    expect(await loadSyncState()).toEqual({
      synced: { local: { updatedAt: 60, sha: "local-final" } },
      tombstones: {},
      indexSha: "index-final",
      lastSyncAt: now,
    });
  });

  it("keeps the old baseline when replacement fails, while retaining the recovery backup", async () => {
    installChromeStorageStub();
    await saveNote({ id: "local", body: "Local", createdAt: 1 }, 60);
    await saveSyncState({ synced: { base: { updatedAt: 10, sha: "base-sha" } }, tombstones: {} });
    let indexReads = 0;
    const client = {
      getFile: vi.fn(async (path) => {
        if (path === "index.json") {
          indexReads += 1;
          return { sha: `index-${indexReads}`, content: serializeRemoteIndex([]) };
        }
        return null;
      }),
      putFile: vi.fn(async (path) => {
        if (path === "index.json") throw new Error("network stopped");
        return { sha: "pushed-before-failure" };
      }),
      deleteFile: vi.fn(),
    };

    await expect(recoverNotesSync("local", { settings, client, now: () => now })).rejects.toThrow("network stopped");
    expect(await loadSyncState()).toEqual({
      synced: { base: { updatedAt: 10, sha: "base-sha" } },
      tombstones: {},
    });
    expect((await globalThis.chrome.storage.local.get(SYNC_RECOVERY_BACKUP_KEY))[SYNC_RECOVERY_BACKUP_KEY])
      .toMatchObject({ strategy: "local" });
    expect((await globalThis.chrome.storage.local.get(SYNC_RECOVERY_LOCK_KEY))[SYNC_RECOVERY_LOCK_KEY])
      .toBeUndefined();
  });

  it("pauses ordinary automatic sync while a recovery lock is active", async () => {
    installChromeStorageStub({}, {
      [SYNC_RECOVERY_LOCK_KEY]: { id: "other-context", expiresAt: Date.now() + 60_000 },
    });
    const client = { getFile: vi.fn(), putFile: vi.fn(), deleteFile: vi.fn() };

    await expect(runSync({ settings, client })).resolves.toEqual({
      ok: true,
      skipped: true,
      reason: "recovery-in-progress",
    });
    expect(client.getFile).not.toHaveBeenCalled();
  });
});
