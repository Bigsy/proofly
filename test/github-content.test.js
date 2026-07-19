import { describe, expect, it, vi } from "vitest";
import { GitHubContentClient, GitHubContentError } from "../lib/github-content.js";

const jsonResponse = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });

const b64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

describe("GitHubContentClient", () => {
  it("calls fetch with the global receiver Chrome expects", async () => {
    const fetchImpl = vi.fn(function fetchWithReceiver() {
      expect(this).toBe(globalThis);
      return Promise.resolve(jsonResponse([]));
    });
    const client = new GitHubContentClient({ token: "tok", fetchImpl });

    await expect(client.listAccessibleRepos()).resolves.toEqual([]);
  });

  it("GETs and decodes a content file", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      type: "file",
      sha: "sha-1",
      content: b64("hello π"),
    }));
    const client = new GitHubContentClient({ owner: "me", repo: "notes", token: "tok", fetchImpl });

    await expect(client.getFile("notes/a.json")).resolves.toMatchObject({
      sha: "sha-1",
      content: "hello π",
    });
    expect(fetchImpl.mock.calls[0][0]).toContain("/repos/me/notes/contents/notes/a.json");
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer tok");
  });

  it("returns null for a missing file", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Not Found" }, { status: 404 }));
    const client = new GitHubContentClient({ owner: "me", repo: "notes", token: "tok", fetchImpl });
    await expect(client.getFile("index.json")).resolves.toBeNull();
  });

  it("falls back through git_url when Contents omits inline content", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes("/git/blobs/")) {
        return jsonResponse({ content: b64("large body") });
      }
      return jsonResponse({
        type: "file",
        sha: "contents-sha",
        content: "",
        git_url: "https://api.github.com/repos/me/notes/git/blobs/blob-sha",
      });
    });
    const client = new GitHubContentClient({ owner: "me", repo: "notes", token: "tok", fetchImpl });

    await expect(client.getFile("notes/large.json")).resolves.toMatchObject({
      sha: "contents-sha",
      content: "large body",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("PUTs base64 content with the current sha", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ content: { sha: "new-sha" } }));
    const client = new GitHubContentClient({ owner: "me", repo: "notes", branch: "main", token: "tok", fetchImpl });

    await expect(client.putFile("index.json", "hello", { sha: "old-sha" })).resolves.toMatchObject({
      sha: "new-sha",
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toMatchObject({ branch: "main", sha: "old-sha", content: b64("hello") });
  });

  it("marks 409/422 responses as retryable conflicts", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "sha mismatch" }, { status: 409 }));
    const client = new GitHubContentClient({ owner: "me", repo: "notes", token: "tok", fetchImpl });

    await expect(client.putFile("index.json", "x")).rejects.toMatchObject({
      retryableConflict: true,
      status: 409,
    });
    await expect(client.putFile("index.json", "x")).rejects.toBeInstanceOf(GitHubContentError);
  });

  it("falls back to download_url when neither inline content nor a blob is usable", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes("raw.example")) {
        return new Response("raw body", { status: 200 });
      }
      return jsonResponse({
        type: "file",
        sha: "contents-sha",
        content: "",
        download_url: "https://raw.example/notes/big.json",
      });
    });
    const client = new GitHubContentClient({ owner: "me", repo: "notes", token: "tok", fetchImpl });

    await expect(client.getFile("notes/big.json")).resolves.toMatchObject({
      sha: "contents-sha",
      content: "raw body",
    });
    // The raw fetch still carries auth (private repos).
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe("Bearer tok");
  });

  it("surfaces a failed raw download as a GitHubContentError, not a silent empty file", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes("raw.example")) {
        return new Response("nope", { status: 500 });
      }
      return jsonResponse({
        type: "file",
        sha: "s",
        content: "",
        download_url: "https://raw.example/x",
      });
    });
    const client = new GitHubContentClient({ owner: "me", repo: "notes", token: "tok", fetchImpl });
    await expect(client.getFile("x")).rejects.toMatchObject({ status: 500 });
  });

  it("throws when GitHub returns a non-file or no content shape at all", async () => {
    const dir = vi.fn(async () => jsonResponse([{ type: "dir" }]));
    await expect(
      new GitHubContentClient({ owner: "m", repo: "n", token: "t", fetchImpl: dir }).getFile("notes"),
    ).resolves.toBeNull(); // a directory answer is "no such file"

    const empty = vi.fn(async () => jsonResponse({ type: "file", sha: "s", content: "" }));
    await expect(
      new GitHubContentClient({ owner: "m", repo: "n", token: "t", fetchImpl: empty }).getFile("x"),
    ).rejects.toBeInstanceOf(GitHubContentError);
  });

  it("DELETEs with the sha and treats already-gone (404) as success", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ commit: { sha: "c" } }));
    const client = new GitHubContentClient({ owner: "me", repo: "notes", branch: "dev", token: "tok", fetchImpl });

    await client.deleteFile("notes/a.json", { sha: "old-sha" });
    expect(fetchImpl.mock.calls[0][1].method).toBe("DELETE");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ sha: "old-sha", branch: "dev" });

    const gone = vi.fn(async () => jsonResponse({ message: "Not Found" }, { status: 404 }));
    const client2 = new GitHubContentClient({ owner: "me", repo: "notes", token: "tok", fetchImpl: gone });
    await expect(client2.deleteFile("notes/a.json", { sha: "s" })).resolves.toBeNull();
  });

  it("deleteFile without a sha is a no-op (nothing was ever pushed)", async () => {
    const fetchImpl = vi.fn();
    const client = new GitHubContentClient({ owner: "me", repo: "notes", token: "tok", fetchImpl });
    await expect(client.deleteFile("notes/a.json", {})).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("validate returns the repo plus the token-scope headers the UI reports", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ full_name: "me/notes", private: true }, {
      headers: {
        "X-Accepted-GitHub-Permissions": "contents=write",
        "GitHub-Authentication-Token-Expiration": "2027-01-01",
      },
    }));
    const client = new GitHubContentClient({ owner: "me", repo: "notes", token: "tok", fetchImpl });

    await expect(client.validate()).resolves.toEqual({
      repo: { full_name: "me/notes", private: true },
      permissions: "contents=write",
      expiration: "2027-01-01",
    });
  });

  it("listAccessibleRepos returns [] for a non-array answer and carries auth errors", async () => {
    const odd = vi.fn(async () => jsonResponse({ message: "weird" }));
    const client = new GitHubContentClient({ token: "tok", fetchImpl: odd });
    await expect(client.listAccessibleRepos()).resolves.toEqual([]);

    const unauth = vi.fn(async () => jsonResponse({ message: "Bad credentials" }, { status: 401 }));
    const client2 = new GitHubContentClient({ token: "bad", fetchImpl: unauth });
    await expect(client2.listAccessibleRepos()).rejects.toMatchObject({
      status: 401,
      message: "Bad credentials",
    });
  });

  it("network failure (fetch rejects) propagates rather than masquerading as a clean result", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const client = new GitHubContentClient({ owner: "me", repo: "notes", token: "tok", fetchImpl });
    await expect(client.getFile("index.json")).rejects.toThrow("Failed to fetch");
    await expect(client.putFile("index.json", "x")).rejects.toThrow("Failed to fetch");
  });
});
