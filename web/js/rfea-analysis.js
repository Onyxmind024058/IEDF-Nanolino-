// RFEA / IEDF analysis — JavaScript port of Python_RFEA_Analysis_fcn.py.
// Loaded as a plain script (works from file:// too); exposes globalThis.RFEA.
// Each function mirrors its Python counterpart (and the NumPy/SciPy calls it
// relies on) so results can be checked against the Python implementation.

(function () {
"use strict";

const EPS = 2.220446049250313e-16; // np.finfo(float).eps
const E_CHARGE = 1.602e-19;
const AMU = 1.66e-27;

// ------------------------------------------------------------------
// NumPy / SciPy helpers
// ------------------------------------------------------------------

// scipy.ndimage.uniform_filter1d(y, size, mode="nearest")
function smooth1d(y, window) {
  const n = y.length;
  const w = Math.max(1, Math.trunc(window));
  const out = new Float64Array(n);
  if (n === 0) return out;
  const left = Math.floor(w / 2);
  const at = (i) => y[i < 0 ? 0 : i >= n ? n - 1 : i];
  let sum = 0;
  for (let k = -left; k < w - left; k++) sum += at(k);
  for (let i = 0; i < n; i++) {
    out[i] = sum / w;
    sum += at(i + w - left) - at(i - left);
  }
  return out;
}

// np.diff(np.r_[eps, a]) / np.diff(np.r_[eps, b])
function diffRatioWithEps(a, b) {
  const n = a.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const da = a[i] - (i === 0 ? EPS : a[i - 1]);
    const db = b[i] - (i === 0 ? EPS : b[i - 1]);
    out[i] = da / db;
  }
  return out;
}

function nanargmax(a) {
  let best = -1;
  for (let i = 0; i < a.length; i++) {
    if (Number.isNaN(a[i])) continue;
    if (best < 0 || a[i] > a[best]) best = i;
  }
  if (best < 0) throw new Error("All-NaN slice encountered");
  return best;
}

function nanmax(a) {
  return a[nanargmax(a)];
}

// scipy.signal._peak_finding_utils._local_maxima_1d
function localMaxima(x) {
  const peaks = [];
  const n = x.length;
  let i = 1;
  const iMax = n - 1;
  while (i < iMax) {
    if (x[i - 1] < x[i]) {
      let ahead = i + 1;
      while (ahead < iMax && x[ahead] === x[i]) ahead++;
      if (x[ahead] < x[i]) {
        peaks.push((i + ahead - 1) >> 1);
        i = ahead;
      }
    }
    i++;
  }
  return peaks;
}

// scipy.signal.peak_prominences (wlen=None)
function prominences(x, peaks) {
  return peaks.map((p) => {
    let leftMin = x[p];
    for (let i = p; i >= 0 && x[i] <= x[p]; i--) if (x[i] < leftMin) leftMin = x[i];
    let rightMin = x[p];
    for (let i = p; i < x.length && x[i] <= x[p]; i++) if (x[i] < rightMin) rightMin = x[i];
    return x[p] - Math.max(leftMin, rightMin);
  });
}

// scipy.signal.find_peaks(x, prominence=minProm) -> {peaks, prominences}
function findPeaks(x, minProm) {
  const all = localMaxima(x);
  const prom = prominences(x, all);
  const peaks = [];
  const proms = [];
  all.forEach((p, k) => {
    if (prom[k] >= minProm) {
      peaks.push(p);
      proms.push(prom[k]);
    }
  });
  return { peaks, prominences: proms };
}

// Least-squares polynomial fit evaluated at `at`, written as weights on the
// samples: returns w so that sum_j w[j] * y[j] is the fitted value.
// x is centred and scaled for numerical stability.
function polyFitWeights(xs, order, at) {
  const m = xs.length;
  const c = (xs[0] + xs[m - 1]) / 2;
  const s = Math.max(1, (xs[m - 1] - xs[0]) / 2);
  const u = xs.map((v) => (v - c) / s);
  const ua = (at - c) / s;
  const k = order + 1;
  // Normal matrix A^T A (k x k)
  const N = Array.from({ length: k }, () => new Float64Array(k));
  for (const v of u) {
    const pw = [1];
    for (let p = 1; p < 2 * k; p++) pw.push(pw[p - 1] * v);
    for (let r = 0; r < k; r++) for (let q = 0; q < k; q++) N[r][q] += pw[r + q];
  }
  // Solve N z = phi(at), then w_j = phi(u_j) . z
  const rhs = new Float64Array(k);
  for (let r = 0; r < k; r++) rhs[r] = ua ** r;
  const z = solve(N, rhs);
  return u.map((v) => {
    let acc = 0;
    for (let r = 0; r < k; r++) acc += z[r] * v ** r;
    return acc;
  });
}

// Gaussian elimination with partial pivoting
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      for (let q = col; q <= n; q++) M[r][q] -= f * M[col][q];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let acc = M[r][n];
    for (let q = r + 1; q < n; q++) acc -= M[r][q] * x[q];
    x[r] = acc / M[r][r];
  }
  return x;
}

