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
function csv({ E0 = 30, width = 3, height = 5e-8, noise = 2e-9, nTraces = 5, sign = 1, scale = () => 1 }) {
  const lines = ["Time Averaged IV scan", "Frame ;1;Time;0", "Electrode Voltage ;0", "Channel;1",
    "Average Energy;0", "Ion Flux;0", "trace ;1", "V;I_1;dI/dE_1;"];
  for (let t = 0; t < nTraces; t++) {
    if (t) lines.push("", `trace ;${t + 1}`, "V;I_1;dI/dE_1;");
    for (let k = 0; k < 292; k++) {
      const V = -50 + (150 * k) / 291;
      const I = -sign * height * scale(t) / (1 + Math.exp((V - E0) / width)) + noise * gauss();
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
