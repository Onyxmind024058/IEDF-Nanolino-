// End-to-end check of web/index.html in Chromium (opened from file://).
// Usage: NODE_PATH=$(npm root -g) node web/tests/browser-check.cjs <csv> <outdir>
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

(async () => {
  const csv = path.resolve(process.argv[2]);
  const out = path.resolve(process.argv[3] || ".");
  const url = "file://" + path.resolve(__dirname, "..", "index.html");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));

  await page.goto(url);
  await page.click('[data-theme-btn="light"]');
  await page.setInputFiles("#file", csv);
  await page.waitForFunction(() => document.querySelector('[data-k="Eavg"]').textContent !== "—");
  const results = await page.$$eval("#results dd", (dds) => dds.map((d) => `${d.dataset.k}=${d.textContent}`));
  console.log("Results:", results.join(" | "));
  console.log("Status:", await page.textContent("#status"));
  await page.screenshot({ path: path.join(out, "web_light.png") });

  // Switch method to SG and check the plot updates without errors
  await page.selectOption("#method", "SG");
  await page.waitForTimeout(400);
  console.log("SG status:", await page.textContent("#status"));

  // Manual smoothing: drag across the plot to add a range
  await page.selectOption("#method", "Manual");
  await page.waitForTimeout(200);
  await page.click("#btn-manual");
  await page.waitForSelector("#manual-plot .nsewdrag");
  const box = await page.locator("#manual-plot .nsewdrag").first().boundingBox();
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  console.log("Ranges after drag:", await page.locator("#ranges-body tr").count());
  await page.screenshot({ path: path.join(out, "web_manual.png") });
  await page.click("#btn-ranges-ok");
  await page.waitForTimeout(400);
  console.log("Manual summary:", await page.textContent("#manual-summary"));
  console.log("Manual status:", await page.textContent("#status"));

  // Exports
  for (const [btn, label] of [["#btn-export-csv", "CSV"], ["#btn-export-png", "PNG"], ["#btn-export-svg", "SVG"]]) {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), page.click(btn)]);
    const target = path.join(out, dl.suggestedFilename());
    await dl.saveAs(target);
    console.log(`${label} export: ${dl.suggestedFilename()} (${fs.statSync(target).size} bytes)`);
  }

  // Dark theme, back to Recursive
  await page.selectOption("#method", "Recursive");
  await page.click('[data-theme-btn="dark"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, "web_dark.png") });

  // Phone width
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log("Horizontal overflow at 390px:", overflow);
  await page.screenshot({ path: path.join(out, "web_phone.png"), fullPage: false });

  console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "No page errors");
  await browser.close();
})();
