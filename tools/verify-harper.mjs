import { performance } from "node:perf_hooks";
import { readFile, stat } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
import { Dialect, LocalLinter } from "../vendor/harper/index.js";
import { binary } from "../vendor/harper/binary.js";

const files = ["index.js", "BinaryModule-Aj1vLnwf.js", "binary.js", "harper_wasm_bg.wasm", "LICENSE"];
const paths = files.map((file) => new URL(`../vendor/harper/${file}`, import.meta.url));
const installedBytes = (await Promise.all(paths.map((path) => stat(path))))
  .reduce((total, item) => total + item.size, 0);
const compressedBytes = (await Promise.all(paths.map((path) => readFile(path))))
  .reduce((total, contents) => total + deflateRawSync(contents, { level: 9 }).length, 0);

const rssBefore = process.memoryUsage().rss;
const linter = new LocalLinter({ binary, dialect: Dialect.American });
const coldStarted = performance.now();
await linter.setup();
const coldMs = performance.now() - coldStarted;
const text = ("However this is wierd text. ").repeat(150).slice(0, 4000);
const warmup = await linter.lint(text, { language: "plaintext" });
warmup.forEach((lint) => lint.free());
const warmStarted = performance.now();
const result = await linter.lint(text, { language: "plaintext" });
const warmMs = performance.now() - warmStarted;
result.forEach((lint) => lint.free());
const rssDeltaBytes = process.memoryUsage().rss - rssBefore;
linter.dispose();

const measurements = {
  installedMiB: +(installedBytes / 1024 / 1024).toFixed(2),
  compressedMiB: +(compressedBytes / 1024 / 1024).toFixed(2),
  coldMs: Math.round(coldMs),
  warm4000Ms: Math.round(warmMs),
  localNodeRssDeltaMiB: +(rssDeltaBytes / 1024 / 1024).toFixed(1),
};
console.log(JSON.stringify(measurements, null, 2));

const failures = [];
if (installedBytes > 20 * 1024 * 1024) failures.push("installed runtime exceeds 20 MiB");
if (compressedBytes > 9 * 1024 * 1024) failures.push("compressed runtime exceeds 9 MiB");
if (coldMs > 1500) failures.push("cold setup exceeds 1.5 seconds");
if (warmMs > 100) failures.push("warm 4,000-code-unit lint exceeds 100 ms");
if (failures.length) throw new Error(failures.join("; "));
