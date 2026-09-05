// Settings UI consumes plain metadata; the offscreen service owns Harper.
export async function initHarperRulesPage({ els, store, loadRules }) {
  let rules = [];
  let settings = {};
  let busy = false;

  function render() {
    const query = els.search.value.trim().toLowerCase();
    const focused = document.activeElement?.dataset.rule;
    els.list.replaceChildren();
    const groups = new Map();
    let count = 0;
    for (const rule of rules) {
      const custom = Object.hasOwn(settings.ruleOverrides ?? {}, rule.name);
      if (els.customOnly.checked && !custom) continue;
      if (!`${rule.name} ${rule.label} ${rule.group} ${rule.description}`.toLowerCase().includes(query)) continue;
      let group = groups.get(rule.group);
      if (!group) {
        group = document.createElement("fieldset");
        group.className = "rule-group";
        const legend = document.createElement("legend");
        legend.textContent = rule.group;
        group.append(legend);
        groups.set(rule.group, group);
        els.list.append(group);
      }
      const row = document.createElement("label");
      row.className = "rule-row";
      const text = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = rule.label;
      const description = document.createElement("small");
      description.textContent = rule.locked
        ? "Kept off because whole-sentence suggestions can hide useful corrections."
        : rule.description;
      text.append(title, description);
      const select = document.createElement("select");
      select.dataset.rule = rule.name;
      select.setAttribute("aria-label", rule.label);
      for (const [value, label] of [["default", `Default (${rule.defaultEnabled ? "on" : "off"})`], ["on", "On"], ["off", "Off"]]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        select.append(option);
      }
      select.value = custom && !rule.locked ? (settings.ruleOverrides[rule.name] ? "on" : "off") : "default";
      select.disabled = busy || rule.locked;
      select.addEventListener("change", () => persist(rule.name, select.value));
      row.append(text, select);
      group.append(row);
      count++;
    }
    els.count.textContent = `${count} ${count === 1 ? "rule" : "rules"} shown`;
    els.reset.disabled = busy || !Object.keys(settings.ruleOverrides ?? {}).length;
    if (focused) [...els.list.querySelectorAll("select")].find((el) => el.dataset.rule === focused)?.focus();
  }

  async function persist(name, value) {
    if (busy) return;
    busy = true;
    render();
    try {
      const current = await store.loadProofingSettings();
      const overrides = name ? { ...current.ruleOverrides } : {};
      if (name && value === "default") delete overrides[name];
      else if (name) overrides[name] = value === "on";
      settings = await store.saveProofingSettings({ ruleOverrides: overrides });
      els.status.textContent = "Saved. Applies to notes and enabled websites.";
    } catch {
      els.status.textContent = "Could not save rules. Try again.";
    } finally {
      busy = false;
      render();
    }
  }

  els.search.addEventListener("input", render);
  els.customOnly.addEventListener("change", render);
  els.reset.addEventListener("click", () => persist(null));
  els.retry.addEventListener("click", load);
  store.onProofingSettingsChanged((next) => { settings = next; render(); });

  async function load() {
    els.retry.hidden = true;
    els.status.textContent = "Loading proofreading rules…";
    try {
      const [nextSettings, response] = await Promise.all([store.loadProofingSettings(), loadRules()]);
      if (response?.type !== "harper:rules" || !Array.isArray(response.rules)) throw new Error("Rules unavailable");
      settings = nextSettings;
      rules = response.rules;
      render();
      els.status.textContent = "Changes save automatically and sync with Chrome.";
    } catch {
      els.status.textContent = "Could not load proofreading rules.";
      els.retry.hidden = false;
    }
  }
  await load();
}
