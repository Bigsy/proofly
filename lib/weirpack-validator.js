import { MAX_GITHUB_WEIRPACK_FILE_BYTES } from "./weirpack-store.js";

export function isValidWeirpackByteArray(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= MAX_GITHUB_WEIRPACK_FILE_BYTES
    && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);
}

export async function validateWeirpack(bytes) {
  const runtime = globalThis.chrome?.runtime;
  if (!runtime?.sendMessage) throw new Error("Extension runtime is unavailable");
  const response = await runtime.sendMessage({
    type: "harper:validate-weirpack",
    bytes: Array.from(bytes),
  });
  if (response?.type === "harper:weirpack-valid") return response.manifest ?? {};
  throw new Error(response?.error?.message || "Harper rejected the Weirpack");
}
