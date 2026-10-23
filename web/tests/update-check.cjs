// Update check: serves an old and then a new copy of web/ with Cache-Control: max-age=600
// (like GitHub Pages) and verifies that returning visitors end up on the new version
// with a working What's new button. Usage: NODE_PATH=$(npm root -g) node web/tests/update-check.cjs <old-web-dir> <new-web-dir>
const http = require("http"), fs = require("fs"), path = require("path");
const { chromium } = require("playwright");
const [oldDir, newDir] = process.argv.slice(2).map((p) => path.resolve(p));
let root = oldDir;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const f = path.join(root, p);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control": "max-age=600" });
  fs.createReadStream(f).pipe(res);
});
(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();                       // old version fully cached, like a regular user
  root = newDir;                             // deploy the new version
  for (let visit = 1; visit <= 3; visit++) {
    await page.reload();
    // Wait until the page has stopped navigating (a new release reloads it once)
    let navs = 0;
    let reloaded = false;
    const onNav = () => { navs++; reloaded = true; };
    page.on("framenavigated", onNav);
    for (let quiet = 0, t = 0; quiet < 2 && t < 20; t++) {
      navs = 0;
      await page.waitForTimeout(1000);
      await page.waitForLoadState("load");
      quiet = navs ? 0 : quiet + 1;
    }
    page.off("framenavigated", onNav);
    if (reloaded) console.log(`  visit ${visit}: page reloaded itself to the new version`);
    const hasBtn = await page.$("#btn-whatsnew") !== null;
    let opens = false;
    if (hasBtn) {
      await page.click("#btn-whatsnew");
      opens = await page.$("#whatsnew-dialog[open]") !== null;
      if (opens) await page.click("#whatsnew-dialog .btn.primary");
    }
    const ver = await page.evaluate(() => (document.getElementById("about-version") || {}).textContent || "-");
    console.log(`visit ${visit} after deploy: button ${hasBtn ? "shown" : "absent"}, ${hasBtn ? (opens ? "dialog opens" : "NOTHING HAPPENS") : "-"}, About: ${ver}`);
  }
  console.log(errors.length ? "page errors: " + errors.join(" | ") : "no page errors");
  await browser.close(); server.close();
})();
