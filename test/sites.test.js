// lib/sites.js — pure helpers behind the per-site enable list.

import { describe, expect, it } from "vitest";
import { asSiteMap, originPattern, patternLabel, samePattern } from "../lib/sites.js";

describe("originPattern", () => {
  it("maps an http(s) URL to its per-site match pattern", () => {
    expect(originPattern("https://github.com/owner/repo?x=1#y")).toBe("https://github.com/*");
    expect(originPattern("http://example.com/")).toBe("http://example.com/*");
  });

  it("drops ports — match patterns ignore them", () => {
    expect(originPattern("http://localhost:8080/fixture.html")).toBe("http://localhost/*");
  });

  it("returns null for pages that can't host the feature", () => {
    for (const url of [
      "chrome://extensions",
      "chrome-extension://abc/sidepanel.html",
      "about:blank",
      "file:///tmp/page.html",
      "not a url",
      "",
    ]) {
      expect(originPattern(url), url).toBe(null);
    }
  });
});

describe("patternLabel", () => {
  it("reduces a pattern to its hostname for UI labels", () => {
    expect(patternLabel("https://github.com/*")).toBe("github.com");
    expect(patternLabel("http://example.com/*")).toBe("example.com");
  });
});

describe("samePattern", () => {
  it("matches a port-carrying adopted pattern against the page's own portless derivation", () => {
    // The teardown-broadcast case: intent adopted from Chrome's site-access
    // menu can carry a port; originPattern(location.href) never does.
    expect(samePattern("http://localhost:3000/*", originPattern("http://localhost:3000/app"))).toBe(true);
    expect(samePattern("http://127.0.0.1:8080/*", "http://127.0.0.1/*")).toBe(true);
    expect(samePattern("https://github.com/*", "https://github.com/*")).toBe(true);
  });

  it("still distinguishes different hosts and schemes", () => {
    expect(samePattern("https://github.com/*", "https://gitlab.com/*")).toBe(false);
    expect(samePattern("http://github.com/*", "https://github.com/*")).toBe(false);
    expect(samePattern(null, "https://github.com/*")).toBe(false);
  });
});

describe("asSiteMap", () => {
  it("passes through a plain object and rejects everything else", () => {
    const map = { "https://a.com/*": true };
    expect(asSiteMap(map)).toBe(map);
    expect(asSiteMap(null)).toEqual({});
    expect(asSiteMap(undefined)).toEqual({});
    expect(asSiteMap(["https://a.com/*"])).toEqual({});
    expect(asSiteMap("nope")).toEqual({});
  });
});
