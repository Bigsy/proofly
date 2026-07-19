import { describe, expect, it } from "vitest";
import manifest from "../manifest.json" with { type: "json" };

describe("manifest module exposure", () => {
  it("keeps nested content-script modules web accessible for bootstrap import chains", () => {
    const resources = manifest.web_accessible_resources.flatMap((entry) => entry.resources);
    expect(resources).toContain("page/content/*");
    expect(resources).toContain("page/content/adapters/*");
    expect(resources).toContain("page/content/bridge/*");
    expect(resources).toContain("lib/*");
    expect(resources).toContain("ui/correction-card.js");
    expect(resources).toContain("ui/icons.js");
  });

  it("allows one offscreen Harper worker to load packaged WASM under MV3 CSP", () => {
    expect(manifest.permissions).toContain("offscreen");
    expect(manifest.content_security_policy?.extension_pages)
      .toBe("script-src 'self' 'wasm-unsafe-eval'; object-src 'self'");
  });
});
