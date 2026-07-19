import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockProofreader } from "./helpers/mock-proofreader.js";
import { docTitles, inLibrary, loadPage, settle } from "./helpers/page.js";
import { SYNC_SETTINGS_KEY } from "../lib/sync-settings.js";

const b64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

const jsonResponse = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });

describe("side-panel notes sync", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pulls remote notes on a fresh machine and shows the library", async () => {
    const remoteNote = {
      id: "remote",
      body: "Remote note\nfrom GitHub",
      createdAt: 10,
      updatedAt: 20,
    };
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/contents/index.json")) {
        return jsonResponse({
          type: "file",
          sha: "index-sha",
          content: b64(JSON.stringify({
            schemaVersion: 1,
            notes: [{ id: "remote", title: "Remote note", snippet: "from GitHub", updatedAt: 20 }],
          })),
        });
      }
      if (u.includes("/contents/notes/remote.json")) {
        return jsonResponse({ type: "file", sha: "note-sha", content: b64(JSON.stringify(remoteNote)) });
      }
      throw new Error(`Unexpected fetch ${u}`);
    }));

    await loadPage({
      mock: createMockProofreader(),
      storage: {
        [SYNC_SETTINGS_KEY]: {
          owner: "me",
          repo: "proofly-notes",
          branch: "main",
          token: "github_pat_test",
        },
      },
    });
    await settle();

    expect(inLibrary()).toBe(true);
    expect(docTitles()).toEqual(["Remote note"]);
  });
});
