import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(__dirname, "../..");
const fixturesDir = path.resolve(__dirname, "../fixtures/pages");
const EXTENSION_ID = "oebafepfakiffjipnmgehgckkmphplng";
const PLAYWRIGHT_DEFAULT_DISABLED_FEATURES =
  "--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion";
const BROWSER_VISIBLE = process.env.PROOFLY_BROWSER_VISIBLE === "1";
// Default to new-headless so the window never pops to the front on macOS. Headed
// is opt-in: when running the real model (needs a GPU-backed window), when visible
// mode is requested, or when headless is explicitly disabled.
const BROWSER_HEADLESS = process.env.PROOFLY_BROWSER_HEADLESS === "1"
  || (process.env.PROOFLY_BROWSER_HEADLESS !== "0"
    && !BROWSER_VISIBLE
    && process.env.PROOFLY_USE_REAL_MODEL !== "1");
const BACKGROUND_BROWSER_ARGS = BROWSER_HEADLESS || BROWSER_VISIBLE
  ? []
  : ["--start-minimized", "--window-position=-32000,-32000", "--window-size=1280,900"];

let server;
let baseURL;
let context;
let userDataDir;
let worker;
let controllerPage;
let preflightSkip = "";

test.setTimeout(60_000);

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/node_modules/") || url.pathname.startsWith("/page/")) {
      serveFile(res, path.join(extensionRoot, path.normalize(url.pathname)));
      return;
    }
    const pathname = url.pathname === "/" ? "/textarea.html" : url.pathname;
    serveFile(res, path.join(fixturesDir, path.normalize(pathname)), fixturesDir);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;

  userDataDir = process.env.PROOFLY_BROWSER_PROFILE
    || path.join(os.homedir(), ".proofly-chrome-beta-dev");
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: process.env.PROOFLY_BROWSER_CHANNEL || "chrome-beta",
    headless: BROWSER_HEADLESS,
    ignoreDefaultArgs: [
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-extensions",
      "--disable-component-extensions-with-background-pages",
      "--use-mock-keychain",
      PLAYWRIGHT_DEFAULT_DISABLED_FEATURES,
    ],
    args: [
      PLAYWRIGHT_DEFAULT_DISABLED_FEATURES.replace(",OptimizationHints", ""),
      ...BACKGROUND_BROWSER_ARGS,
    ],
  });
  await minimizeBrowserWindow();
  await closeAllPages();

  try {
    const browserSession = await context.browser().newBrowserCDPSession();
    const { id } = await browserSession.send("Extensions.loadUnpacked", {
      path: extensionRoot,
    });
    if (id !== EXTENSION_ID) {
      preflightSkip = `Proofly loaded with unexpected extension ID: ${id}`;
    } else {
      await reloadExtensionWithCDP(browserSession, id);
      const reloaded = await browserSession.send("Extensions.loadUnpacked", {
        path: extensionRoot,
      });
      if (reloaded.id !== EXTENSION_ID) {
        preflightSkip = `Proofly reloaded with unexpected extension ID: ${reloaded.id}`;
      }
    }
  } catch (error) {
    preflightSkip = `Proofly could not be loaded into Chrome Beta via CDP: ${error.message}`;
  }

  const preflight = await context.newPage();
  try {
    if (!preflightSkip) {
      await preflight.goto(`chrome-extension://${EXTENSION_ID}/manifest.json`, { timeout: 3000 });
      await expect(preflight.locator("body")).toContainText('"name": "Proofly"', { timeout: 3000 });
    }
  } catch {
    preflightSkip =
      "Proofly is not enabled in the Chrome Beta dev profile. Use the AGENTS.md MCP flow: list_extensions, uninstall stale disabled Proofly if needed, then install_extension for the repo root.";
  } finally {
    await preflight.close().catch(() => {});
  }

  [worker] = context.serviceWorkers().filter((candidate) =>
    candidate.url().startsWith(`chrome-extension://${EXTENSION_ID}/`));
  if (!worker && !preflightSkip) {
    try {
      worker = await context.waitForEvent("serviceworker", {
        timeout: 1000,
        predicate: (candidate) => candidate.url().startsWith(`chrome-extension://${EXTENSION_ID}/`),
      });
    } catch {
      worker = null;
    }
  }

  if (!preflightSkip) {
    try {
      await grantFixtureHostPermission();
    } catch (error) {
      preflightSkip = `Proofly could not be granted fixture host permission: ${error.message}`;
    }
  }
  await closeAllPages();
  if (!preflightSkip && !worker) {
    try {
      worker = await openExtensionController();
    } catch (error) {
      preflightSkip = `Proofly extension controller could not start: ${error.message}`;
    }
  }
});

test.afterEach(async () => {
  await closeAllPages();
});

test.afterAll(async () => {
  await closeAllPages();
  await context?.close();
  await new Promise((resolve) => server?.close(resolve));
});

test("controlled textarea fixture runs through the extension content path", async () => {
  test.skip(!!preflightSkip, preflightSkip);
  const page = await context.newPage();
  await page.goto(`${baseURL}/controlled-input.html`);
  await injectProofly(page);
  await expect(page.locator("html[data-proofly-test-stub='loaded']")).toHaveCount(1, { timeout: 5000 });
  const field = page.locator("#field");
  await field.fill("I seen teh result.");
  await expect(page.locator("#proofly-highlight-host")).toHaveCount(1, { timeout: 5000 });
  await expect(page.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelectorAll(".squiggle-box").length)).resolves.toBeGreaterThan(0);

  await field.evaluate((el) => {
    el.setSelectionRange(3, 3);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 30, clientY: 30 }));
  });
  await expect(page.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelector(".popup")?.hidden === false)).resolves.toBe(true);
  await page.locator("#proofly-highlight-host").evaluate((host) => {
    host.shadowRoot.querySelector(".citem__choice").click();
  });
  await expect(field).toHaveValue("I saw teh result.");
  await expect(page.evaluate(() => window.__fixture.log)).resolves.toContainEqual({
    type: "change",
    value: "I saw teh result.",
  });
});

test("controlled textarea fixture applies the clicked suggestion only", async () => {
  test.skip(!!preflightSkip, preflightSkip);
  const page = await context.newPage();
  await page.goto(`${baseURL}/controlled-input.html`);
  await injectProofly(page);
  await expect(page.locator("html[data-proofly-test-stub='loaded']")).toHaveCount(1, { timeout: 5000 });

  const field = page.locator("#field");
  await field.fill("I seen teh result.");
  await expect(page.locator("#proofly-highlight-host")).toHaveCount(1, { timeout: 5000 });
  await expect.poll(async () => page.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelectorAll(".squiggle-box").length), { timeout: 5000 }).toBe(2);

  await field.evaluate((el) => {
    el.setSelectionRange(3, 3);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 30, clientY: 30 }));
  });
  await expect(page.locator("#proofly-highlight-host").evaluate((host) =>
    [...host.shadowRoot.querySelectorAll(".popup__actions .btn")].map((button) => button.getAttribute("aria-label")))).resolves.toEqual([
    "Dismiss for now",
  ]);

  await page.locator("#proofly-highlight-host").evaluate((host) => {
    host.shadowRoot.querySelector(".citem__choice").click();
  });
  await expect(field).toHaveValue("I saw teh result.");
  await expect(page.evaluate(() => window.__fixture.log.at(-1))).resolves.toEqual({
    type: "change",
    value: "I saw teh result.",
  });
});

