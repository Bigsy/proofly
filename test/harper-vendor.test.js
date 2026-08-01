import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("Harper store assets", () => {
  it("are the exact pinned 2.7.0 files", () => {
    expect(() => execFileSync("bash", ["tools/vendor-harper.sh", "--check"], {
      cwd: root,
      stdio: "pipe",
    })).not.toThrow();
  });

  it("are included by store packaging without node_modules", () => {
    const script = readFileSync(join(root, "tools/package-store.sh"), "utf8");
    expect(script).toContain("tools/vendor-harper.sh --check");
    expect(script).toMatch(/\n\s+vendor \\\n/);
    expect(script).toMatch(/\n\s+THIRD_PARTY_NOTICES\.md \\\n/);
    expect(script).not.toMatch(/\n\s+node_modules \\\n/);
  });

  it("stay within the 20 MiB installed runtime budget", () => {
    const files = ["index.js", "BinaryModule-Aj1vLnwf.js", "binary.js", "harper_wasm_bg.wasm", "LICENSE"];
    const bytes = files.reduce((total, file) => total + statSync(join(root, "vendor/harper", file)).size, 0);
    expect(bytes).toBeLessThanOrEqual(20 * 1024 * 1024);
  });
});
