// Accuracy benchmark on synthetic RFEA data with a known IEDF.
// Each case builds 10 noisy traces from a known ion energy distribution, runs the
// full analysis and scores peak energy, mean energy and IEDF shape against the truth.
// Usage: node web/tests/benchmark.cjs        (exit code 1 if the limits below are missed)
const fs = require("fs");
const vm = require("vm");
const path = require("path");
vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "js", "rfea-analysis.js"), "utf8"));
const R = globalThis.RFEA;

const LIMITS = { meanPeakErr: 0.2, meanAvgErr: 0.15, meanShapeErr: 0.06 }; // new Recursive method
const SEEDS = 8;

let seed = 1;
const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const gauss = () => Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());
const G = (E, mu, s) => Math.exp(-0.5 * ((E - mu) / s) ** 2);

const CASES = [
  { name: "sparse 0.5 V, peak 12 eV + tail", v0: -20, v1: 70, dv: 0.5, f: (E) => G(E, 12, 3) + 0.25 * G(E, 5, 6), noise: 0.01 },
  { name: "sparse 0.5 V, peak 45 eV", v0: 0, v1: 90, dv: 0.5, f: (E) => G(E, 45, 5), noise: 0.01 },
  { name: "dense 0.17 V, peak 70 eV", v0: 0, v1: 150, dv: 150 / 899, f: (E) => G(E, 70, 4), noise: 0.005 },
  { name: "dense 0.1 V, narrow 20 eV", v0: -10, v1: 60, dv: 0.1, f: (E) => G(E, 20, 1.5), noise: 0.005 },
  { name: "bimodal 0.25 V, 40 + 60 eV", v0: 0, v1: 120, dv: 0.25, f: (E) => G(E, 40, 3) + 1.3 * G(E, 60, 3), noise: 0.01 },
];

function makeCase(c) {
  const V = [];
  for (let v = c.v0; v <= c.v1 + 1e-9; v += c.dv) V.push(Number(v.toFixed(6)));
  // Collector current: I(V) = -A x (fraction of ions with energy above V), so dI/dV ∝ f(V)
  const step = c.dv / 20;
  const Ef = [];
  const ff = [];
  for (let e = c.v0 - 30; e <= c.v1 + 30; e += step) { Ef.push(e); ff.push(Math.max(0, c.f(e))); }
  const cum = [0];
  for (let k = 1; k < Ef.length; k++) cum.push(cum[k - 1] + 0.5 * (ff[k] + ff[k - 1]) * step);
  const total = cum[cum.length - 1];
  const A = 3e-8;
  const Iclean = V.map((v) => {
    const k = Math.min(Ef.length - 1, Math.max(0, Math.round((v - Ef[0]) / step)));
    return -A * (1 - cum[k] / total);
  });
  const lines = ["Time Averaged IV scan", "Frame ;1;Time;0.001", "Electrode Voltage ;1.5", "Channel;1",
    "Average Energy;0", "Ion Flux;0", "trace ;1", "V;I_1;dI/dE_1;"];
  for (let t = 0; t < 10; t++) {
    if (t) lines.push("", `trace ;${t + 1}`, "V;I_1;dI/dE_1;");
    V.forEach((v, i) => lines.push(`${v};${(Iclean[i] + A * c.noise * gauss()).toExponential(6)};0;`));
  }
  const fv = V.map((v) => Math.max(0, c.f(v)));
  let num = 0;
  let den = 0;
  V.forEach((v, i) => { num += v * fv[i]; den += fv[i]; });
  return { text: lines.join("\r\n"), V, fv, Epeak: V[fv.indexOf(Math.max(...fv))], Eavg: num / den };
}

// L1 distance between the unit-area recovered and true IEDFs (0 = identical, 2 = disjoint)
function shapeError(E, d, V, fv) {
  const g = V.map((x) => {
    if (x <= E[0] || x >= E[E.length - 1]) return 0;
    let k = 1;
    while (E[k] < x) k++;
    const t = (x - E[k - 1]) / (E[k] - E[k - 1]);
    return Math.max(0, d[k - 1] + t * (d[k] - d[k - 1]));
  });
  const sg = g.reduce((a, b) => a + b, 0);
  const sf = fv.reduce((a, b) => a + b, 0);
  return sg ? V.reduce((acc, _, i) => acc + Math.abs(g[i] / sg - fv[i] / sf), 0) : 2;
}

const base = { pressure: 1, Mi: 40, fRf: 13.56e6, Vp: 20, Te: 3, alpha: 3, fluxFactor: 1, crossSection: 8.8e-19 };
const METHODS = [
  ["Recursive (new)", { smoothMethod: "Recursive", smoothParam: 10, dIdESmoothEV: 1 }],
  ["Mavg 5", { smoothMethod: "Mavg", smoothParam: 5, dIdESmoothEV: 1 }],
  ["SG (2, 9)", { smoothMethod: "SG", smoothParam: [2, 9], dIdESmoothEV: 1 }],
  ["Recursive (legacy defaults)", { pipeline: "legacy", smoothMethod: "Recursive", smoothParam: 10, smoothFactordIdV: 50 }],
  ["Mavg 20 (legacy defaults)", { pipeline: "legacy", smoothMethod: "Mavg", smoothParam: 20, smoothFactordIdV: 50 }],
];

const stats = {};
for (const [name] of METHODS) stats[name] = { peak: [], avg: [], shape: [], failed: 0, perCase: {} };
for (let s = 0; s < SEEDS; s++) {
  for (const c of CASES) {
    seed = 1000 + 7919 * s;
    const t = makeCase(c);
    for (const [name, opts] of METHODS) {
      const st = stats[name];
      try {
        const r = R.fullAnalysis(t.text, { ...base, ...opts });
        const sh = shapeError(Array.from(r.E), Array.from(r.dIdE), t.V, t.fv);
        st.peak.push(Math.abs(r.Epeak - t.Epeak));
        st.avg.push(Math.abs(r.Eavg - t.Eavg));
        st.shape.push(sh);
        (st.perCase[c.name] ??= []).push(sh);
      } catch (e) {
        st.failed++;
      }
    }
  }
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const runs = SEEDS * CASES.length;
console.log(`${CASES.length} cases x ${SEEDS} noise draws\n`);
console.log("Method".padEnd(30) + "|ΔE_peak| eV  |ΔE_avg| eV  shape error  failed");
for (const [name] of METHODS) {
  const st = stats[name];
  console.log(name.padEnd(30) + mean(st.peak).toFixed(2).padStart(11) + mean(st.avg).toFixed(2).padStart(13) +
    mean(st.shape).toFixed(3).padStart(13) + `${st.failed}/${runs}`.padStart(8));
}
console.log("\nShape error per case (Recursive new):");
for (const [c, v] of Object.entries(stats["Recursive (new)"].perCase)) console.log("  " + c.padEnd(34) + mean(v).toFixed(3));

const n = stats["Recursive (new)"];
const ok = n.failed === 0 && mean(n.peak) <= LIMITS.meanPeakErr && mean(n.avg) <= LIMITS.meanAvgErr && mean(n.shape) <= LIMITS.meanShapeErr;
console.log(ok ? "\nPASS: Recursive (new) within limits" : `\nFAIL: Recursive (new) outside limits ${JSON.stringify(LIMITS)}`);
process.exit(ok ? 0 : 1);
