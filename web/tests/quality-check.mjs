// Unit checks for the automatic review (assessQuality) and parseFileName.
// Usage: node web/tests/quality-check.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

vm.runInThisContext(readFileSync(fileURLToPath(new URL("../js/rfea-analysis.js", import.meta.url)), "utf8"));
const { fullAnalysis, assessQuality, parseFileName } = globalThis.RFEA;

// Deterministic noise
let seed = 1;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

// Semion-like export: ion current negative, rising to 0 above the ion energy
function csv({ E0 = 30, width = 3, height = 5e-8, noise = 2e-9, nTraces = 5, sign = 1, scale = () => 1, steps = null }) {
  const st = steps || [[E0, height]];
  const lines = ["Time Averaged IV scan", "Frame ;1;Time;0", "Electrode Voltage ;0", "Channel;1",
    "Average Energy;0", "Ion Flux;0", "trace ;1", "V;I_1;dI/dE_1;"];
  for (let t = 0; t < nTraces; t++) {
    if (t) lines.push("", `trace ;${t + 1}`, "V;I_1;dI/dE_1;");
    for (let k = 0; k < 292; k++) {
      const V = -50 + (150 * k) / 291;
      let I = noise * gauss();
      for (const [E, h] of st) I -= (sign * h * scale(t)) / (1 + Math.exp((V - E) / width));
      lines.push(`${V};${I};0;`);
    }
  }
  return lines.join("\n");
}

const P = { pressure: 1, smoothMethod: "Recursive", smoothParam: 10, Mi: 40, fRf: 13.56e6, Vp: 20, Te: 3, alpha: 3,
  fluxFactor: 6.374e5, crossSection: 8.8e-19, voltageShift: 0, dIdESmoothEV: 1 };
let failed = 0;
const check = (ok, msg) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
};
const rate = (opts) => assessQuality(fullAnalysis(csv(opts), P));
const codes = (q) => q.flags.map((f) => f.code);

let q = rate({});
check(q.level === "ok", `clean signal is OK (SNR ${q.metrics.snr.toFixed(0)}, flags: ${codes(q).join(",") || "none"})`);
q = rate({ noise: 1e-8 });
check(q.level === "check" && codes(q).includes("noisy"), `noisy signal is Check (SNR ${q.metrics.snr.toFixed(1)}: ${codes(q)})`);
q = rate({ height: 3e-9 });
check(q.level === "review" && codes(q).includes("weak-signal"), `weak signal must be reviewed (SNR ${q.metrics.snr.toFixed(1)}: ${codes(q)})`);
q = rate({ sign: -1 });
check(q.level === "review" && codes(q).includes("inverted"), `inverted current must be reviewed (${codes(q)})`);
q = rate({ E0: -55, height: 2e-7 });
check(q.level === "review" && codes(q).includes("peak-edge"), `peak at the start of the sweep must be reviewed (${codes(q)})`);
q = rate({ E0: -15 });
check(q.level === "review" && codes(q).includes("peak-negative"), `peak below 0 eV must be reviewed (${codes(q)})`);
q = rate({ scale: (t) => [1, 0.2, 1.8, 0.4, 1.6][t] });
check(codes(q).includes("traces-disagree"), `traces with different steps are flagged (spread ${q.metrics.traceSpread.toFixed(2)})`);
q = rate({ nTraces: 1 });
check(codes(q).includes("few-traces"), `a single trace is flagged (${codes(q)})`);
q = assessQuality(fullAnalysis(csv({ noise: 1e-8 }), P), { snrReview: 0, snrCheck: 0 });
check(!codes(q).includes("noisy"), "SNR limits can be lowered");

// ---- Double peak and sheath model ----
const two = { steps: [[17, 2.5e-8], [23, 2.5e-8]], width: 0.6 };
let r = fullAnalysis(csv(two), P);
let dp = r.doublePeak;
check(dp.found && Math.abs(dp.Elow - 17) < 1 && Math.abs(dp.Ehigh - 23) < 1,
  `double peak found at ${dp.Elow.toFixed(2)} / ${dp.Ehigh.toFixed(2)} eV (true 17 / 23), ΔE ${dp.dE.toFixed(2)}`);
r = fullAnalysis(csv({ E0: 20, width: 0.6 }), P);
check(!r.doublePeak.found && r.doublePeak.peaks.length === 1, `single peak is not a double peak (${r.doublePeak.peaks.map((x) => x.E.toFixed(1))})`);
check(r.flux > 1e15 && r.flux < 1e20, `flux is a particle flux (${r.flux.toExponential(2)} m⁻² s⁻¹)`);
check(r.ni > 1e12 && r.ni < 1e17 && r.tauRatio > 0.1 && r.tauRatio < 1e3, `n_i ${r.ni.toExponential(2)} m⁻³ and τ ratio ${r.tauRatio.toFixed(1)} are physical`);
const m = r.doublePeak.model;
check(Math.abs(globalThis.RFEA.splitFromSheath(P.Vp, m.sheathWidth, P.fRf, P.Mi) - m.dETheory) < 1e-12 &&
  Math.abs(globalThis.RFEA.sheathFromSplit(P.Vp, m.dETheory, P.fRf, P.Mi) / m.sheathWidth - 1) < 1e-12, "ΔE ↔ sheath width formulas invert each other");