test("correction click stays inside a dialog with outside-pointer dismissal", async () => {
  test.skip(!!preflightSkip, preflightSkip);
  const page = await context.newPage();
  await page.goto(`${baseURL}/textarea.html`);
  await page.evaluate(() => {
    const field = document.getElementById("field");
    const dialog = document.createElement("div");
    dialog.id = "review-dialog";
    dialog.setAttribute("role", "dialog");
    field.before(dialog);
    dialog.appendChild(field);
    document.addEventListener("pointerdown", (event) => {
      if (!dialog.contains(event.target)) dialog.remove();
    }, true);
  });
  await injectProofly(page);

  const field = page.locator("#field");
  await field.fill("I seen it.");
  await expect(page.locator("#proofly-highlight-host")).toHaveCount(1, { timeout: 5000 });
  await expect.poll(async () => page.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelectorAll(".squiggle-box").length), { timeout: 5000 }).toBe(1);

  await field.evaluate((el) => {
    el.setSelectionRange(3, 3);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 30, clientY: 30 }));
  });
  await page.locator("#proofly-highlight-host .citem__choice").click();

  await expect(page.locator("#review-dialog")).toHaveCount(1);
  await expect(field).toHaveValue("I saw it.");
});

test("same-origin iframe gets its own single content-script engine", async () => {
  test.skip(!!preflightSkip, preflightSkip);
  const page = await context.newPage();
  await page.goto(`${baseURL}/iframe-parent.html`);
  await injectProofly(page);
  await expect(page.locator("html[data-proofly-test-stub='loaded']")).toHaveCount(1, { timeout: 5000 });
  const frame = page.frameLocator("#child");
  await expect(frame.locator("html[data-proofly-test-stub='loaded']")).toHaveCount(1, { timeout: 5000 });
  await frame.locator("#field").fill("I seen it.");
  await expect(frame.locator("#proofly-highlight-host")).toHaveCount(1, { timeout: 5000 });
  await expect(frame.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelectorAll(".squiggle-box").length)).resolves.toBeGreaterThan(0);

  await page.locator("#field").fill("I seen it.");
  await expect(page.locator("#proofly-highlight-host")).toHaveCount(1, { timeout: 5000 });
});

test("about:blank and srcdoc frames inherit the enabled origin without duplicate engines", async () => {
  test.skip(!!preflightSkip, preflightSkip);
  await expectFixtureRegistration({ matchOriginAsFallback: true });
  const page = await context.newPage();
  await page.goto(`${baseURL}/iframe-fallback-parent.html`);

  await expect.poll(async () => {
    const frames = await inspectProoflyFrames(page);
    return loadedFrameSummary(frames);
  }, { timeout: 5000 }).toEqual({
    total: 3,
    loaded: 3,
    aboutBlank: true,
    srcdoc: true,
  });

  await injectProofreaderStub(page);
  const aboutBlank = page.frameLocator("#about-blank");
  const srcdoc = page.frameLocator("#srcdoc");
  await expect(aboutBlank.locator("html[data-proofly-test-stub='loaded']")).toHaveCount(1, { timeout: 5000 });
  await expect(srcdoc.locator("html[data-proofly-test-stub='loaded']")).toHaveCount(1, { timeout: 5000 });

  await aboutBlank.locator("#field").fill("I seen it.");
  await expect(aboutBlank.locator("#proofly-highlight-host")).toHaveCount(1, { timeout: 5000 });
  await expect(aboutBlank.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelectorAll(".squiggle-box").length)).resolves.toBeGreaterThan(0);

  await srcdoc.locator("#field").fill("I seen it.");
  await expect(srcdoc.locator("#proofly-highlight-host")).toHaveCount(1, { timeout: 5000 });
  await expect(srcdoc.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelectorAll(".squiggle-box").length)).resolves.toBeGreaterThan(0);

  const frames = await inspectProoflyFrames(page);
  for (const frame of frames) expect(frame.hostCount).toBeLessThanOrEqual(1);
});

test("gated contenteditable fixture reads, renders, and applies through the snapshot path", async () => {
  test.skip(!!preflightSkip, preflightSkip);
  const page = await context.newPage();
  await page.goto(`${baseURL}/rich-editor-gated.html`);
  await injectProofly(page);
  await expect(page.locator("html[data-proofly-test-stub='loaded']")).toHaveCount(1, { timeout: 5000 });

  const field = page.locator("#field");
  await field.evaluate((el) => {
    el.focus();
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#proofly-highlight-host")).toHaveCount(1, { timeout: 5000 });
  await expect(page.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelectorAll(".squiggle-box").length)).resolves.toBeGreaterThan(0);

  await field.evaluate((el) => {
    const text = el.querySelector("span").firstChild;
    const range = document.createRange();
    range.setStart(text, 3);
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 30, clientY: 30 }));
  });
  await expect(page.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelector(".popup")?.hidden === false)).resolves.toBe(true);

  await field.evaluate((el) => {
    window.__prooflyApplyInputs = 0;
    el.addEventListener("input", () => { window.__prooflyApplyInputs += 1; }, { once: true });
  });
  await page.locator("#proofly-highlight-host").evaluate((host) => {
    host.shadowRoot.querySelector(".citem__choice").click();
  });
  await expect(field).toContainText("I saw it.");
  await expect(page.evaluate(() => window.__prooflyApplyInputs)).resolves.toBe(1);
});

test("gated contenteditable writeback covers insertion, deletion, multi-node, selection, and stale refusal", async () => {
  test.skip(!!preflightSkip, preflightSkip);
  const page = await context.newPage();
  await page.goto(`${baseURL}/rich-editor-gated.html`);
  await injectProofly(page);
  await expect(page.locator("html[data-proofly-test-stub='loaded']")).toHaveCount(1, { timeout: 5000 });

  const field = page.locator("#field");
  await installRichEditorEventCounters(field);

  await exerciseRichEditorApply(page, {
    html: '<p><span id="target">In France we ate.</span></p>',
    selector: "#target",
    clickOffset: 4,
    expectedText: "In France, we ate.",
    expectedCaret: 10,
    expectedBeforeInput: { inputType: "insertReplacementText", data: ",", ranges: 0 },
  });

  await exerciseRichEditorApply(page, {
    html: '<p><span id="target">very very good</span></p>',
    selector: "#target",
    clickOffset: 2,
    expectedText: "very good",
    expectedCaret: 0,
    expectedBeforeInput: { inputType: "insertReplacementText", data: "", ranges: 0 },
  });

  await exerciseRichEditorApply(page, {
    html: '<p><span id="target">I se</span><strong>en</strong><span> it.</span></p>',
    selector: "#target",
    clickOffset: 4,
    expectedText: "I saw it.",
    expectedCaret: 5,
    expectedBeforeInput: { inputType: "insertReplacementText", data: "saw", ranges: 0 },
  });

  await prepareRichEditorCase(page, '<p><span id="target">I seen it.</span></p>');
  await clickRichEditorCorrection(page, "#target", 3);
  await expect(page.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelector(".popup")?.hidden === false)).resolves.toBe(true);
  await field.evaluate((el) => {
    window.__prooflyApplyInputs = 0;
    window.__prooflyBeforeInputs = [];
    el.querySelector("#target").firstChild.data = "I seen it stale.";
  });
  await page.locator("#proofly-highlight-host").evaluate((host) => {
    host.shadowRoot.querySelector(".citem__choice").click();
  });
  await expect(field.evaluate((el) => el.textContent)).resolves.toBe("I seen it stale.");
  await expect(page.evaluate(() => window.__prooflyApplyInputs)).resolves.toBe(0);
  await expect(page.evaluate(() => window.__prooflyBeforeInputs)).resolves.toEqual([]);
});

