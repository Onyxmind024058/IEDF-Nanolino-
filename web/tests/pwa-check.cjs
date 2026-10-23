// PWA check: serves web/ over http, verifies installability, offline start and analysis.
// Usage: NODE_PATH=$(npm root -g) node web/tests/pwa-check.cjs <csv>
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".webmanifest": "application/manifest+json", ".csv": "text/csv" };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(url);
  await page.evaluate(() => navigator.serviceWorker.ready);
  console.log("Service worker active:", await page.evaluate(() => !!navigator.serviceWorker.controller || "after reload"));

  const cdp = await context.newCDPSession(page);
  const inst = await cdp.send("Page.getInstallabilityErrors");
  console.log("Installability errors:", inst.installabilityErrors.length ? JSON.stringify(inst.installabilityErrors) : "none");
  const man = await cdp.send("Page.getAppManifest");
  console.log("Manifest parse errors:", man.errors.length ? JSON.stringify(man.errors) : "none");

  const swVersion = fs.readFileSync(path.join(root, "sw.js"), "utf8").match(/const VERSION = "rfea-([^"]+)"/)[1];
  const appVersion = fs.readFileSync(path.join(root, "js", "app.js"), "utf8").match(/const APP_VERSION = "([^"]+)"/)[1];
  console.log("sw.js version matches APP_VERSION:", swVersion === appVersion ? `yes (${appVersion})` : `NO: sw ${swVersion}, app ${appVersion}`);
  if (swVersion !== appVersion) process.exitCode = 1;
  const cached = await page.evaluate(async (v) => (await (await caches.open(v)).keys()).length, "rfea-" + swVersion);
  console.log("Files cached:", cached);

  await context.setOffline(true);
  await page.reload();
  console.log("Offline reload title:", await page.title());
  await page.setInputFiles("#file", path.resolve(process.argv[2]));
  await page.waitForFunction(() => document.querySelector('[data-k="Eavg"]').textContent !== "—", null, { timeout: 15000 });
  console.log("Offline analysis:", await page.textContent("#status"));
  const plotOk = await page.evaluate(() => typeof Plotly !== "undefined" && !!document.querySelector("#plot .main-svg"));
  console.log("Plot drawn offline:", plotOk);

  console.log(errors.length ? "ERRORS: " + errors.join(" | ") : "No page errors");
  await browser.close();
  server.close();
})();
