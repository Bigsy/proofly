import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

test.use({ channel: process.env.PROOFLY_BROWSER_CHANNEL || "chrome" });

test.beforeEach(async ({ page }) => {
  await page.route("http://proofly.test/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/") {
      return route.fulfill({ contentType: "text/html", body: '<link rel="stylesheet" href="/sidepanel.css"><textarea id="editor"></textarea><div id="popup" class="popup" hidden></div>' });
    }
    const body = await readFile(path.join(process.cwd(), pathname));
    return route.fulfill({ contentType: pathname.endsWith(".css") ? "text/css" : "text/javascript", body });
  });
  await page.goto("http://proofly.test/");
});

for (const surface of ["panel", "page"]) {
  test(`${surface}: compact spelling and native rule menu with durable Undo`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 380, height: 500 });
    await page.evaluate(async (surface) => {
      const correction = { startIndex: 0, endIndex: 3, correction: "milk", suggestions: [{ replacement: "milk" }, { replacement: "milky" }], rule: "SpellCheck" };
      const onDisableRule = async () => {
        window.renderer.hidePopup();
        window.disabledRule = true;
        return async () => { window.disabledRule = false; };
      };
      if (surface === "page") {
        const { createOverlayRenderer } = await import("/page/content/highlights.js");
        window.renderer = createOverlayRenderer();
        window.show = (rule) => window.renderer.showPopup("mlk", { ...correction, rule }, 0, 330, 460, {
          onDisableRule, onAddToDictionary: rule === "SpellCheck" ? () => {} : undefined,
        });
      } else {
        const { initRender } = await import("/ui/render.js");
        window.renderer = initRender({
          els: { popup: document.querySelector("#popup"), editor: document.querySelector("#editor") },
          syncScroll: () => {}, onDisableRule, onAddToDictionary: () => {},
          getCandidate: (c) => c.rule === "SpellCheck" ? "mlk" : null,
        });
        window.show = (rule) => window.renderer.showPopup("mlk", { ...correction, rule }, 0, 330, 460);
      }
      window.show("SpellCheck");
    }, surface);
    const popup = page.locator(surface === "page" ? "#proofly-highlight-host .popup" : "#popup");
    await expect(popup.locator(".popup__dict")).toBeVisible();
    await expect(popup.locator(".rule-menu")).toHaveCount(0);
    await expect(popup.locator(".citem__rule")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("spelling.png") });
    await page.evaluate(() => window.show("RepeatedWords"));
    const trigger = popup.getByRole("button", { name: "More options" });
    const disable = popup.getByRole("button", { name: "Turn off “Repeated Words”" });
    await trigger.click();
    await expect(disable).toBeVisible();
    await expect(disable).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("rule-menu.png") });
    const box = await disable.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(500);
    await page.keyboard.press("Escape");
    await expect(disable).toBeHidden();
    await expect(popup).toBeVisible();
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(disable).toBeVisible();
    await page.locator("#editor").click();
    await expect(disable).toBeHidden();
    await page.evaluate(() => window.show("RepeatedWords"));
    await trigger.click();
    await disable.click();
    const undo = page.getByRole("button", { name: "Undo", exact: true });
    await expect(undo).toBeVisible();
    await expect(popup).toBeHidden();
    expect(await page.evaluate(() => window.disabledRule)).toBe(true);
    await undo.click();
    expect(await page.evaluate(() => window.disabledRule)).toBe(false);
    await expect(page.getByRole("status").filter({ hasText: "restored." })).toBeVisible();
  });
}