test("pinned ProseMirror fixture keeps framework state aligned after apply", async () => {
  test.skip(!!preflightSkip, preflightSkip);
  const page = await context.newPage();
  await page.goto(`${baseURL}/prosemirror-pinned.html`);
  await expect(page.locator("#field.ProseMirror")).toHaveCount(1, { timeout: 5000 });
  await injectProofly(page);
  await expect(page.locator("html[data-proofly-test-stub='loaded']")).toHaveCount(1, { timeout: 5000 });

  const field = page.locator("#field");
  await field.evaluate((el) => {
    el.focus();
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect.poll(async () => page.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelectorAll(".squiggle-box").length), { timeout: 5000 }).toBeGreaterThan(0);

  await field.evaluate((el) => {
    const text = window.__fixture.textNodeContaining("seen");
    const range = document.createRange();
    range.setStart(text, text.nodeValue.indexOf("seen") + 1);
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 30, clientY: 30 }));
  });
  await expect(page.evaluate(() => {
    const sel = getSelection();
    const node = sel?.anchorNode;
    return {
      anchorText: node?.nodeValue ?? null,
      anchorOffset: sel?.anchorOffset ?? null,
      stateText: window.__fixture.stateText,
      widgetCount: window.__fixture.widgetCount,
    };
  })).resolves.toMatchObject({
    anchorText: /seen/,
    stateText: "I seen it.",
    widgetCount: 0,
  });
  await expect(page.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelector(".popup")?.hidden === false)).resolves.toBe(true);

  await page.evaluate(() => { window.__fixture.inputEvents = 0; });
  await page.locator("#proofly-highlight-host").evaluate((host) => {
    host.shadowRoot.querySelector(".citem__choice").click();
  });
  await expect(field).toContainText("I saw it.");
  await expect(page.evaluate(() => window.__fixture.stateText)).resolves.toBe("I saw it.");
  await expect(page.evaluate(() => window.__fixture.inputEvents)).resolves.toBe(1);
  await expect(page.evaluate(() => window.__fixture.transactions.at(-1)?.doc)).resolves.toBe("I saw it.");
  await expect(page.evaluate(() => window.__fixture.widgetCount)).resolves.toBe(0);
  await expect(page.evaluate(() => window.__fixture.selection)).resolves.toEqual({ from: 6, to: 6 });

  await expect(page.evaluate(() => window.__fixture.undo())).resolves.toBe(true);
  await expect(page.evaluate(() => window.__fixture.stateText)).resolves.toBe("I seen it.");
  await expect(field).toContainText("I seen it.");

  await expect(page.evaluate(() => window.__fixture.redo())).resolves.toBe(true);
  await expect(page.evaluate(() => window.__fixture.stateText)).resolves.toBe("I saw it.");
  await expect(field).toContainText("I saw it.");
});

test("pinned ProseMirror widget fixture applies without deleting ignored decoration chrome", async () => {
  test.skip(!!preflightSkip, preflightSkip);
  const page = await context.newPage();
  await page.goto(`${baseURL}/prosemirror-pinned.html?widget=1`);
  await expect(page.locator("#field.ProseMirror")).toHaveCount(1, { timeout: 5000 });
  await expect(page.evaluate(() => window.__fixture.widgetCount)).resolves.toBe(1);

  await page.evaluate(async () => {
    const { prosemirrorAdapter } = await import("/page/content/adapters/prosemirror.js");
    const root = window.__fixture.view.dom;
    const snapshot = prosemirrorAdapter.snapshot(root);
    window.__fixture.adapterApplyResult = prosemirrorAdapter.apply(root, snapshot, {
      startIndex: 2,
      endIndex: 6,
      correction: "saw",
    });
    snapshot.dispose();
  });

  await expect(page.evaluate(() => window.__fixture.adapterApplyResult)).resolves.toEqual({ applied: true, newCaret: 5 });
  await expect(page.evaluate(() => window.__fixture.stateText)).resolves.toBe("I saw it.");
  await expect(page.evaluate(() => window.__fixture.widgetCount)).resolves.toBe(1);
  await expect(page.evaluate(() => window.__fixture.undo())).resolves.toBe(true);
  await expect(page.evaluate(() => window.__fixture.stateText)).resolves.toBe("I seen it.");
  await expect(page.evaluate(() => window.__fixture.widgetCount)).resolves.toBe(1);
});

test("pinned CKEditor 5 fixture keeps framework state aligned after apply", async () => {
  test.skip(!!preflightSkip, preflightSkip);
  const page = await context.newPage();
  await page.goto(`${baseURL}/ckeditor5-pinned.html`);
  await expect.poll(async () => page.evaluate(() => window.__fixture.ready), { timeout: 10_000 }).toBe(true);
  await expect(page.locator(".ck-editor__editable[contenteditable='true']")).toHaveCount(1, { timeout: 5000 });
  await expect(page.evaluate(() => window.__fixture.modelText)).resolves.toBe("I seen it.");

  await injectProofly(page);
  await expect(page.locator("html[data-proofly-test-stub='loaded']")).toHaveCount(1, { timeout: 5000 });

  const field = page.locator(".ck-editor__editable[contenteditable='true']");
  await field.evaluate((el) => {
    el.focus();
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect.poll(async () => page.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelectorAll(".squiggle-box").length), { timeout: 5000 }).toBeGreaterThan(0);

  await field.evaluate((el) => {
    const text = window.__fixture.textNodeContaining("seen");
    const range = document.createRange();
    range.setStart(text, text.nodeValue.indexOf("seen") + 1);
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 30, clientY: 30 }));
  });
  await expect(page.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelector(".popup")?.hidden === false)).resolves.toBe(true);

  await page.evaluate(() => {
    window.__fixture.inputEvents = 0;
    window.__fixture.modelChanges = [];
  });
  await page.locator("#proofly-highlight-host").evaluate((host) => {
    host.shadowRoot.querySelector(".citem__choice").click();
  });

  await expect(field).toContainText("I saw it.");
  await expect(page.evaluate(() => window.__fixture.modelText)).resolves.toBe("I saw it.");
  await expect(page.evaluate(() => window.__fixture.data)).resolves.toBe("<p>I saw it.</p>");
  await expect(page.evaluate(() => window.__fixture.modelChanges.at(-1))).resolves.toBe("I saw it.");
  await expect(page.evaluate(() => window.__fixture.selection.isCollapsed)).resolves.toBe(true);

  await expect(page.evaluate(() => window.__fixture.undo())).resolves.toBe(true);
  await expect(page.evaluate(() => window.__fixture.modelText)).resolves.toBe("I seen it.");
  await expect(field).toContainText("I seen it.");

  await expect(page.evaluate(() => window.__fixture.redo())).resolves.toBe(true);
  await expect(page.evaluate(() => window.__fixture.modelText)).resolves.toBe("I saw it.");
  await expect(field).toContainText("I saw it.");
});

