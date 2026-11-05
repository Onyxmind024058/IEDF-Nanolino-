// End-to-end check of batch analysis and review in Chromium (opened from file://).
// Usage: NODE_PATH=$(npm root -g) node web/tests/batch-check.cjs <outdir> <file.csv|file.sdf> ...
// Pass at least one file the automatic check rates OK and one it flags.
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require("playwright");

(async () => {
  const out = path.resolve(process.argv[2] || ".");
  const files = process.argv.slice(3).map((f) => path.resolve(f));
  // Plus one broken file, which must show up as an error and not stop the batch
  const broken = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rfea-")), "broken_5PaAr.csv");
  fs.writeFileSync(broken, "not a Semion export\n");
  files.push(broken);

  const url = "file://" + path.resolve(__dirname, "..", "index.html");
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
  page.on("dialog", (d) => d.accept());
  let failed = 0;
  const check = (ok, msg) => {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  };
  const rows = () => page.$$eval("#batch-body tr", (trs) => trs.map((tr) => {
    const td = tr.querySelectorAll("td");
    return { file: td[1].textContent, status: td[2].textContent, flags: td[3].textContent, dE: td[6].textContent, p: td[9].textContent, gas: td[10].textContent, frf: td[11].textContent, note: td[12].textContent };
  }));

  await page.goto(url);
  await page.click('[data-theme-btn="light"]');
  await page.setInputFiles("#file", files);
  await page.waitForFunction((n) => document.querySelectorAll("#batch-body tr").length === n, files.length);
  let r = await rows();
  for (const row of r) console.log(`      ${row.file.padEnd(34)} ${row.status.padEnd(12)} P=${row.p.padEnd(5)} ${row.gas.padEnd(12)} f=${row.frf.padEnd(6)} ${row.flags}`);
  check(!(await page.isHidden("#view-batch")), "batch view opens after opening several files");
  check(r.some((x) => x.status === "OK") && r.some((x) => x.status === "Must review"), "files are rated OK and Must review");
  check(r.at(-1).status === "Error", "broken file is listed as Error");
  console.log("      summary:", await page.textContent("#batch-summary"));
  await page.screenshot({ path: path.join(out, "batch_light.png") });

  // Review the first flagged file
  const flaggedIdx = r.findIndex((x) => x.status === "Must review");
  await page.click(`#batch-body tr:nth-child(${flaggedIdx + 1})`);
  await page.waitForSelector("#view-plot:not([hidden])");
  const flagsShown = await page.$$eval("#review-flags li", (lis) => lis.map((l) => l.textContent));
  check(flagsShown.length > 0, `review bar lists the flags (${flagsShown.length})`);
  check((await page.textContent("#review-name")) === r[flaggedIdx].file, "review bar shows the selected file");
  await page.screenshot({ path: path.join(out, "review_light.png") });

  // Change a setting for this file only
  const otherP = r.find((x, i) => i !== flaggedIdx).p;
  await page.fill("#pressure", "7.5");
  await page.waitForTimeout(300);
  check(!(await page.isHidden("#review-edited")), "edited file is marked as having its own settings");
  await page.click('[data-view="batch"]');
  r = await rows();
  check(r[flaggedIdx].p.startsWith("7.5") && r.find((x, i) => i !== flaggedIdx).p === otherP, "edit applies to this file only");
  await page.click(`#batch-body tr:nth-child(${flaggedIdx + 1})`);

  // Approve with a note: moves on to the next file that needs a look
  await page.fill("#review-note", "checked by eye, peak plausible");
  await page.click("#btn-approve");
  await page.waitForTimeout(200);
  const nextName = await page.textContent("#review-name");
  check(nextName !== r[flaggedIdx].file, `approve moves on to the next flagged file (${nextName})`);
  await page.click("#btn-reject");
  await page.waitForTimeout(200);

  await page.click('[data-view="batch"]');
  await page.click("#btn-approve-ok");
  r = await rows();
  check(r[flaggedIdx].status === "Approved" && r[flaggedIdx].note.startsWith("checked by eye"), "approval and note are in the table");
  check(r.some((x) => x.status === "Approved (bulk)"), "Approve all OK approves the unflagged files");
  check(r.some((x) => x.status === "Rejected"), "reject is recorded");

  await page.selectOption("#batch-filter", "todo");
  const todo = (await rows()).length;
  console.log("      still to review:", todo);
  await page.selectOption("#batch-filter", "all");

  // Summary CSV
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#btn-export-summary")]);
  const csvPath = path.join(out, dl.suggestedFilename());
  await dl.saveAs(csvPath);
  const lines = fs.readFileSync(csvPath, "utf8").trim().split("\n");
  check(lines.length === files.length + 1, `summary CSV has a row per file (${dl.suggestedFilename()})`);
  console.log("      header:", lines[0]);

  // Decisions survive a reload
  await page.reload();
  await page.setInputFiles("#file", files);
  await page.waitForFunction((n) => document.querySelectorAll("#batch-body tr").length === n, files.length);
  r = await rows();
  check(r[flaggedIdx].status === "Approved" && r[flaggedIdx].p.startsWith("7.5"), "review and own settings are restored after reload");

  // Thresholds re-rate the files
  await page.fill("#snr-review", "0");
  await page.fill("#snr-check", "0");
  await page.waitForTimeout(200);
  console.log("      with SNR limits 0:", (await rows()).map((x) => x.flags).join(" | "));

  // Phone width
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 0, `no horizontal page overflow at 390px (${overflow})`);
  await page.screenshot({ path: path.join(out, "batch_phone.png"), fullPage: true });

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.click('[data-theme-btn="dark"]');
  await page.click(`#batch-body tr:nth-child(1)`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, "review_dark.png") });

  check(!errors.length, errors.length ? errors.join("\n") : "no page errors");
  await browser.close();
  console.log(failed ? `\n${failed} check(s) failed` : "\nAll batch checks passed");
  process.exit(failed ? 1 : 0);
})();
