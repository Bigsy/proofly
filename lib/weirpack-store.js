// Synced Harper Weirpacks. Each archive gets its own storage item so several
// small packs do not collide with Chrome sync's ~8 KB per-item quota.
//
// Write ordering mirrors notes-store:
//   add    = body, then index (an orphaned body is invisible)
//   remove = index, then body (the UI/Harper never sees a missing body)

export const WEIRPACK_INDEX_KEY = "weirpackIndex";
export const WEIRPACK_KEY_PREFIX = "weirpack:";
export const MAX_WEIRPACK_FILE_BYTES = 5600;
export const SYNC_ITEM_QUOTA_BYTES = 8192;

const store = () => globalThis.chrome?.storage?.sync ?? null;
const encoder = new TextEncoder();

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanMetadata(value = {}) {
  return {
    author: cleanText(value.author, 120),
    version: cleanText(value.version, 40),
    description: cleanText(value.description, 500),
  };
}

export function asWeirpackIndex(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const entry of value) {
    const id = cleanText(entry?.id, 64);
    const name = cleanText(entry?.name, 160);
    const size = Number(entry?.size);
    if (!/^[a-f0-9]{32}$/u.test(id) || !name || seen.has(id)
      || !Number.isInteger(size) || size < 1 || size > MAX_WEIRPACK_FILE_BYTES) continue;
    seen.add(id);
    result.push({ id, name, size, ...cleanMetadata(entry) });
  }
  return result;
}

export function bytesToBase64(value) {
  const bytes = value instanceof Uint8Array ? value : Uint8Array.from(value ?? []);
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(value) {
  if (typeof value !== "string" || !value) throw new TypeError("Invalid Weirpack data");
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function contentId(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function itemBytes(key, value) {
  return encoder.encode(key).length + encoder.encode(JSON.stringify(value)).length;
}

export async function loadWeirpackIndex() {
  const sync = store();
  if (!sync) return [];
  try {
    const data = await sync.get(WEIRPACK_INDEX_KEY);
    return asWeirpackIndex(data?.[WEIRPACK_INDEX_KEY]);
  } catch {
    return [];
  }
}

export async function loadWeirpacks() {
  const sync = store();
  if (!sync) return [];
  const index = await loadWeirpackIndex();
  if (!index.length) return [];
  try {
    const keys = index.map(({ id }) => `${WEIRPACK_KEY_PREFIX}${id}`);
    const data = await sync.get(keys);
    const packs = [];
    for (const entry of index) {
      const record = data?.[`${WEIRPACK_KEY_PREFIX}${entry.id}`];
      try {
        const bytes = base64ToBytes(record?.data);
        if (bytes.length !== entry.size) continue;
        packs.push({ ...entry, bytes });
      } catch {
        // A partially synced or corrupt body stays invisible until repaired by
        // the matching body change or a re-import.
      }
    }
    return packs;
  } catch {
    return [];
  }
}

export async function saveWeirpack({ name, bytes: value, manifest = {} } = {}) {
  const sync = store();
  if (!sync) throw new Error("Chrome sync storage is unavailable");
  const bytes = value instanceof Uint8Array ? value : Uint8Array.from(value ?? []);
  if (!bytes.length) throw new Error("The Weirpack is empty");
  if (bytes.length > MAX_WEIRPACK_FILE_BYTES) {
    throw new Error(`Weirpack exceeds the ${MAX_WEIRPACK_FILE_BYTES}-byte sync limit`);
  }

  const id = await contentId(bytes);
  const metadata = cleanMetadata(manifest);
  const entry = {
    id,
    name: cleanText(name, 160) || "Unnamed.weirpack",
    size: bytes.length,
    ...metadata,
  };
  const key = `${WEIRPACK_KEY_PREFIX}${id}`;
  const record = { data: bytesToBase64(bytes) };
  if (itemBytes(key, record) > SYNC_ITEM_QUOTA_BYTES) {
    throw new Error("Weirpack exceeds Chrome's 8 KB sync item quota");
  }

  const current = await loadWeirpackIndex();
  const next = [...current.filter((item) => item.id !== id), entry];
  if (itemBytes(WEIRPACK_INDEX_KEY, next) > SYNC_ITEM_QUOTA_BYTES) {
    throw new Error("Weirpack index exceeds Chrome's 8 KB sync item quota");
  }
  await sync.set({ [key]: record });
  await sync.set({ [WEIRPACK_INDEX_KEY]: next });
  return entry;
}

export async function removeWeirpack(id) {
  const sync = store();
  if (!sync) throw new Error("Chrome sync storage is unavailable");
  if (!/^[a-f0-9]{32}$/u.test(id)) throw new Error("Invalid Weirpack id");
  const current = await loadWeirpackIndex();
  const next = current.filter((entry) => entry.id !== id);
  await sync.set({ [WEIRPACK_INDEX_KEY]: next });
  await sync.remove(`${WEIRPACK_KEY_PREFIX}${id}`);
  return next;
}

export function onWeirpacksChanged(callback) {
  const changed = globalThis.chrome?.storage?.onChanged;
  if (!changed?.addListener) return () => {};
  const listener = (changes, area) => {
    if (area !== "sync" || !changes?.[WEIRPACK_INDEX_KEY]) return;
    callback(asWeirpackIndex(changes[WEIRPACK_INDEX_KEY].newValue));
  };
  changed.addListener(listener);
  return () => changed.removeListener(listener);
}

export function isWeirpackStorageChange(changes) {
  return !!changes && Object.keys(changes).some((key) =>
    key === WEIRPACK_INDEX_KEY || key.startsWith(WEIRPACK_KEY_PREFIX));
}
