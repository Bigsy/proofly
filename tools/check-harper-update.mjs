#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const installed = pkg.devDependencies?.["harper.js"];

if (typeof installed !== "string" || !installed) {
  throw new Error("package.json does not pin harper.js in devDependencies");
}

const registry = process.env.npm_config_registry || "https://registry.npmjs.org/";
const latestUrl = new URL("harper.js/latest", registry.endsWith("/") ? registry : `${registry}/`);
const response = await fetch(latestUrl, {
  headers: { Accept: "application/json" },
  signal: AbortSignal.timeout(15_000),
});
if (!response.ok) {
  throw new Error(`npm registry returned ${response.status} for harper.js`);
}
const latest = (await response.json())?.version;

if (typeof latest !== "string" || !latest) {
  throw new Error("npm did not return a latest version for harper.js");
}

console.log(`Pinned harper.js: ${installed}`);
console.log(`Latest harper.js on npm: ${latest}`);
console.log(installed === latest
  ? "Proofly already uses the latest published Harper release."
  : `Harper ${latest} is available; review and vendor it before changing the pin.`);