// scipy.signal.savgol_filter(y, window, polyorder, mode="interp")
function savgolFilter(y, window, polyorder) {
  const n = y.length;
  if (polyorder >= window) throw new Error("polyorder must be less than window_length.");
  if (window % 2 === 0) throw new Error("SG window_length must be odd and larger than polyorder + 1.");
  if (window > n) throw new Error("If mode is 'interp', window_length must be less than or equal to the size of x.");
  const half = (window - 1) / 2;
  const idx = Array.from({ length: window }, (_, j) => j);
  const centre = polyFitWeights(idx, polyorder, half);
  const out = new Float64Array(n);
  for (let i = half; i < n - half; i++) {
    let acc = 0;
    for (let j = 0; j < window; j++) acc += centre[j] * y[i - half + j];
    out[i] = acc;
  }
  // Edges: fit the first/last window and evaluate the polynomial there
  for (let i = 0; i < half; i++) {
    const wStart = polyFitWeights(idx, polyorder, i);
    const wEnd = polyFitWeights(idx, polyorder, window - half + i);
    let a = 0;
    let b = 0;
    for (let j = 0; j < window; j++) {
      a += wStart[j] * y[j];
      b += wEnd[j] * y[n - window + j];
    }
    out[i] = a;
    out[n - half + i] = b;
  }
  return out;
}

// np.trapezoid(y, x)
function trapezoid(y, x) {
  let s = 0;
  for (let i = 1; i < y.length; i++) s += ((y[i] + y[i - 1]) / 2) * (x[i] - x[i - 1]);
  return s;
}

// pandas.to_numeric(..., errors="coerce") for one stripped cell
function toNumber(cell) {
  if (cell === undefined) return NaN;
  const s = cell.trim();
  if (s === "") return NaN;
  const lower = s.toLowerCase();
  if (lower === "inf" || lower === "+inf" || lower === "infinity") return Infinity;
  if (lower === "-inf" || lower === "-infinity") return -Infinity;
  const v = Number(s);
  return Number.isNaN(v) ? NaN : v;
}

// ------------------------------------------------------------------
// Analysis (same structure as the Python module)
// ------------------------------------------------------------------

// ------------------------------------------------------------------
// Binary Semion .sdf scan files (same layout as import_sdf in Python)
// ------------------------------------------------------------------
// uint32 length + JSON scan settings, then "\r\n[DATA]\r\n" and, big-endian:
// uint32 magic 0xACDCB070, uint32 stream version, 11 uint32 header words,
// uint32 nTraces; per trace uint32 nArrays, uint32 nPoints, then
// nArrays x nPoints float64: current I [A], the voltage channels [V] (second
// last = electrode voltage) and, last, the measured discriminator bias [V].
const SDF_MARKER = [13, 10, 91, 68, 65, 84, 65, 93, 13, 10]; // \r\n[DATA]\r\n
const SDF_MAGIC = 0xacdcb070;

function asBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function findBytes(bytes, pattern, from) {
  outer: for (let i = from; i <= bytes.length - pattern.length; i++) {
    for (let k = 0; k < pattern.length; k++) if (bytes[i + k] !== pattern[k]) continue outer;
    return i;
  }
  return -1;
}

// True for a binary .sdf file (detected by content, not by extension)
function isSdf(data) {
  const b = asBytes(data);
  if (!b || b.length < 8) return false;
  const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, false);
  return b[4] === 0x7b && findBytes(b, SDF_MARKER, 4 + n) !== -1;
}

// Returns the same shape as importFile. V is a straight-line fit of the
// measured bias per trace (the V column Semion writes to its CSV export);
// ion flux is not stored in .sdf (NaN); dIdE is recomputed by the analysis.
function importSdf(data) {
  const b = asBytes(data);
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const n = view.getUint32(0, false);
  let settings;
  try {
    settings = JSON.parse(new TextDecoder("utf-8").decode(b.subarray(4, 4 + n)));
  } catch (e) {
    throw new Error(`SDF: could not read the scan settings: ${e.message}`);
  }
  if (Number(settings.activeSensors ?? 1) !== 1) {
    throw new Error(`SDF: only single-sensor scans are supported (this file has activeSensors=${settings.activeSensors})`);
  }
  const start = findBytes(b, SDF_MARKER, 4 + n) + SDF_MARKER.length;
  const len = b.length - start;
  const u32 = (o) => view.getUint32(start + o, false);
  if (len < 56 || u32(0) !== SDF_MAGIC) throw new Error("SDF: unrecognised data block (wrong magic number)");

  const nTraces = u32(52);
  let off = 56;
  const V = [];
  const I = [];
  const dIdE = [];
  let evSum = 0;
  let evCount = 0;
  for (let t = 0; t < nTraces; t++) {
    if (off + 8 > len) throw new Error(`SDF: file ends inside trace ${t + 1}`);
    const nArr = u32(off);
    const nPts = u32(off + 4);
    off += 8;
    if (nArr < 3 || off + 8 * nArr * nPts > len) {
      throw new Error(`SDF: trace ${t + 1} has an unexpected size (${nArr} x ${nPts})`);
    }
    const f64 = (a, k) => view.getFloat64(start + off + 8 * (a * nPts + k), false);
    // Least-squares line through the measured bias against the point index
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let k = 0; k < nPts; k++) {
      const y = f64(nArr - 1, k);
      sx += k; sy += y; sxx += k * k; sxy += k * y;
    }
    const den = nPts * sxx - sx * sx;
    const slope = den ? (nPts * sxy - sx * sy) / den : 0;
    const intercept = (sy - slope * sx) / nPts;
    for (let k = 0; k < nPts; k++) {
      V.push(intercept + slope * k);
      I.push(f64(0, k));
      dIdE.push(NaN);
      evSum += f64(nArr - 2, k);
      evCount++;
    }
    V.push(NaN); I.push(NaN); dIdE.push(NaN); // trace separator
    off += 8 * nArr * nPts;
  }
  if (off !== len) throw new Error(`SDF: ${len - off} unexpected bytes after the last trace`);
  if (!nTraces) throw new Error("SDF: the file contains no traces");
  return { electrodeVoltage: evSum / evCount, ionFlux: NaN, table: { V, I, dIdE } };
}