test("pinned CKEditor 4 classic fixture keeps editor data aligned after apply", async () => {
  test.skip(!!preflightSkip, preflightSkip);
  const page = await context.newPage();
  await page.goto(`${baseURL}/ckeditor4-pinned.html`);
  await expect.poll(async () => page.evaluate(() => window.__fixture.ready), { timeout: 10_000 }).toBe(true);
  const editorFrame = page.frameLocator("iframe.cke_wysiwyg_frame");
  await expect(editorFrame.locator("#field[data-proofly-ckeditor4-root='true']")).toHaveCount(1, { timeout: 5000 });
  await expect(page.evaluate(() => window.__fixture.data.trim())).resolves.toBe("<p>I seen it.</p>");

  await injectProofly(page);
  await expect(page.locator("html[data-proofly-test-stub='loaded']")).toHaveCount(1, { timeout: 5000 });
  await expect(editorFrame.locator("html[data-proofly-test-stub='loaded']")).toHaveCount(1, { timeout: 5000 });

  const field = editorFrame.locator("#field[data-proofly-ckeditor4-root='true']");
  await field.evaluate((el) => {
    el.focus();
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect.poll(async () => editorFrame.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelectorAll(".squiggle-box").length), { timeout: 5000 }).toBeGreaterThan(0);

  await field.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode())) {
      if (text.nodeValue.includes("seen")) break;
    }
    const range = document.createRange();
    range.setStart(text, text.nodeValue.indexOf("seen") + 1);
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 30, clientY: 30 }));
  });
  await expect(editorFrame.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelector(".popup")?.hidden === false)).resolves.toBe(true);

  await page.evaluate(() => {
    window.__fixture.inputEvents = 0;
    window.__fixture.changes = [];
  });
  await editorFrame.locator("#proofly-highlight-host").evaluate((host) => {
    host.shadowRoot.querySelector(".citem__choice").click();
  });

  await expect(field).toContainText("I saw it.");
  await expect(page.evaluate(() => window.__fixture.data.trim())).resolves.toBe("<p>I saw it.</p>");
  await expect(page.evaluate(() => window.__fixture.inputEvents)).resolves.toBe(1);

  await expect(page.evaluate(() => window.__fixture.undo() || window.__fixture.nativeUndo())).resolves.toBe(true);
  await expect(field).toContainText("I seen it.");
  await expect(page.evaluate(() => window.__fixture.data.trim())).resolves.toBe("<p>I seen it.</p>");

  await expect(page.evaluate(() => window.__fixture.redo() || window.__fixture.nativeRedo())).resolves.toBe(true);
  await expect(field).toContainText("I saw it.");
  await expect(page.evaluate(() => window.__fixture.data.trim())).resolves.toBe("<p>I saw it.</p>");
});

test("pinned Quill fixture keeps Delta state aligned after apply", async () => {
  test.skip(!!preflightSkip, preflightSkip);
  const page = await context.newPage();
  await page.goto(`${baseURL}/quill-pinned.html`);
  await expect.poll(async () => page.evaluate(() => window.__fixture.ready), { timeout: 10_000 }).toBe(true);
  await expect(page.locator("#field.ql-editor[contenteditable='true']")).toHaveCount(1, { timeout: 5000 });
  await expect(page.evaluate(() => window.__fixture.text)).resolves.toBe("I seen it.\n");

  await injectProofly(page);
  await expect(page.locator("html[data-proofly-test-stub='loaded']")).toHaveCount(1, { timeout: 5000 });

  const field = page.locator("#field.ql-editor[contenteditable='true']");
  await field.evaluate((el) => {
    el.focus();
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect.poll(async () => page.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelectorAll(".squiggle-box").length), { timeout: 5000 }).toBeGreaterThan(0);

  await field.evaluate((el) => {
    const text = window.__fixture.textNodeContaining("seen");
    const range = document.createRange();
    range.setStart(text, text.nodeValue.indexOf("seen") + 1);
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 30, clientY: 30 }));
  });
  await expect(page.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelector(".popup")?.hidden === false)).resolves.toBe(true);

  await page.evaluate(() => {
    window.__fixture.inputEvents = 0;
    window.__fixture.textChanges = [];
  });
  await page.locator("#proofly-highlight-host").evaluate((host) => {
    host.shadowRoot.querySelector(".citem__choice").click();
  });

  await expect(field).toContainText("I saw it.");
  await expect(page.evaluate(() => window.__fixture.text)).resolves.toBe("I saw it.\n");
  await expect(page.evaluate(() => window.__fixture.delta)).resolves.toEqual([{ insert: "I saw it.\n" }]);
  await expect(page.evaluate(() => window.__fixture.inputEvents)).resolves.toBe(1);
  await expect(page.evaluate(() => window.__fixture.textChanges.at(-1))).resolves.toEqual({
    text: "I saw it.\n",
    source: "user",
  });
  await expect(page.evaluate(() => window.__fixture.selection)).resolves.toEqual({ index: 5, length: 0 });

  await page.evaluate(() => window.__fixture.undo());
  await expect(page.evaluate(() => window.__fixture.text)).resolves.toBe("I seen it.\n");
  await expect(field).toContainText("I seen it.");

  await page.evaluate(() => window.__fixture.redo());
  await expect(page.evaluate(() => window.__fixture.text)).resolves.toBe("I saw it.\n");
  await expect(field).toContainText("I saw it.");
});

test("pinned TinyMCE iframe fixture keeps editor data aligned after apply", async () => {
  test.skip(!!preflightSkip, preflightSkip);
  const page = await context.newPage();
  await page.goto(`${baseURL}/tinymce-pinned.html`);
  await expect.poll(async () => page.evaluate(() => window.__fixture.ready), { timeout: 10_000 }).toBe(true);
  const editorFrame = page.frameLocator("iframe.tox-edit-area__iframe");
  await expect(editorFrame.locator("#field.mce-content-body[contenteditable='true']")).toHaveCount(1, { timeout: 5000 });
  await expect(page.evaluate(() => window.__fixture.data.trim())).resolves.toBe("<p>I seen it.</p>");

  await injectProofly(page);
  await expect(page.locator("html[data-proofly-test-stub='loaded']")).toHaveCount(1, { timeout: 5000 });
  await expect(editorFrame.locator("html[data-proofly-test-stub='loaded']")).toHaveCount(1, { timeout: 5000 });

  const field = editorFrame.locator("#field.mce-content-body[contenteditable='true']");
  await field.evaluate((el) => {
    el.focus();
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect.poll(async () => editorFrame.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelectorAll(".squiggle-box").length), { timeout: 5000 }).toBeGreaterThan(0);

  await field.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode())) {
      if (text.nodeValue.includes("seen")) break;
    }
    const range = document.createRange();
    range.setStart(text, text.nodeValue.indexOf("seen") + 1);
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 30, clientY: 30 }));
  });
  await expect(editorFrame.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelector(".popup")?.hidden === false)).resolves.toBe(true);

  await page.evaluate(() => {
    window.__fixture.inputEvents = 0;
    window.__fixture.changes = [];
  });
  await editorFrame.locator("#proofly-highlight-host").evaluate((host) => {
    host.shadowRoot.querySelector(".citem__choice").click();
  });

  await expect(field).toContainText("I saw it.");
  await expect(page.evaluate(() => window.__fixture.data.trim())).resolves.toBe("<p>I saw it.</p>");
  await expect(page.evaluate(() => window.__fixture.inputEvents)).resolves.toBe(1);
  await expect(page.evaluate(() => window.__fixture.selection)).resolves.toEqual({ offset: 5, collapsed: true });

  await page.evaluate(() => window.__fixture.undo());
  await expect(field).toContainText("I seen it.");
  await expect(page.evaluate(() => window.__fixture.data.trim())).resolves.toBe("<p>I seen it.</p>");

  await page.evaluate(() => window.__fixture.redo());
  await expect(field).toContainText("I saw it.");
  await expect(page.evaluate(() => window.__fixture.data.trim())).resolves.toBe("<p>I saw it.</p>");
});

