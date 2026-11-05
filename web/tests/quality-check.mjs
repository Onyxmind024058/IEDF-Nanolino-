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
q = rate({ nTraces: 2 });
check(codes(q).includes("few-traces"), `two traces are flagged (${codes(q)})`);
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
const lowF = { ...lowP, fRf: 1e6 };
r = fullAnalysis(csv({ E0: 20, width: 0.6 }), lowF);
q = assessQuality(r);
check(codes(q).includes("double-missing"), `theory ΔE ${r.doublePeak.model.dETheory.toFixed(1)} eV, τ ${r.tauRatio.toFixed(1)}, one peak: flagged (${codes(q)})`);

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