// import_file: electrode voltage (line 3), ion flux (line 6), traces (line 9+).
// Accepts CSV text, or the raw bytes (ArrayBuffer / Uint8Array) of a .csv or .sdf file.
function importFile(data) {
  const bytes = asBytes(data);
  if (bytes) {
    if (isSdf(bytes)) return importSdf(bytes);
    data = new TextDecoder("utf-8").decode(bytes);
  }
  const text = data;
  const lines = text.split(/\r\n|\r|\n/);

  const secondCol = (line1) => {
    const idx = line1 - 1;
    if (idx < 0 || idx >= lines.length) throw new Error(`File too short: can't read line ${line1}`);
    const parts = lines[idx].split(/[;,]/).map((p) => p.trim()).filter((p) => p);
    if (parts.length < 2) throw new Error(`Line ${line1} has <2 columns: ${JSON.stringify(lines[idx])}`);
    const v = toNumber(parts[1]);
    if (Number.isNaN(v) && !/^[+-]?nan$/i.test(parts[1])) {
      throw new Error(`could not convert string to float: '${parts[1]}'`);
    }
    return v;
  };

  const electrodeVoltage = secondCol(3);
  const ionFlux = secondCol(6);

  const traceLines = lines.slice(8).filter((l) => l.trim() !== "");
  const sample = traceLines.slice(0, 50).join("\n");
  const sep = sample.includes(";") ? ";" : sample.includes("\t") ? "\t" : ",";

  const V = [];
  const I = [];
  const dIdE = [];
  for (const line of traceLines) {
    const cells = line.split(sep);
    const v = toNumber(cells[0]);
    const i = toNumber(cells[1]);
    const d = toNumber(cells[2]);
    if (Number.isNaN(v) && Number.isNaN(i) && Number.isNaN(d)) continue;
    V.push(v);
    I.push(i);
    dIdE.push(d);
  }
  return { electrodeVoltage, ionFlux, table: { V, I, dIdE } };
}

// separate_traces_from_table: split on NaN voltage rows -> arrays of traces
function separateTraces(table) {
  const { V, I } = table;
  const segV = [];
  const segI = [];
  let start = 0;
  const flush = (end) => {
    if (end > start) {
      const v = V.slice(start, end);
      const i = I.slice(start, end);
      if (v.every(Number.isFinite) && i.every(Number.isFinite)) {
        segV.push(v);
        segI.push(i);
      }
    }
  };
  for (let k = 0; k < V.length; k++) {
    if (Number.isNaN(V[k])) {
      flush(k);
      start = k + 1;
    }
  }
  flush(V.length);
  if (segV.length === 0) throw new Error("No numeric trace segments found (check NaN separators / file format).");
  const nrow = Math.min(...segV.map((v) => v.length));
  return {
    V: segV.map((v) => v.slice(0, nrow)),
    I: segI.map((i) => i.slice(0, nrow)),
    nrow,
  };
}

// traceaverage_and_smooth: mean over traces, shift voltage, light smoothing
function traceAverageAndSmooth(traces, smoothFactorIV, voltageShift = 0) {
  const { V, I, nrow } = traces;
  const k = V.length;
  const Vavg = new Float64Array(nrow);
  const Iavg = new Float64Array(nrow);
  for (let r = 0; r < nrow; r++) {
    let sv = 0;
    let si = 0;
    for (let t = 0; t < k; t++) {
      sv += V[t][r];
      si += I[t][r];
    }
    Vavg[r] = sv / k - voltageShift;
    Iavg[r] = si / k;
  }
  return { Isth: smooth1d(Iavg, smoothFactorIV), Iavg, Vavg };
}

// manual_smooth_by_ranges: moving average only inside the selected V ranges
function manualSmoothByRanges(I, V, ranges) {
  const Ismooth = Float64Array.from(I);
  for (const r of ranges || []) {
    let xmin = Number(r.xmin);
    let xmax = Number(r.xmax);
    const window = Math.max(1, Math.trunc(Number(r.window)));
    if (!Number.isFinite(xmin) || !Number.isFinite(xmax) || !Number.isFinite(window)) continue;
    if (xmax < xmin) [xmin, xmax] = [xmax, xmin];
    const idx = [];
    for (let i = 0; i < V.length; i++) if (V[i] >= xmin && V[i] <= xmax) idx.push(i);
    if (idx.length <= 1) continue;
    const seg = idx.map((i) => I[i]);
    const sm = smooth1d(seg, Math.max(1, Math.min(window, seg.length)));
    idx.forEach((i, j) => (Ismooth[i] = sm[j]));
  }
  return Ismooth;
}

function detectPeakEnergy(dIdE, Vx) {
  const lo = 9;
  const hi = Math.max(lo + 1, dIdE.length - 100);
  const yy = dIdE.slice(lo, hi);
  const xx = Vx.slice(lo, hi);
  if (yy.length < 5) return Vx[nanargmax(dIdE)];
  const prom = nanmax(yy);
  let res = findPeaks(yy, prom);
  if (res.peaks.length === 0) res = findPeaks(yy, 0.7 * prom);
  if (res.peaks.length === 0) return xx[nanargmax(yy)];
  let best = 0;
  for (let k = 1; k < res.peaks.length; k++) if (res.prominences[k] > res.prominences[best]) best = k;
  return xx[res.peaks[best]];
}