test("pinned Lexical fixture keeps editor state aligned after apply", async () => {
  test.skip(!!preflightSkip, preflightSkip);
  const page = await context.newPage();
  await page.goto(`${baseURL}/lexical-pinned.html`);
  await expect.poll(async () => page.evaluate(() => window.__fixture?.ready ?? false), { timeout: 10_000 }).toBe(true);
  await expect(page.locator("#field[data-lexical-editor='true'][contenteditable='true']")).toHaveCount(1, { timeout: 5000 });
  await expect(page.evaluate(() => window.__fixture.stateText)).resolves.toBe("I seen it.");

  await injectProofly(page);
  await expect(page.locator("html[data-proofly-test-stub='loaded']")).toHaveCount(1, { timeout: 5000 });

  const field = page.locator("#field[data-lexical-editor='true']");
  await field.evaluate((el) => {
    el.focus();
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect.poll(async () => page.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelectorAll(".squiggle-box").length), { timeout: 5000 }).toBeGreaterThan(0);

  await field.evaluate((el) => {
    const text = window.__fixture.textNodeContaining("seen");
    const range = document.createRange();
    range.setStart(text, text.nodeValue.indexOf("seen") + 1);
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 30, clientY: 30 }));
  });
  await expect(page.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelector(".popup")?.hidden === false)).resolves.toBe(true);

  await page.evaluate(() => {
    window.__fixture.inputEvents = 0;
    window.__fixture.updates = [];
  });
  await page.locator("#proofly-highlight-host").evaluate((host) => {
    host.shadowRoot.querySelector(".citem__choice").click();
  });

  await expect(field).toContainText("I saw it.");
  await expect.poll(async () => page.evaluate(() => window.__fixture.stateText), { timeout: 5000 }).toBe("I saw it.");
  await expect(page.evaluate(() => window.__fixture.inputEvents)).resolves.toBe(1);
  await expect(page.evaluate(() => window.__fixture.selection)).resolves.toEqual({ offset: 5, collapsed: true });

  await page.evaluate(() => window.__fixture.undo());
  await expect.poll(async () => page.evaluate(() => window.__fixture.stateText), { timeout: 5000 }).toBe("I seen it.");
  await expect(field).toContainText("I seen it.");

  await page.evaluate(() => window.__fixture.redo());
  await expect.poll(async () => page.evaluate(() => window.__fixture.stateText), { timeout: 5000 }).toBe("I saw it.");
  await expect(field).toContainText("I saw it.");
});

test("pinned Slate core fixture keeps editor state aligned after apply", async () => {
  test.skip(!!preflightSkip, preflightSkip);
  const page = await context.newPage();
  await page.goto(`${baseURL}/slate-pinned.html`);
  await expect.poll(async () => page.evaluate(() => window.__fixture?.ready ?? false), { timeout: 10_000 }).toBe(true);
  await expect(page.locator("#field[data-slate-editor='true'][contenteditable='true']")).toHaveCount(1, { timeout: 5000 });
  await expect(page.evaluate(() => window.__fixture.stateText)).resolves.toBe("I seen it.");

  await injectProofly(page);
  await expect(page.locator("html[data-proofly-test-stub='loaded']")).toHaveCount(1, { timeout: 5000 });

  const field = page.locator("#field[data-slate-editor='true']");
  await field.evaluate((el) => {
    el.focus();
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect.poll(async () => page.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelectorAll(".squiggle-box").length), { timeout: 5000 }).toBeGreaterThan(0);

  await field.evaluate((el) => {
    const text = window.__fixture.textNodeContaining("seen");
    const range = document.createRange();
    range.setStart(text, text.nodeValue.indexOf("seen") + 1);
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 30, clientY: 30 }));
  });
  await expect(page.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelector(".popup")?.hidden === false)).resolves.toBe(true);

  await page.evaluate(() => {
    window.__fixture.inputEvents = 0;
    window.__fixture.updates = [];
  });
  await page.locator("#proofly-highlight-host").evaluate((host) => {
    host.shadowRoot.querySelector(".citem__choice").click();
  });

  await expect(field).toContainText("I saw it.");
  await expect(page.evaluate(() => window.__fixture.stateText)).resolves.toBe("I saw it.");
  await expect(page.evaluate(() => window.__fixture.inputEvents)).resolves.toBe(1);
  await expect(page.evaluate(() => window.__fixture.selection)).resolves.toEqual({ offset: 5, collapsed: true });

  await page.evaluate(() => window.__fixture.undo());
  await expect(field).toContainText("I seen it.");
  await expect(page.evaluate(() => window.__fixture.stateText)).resolves.toBe("I seen it.");

  await page.evaluate(() => window.__fixture.redo());
  await expect(field).toContainText("I saw it.");
  await expect(page.evaluate(() => window.__fixture.stateText)).resolves.toBe("I saw it.");
});

test("pinned DraftJS fixture keeps editor state aligned after apply", async () => {
  test.skip(!!preflightSkip, preflightSkip);
  const page = await context.newPage();
  await page.goto(`${baseURL}/draftjs-pinned.html`);
  await expect.poll(async () => page.evaluate(() => window.__fixture?.ready ?? false), { timeout: 10_000 }).toBe(true);
  await expect(page.locator("#field.public-DraftEditor-content[contenteditable='true']")).toHaveCount(1, { timeout: 5000 });
  await expect(page.evaluate(() => window.__fixture.stateText)).resolves.toBe("I seen it.");

  await injectProofly(page);
  await expect(page.locator("html[data-proofly-test-stub='loaded']")).toHaveCount(1, { timeout: 5000 });

  const field = page.locator("#field.public-DraftEditor-content");
  await field.evaluate((el) => {
    el.focus();
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect.poll(async () => page.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelectorAll(".squiggle-box").length), { timeout: 5000 }).toBeGreaterThan(0);

  await field.evaluate((el) => {
    const text = window.__fixture.textNodeContaining("seen");
    const range = document.createRange();
    range.setStart(text, text.nodeValue.indexOf("seen") + 1);
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 30, clientY: 30 }));
  });
  await expect(page.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelector(".popup")?.hidden === false)).resolves.toBe(true);

  await page.evaluate(() => {
    window.__fixture.inputEvents = 0;
    window.__fixture.updates = [];
  });
  await page.locator("#proofly-highlight-host").evaluate((host) => {
    host.shadowRoot.querySelector(".citem__choice").click();
  });

  await expect(field).toContainText("I saw it.");
  await expect.poll(async () => page.evaluate(() => window.__fixture.stateText), { timeout: 5000 }).toBe("I saw it.");
  await expect(page.evaluate(() => window.__fixture.inputEvents)).resolves.toBe(1);
  await expect(page.evaluate(() => window.__fixture.selection)).resolves.toEqual({ offset: 5, collapsed: true });

  await page.evaluate(() => window.__fixture.undo());
  await expect.poll(async () => page.evaluate(() => window.__fixture.stateText), { timeout: 5000 }).toBe("I seen it.");
  await expect(field).toContainText("I seen it.");

  await page.evaluate(() => window.__fixture.redo());
  await expect.poll(async () => page.evaluate(() => window.__fixture.stateText), { timeout: 5000 }).toBe("I saw it.");
  await expect(field).toContainText("I saw it.");
});

