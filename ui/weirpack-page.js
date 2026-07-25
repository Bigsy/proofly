import { MAX_WEIRPACK_FILE_BYTES } from "../lib/weirpack-store.js";

const displayName = (entry) => {
  const details = [entry.author, entry.version && `v${entry.version}`].filter(Boolean);
  return details.length ? `${entry.name} · ${details.join(" · ")}` : entry.name;
};

export function initWeirpackPage({ els, store, validate }) {
  let packs = [];

  function report(message, isError = false) {
    els.status.textContent = message;
    els.status.classList.toggle("error", isError);
  }

  function draw() {
    els.list.textContent = "";
    els.empty.hidden = !!packs.length;
    for (const pack of packs) {
      const li = document.createElement("li");
      li.className = "weirpack";

      const details = document.createElement("div");
      details.className = "weirpack__details";
      const title = document.createElement("strong");
      title.textContent = displayName(pack);
      const meta = document.createElement("span");
      meta.textContent = pack.description || `${pack.size.toLocaleString()} bytes`;
      details.append(title, meta);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn--danger";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${pack.name}`);
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          packs = await store.removeWeirpack(pack.id);
          report(`Removed ${pack.name}.`);
          draw();
        } catch (error) {
          remove.disabled = false;
          report(`Couldn't remove: ${error?.message || error}`, true);
        }
      });
      li.append(details, remove);
      els.list.append(li);
    }
  }

  async function importSelected() {
    const [file] = els.file.files ?? [];
    els.file.value = "";
    if (!file) return;
    if (file.size > MAX_WEIRPACK_FILE_BYTES) {
      report(
        `That pack is too large to sync (${file.size.toLocaleString()} bytes; `
          + `maximum ${MAX_WEIRPACK_FILE_BYTES.toLocaleString()}).`,
        true,
      );
      return;
    }

    els.importBtn.disabled = true;
    report(`Checking ${file.name} with Harper…`);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const manifest = await validate(bytes);
      const saved = await store.saveWeirpack({ name: file.name, bytes, manifest });
      packs = [...packs.filter((pack) => pack.id !== saved.id), saved];
      report(`Imported ${file.name}.`);
      draw();
    } catch (error) {
      report(`Couldn't import: ${error?.message || error}`, true);
    } finally {
      els.importBtn.disabled = false;
    }
  }

  els.importBtn.addEventListener("click", () => els.file.click());
  els.file.addEventListener("change", importSelected);
  store.onWeirpacksChanged((next) => {
    packs = next;
    draw();
  });

  draw();
  const ready = store.loadWeirpackIndex().then((loaded) => {
    packs = loaded;
    draw();
  });
  return { ready };
}