function splitSmoothAround(I, V, Epeak, x) {
  const I1 = [];
  const I2 = [];
  const I3 = [];
  for (let k = 0; k < V.length; k++) {
    if (V[k] < Epeak - x) I1.push(I[k]);
    if (V[k] > Epeak - x && V[k] < Epeak + x) I2.push(I[k]);
    if (V[k] > Epeak + x) I3.push(I[k]);
  }
  const out = Float64Array.from([...smooth1d(I1, 200), ...I2, ...smooth1d(I3, 200)]);
  if (out.length !== V.length) {
    throw new Error(`operands could not be broadcast together with shapes (${out.length},) (${V.length},)`);
  }
  return out;
}

// smoothIV_SinglePeak: iterate until the detected peak moves < 0.1 eV
function smoothIVSinglePeak(I, V, window = 10, maxIter = 1000) {
  const x = Math.trunc(window);
  let cur = Float64Array.from(I);
  let Epeak = NaN;
  let EpeakPrev = NaN;
  for (let iter = 0; iter < maxIter; iter++) {
    if (!Number.isNaN(Epeak) && !Number.isNaN(EpeakPrev) && Math.abs(EpeakPrev - Epeak) < 0.1) {
      return { Epeak, Ismooth: cur, V };
    }
    const dIdE = smooth1d(diffRatioWithEps(cur, V), 100);
    const Enew = detectPeakEnergy(dIdE, V);
    cur = splitSmoothAround(cur, V, Enew, x);
    EpeakPrev = Epeak;
    Epeak = Enew;
  }
  throw new Error("Recursive smoothing did not converge (peak keeps moving). Try another smoothing method.");
}

// ------------------------------------------------------------------
// Peak-preserving smoothing (the improved "Recursive" method)
//
// All widths are in eV, so the same settings work for any voltage step.
// Every significant IEDF peak gets a protected zone that is left unsmoothed;
// outside it a moving average widens with the distance to the zone but never
// reaches into it, so there are no kinks at the zone edges. Peaks are
// re-detected on the result until they stop moving.
// ------------------------------------------------------------------

function medianStep(V) {
  const d = [];
  for (let i = 1; i < V.length; i++) d.push(Math.abs(V[i] - V[i - 1]));
  d.sort((a, b) => a - b);
  return d[d.length >> 1] || 1;
}

// Width in eV -> odd number of samples (even moving averages shift the curve)
function oddWindow(widthEV, dv) {
  const n = Math.max(1, Math.round(widthEV / dv));
  return n % 2 ? n : n + 1;
}

function slopes(I, V) {
  const d = new Float64Array(I.length - 1);
  for (let i = 1; i < I.length; i++) d[i - 1] = (I[i] - I[i - 1]) / (V[i] - V[i - 1]);
  return d;
}

// Moving average with a half-width h[i] (samples) per point; nearest-value padding at the ends
function variableMovingAverage(y, h) {
  const n = y.length;
  const P = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) P[i + 1] = P[i] + y[i];
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const k = Math.max(0, Math.round(h[i]));
    let a = i - k;
    let b = i + k;
    let s = 0;
    if (a < 0) { s += -a * y[0]; a = 0; }
    if (b > n - 1) { s += (b - n + 1) * y[n - 1]; b = n - 1; }
    out[i] = (s + P[b + 1] - P[a]) / (2 * k + 1);
  }
  return out;
}

// IEDF peaks with at least relProm x the largest prominence, strongest first
function detectIedfPeaks(I, V, detectEV, relProm) {
  const w = oddWindow(detectEV, medianStep(V));
  const d = smooth1d(slopes(I, V), w);
  const Vm = Array.from({ length: d.length }, (_, i) => 0.5 * (V[i] + V[i + 1]));
  const lo = Math.min(w, d.length >> 2);
  const hi = Math.max(lo + 1, d.length - lo); // skip edges distorted by the smoothing
  const yy = d.slice(lo, hi);
  const { peaks, prominences } = findPeaks(yy, 0);
  if (!peaks.length) return [Vm[lo + nanargmax(yy)]];
  const top = Math.max(...prominences);
  return peaks
    .map((p, k) => [p, prominences[k]])
    .filter(([, pr]) => pr >= relProm * top)
    .sort((a, b) => b[1] - a[1])
    .map(([p]) => Vm[lo + p]);
}

function peakPreservingSmooth(I, V, opts = {}) {
  const { protectEV = 10, maxEV = 5, growth = 0.5, detectEV = 2, relProm = 0.2, maxIter = 20 } = opts;
  const dv = medianStep(V);
  let peaks = detectIedfPeaks(I, V, detectEV, relProm);
  let Ismooth = Float64Array.from(I);
  let iterations = 0;
  while (iterations < maxIter) {
    iterations++;
    const h = V.map((v) => {
      let dist = Infinity;
      for (const p of peaks) dist = Math.min(dist, Math.abs(v - p));
      dist -= protectEV;
      return dist <= 0 ? 0 : Math.min(maxEV, growth * dist) / dv;
    });
    Ismooth = variableMovingAverage(I, h);
    const next = detectIedfPeaks(Ismooth, V, detectEV, relProm);
    const moved = next.length !== peaks.length || next.some((p, k) => Math.abs(p - peaks[k]) >= 0.1);
    peaks = next;
    if (!moved) break;
  }
  return { Ismooth, peaks, iterations, protectEV };
}

