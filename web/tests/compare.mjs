// Compare the JavaScript analysis against the Python reference results.
// Usage: node web/tests/compare.mjs web/tests/data
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

vm.runInThisContext(readFileSync(fileURLToPath(new URL("../js/rfea-analysis.js", import.meta.url)), "utf8"));
const { fullAnalysis } = globalThis.RFEA;

const dir = process.argv[2] || "web/tests/data";
const ref = JSON.parse(readFileSync(join(dir, "reference.json"), "utf8"));
const RTOL = 1e-6;

function relErr(a, b) {
  if (a === b) return 0;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.isNaN(a) && Number.isNaN(b) ? 0 : Infinity;
  return Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);
}

// Array error relative to the array's scale (point-wise error near zero
// crossings is meaningless)
function arrErr(a, b) {
  if (a.length !== b.length) return { err: Infinity, note: `length ${a.length} vs ${b.length}` };
  let scale = 0;
  for (const v of b) if (Number.isFinite(v)) scale = Math.max(scale, Math.abs(v));
  let err = 0;
  for (let i = 0; i < a.length; i++) err = Math.max(err, Math.abs(a[i] - b[i]) / (scale || 1));
  return { err };
}

let failed = 0;
for (const c of ref) {
  const p = c.params;
  const params = {
    pressure: p.pressure,
    smoothFactordIdV: p.SmoothFactordIdV,
    smoothMethod: p.smoothfunctionIV,
    smoothParam: p.smoothIVparam,
    Mi: p.Mi,
    fRf: p.f_rf,
    Vp: p.Vp,
    Te: p.Te,
    alpha: p.alpha,
    fluxFactor: p.Flux_factor,
    crossSection: p.collision_cross_section,
    voltageShift: p.voltage_shift,
  };
  const label = `${c.csv} / ${c.case}`;
  let js;
  try {
    js = fullAnalysis(readFileSync(join(dir, c.csv), "utf8"), params);
  } catch (e) {
    js = { error: String(e.message) };
  }
  const py = c.result;
  if (py.error || js.error) {
    const ok = Boolean(py.error) && Boolean(js.error);
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}: python=${py.error ?? "ok"} | js=${js.error ?? "ok"}`);
    continue;
  }
  const rows = [];
  for (const k of ["Eavg", "flux", "ni", "Epeak", "tauRatio", "electrodeVoltage", "ionFlux"]) {
    rows.push([k, relErr(js[k], py[k])]);
  }
  for (const k of ["Vavg", "Iavg", "Ismooth", "E", "dIdE"]) {
    const { err, note } = arrErr(Array.from(js[k]), py[k]);
    rows.push([k + "[]", err, note]);
  }
  const bad = rows.filter(([, e]) => !(e <= RTOL));
  if (bad.length) failed++;
  const worst = Math.max(...rows.map(([, e]) => e));
  console.log(`${bad.length ? "FAIL" : "PASS"}  ${label}: worst rel. error ${worst.toExponential(2)}` +
    (bad.length ? "  <- " + bad.map(([k, e, n]) => `${k}=${n ?? e.toExponential(2)}`).join(", ") : ""));
}
console.log(failed ? `\n${failed} case(s) differ` : `\nAll ${ref.length} cases match Python (rtol ${RTOL})`);
process.exit(failed ? 1 : 0);