test("pinned Trix fixture keeps editor state aligned after apply", async () => {
  test.skip(!!preflightSkip, preflightSkip);
  const page = await context.newPage();
  await page.goto(`${baseURL}/trix-pinned.html`);
  await expect.poll(async () => page.evaluate(() => window.__fixture?.ready ?? false), { timeout: 10_000 }).toBe(true);
  await expect(page.locator("#field[contenteditable]")).toHaveCount(1, { timeout: 5000 });
  await expect(page.evaluate(() => window.__fixture.stateText)).resolves.toBe("I seen it.");

  await injectProofly(page);
  await expect(page.locator("html[data-proofly-test-stub='loaded']")).toHaveCount(1, { timeout: 5000 });

  const field = page.locator("#field");
  await field.evaluate((el) => {
    el.focus();
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect.poll(async () => page.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelectorAll(".squiggle-box").length), { timeout: 5000 }).toBeGreaterThan(0);

  await field.evaluate((el) => {
    const text = window.__fixture.textNodeContaining("seen");
    const range = document.createRange();
    range.setStart(text, text.nodeValue.indexOf("seen") + 1);
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 30, clientY: 30 }));
  });
  await expect(page.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelector(".popup")?.hidden === false)).resolves.toBe(true);

  await page.evaluate(() => {
    window.__fixture.inputEvents = 0;
    window.__fixture.changes = [];
  });
  await page.locator("#proofly-highlight-host").evaluate((host) => {
    host.shadowRoot.querySelector(".citem__choice").click();
  });

  await expect(field).toContainText("I saw it.");
  await expect.poll(async () => page.evaluate(() => window.__fixture.stateText), { timeout: 5000 }).toBe("I saw it.");
  await expect(page.evaluate(() => window.__fixture.inputEvents)).resolves.toBe(0);
  await expect(page.evaluate(() => window.__fixture.changes)).resolves.toEqual(["I saw it."]);
  await expect(page.evaluate(() => window.__fixture.selection)).resolves.toEqual({ offset: 5, collapsed: true });

  await page.evaluate(() => window.__fixture.undo());
  await expect.poll(async () => page.evaluate(() => window.__fixture.stateText), { timeout: 5000 }).toBe("I seen it.");
  await expect(field).toContainText("I seen it.");

  await page.evaluate(() => window.__fixture.redo());
  await expect.poll(async () => page.evaluate(() => window.__fixture.stateText), { timeout: 5000 }).toBe("I saw it.");
  await expect(field).toContainText("I saw it.");
});

test("pinned CodeMirror 6 fixture keeps editor state aligned after apply", async () => {
  test.skip(!!preflightSkip, preflightSkip);
  const page = await context.newPage();
  await page.goto(`${baseURL}/codemirror6-pinned.html`);
  await expect.poll(async () => page.evaluate(() => window.__fixture?.ready ?? false), { timeout: 10_000 }).toBe(true);
  await expect(page.locator("#field.cm-content[contenteditable='true']")).toHaveCount(1, { timeout: 5000 });
  await expect(page.evaluate(() => window.__fixture.stateText)).resolves.toBe("I seen it.");

  await injectProofly(page);
  await expect(page.locator("html[data-proofly-test-stub='loaded']")).toHaveCount(1, { timeout: 5000 });

  const field = page.locator("#field");
  await field.evaluate((el) => {
    window.__fixture.view.focus();
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect.poll(async () => page.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelectorAll(".squiggle-box").length), { timeout: 5000 }).toBeGreaterThan(0);

  await field.evaluate((el) => {
    const text = window.__fixture.textNodeContaining("seen");
    const range = document.createRange();
    range.setStart(text, text.nodeValue.indexOf("seen") + 1);
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 30, clientY: 30 }));
  });
  await expect(page.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelector(".popup")?.hidden === false)).resolves.toBe(true);

  await page.evaluate(() => {
    window.__fixture.inputEvents = 0;
    window.__fixture.updates = [];
  });
  await page.locator("#proofly-highlight-host").evaluate((host) => {
    host.shadowRoot.querySelector(".citem__choice").click();
  });

  await expect(field).toContainText("I saw it.");
  await expect.poll(async () => page.evaluate(() => window.__fixture.stateText), { timeout: 5000 }).toBe("I saw it.");
  await expect(page.evaluate(() => window.__fixture.inputEvents)).resolves.toBe(0);
  await expect(page.evaluate(() => window.__fixture.updates)).resolves.toEqual(["I saw it."]);
  await expect(page.evaluate(() => window.__fixture.selection)).resolves.toEqual({ offset: 5, collapsed: true });

  await page.evaluate(() => window.__fixture.undo());
  await expect.poll(async () => page.evaluate(() => window.__fixture.stateText), { timeout: 5000 }).toBe("I seen it.");
  await expect(field).toContainText("I seen it.");

  await page.evaluate(() => window.__fixture.redo());
  await expect.poll(async () => page.evaluate(() => window.__fixture.stateText), { timeout: 5000 }).toBe("I saw it.");
  await expect(field).toContainText("I saw it.");
});

test("pinned CodeMirror 5 fixture keeps editor state aligned after apply", async () => {
  test.skip(!!preflightSkip, preflightSkip);
  const page = await context.newPage();
  await page.goto(`${baseURL}/codemirror5-pinned.html`);
  await expect.poll(async () => page.evaluate(() => window.__fixture?.ready ?? false), { timeout: 10_000 }).toBe(true);
  await expect(page.locator("#field.CodeMirror-code")).toHaveCount(1, { timeout: 5000 });
  await expect(page.evaluate(() => window.__fixture.stateText)).resolves.toBe("I seen it.");

  await injectProofly(page);
  await expect(page.locator("html[data-proofly-test-stub='loaded']")).toHaveCount(1, { timeout: 5000 });

  const field = page.locator("#field");
  await field.evaluate((el) => {
    window.__fixture.editor.focus();
    window.__fixture.editor.getInputField().dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect.poll(async () => page.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelectorAll(".squiggle-box").length), { timeout: 5000 }).toBeGreaterThan(0);

  await field.evaluate((el) => {
    const text = window.__fixture.textNodeContaining("seen");
    const range = document.createRange();
    range.setStart(text, text.nodeValue.indexOf("seen") + 1);
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 30, clientY: 30 }));
  });
  await expect(page.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelector(".popup")?.hidden === false)).resolves.toBe(true);

  await page.evaluate(() => {
    window.__fixture.inputEvents = 0;
    window.__fixture.changes = [];
  });
  await page.locator("#proofly-highlight-host").evaluate((host) => {
    host.shadowRoot.querySelector(".citem__choice").click();
  });

  await expect.poll(async () => page.evaluate(() => window.__fixture.stateText), { timeout: 5000 }).toBe("I saw it.");
  await expect(page.evaluate(() => window.__fixture.inputEvents)).resolves.toBe(0);
  await expect(page.evaluate(() => window.__fixture.changes)).resolves.toEqual(["I saw it."]);
  await expect(page.evaluate(() => window.__fixture.selection)).resolves.toEqual({ offset: 5, collapsed: true });

  await page.evaluate(() => window.__fixture.undo());
  await expect.poll(async () => page.evaluate(() => window.__fixture.stateText), { timeout: 5000 }).toBe("I seen it.");

  await page.evaluate(() => window.__fixture.redo());
  await expect.poll(async () => page.evaluate(() => window.__fixture.stateText), { timeout: 5000 }).toBe("I saw it.");
});