// Peak energy from a least-squares parabola through the top of the highest peak
// (all contiguous points above `frac` of the maximum); falls back to the maximum
function peakEnergy(E, d, frac = 0.7) {
  if (!d.length) return NaN;
  const im = nanargmax(d);
  let a = im;
  let b = im;
  while (a > 0 && d[a - 1] >= frac * d[im]) a--;
  while (b < d.length - 1 && d[b + 1] >= frac * d[im]) b++;
  if (b - a < 2) return E[im];
  const n = b - a + 1;
  let s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (let k = a; k <= b; k++) {
    const x = E[k] - E[im];
    const y = d[k];
    s1 += x; s2 += x * x; s3 += x ** 3; s4 += x ** 4;
    t0 += y; t1 += x * y; t2 += x * x * y;
  }
  const c = solve([[s4, s3, s2], [s3, s2, s1], [s2, s1, n]], Float64Array.from([t2, t1, t0]));
  if (!(c[0] < 0)) return E[im];
  const xv = -c[1] / (2 * c[0]);
  return xv >= E[a] - E[im] && xv <= E[b] - E[im] ? E[im] + xv : E[im];
}

function ionFluxPressureCorrection(pressure, fluxFactor, crossSection) {
  const fixCorr = 1.12e-3;
  const Ng = 3.25e22 * pressure * 0.0075;
  const IMF = 1.0 / (Ng * crossSection);
  const Pc = Math.exp(-fixCorr / IMF);
  return fluxFactor / Pc;
}

function tauRatioNF({ Mi, fRf, Vp, ni, Te = 3.0, alpha = 3.0 }) {
  const e = E_CHARGE;
  const eps0 = 8.85e-12;
  const u = AMU;
  const Lde = Math.sqrt((eps0 * Te) / e / ni);
  const s = alpha * Lde * (Vp / Te) ** (3 / 4);
  const tauI = 3 * s * Math.sqrt((Mi * u) / (2 * e * Vp));
  return tauI / (1.0 / fRf);
}

// Derivative of the smoothed I-V curve, then smoothing: E, dIdE
function derivative(Ismooth, V, smoothFactordIdV) {
  const d = diffRatioWithEps(Ismooth, V).slice(1);
  return { dIdE: smooth1d(d, smoothFactordIdV), E: V.slice(1) };
}

// iedf: smoothing method -> IEDF, flux, density, mean and peak energy.
// p.pipeline === "legacy" reproduces Python_RFEA_Analysis_fcn.py exactly
// (windows in points, slope placed at the upper voltage of each step).
function iedf(I, V, p) {
  let Ismooth;
  let E;
  let dIdE;
  let Epeak;
  let peaks = null;
  const method = p.smoothMethod;
  const legacy = p.pipeline === "legacy";

  if (legacy && method === "Recursive") {
    const r = smoothIVSinglePeak(I.slice(2), V.slice(2), p.smoothParam ?? 10);
    Ismooth = r.Ismooth;
    ({ dIdE, E } = derivative(Ismooth, r.V, p.smoothFactordIdV));
    Epeak = r.Epeak;
  } else {
    if (method === "Recursive") {
      const r = peakPreservingSmooth(I, V, { protectEV: p.smoothParam ?? 10 });
      Ismooth = r.Ismooth;
      peaks = r.peaks;
    } else if (method === "Mavg") {
      Ismooth = smooth1d(I, p.smoothParam ?? 20);
    } else if (method === "SG") {
      let [polyorder, win] = p.smoothParam ?? [1, 13];
      win = Math.trunc(win);
      polyorder = Math.trunc(polyorder);
      if (win % 2 === 0) win += 1;
      win = Math.max(win, polyorder + 2 + ((polyorder + 2) % 2));
      Ismooth = savgolFilter(I, win, polyorder);
    } else if (method === "Manual") {
      Ismooth = manualSmoothByRanges(I, V, p.smoothParam?.ranges ?? []);
    } else {
      throw new Error(`Unknown smoothing method: ${method}`);
    }
    if (legacy) {
      ({ dIdE, E } = derivative(Ismooth, V, p.smoothFactordIdV));
      Epeak = dIdE.length ? E[nanargmax(dIdE)] : NaN;
    } else {
      // Slope of each voltage step belongs to the middle of that step
      dIdE = smooth1d(slopes(Ismooth, V), oddWindow(p.dIdESmoothEV ?? 1, medianStep(V)));
      E = Float64Array.from({ length: V.length - 1 }, (_, i) => 0.5 * (V[i] + V[i + 1]));
      Epeak = peakEnergy(E, dIdE);
    }
  }

  const Ev = [];
  const dv = [];
  for (let k = 0; k < E.length; k++) {
    if (E[k] > 0 && dIdE[k] > 0) {
      Ev.push(E[k]);
      dv.push(dIdE[k]);
    }
  }
  const S = Ev.length ? trapezoid(dv, Ev) : 0;

  const corr = ionFluxPressureCorrection(p.pressure, p.fluxFactor, p.crossSection);
  dIdE = dIdE.map((v) => v * corr);
  // S is a current (A) and corr 1/m²: divide by e for a particle flux (m⁻² s⁻¹)
  const flux = (S * corr) / E_CHARGE;

  const vBohm = Math.sqrt((p.Te * E_CHARGE) / (p.Mi * AMU));
  const ni = vBohm !== 0 ? flux / (0.6 * vBohm) : NaN;

  let num = 0;
  let den = 0;
  for (let k = 0; k < E.length; k++) {
    num += E[k] * dIdE[k];
    den += dIdE[k];
  }
  const Eavg = den !== 0 ? num / den : NaN;

  return { Eavg, flux, dIdE, E, ni, Epeak, Ismooth, peaks };
}

// Grid geometry -> flux factor (same formula as the desktop GUI)
function fluxFactor({ transmissionPct, nHoles, holeRadiusUm }) {
  const t = transmissionPct / 100;
  const r = holeRadiusUm * 1e-6;
  const area = Math.PI * r * r * nHoles;
  return 1 / (area * t ** 4);
}

