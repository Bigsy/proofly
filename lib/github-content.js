// lib/github-content.js — tiny GitHub Contents API client for notes sync.
// No chrome/DOM coupling; fetch is injected for tests.

const API = "https://api.github.com";

export class GitHubContentError extends Error {
  constructor(message, { status = 0, response = null, permissions = "", expiration = "" } = {}) {
    super(message);
    this.name = "GitHubContentError";
    this.status = status;
    this.response = response;
    this.permissions = permissions;
    this.expiration = expiration;
    this.retryableConflict = status === 409 || status === 422;
  }
}

function header(res, name) {
  return res?.headers?.get?.(name) ?? "";
}

async function readJson(res) {
  try { return await res.json(); } catch { return null; }
}

function utf8ToBase64(text) {
  return bytesToBase64(new TextEncoder().encode(text));
}

function bytesToBase64(value) {
  const bytes = value instanceof Uint8Array ? value : Uint8Array.from(value ?? []);
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

function base64ToUtf8(value) {
  return new TextDecoder().decode(base64ToBytes(value));
}

function base64ToBytes(value) {
  const binary = atob(String(value ?? "").replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

export class GitHubContentClient {
  constructor({ owner, repo, branch = "main", token, fetchImpl = globalThis.fetch } = {}) {
    this.owner = owner;
    this.repo = repo;
    this.branch = branch || "main";
    this.token = token;
    this.fetch = fetchImpl?.bind?.(globalThis) ?? fetchImpl;
  }

  async request(path, options = {}) {
    if (!this.fetch) throw new GitHubContentError("fetch is not available");
    const res = await this.fetch(`${API}${path}`, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(options.headers ?? {}),
      },
    });
    if (res.ok) return res;
    const body = await readJson(res);
    throw new GitHubContentError(
      body?.message || `GitHub request failed (${res.status})`,
      {
        status: res.status,
        response: body,
        permissions: header(res, "X-Accepted-GitHub-Permissions"),
        expiration: header(res, "GitHub-Authentication-Token-Expiration"),
      },
    );
  }

  contentPath(path) {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}` +
      `/contents/${encodePath(path)}`;
  }

  async getFile(path) {
    let res;
    try {
      res = await this.request(`${this.contentPath(path)}?ref=${encodeURIComponent(this.branch)}`);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
    const data = await readJson(res);
    if (!data || data.type !== "file") return null;
    if (typeof data.content === "string" && data.content) {
      return { path, sha: data.sha, content: base64ToUtf8(data.content), json: data };
    }
    if (data.git_url) {
      const blobRes = await this.request(data.git_url.replace(API, ""));
      const blob = await readJson(blobRes);
      if (typeof blob?.content === "string") {
        return { path, sha: data.sha, content: base64ToUtf8(blob.content), json: data };
      }
    }
    if (data.download_url) {
      const raw = await this.fetch(data.download_url, {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      });
      if (!raw.ok) {
        throw new GitHubContentError(`GitHub raw download failed (${raw.status})`, { status: raw.status });
      }
      return { path, sha: data.sha, content: await raw.text(), json: data };
    }
    throw new GitHubContentError(`GitHub did not return file content for ${path}`);
  }

  async getFileBytes(path) {
    let res;
    try {
      res = await this.request(`${this.contentPath(path)}?ref=${encodeURIComponent(this.branch)}`);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
    const data = await readJson(res);
    if (!data || data.type !== "file") return null;
    if (typeof data.content === "string" && data.content) {
      return { path, sha: data.sha, bytes: base64ToBytes(data.content), json: data };
    }
    if (data.git_url) {
      const blobRes = await this.request(data.git_url.replace(API, ""));
      const blob = await readJson(blobRes);
      if (typeof blob?.content === "string") {
        return { path, sha: data.sha, bytes: base64ToBytes(blob.content), json: data };
      }
    }
    if (data.download_url) {
      const raw = await this.fetch(data.download_url, {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      });
      if (!raw.ok) {
        throw new GitHubContentError(`GitHub raw download failed (${raw.status})`, { status: raw.status });
      }
      return { path, sha: data.sha, bytes: new Uint8Array(await raw.arrayBuffer()), json: data };
    }
    throw new GitHubContentError(`GitHub did not return file content for ${path}`);
  }

  async putFile(path, content, { sha, message } = {}) {
    const body = {
      message: message || `Update ${path}`,
      content: utf8ToBase64(content),
      branch: this.branch,
      ...(sha ? { sha } : {}),
    };
    const res = await this.request(this.contentPath(path), {
      method: "PUT",
      body: JSON.stringify(body),
    });
    const data = await readJson(res);
    return { sha: data?.content?.sha, commit: data?.commit, json: data };
  }

  async putFileBytes(path, bytes, { sha, message } = {}) {
    const body = {
      message: message || `Update ${path}`,
      content: bytesToBase64(bytes),
      branch: this.branch,
      ...(sha ? { sha } : {}),
    };
    const res = await this.request(this.contentPath(path), {
      method: "PUT",
      body: JSON.stringify(body),
    });
    const data = await readJson(res);
    return { sha: data?.content?.sha, commit: data?.commit, json: data };
  }

  async deleteFile(path, { sha, message } = {}) {
    if (!sha) return null;
    try {
      const res = await this.request(this.contentPath(path), {
        method: "DELETE",
        body: JSON.stringify({
          message: message || `Delete ${path}`,
          sha,
          branch: this.branch,
        }),
      });
      return readJson(res);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  async validate() {
    const res = await this.request(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`,
    );
    const repo = await readJson(res);
    return {
      repo,
      permissions: header(res, "X-Accepted-GitHub-Permissions"),
      expiration: header(res, "GitHub-Authentication-Token-Expiration"),
    };
  }

  async listAccessibleRepos() {
    const res = await this.request("/user/repos?per_page=100&affiliation=owner,collaborator");
    const repos = await readJson(res);
    return Array.isArray(repos) ? repos : [];
  }
}

export async function discoverTokenRepos(token, { fetchImpl = globalThis.fetch } = {}) {
  const client = new GitHubContentClient({ token, fetchImpl });
  return client.listAccessibleRepos();
}