q = assessQuality(r);
check(q.level === "ok" && codes(q).includes("split-unresolved"), `13.56 MHz Ar: splitting ${m.dETheory.toFixed(2)} eV noted as unresolved, rating stays OK (${codes(q)})`);
q = assessQuality(fullAnalysis(csv({ E0: 20, width: 0.6 }), { ...P, pressure: 10 }));
check(codes(q).includes("collisional") && q.level === "ok", `10 Pa: collisional sheath noted (${codes(q)})`);
const lowP = { ...P, pressure: 0.05, Mi: 4, crossSection: 8.8e-19 / 3 };
q = assessQuality(fullAnalysis(csv(two), lowP));
check(codes(q).includes("double-peak") && codes(q).includes("split-mismatch"), `ΔE far from theory is flagged (${codes(q)})`);
const lowF = { ...lowP, fRf: 0.4e6 };
r = fullAnalysis(csv({ E0: 20, width: 0.6 }), lowF);
q = assessQuality(r);
check(codes(q).includes("double-missing"), `theory ΔE ${r.doublePeak.model.dETheory.toFixed(1)} eV, τ ${r.tauRatio.toFixed(1)}, one peak: flagged (${codes(q)})`);

// Powered-electrode scan like 13.56 MHz / 1 Pa: electrode at -352 V, bias measured
// against it from -30 to 440 V in 1 V steps; IEDF = charge-exchange ramp below
// E1 plus a bimodal group between E1 and E2, broadened by 4 eV.
function electrodeScan({ E1 = 330, E2 = 420, highWeight = 1, noise = 3e-9, electrode = -352 }) {
  const Ev = [];
  const f = [];
  for (let E = -60; E <= 480; E += 0.25) {
    let v = E > 0 && E < E1 ? 0.35 * (E / E1) : 0;
    if (E > E1 && E < E2) {
      const x = (2 * (E - E1)) / (E2 - E1) - 1; // -1 .. 1 across the group
      v += Math.min(4, 1 / Math.sqrt(1 - x * x)) * (x > 0 ? highWeight : 1);
    }
    Ev.push(E);
    f.push(v);
  }
  const g = f.map((_, i) => { // Gaussian broadening, sigma 4 eV
    let a = 0, wsum = 0;
    for (let k = -64; k <= 64; k++) {
      const j = i + k;
      if (j < 0 || j >= f.length) continue;
      const w = Math.exp(-0.5 * ((k * 0.25) / 4) ** 2);
      a += w * f[j];
      wsum += w;
    }
    return a / wsum;
  });
  const cum = new Float64Array(g.length); // current = -integral of f above V
  for (let i = g.length - 2; i >= 0; i--) cum[i] = cum[i + 1] + 0.25 * g[i];
  const scale = 1.35e-6 / cum[Ev.indexOf(-30)];
  const lines = ["Time Averaged IV scan", "Frame ;1;Time;0", `Electrode Voltage ;${electrode}`, "Channel;1", "Average Energy;0", "Ion Flux;0", "trace ;1", "V;I_1;dI/dE_1;"];
  for (let t = 0; t < 2; t++) {
    if (t) lines.push("", "trace ;2", "V;I_1;dI/dE_1;");
    for (let V = -30; V <= 440; V += 1) lines.push(`${V};${-scale * cum[Math.round((V + 60) / 0.25)] + noise * gauss()};0;`);
  }
  return lines.join("\n");
}
const P1 = { ...P, pressure: 1 };
for (const [label, opts] of [["equal peaks", {}], ["weaker high-energy peak", { highWeight: 0.45 }]]) {
  r = fullAnalysis(electrodeScan(opts), P1);
  dp = r.doublePeak;
  check(dp.found && Math.abs(dp.Elow - 330) < 8 && Math.abs(dp.Ehigh - 420) < 10,
    `electrode scan, ${label}: double peak ${dp.Elow.toFixed(1)} / ${dp.Ehigh.toFixed(1)} eV (true 330 / 420)${dp.highFromEdge ? ", high peak from the edge" : ""}`);
}
check(Math.abs(dp.model.sheathVoltage - (P1.Vp + 352)) < 1e-9, `sheath voltage is V_p − electrode voltage (${dp.model.sheathVoltage} V)`);
r = fullAnalysis(csv({ E0: 40, width: 15 }), P);
check(!r.doublePeak.found, `broad single peak with a slow tail is not a double peak (${r.doublePeak.peaks.map((x) => `${x.E.toFixed(1)} eV ${x.sigmas.toFixed(1)}σ`)})`);

const cases = [
  ["20240618_21_25W10PaAr60MHz.sdf", { powerW: 25, pressure: 10, fRfMHz: 60, species: "Ar", Mi: 40, gas: "Ar Impedans" }],
  ["20240618_14_10W5PaHe13MHz.csv", { powerW: 10, pressure: 5, fRfMHz: 13.56, species: "He", Mi: 4, gas: "He Impedans" }],
  ["scan_2,5W0.8PaAr27MHz.csv", { powerW: 2.5, pressure: 0.8, fRfMHz: 27.12, species: "Ar", Mi: 40, gas: "Ar Impedans" }],
  ["export.csv", {}],
];
for (const [name, want] of cases) {
  const got = parseFileName(name);
  check(JSON.stringify(got) === JSON.stringify(want), `parseFileName(${name}) = ${JSON.stringify(got)}`);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nAll quality checks passed");
process.exit(failed ? 1 : 0);