const CROSS_SECTIONS = {
  "Ar Impedans": 8.8e-19,
  "Ar kinetic": 5.1e-19,
  "He Impedans": 8.8e-19 / 3,
};

// full_analysis: CSV text or .csv/.sdf bytes + parameters -> everything the UI shows
function fullAnalysis(text, p) {
  const { electrodeVoltage, ionFlux, table } = importFile(text);
  const traces = separateTraces(table);
  let { Isth, Iavg, Vavg } = traceAverageAndSmooth(traces, 10, p.voltageShift ?? 0);
  // Light noise filter before any method: 10 points (legacy) or 1 eV
  if (p.pipeline !== "legacy") Isth = smooth1d(Iavg, oddWindow(1, medianStep(Vavg)));
  const r = iedf(Isth, Vavg, p);

  let tauRatio = null;
  if (p.Mi != null && p.fRf != null && p.Vp != null) {
    tauRatio = tauRatioNF({ Mi: p.Mi, fRf: p.fRf, Vp: p.Vp, ni: r.ni, Te: p.Te, alpha: p.alpha });
  }
  const out = {
    ...r,
    electrodeVoltage,
    ionFlux,
    Iavg,
    Vavg,
    tauRatio,
    nTraces: traces.V.length,
    traces,
  };
  out.doublePeak = doublePeakAnalysis(out, p);
  return out;
}

// ------------------------------------------------------------------
// Double peak from sheath oscillation
// ------------------------------------------------------------------
// Ions crossing an RF-modulated sheath arrive with energies spread between
// two peaks around the mean sheath voltage. In the high-frequency limit
// (tau_i/tau_rf >> 1, collisionless sheath) the splitting is
//   dE [eV] = 8 Vs / (3 pi w s) * sqrt(2 e Vs / M)      (Benoit-Cattin & Bernard)
// with Vs the mean sheath voltage, w = 2 pi f_rf and s the mean sheath width.
const DOUBLE_DEFAULTS = {
  kSigma: 4, // a peak must stand this many noise sigmas above its surroundings
  relProm: 0.15, // ... and at least this fraction of the IEDF maximum
  edgeEV: 2, // ignore peaks this close to either end of the sweep
  highFreqTau: 3, // tau_i/tau_rf above this: high-frequency regime, formula applies
  lowFreqTau: 0.3, // below this: low-frequency regime (ions follow the RF field)
};

// Splitting dE (eV) for sheath voltage Vs (V) and width s (m), or the width for a splitting
const splitFromSheath = (Vs, s, fRf, Mi) => ((8 * Vs) / (3 * Math.PI * 2 * Math.PI * fRf * s)) * Math.sqrt((2 * E_CHARGE * Vs) / (Mi * AMU));
const sheathFromSplit = (Vs, dE, fRf, Mi) => ((8 * Vs) / (3 * Math.PI * 2 * Math.PI * fRf * dE)) * Math.sqrt((2 * E_CHARGE * Vs) / (Mi * AMU));

// Sheath model from the panel values (Vp as sheath voltage, Child-law width
// as in tauRatioNF) and the ion mean free path from the pressure
function sheathModel(p, ni) {
  const o = DOUBLE_DEFAULTS;
  const out = { sheathWidth: NaN, lambdaD: NaN, tauRatio: NaN, dETheory: NaN, mfp: NaN, sOverMfp: NaN, regime: "unknown" };
  if (!(p.Mi > 0 && p.fRf > 0 && p.Vp > 0 && p.Te > 0 && ni > 0)) return out;
  out.lambdaD = Math.sqrt((8.85e-12 * p.Te) / E_CHARGE / ni);
  out.sheathWidth = (p.alpha ?? 3) * out.lambdaD * (p.Vp / p.Te) ** 0.75;
  out.tauRatio = tauRatioNF({ Mi: p.Mi, fRf: p.fRf, Vp: p.Vp, ni, Te: p.Te, alpha: p.alpha ?? 3 });
  out.dETheory = splitFromSheath(p.Vp, out.sheathWidth, p.fRf, p.Mi);
  out.regime = out.tauRatio >= o.highFreqTau ? "high-frequency" : out.tauRatio <= o.lowFreqTau ? "low-frequency" : "intermediate";
  if (p.pressure > 0 && p.crossSection > 0) {
    const Ng = 3.25e22 * p.pressure * 0.0075; // same gas density as the flux correction
    out.mfp = 1 / (Ng * p.crossSection);
    out.sOverMfp = out.sheathWidth / out.mfp;
  }
  return out;
}

