// Shared by list cards and both popups. Native popovers supply light-dismiss,
// Escape handling and top-layer rendering without clipping the correction card.
export const RULE_MENU_STYLES = `
.rule-menu { margin-left: auto; flex: 0 0 auto; }
.rule-menu__trigger { width: 28px; height: 28px; padding: 0; border: 1px solid var(--border, #2a2f3d); border-radius: 7px; background: var(--panel-2, #1e222e); color: var(--muted, #8b91a3); cursor: pointer; font: bold 18px/1 system-ui; }
.rule-menu__panel, .rule-toast { box-sizing: border-box; pointer-events: auto; color: var(--text, #e6e8ee); background: var(--panel, #171a23); border: 1px solid var(--border, #2a2f3d); border-radius: 9px; padding: 8px; font: 13px/1.5 system-ui; box-shadow: 0 8px 24px #0003; }
.rule-menu__panel { position: fixed; inset: auto; margin: 0; max-width: min(280px, calc(100vw - 16px)); }
.rule-menu__panel button, .rule-toast button { font: inherit; color: inherit; background: transparent; border: 0; border-radius: 5px; padding: 6px 8px; cursor: pointer; text-align: left; overflow-wrap: anywhere; }
.rule-menu__panel button:hover, .rule-toast button:hover { background: var(--panel-2, #292d3a); }
.rule-menu button:focus-visible, .rule-toast button:focus-visible { outline: 2px solid var(--accent, #818cf8); outline-offset: 2px; }
.rule-menu__status:empty { display: none; }
.rule-menu__status { display: block; padding: 4px 8px; }
.rule-toast { position: fixed; inset: auto 12px 12px auto; margin: 0; max-width: calc(100vw - 24px); z-index: 2147483647; }
.rule-toast button { text-decoration: underline; }
`;

function showUndo(root, label, undo) {
  const doc = root.ownerDocument ?? root;
  const toast = doc.createElement("div");
  toast.className = "rule-toast";
  toast.setAttribute("popover", "manual");
  const status = doc.createElement("span");
  status.setAttribute("role", "status");
  status.textContent = `“${label}” turned off.`;
  toast.append(status);
  (root.body ?? root).append(toast);
  toast.showPopover();
  let timer;
  const dismiss = () => { clearTimeout(timer); toast.remove(); };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(dismiss, 8000); };
  toast.addEventListener("pointerenter", () => clearTimeout(timer));
  toast.addEventListener("pointerleave", schedule);
  toast.addEventListener("focusin", () => clearTimeout(timer));
  toast.addEventListener("focusout", schedule);
  if (typeof undo === "function") {
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = "Undo";
    button.addEventListener("click", async () => {
      clearTimeout(timer);
      button.disabled = true;
      try {
        await undo();
        status.textContent = `“${label}” restored.`;
        button.remove();
        schedule();
      } catch {
        status.textContent = "Could not restore this rule. Try again.";
        button.disabled = false;
      }
    });
    toast.append(button);
  }
  schedule();
}

export function buildRuleMenu(c, onDisableRule) {
  if (!onDisableRule || typeof c.rule !== "string" || !c.rule
    || c.rule === "SpellCheck" || c.types?.includes("spelling")) return null;
  const label = c.rule.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const menu = document.createElement("div");
  menu.className = "rule-menu";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "rule-menu__trigger";
  trigger.textContent = "⋯";
  trigger.title = "More options";
  trigger.setAttribute("aria-label", "More options");
  trigger.setAttribute("aria-expanded", "false");
  const panel = document.createElement("div");
  panel.className = "rule-menu__panel";
  panel.setAttribute("popover", "auto");
  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    event.preventDefault();
    panel.hidePopover();
    trigger.focus({ preventScroll: true });
  });
  trigger.popoverTargetElement = panel;
  panel.addEventListener("toggle", (event) => {
    trigger.setAttribute("aria-expanded", String(event.newState === "open"));
    if (event.newState !== "open") return;
    const anchor = trigger.getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - box.height - 8))}px`;
    disable.focus({ preventScroll: true });
  });
  const disable = document.createElement("button");
  disable.type = "button";
  disable.className = "citem__disable-rule";
  disable.textContent = `Turn off “${label}”`;
  disable.title = "Applies to all notes and enabled websites. Re-enable in Settings → Proofreading rules.";
  const status = document.createElement("span");
  status.className = "rule-menu__status";
  status.setAttribute("role", "status");
  disable.addEventListener("click", async () => {
    if (disable.disabled) return;
    const root = menu.getRootNode();
    disable.disabled = true;
    status.textContent = "Saving…";
    try {
      const undo = await onDisableRule(c.rule);
      if (panel.isConnected) panel.hidePopover();
      showUndo(root, label, undo);
    } catch {
      disable.disabled = false;
      status.textContent = "Could not turn off this rule. Try again.";
    }
  });
  panel.append(disable, status);
  menu.append(trigger, panel);
  return menu;
}
