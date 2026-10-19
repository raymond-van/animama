import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { chromium } from "playwright";

const root = resolve("dist");
const assetRequests = [];
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
// The fixture host supplies thumbnails. They are not copied product/runtime assets.
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (/^\/thumbnails\/(local|hosted)\.svg$/.test(pathname)) {
    assetRequests.push(pathname);
    response.writeHead(200, { "content-type": "image/svg+xml" });
    response.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#6c83a7"/></svg>');
    return;
  }
  const path = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!path.startsWith(root + sep)) { response.writeHead(403).end(); return; }
  try {
    const bytes = await readFile(path);
    response.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
    response.end(bytes);
  } catch { response.writeHead(404).end(); }
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let page;
try {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin !== origin) {
      failures.push(`Unexpected network origin: ${route.request().url()}`);
      return route.abort();
    }
    return route.continue();
  });
  await page.goto(origin);
  const locales = await page.evaluate(() => window.consumerLocales);
  assert.deepEqual(locales, {
    visitor: "ja", savedEnglish: "en", systemDefault: "zh-Hant",
    invalidHints: "zh-Hans", fallback: "en",
  });
  for (const scope of ["local", "hosted"]) {
    const pane = page.getByTestId(scope);
    await pane.getByRole("button", { name: `${scope === "local" ? "Local" : "Hosted"} Anima`, exact: true }).click();
    await pane.getByRole("textbox").fill(`hello ${scope}`);
    await pane.getByRole("button", { name: "Send message", exact: true }).click();
    await pane.getByText(`Hello from ${scope}`, { exact: true }).waitFor();
    await page.waitForFunction((scope) => document.querySelector(`[data-testid="${scope}"]`)?.getAttribute("data-streaming") === "false", scope);
  }
  assert.equal(await page.getByText("STALE OUTPUT MUST NOT RENDER", { exact: true }).count(), 0);
  assert.equal(await page.getByTestId("local").getByText("Hello from hosted", { exact: true }).count(), 0);
  assert.equal(await page.getByTestId("hosted").getByText("Hello from local", { exact: true }).count(), 0);
  assert.deepEqual(assetRequests.sort(), ["/thumbnails/hosted.svg", "/thumbnails/local.svg"]);
  const styling = await page.evaluate(() => ({
    loadedStylesheets: [...document.styleSheets].filter((sheet) => sheet.href?.includes("/assets/")).length,
    visibleThumbnails: [...document.images].filter((image) => image.naturalWidth > 0).length,
    selectionDisplay: getComputedStyle(document.querySelector(".animama-anima-selection")).display,
    userMessageAlignment: getComputedStyle(document.querySelector('.animama-chat-conversation .is-user')).justifyContent,
  }));
  assert.ok(styling.loadedStylesheets > 0, "Packed CSS must be emitted and loaded by the consumer");
  assert.equal(styling.visibleThumbnails, 2);
  assert.equal(styling.selectionDisplay, "flex");
  assert.equal(styling.userMessageAlignment, "flex-end");
  await page.screenshot({ path: "consumer.png", fullPage: true });

  const local = page.getByTestId("local");
  await local.getByRole("textbox").fill("hold");
  await local.getByRole("button", { name: "Send message", exact: true }).click();
  await local.getByText("Waiting for cancellation", { exact: true }).waitFor();
  await local.getByRole("button", { name: "Stop", exact: true }).click();
  await page.waitForFunction(() => window.consumerEvidence.aborted.includes("local"));
  await local.getByRole("textbox").fill("fail");
  await local.getByRole("button", { name: "Send message", exact: true }).click();
  await page.waitForFunction(() => window.consumerEvidence.requests.some((request) => request.body?.message === "fail"));
  await page.waitForFunction(() => document.querySelector('[data-testid="local"]')?.getAttribute("data-streaming") === "false");
  // A single failed POST may have reached a model. Give a mistakenly enabled
  // default reconnect delay time to fire, then prove the operation was not retried.
  await page.waitForTimeout(3300);
  const evidence = await page.evaluate(() => window.consumerEvidence);
  assert.deepEqual(evidence.errors, []);
  assert.equal(evidence.requests.filter((request) => request.body?.message === "fail").length, 1);
  assert.ok(evidence.acceptedGestures.length >= 2);
  assert.ok(evidence.acceptedGestures.every((gesture) => gesture === "accepted-gesture"));
  for (const request of evidence.requests) {
    if (request.path.includes("/animas/")) assert.ok(request.path.includes(`${request.scope}-anima`));
    if (request.body?.chat_id) assert.equal(request.body.chat_id, `${request.scope}-chat`);
  }
  assert.deepEqual(failures, []);
  const report = { result: "passed", owners: 2, sourceImports: "packed packages only", locales, styling, assetRequests, ...evidence };
  await writeFile("browser-evidence.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} catch (error) {
  const failure = page ? await page.evaluate(() => ({ evidence: window.consumerEvidence, text: document.body.innerText })) : {};
  await writeFile("browser-failure.json", JSON.stringify(failure, null, 2) + "\n");
  await page?.screenshot({ path: "consumer-failure.png", fullPage: true });
  console.error(JSON.stringify(failure));
  throw error;
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