// Significant IEDF peaks (energy descending) and the double-peak pair:
// the two highest-energy peaks that stand kSigma noise sigmas above their
// surroundings. Noise of dI/dE comes from the I-V noise through the
// derivative and its smoothing window.
function doublePeakAnalysis(r, p, opts = {}) {
  const o = { ...DOUBLE_DEFAULTS, ...opts };
  const E = Array.from(r.E);
  const d = Array.from(r.dIdE);
  const V = Array.from(r.Vavg);
  const dv = medianStep(V);
  const w = p.pipeline === "legacy" ? Math.max(1, p.smoothFactordIdV ?? 1) : oddWindow(p.dIdESmoothEV ?? 1, dv);
  const corr = ionFluxPressureCorrection(p.pressure, p.fluxFactor, p.crossSection);
  const sigma = (corr * noiseSigma(Array.from(r.Iavg)) * Math.SQRT2) / (w * dv);
  let dmax = 0;
  for (const v of d) if (v > dmax) dmax = v;
  const minProm = Math.max(o.kSigma * sigma, o.relProm * dmax);
  const vLo = Math.min(...V) + o.edgeEV;
  const vHi = Math.max(...V) - o.edgeEV;
  const { peaks, prominences: prom } = findPeaks(d, minProm > 0 ? minProm : Infinity);
  const list = peaks.map((i, k) => {
    // Parabola through the three top points for sub-step energy
    let Ei = E[i];
    if (i > 0 && i < d.length - 1) {
      const den = d[i - 1] - 2 * d[i] + d[i + 1];
      if (den < 0) Ei += Math.max(-0.5, Math.min(0.5, (0.5 * (d[i - 1] - d[i + 1])) / den)) * (E[i + 1] - E[i - 1]) / 2;
    }
    return { E: Ei, height: d[i], prominence: prom[k], sigmas: sigma > 0 ? prom[k] / sigma : Infinity };
  }).filter((q) => q.E > 0 && q.E > vLo && q.E < vHi).sort((a, b) => b.E - a.E);

  const model = sheathModel(p, r.ni);
  const resolution = Math.max(2 * dv, w * dv);
  const out = { peaks: list, sigma, resolution, model, found: false, Elow: NaN, Ehigh: NaN, dE: NaN, Emid: NaN, heightRatio: NaN, sheathFromSplit: NaN };
  if (list.length >= 2) {
    const [hi, lo] = list;
    out.found = true;
    out.Ehigh = hi.E;
    out.Elow = lo.E;
    out.dE = hi.E - lo.E;
    out.Emid = 0.5 * (hi.E + lo.E);
    out.heightRatio = lo.height / hi.height;
    if (p.Mi > 0 && p.fRf > 0) out.sheathFromSplit = sheathFromSplit(out.Emid, out.dE, p.fRf, p.Mi);
  }
  return out;
}

// ------------------------------------------------------------------
// Automatic quality review
// ------------------------------------------------------------------
// Default thresholds; the app lets the user change the two SNR limits.
const QUALITY_DEFAULTS = {
  snrReview: 5, // I–V step / noise below this: must review
  snrCheck: 15, // below this: check
  negReview: 0.75, // negative / positive IEDF area above this: must review
  negCheck: 0.5,
  edgeEV: 2, // E_peak this close to either end of the sweep: must review
  spreadCheck: 0.5, // step varies between traces by more than this fraction: check
  minTraces: 3,
};

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

// Robust noise of a curve: median absolute point-to-point change (white noise -> sigma)
function noiseSigma(y) {
  const d = [];
  for (let i = 1; i < y.length; i++) if (Number.isFinite(y[i]) && Number.isFinite(y[i - 1])) d.push(Math.abs(y[i] - y[i - 1]));
  if (!d.length) return NaN;
  d.sort((a, b) => a - b);
  return d[d.length >> 1] / 0.6745 / Math.SQRT2;
}

// Change of current across the sweep: mean of the last 10 % minus the first 10 %
function ivStep(I) {
  const k = Math.max(3, Math.floor(I.length * 0.1));
  return mean(Array.from(I.slice(-k))) - mean(Array.from(I.slice(0, k)));
}