test("CodeMirror prose gate refuses programming and runtime mode changes", async () => {
  test.skip(!!preflightSkip, preflightSkip);

  const programming = await context.newPage();
  await programming.goto(`${baseURL}/codemirror6-pinned.html?language=javascript`);
  await expect.poll(async () => programming.evaluate(() => window.__fixture?.ready ?? false), { timeout: 10_000 }).toBe(true);
  await injectProofly(programming);
  await programming.locator("#field").evaluate((el) => {
    window.__fixture.view.focus();
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await programming.waitForTimeout(1300);
  await expect(programming.locator("#proofly-highlight-host")).toHaveCount(0);
  await programming.close();

  const runtime = await context.newPage();
  await runtime.goto(`${baseURL}/codemirror6-pinned.html`);
  await expect.poll(async () => runtime.evaluate(() => window.__fixture?.ready ?? false), { timeout: 10_000 }).toBe(true);
  await injectProofly(runtime);
  await runtime.locator("#field").evaluate((el) => {
    window.__fixture.view.focus();
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect.poll(async () => runtime.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelectorAll(".squiggle-box").length), { timeout: 5000 }).toBeGreaterThan(0);
  await runtime.evaluate(() => window.__fixture.setLanguage("javascript"));
  await expect.poll(async () => runtime.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelectorAll(".squiggle-box").length), { timeout: 5000 }).toBe(0);
});

test("local Google Docs bridge fixture reads visual ranges and fails stale writes closed", async () => {
  const page = await context.newPage();
  await page.goto(`${baseURL}/google-docs-bridge.html`);
  await expect(page.locator("#field[data-proofly-google-docs-root]")).toHaveCount(1, { timeout: 5000 });

  const result = await page.evaluate(async () => {
    const { createBridgeClient } = await import("/page/content/bridge/client.js");
    const {
      applyGoogleDocsCorrection,
      GOOGLE_DOCS_BRIDGE_CAPABILITIES,
      readGoogleDocsSnapshot,
    } = await import("/page/content/adapters/google-docs.js");
    const client = createBridgeClient({
      allowedCapabilities: GOOGLE_DOCS_BRIDGE_CAPABILITIES,
      timeoutMs: 500,
    });
    const root = document.querySelector("#field");
    const snapshot = await readGoogleDocsSnapshot(root, client);
    const before = {
      text: snapshot.text,
      rects: snapshot.rangeForSpan(2, 6).rects,
      selection: snapshot.offsetForPoint(),
    };
    const applied = await applyGoogleDocsCorrection(root, snapshot, {
      startIndex: 2,
      endIndex: 6,
      correction: "saw",
    }, client);
    const textAfterApply = window.__fixture.logicalText();
    snapshot.dispose();

    const stale = await readGoogleDocsSnapshot(root, client);
    window.__fixture.mutateStale();
    const staleApply = await applyGoogleDocsCorrection(root, stale, {
      startIndex: 2,
      endIndex: 5,
      correction: "seen",
    }, client);
    stale.dispose();
    client.dispose();
    return {
      before,
      applied,
      textAfterApply,
      staleApply,
      replaceCalls: window.__fixture.replaceCalls,
    };
  });

  expect(result.before).toEqual({
    text: "I seen\nit.",
    rects: [{ left: 10, top: 20, width: 40, height: 12 }],
    selection: 3,
  });
  expect(result.applied).toEqual({ applied: true, newCaret: 5 });
  expect(result.textAfterApply).toBe("I saw\nit.");
  expect(result.staleApply).toEqual({ applied: false });
  expect(result.replaceCalls).toHaveLength(2);
});

// Denial path: mirrors the popup's Disable (drop synced intent, then the
// grant) and asserts the SW side — unregistration plus the teardown
// broadcast reaching a live tab whose squiggles are on screen. Kept LAST:
// it briefly disables the fixture origin for the whole browser, and ends by
// re-enabling so a retry or later addition still finds the site on.
test("disabling the site tears down live tabs, unregisters, and stays torn down", async () => {
  test.skip(!!preflightSkip, preflightSkip);
  const pattern = `${new URL(baseURL).origin}/*`;
  const page = await context.newPage();
  await page.goto(`${baseURL}/textarea.html`);
  await injectProofly(page);
  await expect(page.locator("html[data-proofly-test-stub='loaded']")).toHaveCount(1, { timeout: 5000 });
  const field = page.locator("#field");
  await field.fill("I seen teh result.");
  await expect(page.locator("#proofly-highlight-host")).toHaveCount(1, { timeout: 5000 });
  await expect.poll(async () => page.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelectorAll(".squiggle-box").length), { timeout: 5000 }).toBeGreaterThan(0);

  try {
    // Disable exactly as the popup does: intent first, then the grant. The
    // SW's storage.onChanged + permissions.onRemoved handle the rest.
    await worker.evaluate(async ({ sitePattern }) => {
      const data = await chrome.storage.sync.get("enabledSites");
      const map = data?.enabledSites ?? {};
      delete map[sitePattern];
      await chrome.storage.sync.set({ enabledSites: map });
      await chrome.permissions.remove({ origins: [sitePattern] });
    }, { sitePattern: pattern });

    // The live tab heard the broadcast: overlay gone, engine inert.
    await expect(page.locator("#proofly-highlight-host")).toHaveCount(0, { timeout: 5000 });
    await field.fill("I seen more mistaks here.");
    await page.waitForTimeout(1500); // > the 1s lint-on-pause debounce
    await expect(page.locator("#proofly-highlight-host")).toHaveCount(0);

    // And future page loads are off too: our registration is gone.
    await expect.poll(async () => worker.evaluate(async ({ sitePattern }) => {
      const scripts = await chrome.scripting.getRegisteredContentScripts();
      return scripts.some((s) => s.id === `proofly-page:${sitePattern}`);
    }, { sitePattern: pattern }), { timeout: 5000 }).toBe(false);
  } finally {
    // Re-enable for whatever runs after us (the profile persists).
    await grantFixtureHostPermission();
  }
  await expectFixtureRegistration({ matchOriginAsFallback: true });
});

async function minimizeBrowserWindow() {
  if (!context || BROWSER_HEADLESS || BROWSER_VISIBLE) return;
  const session = await context.browser().newBrowserCDPSession();
  try {
    let windowId;
    try {
      ({ windowId } = await session.send("Browser.getWindowForTarget"));
    } catch {
      const targets = await session.send("Target.getTargets");
      const pageTarget = targets.targetInfos.find((target) => target.type === "page");
      if (!pageTarget) return;
      ({ windowId } = await session.send("Browser.getWindowForTarget", {
        targetId: pageTarget.targetId,
      }));
    }
    if (Number.isInteger(windowId)) {
      await session.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "minimized" },
      });
    }
  } catch {
    // Best effort only: the browser args still keep the window out of the way
    // on platforms that ignore CDP window minimization.
  }
}

async function injectProofly(page) {
  const useMockModel = process.env.PROOFLY_USE_REAL_MODEL !== "1";
  await page.bringToFront();
  await worker.evaluate(async ({ useMockModel }) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error("No active tab found for Proofly fixture injection");
    }
    const files = useMockModel
      ? ["test/browser/content-proofreader-stub.js", "page/content/bootstrap.js"]
      : ["page/content/bootstrap.js"];
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files,
    });
  }, { useMockModel });
}

async function reloadExtensionWithCDP(browserSession, id) {
  for (const command of ["Extensions.reload", "Extensions.reloadExtension"]) {
    try {
      await browserSession.send(command, { id });
      return;
    } catch {
      // Older Chrome DevTools Protocol builds may expose loadUnpacked without
      // a reload command. The following loadUnpacked call remains the fallback.
    }
  }
}

async function openExtensionController() {
  controllerPage = await context.newPage();
  await controllerPage.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`);
  return controllerPage;
}

async function injectProofreaderStub(page) {
  await page.bringToFront();
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error("No active tab found for Proofly fixture injection");
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["test/browser/content-proofreader-stub.js"],
    });
  });
}

async function inspectProoflyFrames(page) {
  await page.bringToFront();
  return worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error("No active tab found for Proofly fixture inspection");
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => ({
        href: location.href,
        title: document.title,
        loaded: window.__prooflyPageLoaded === true,
        hostCount: document.querySelectorAll("#proofly-highlight-host").length,
      }),
    });
    return results.map((result) => result.result);
  });
}

function loadedFrameSummary(frames) {
  return {
    total: frames.length,
    loaded: frames.filter((frame) => frame.loaded).length,
    aboutBlank: frames.some((frame) => frame.loaded && frame.title === "Proofly about blank child"),
    srcdoc: frames.some((frame) => frame.loaded && frame.title === "Proofly srcdoc child"),
  };
}

async function expectFixtureRegistration(expected) {
  const pattern = `${new URL(baseURL).origin}/*`;
  await expect.poll(async () => worker.evaluate(async ({ extensionPattern }) => {
    const scripts = await chrome.scripting.getRegisteredContentScripts();
    const script = scripts.find((candidate) =>
      candidate.id === `proofly-page:${extensionPattern}`);
    if (!script) return null;
    return {
      allFrames: script.allFrames,
      matchOriginAsFallback: script.matchOriginAsFallback,
      matches: script.matches,
      js: script.js,
      runAt: script.runAt,
    };
  }, { extensionPattern: pattern }), { timeout: 5000 }).toMatchObject({
    allFrames: true,
    matchOriginAsFallback: expected.matchOriginAsFallback,
    matches: [pattern],
    js: ["page/content/bootstrap.js"],
    runAt: "document_idle",
  });
}

async function installRichEditorEventCounters(field) {
  await field.evaluate((el) => {
    if (window.__prooflyRichEditorCountersInstalled) return;
    window.__prooflyRichEditorCountersInstalled = true;
    window.__prooflyApplyInputs = 0;
    window.__prooflyBeforeInputs = [];
    el.addEventListener("input", () => { window.__prooflyApplyInputs += 1; });
    el.addEventListener("beforeinput", (event) => {
      window.__prooflyBeforeInputs.push({
        inputType: event.inputType,
        data: event.data,
        ranges: event.getTargetRanges?.().length ?? 0,
      });
    });
  });
}

async function prepareRichEditorCase(page, html) {
  const field = page.locator("#field");
  await field.evaluate((el, nextHtml) => {
    el.innerHTML = nextHtml;
    window.__prooflyApplyInputs = 0;
    window.__prooflyBeforeInputs = [];
  }, html);
  await field.focus();
  await field.evaluate((el) => el.dispatchEvent(new Event("input", { bubbles: true })));
  await expect(page.locator("#proofly-highlight-host")).toHaveCount(1, { timeout: 5000 });
  await expect.poll(async () => page.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelectorAll(".squiggle-box").length), { timeout: 5000 }).toBeGreaterThan(0);
}

async function clickRichEditorCorrection(page, selector, offset) {
  const field = page.locator("#field");
  await field.evaluate((el, { selector: targetSelector, offset: targetOffset }) => {
    const target = el.querySelector(targetSelector);
    const text = target.firstChild;
    const range = document.createRange();
    range.setStart(text, Math.min(targetOffset, text.nodeValue.length));
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 30, clientY: 30 }));
  }, { selector, offset });
}

async function exerciseRichEditorApply(page, {
  html,
  selector,
  clickOffset,
  expectedText,
  expectedCaret,
  expectedBeforeInput,
}) {
  const field = page.locator("#field");
  await prepareRichEditorCase(page, html);
  await clickRichEditorCorrection(page, selector, clickOffset);
  await expect(page.locator("#proofly-highlight-host").evaluate((host) =>
    host.shadowRoot.querySelector(".popup")?.hidden === false)).resolves.toBe(true);
  await field.evaluate(() => {
    window.__prooflyApplyInputs = 0;
    window.__prooflyBeforeInputs = [];
  });
  await page.locator("#proofly-highlight-host").evaluate((host) => {
    host.shadowRoot.querySelector(".citem__choice").click();
  });
  await expect(field.evaluate((el) => el.textContent)).resolves.toBe(expectedText);
  await expect(page.evaluate(() => window.__prooflyApplyInputs)).resolves.toBe(1);
  await expect(page.evaluate(() => window.__prooflyBeforeInputs)).resolves.toEqual([expectedBeforeInput]);
  await expect(field.evaluate((el) => {
    const sel = getSelection();
    if (!sel?.rangeCount || !el.contains(sel.anchorNode)) return null;
    const before = document.createRange();
    before.selectNodeContents(el);
    before.setEnd(sel.anchorNode, sel.anchorOffset);
    return before.toString().length;
  })).resolves.toBe(expectedCaret);
}

async function grantFixtureHostPermission() {
  const pattern = `${new URL(baseURL).origin}/*`;
  const extensionsPage = await context.newPage();
  try {
    await extensionsPage.goto(`chrome://extensions/?id=${EXTENSION_ID}`);
    const preapproveError = await extensionsPage.evaluate(
      ({ extensionId, originPattern }) => new Promise((resolve) => {
        chrome.developerPrivate.addHostPermission(extensionId, originPattern, () => {
          resolve(chrome.runtime.lastError?.message ?? null);
        });
      }),
      { extensionId: EXTENSION_ID, originPattern: pattern },
    );
    if (preapproveError) {
      throw new Error(preapproveError);
    }
  } finally {
    await extensionsPage.close().catch(() => {});
  }

  const requestPage = await context.newPage();
  try {
    await requestPage.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`);
    await requestPage.evaluate((originPattern) => {
      const button = document.createElement("button");
      button.id = "proofly-test-grant-host";
      button.textContent = "Grant";
      button.addEventListener("click", async () => {
        button.dataset.granted = String(await chrome.permissions.request({
          origins: [originPattern],
        }));
      });
      document.body.append(button);
    }, pattern);
    await requestPage.locator("#proofly-test-grant-host").click();
    await expect(requestPage.locator("#proofly-test-grant-host")).toHaveAttribute("data-granted", "true");
  } finally {
    await requestPage.close().catch(() => {});
  }
}

async function closeAllPages() {
  if (!context) return;
  await Promise.allSettled(context.pages()
    .filter((page) => page !== controllerPage)
    .map((page) => page.close({ runBeforeUnload: false })));
}

function serveFile(res, filePath, root = extensionRoot) {
  if (!filePath.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { "content-type": contentType(filePath) });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  return "text/plain; charset=utf-8";
}