// Measures and flags for one analysed file. Each flag is
// { level: "review" | "check" | "info", code, message }; "review" means a
// person must look at the file before its results are used; "info" notes
// (double peak, sheath regime) do not change the rating.
function assessQuality(r, opts = {}) {
  const o = { ...QUALITY_DEFAULTS, ...opts };
  const flags = [];
  const add = (level, code, message) => flags.push({ level, code, message });
  const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : String(v));

  const I = Array.from(r.Iavg);
  const V = Array.from(r.Vavg);
  const noise = noiseSigma(I);
  const step = ivStep(I);
  const snr = noise > 0 ? Math.abs(step) / noise : Infinity;

  let pos = 0;
  let neg = 0;
  for (const v of r.dIdE) {
    if (v > 0) pos += v;
    else if (v < 0) neg -= v;
  }
  const negRatio = pos > 0 ? neg / pos : Infinity;

  let spread = 0;
  const steps = r.traces ? r.traces.I.map((t) => ivStep(t)) : [];
  if (steps.length >= 2) {
    const m = mean(steps);
    const sd = Math.sqrt(mean(steps.map((s) => (s - m) ** 2)));
    spread = m !== 0 ? sd / Math.abs(m) : Infinity;
  }

  const vMin = Math.min(...V);
  const vMax = Math.max(...V);

  if (!(snr >= o.snrReview)) {
    add("review", "weak-signal", `Weak ion signal: the I–V step is ${f1(snr)}× the noise (at least ${o.snrReview}× expected).`);
  } else if (snr < o.snrCheck) {
    add("check", "noisy", `Noisy: the I–V step is ${f1(snr)}× the noise (below ${o.snrCheck}×).`);
  }
  if (!Number.isFinite(r.Epeak)) {
    add("review", "no-peak", "No E<sub>peak</sub> found.");
  } else if (r.Epeak - vMin < o.edgeEV || vMax - r.Epeak < o.edgeEV) {
    add("review", "peak-edge", `E<sub>peak</sub> (${f1(r.Epeak)} eV) is at the end of the voltage sweep.`);
  } else if (r.Epeak <= 0) {
    add("review", "peak-negative", `E<sub>peak</sub> is at or below 0 eV (${f1(r.Epeak)} eV).`);
  }
  if (!(r.Eavg > 0)) add("review", "eavg-negative", `E<sub>avg</sub> is not positive (${f1(r.Eavg)} eV).`);
  // Semion records the ion current as negative, rising towards 0 as the
  // discriminator voltage goes up. A clear step the other way gives a negative IEDF.
  const inverted = step < 0 && snr >= o.snrReview;
  if (inverted) {
    add("review", "inverted", "The current falls with voltage, so the IEDF comes out negative. Is the current sign inverted?");
  } else if (!(negRatio <= o.negReview)) {
    add("review", "iedf-noise", `IEDF is mostly noise: its negative area is ${Number.isFinite(negRatio) ? Math.round(negRatio * 100) + " %" : "larger than"} of the positive area.`);
  } else if (negRatio > o.negCheck) {
    add("check", "iedf-negative", `Large negative IEDF parts: ${Math.round(negRatio * 100)} % of the positive area.`);
  }
  if (spread > o.spreadCheck) {
    add("check", "traces-disagree", `Traces disagree: the I–V step varies by ${Number.isFinite(spread) ? Math.round(spread * 100) + " %" : "a lot"} between traces.`);
  }
  if (r.nTraces < o.minTraces) add("check", "few-traces", `Only ${r.nTraces} trace${r.nTraces === 1 ? "" : "s"} averaged.`);

  // Double peak from sheath oscillation; "info" notes do not change the rating
  const dp = r.doublePeak;
  if (dp) {
    const m = dp.model;
    const mm = (x) => (x * 1e3).toFixed(x < 1e-3 ? 2 : 1);
    const collisional = m.sOverMfp > 1;
    const theory = Number.isFinite(m.dETheory) ? `; theory ${m.dETheory.toFixed(m.dETheory < 1 ? 2 : 1)} eV` : "";
    if (dp.found) {
      add("info", "double-peak", `Double peak: ${f1(dp.Elow)} and ${f1(dp.Ehigh)} eV (ΔE = ${f1(dp.dE)} eV${theory}).`);
      const ratio = dp.dE / m.dETheory;
      if (m.regime === "high-frequency" && !collisional && Number.isFinite(ratio) && (ratio > 2 || ratio < 0.5)) {
        add("check", "split-mismatch", `Measured splitting (${f1(dp.dE)} eV) is ${ratio > 1 ? f1(ratio) + "× larger" : f1(1 / ratio) + "× smaller"} than the sheath model (${m.dETheory.toFixed(2)} eV). Check V<sub>p</sub>, T<sub>e</sub> and α, or whether one peak is not from the sheath.`);
      }
    } else if (m.regime !== "low-frequency" && !collisional && m.dETheory >= 2 * dp.resolution && snr >= o.snrCheck) {
      add("check", "double-missing", `The sheath model predicts a double peak (ΔE ≈ ${f1(m.dETheory)} eV) but only ${dp.peaks.length === 1 ? "one peak was" : "no clear peak was"} found.`);
    }
    if (m.regime === "high-frequency" && m.dETheory < dp.resolution) {
      add("info", "split-unresolved", `Predicted splitting ΔE ≈ ${m.dETheory.toFixed(2)} eV is below the resolution (${dp.resolution.toFixed(1)} eV), so a sheath-oscillation double peak cannot be resolved.`);
    }
    if (collisional) {
      add("info", "collisional", `Collisional sheath: about ${Math.round(m.sOverMfp)} ion mean free paths across it (s ≈ ${mm(m.sheathWidth)} mm, λ<sub>i</sub> ≈ ${mm(m.mfp)} mm). Low-energy peaks are likely charge exchange, and the double peak is washed out.`);
    }
  }

  const level = flags.some((f) => f.level === "review") ? "review" : flags.some((f) => f.level === "check") ? "check" : "ok";
  return { level, flags, metrics: { snr, noise, step, negRatio, traceSpread: spread } };
}

// ------------------------------------------------------------------
// Settings from Semion file names, e.g. 20240618_21_25W10PaAr60MHz
// ------------------------------------------------------------------
const GASES = {
  Ar: { Mi: 40, gas: "Ar Impedans" },
  He: { Mi: 4, gas: "He Impedans" },
};
// Nominal ISM frequencies written in short form in file names
const NOMINAL_MHZ = { 13: 13.56, 27: 27.12, 40: 40.68 };

function parseFileName(name) {
  const base = String(name).replace(/\.[^.]+$/, "");
  const out = {};
  const num = (s) => Number(s.replace(",", "."));
  let m = base.match(/(\d+(?:[.,]\d+)?)\s*W(?![a-z])/);
  if (m) out.powerW = num(m[1]);
  m = base.match(/(\d+(?:[.,]\d+)?)\s*Pa(?![a-z])/);
  if (m) out.pressure = num(m[1]);
  m = base.match(/(\d+(?:[.,]\d+)?)\s*MHz/i);
  if (m) {
    const f = num(m[1]);
    out.fRfMHz = NOMINAL_MHZ[f] ?? f;
  }
  m = base.match(/(?:^|[^A-Za-z])(Ar|He)(?![a-z])|Pa(Ar|He)(?![a-z])/);
  if (m) {
    const g = m[1] || m[2];
    out.species = g;
    out.Mi = GASES[g].Mi;
    out.gas = GASES[g].gas;
  }
  return out;
}

globalThis.RFEA = { smooth1d, findPeaks, savgolFilter, importFile, importSdf, isSdf, separateTraces, traceAverageAndSmooth, manualSmoothByRanges, smoothIVSinglePeak, peakPreservingSmooth, peakEnergy, medianStep, oddWindow, ionFluxPressureCorrection, tauRatioNF, iedf, fluxFactor, CROSS_SECTIONS, fullAnalysis, assessQuality, QUALITY_DEFAULTS, parseFileName, doublePeakAnalysis, sheathModel, DOUBLE_DEFAULTS, splitFromSheath, sheathFromSplit };
})();
