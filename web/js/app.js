// RFEA Analyzer web app: wires the form, plots and exports to RFEA (rfea-analysis.js).
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const plotEl = $("plot");
  const manualPlotEl = $("manual-plot");

  const state = {
    files: [], // the batch: one entry per opened file (see addFiles)
    current: -1, // index of the file shown in the Plot view
    manualRanges: [], // manual smoothing ranges of the current file
    result: null,
    params: null,
  };
  const cur = () => state.files[state.current] || null;

  // ---------------- Storage (per-browser convenience only) ----------------
  const store = {
    get(key) {
      try { return localStorage.getItem(key); } catch (e) { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(key, value); } catch (e) { /* private mode etc. */ }
    },
  };

  const PARAM_IDS = ["transmission", "nholes", "radius", "pressure", "gas", "method", "smooth-didv",
    "rec-window", "mavg-window", "sg-poly", "sg-window", "vp", "mi", "frf", "te", "alpha", "shift-on", "shift"];

  function saveForm() {
    const data = {};
    for (const id of PARAM_IDS) {
      const el = $(id);
      data[id] = el.type === "checkbox" ? el.checked : el.value;
    }
    data.manualRanges = state.manualRanges;
    store.set("rfea-params-v3", JSON.stringify(data));
  }

  function restoreForm() {
    let data = null;
    try { data = JSON.parse(store.get("rfea-params-v3") || "null"); } catch (e) { data = null; }
    if (!data) return;
    for (const id of PARAM_IDS) {
      if (!(id in data)) continue;
      const el = $(id);
      if (el.type === "checkbox") el.checked = Boolean(data[id]);
      else el.value = data[id];
    }
    if (Array.isArray(data.manualRanges)) state.manualRanges = data.manualRanges;
  }

  // ---------------- Formatting ----------------
  // Python's "%.6g"
  function fmtG(v, digits = 6) {
    if (v === null || v === undefined) return "N/A";
    if (Number.isNaN(v)) return "nan";
    if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf";
    if (v === 0) return "0";
    const exp = Math.floor(Math.log10(Math.abs(Number(v.toPrecision(digits)))));
    if (exp < -4 || exp >= digits) {
      const [m, e] = v.toExponential(digits - 1).split("e");
      const mant = m.includes(".") ? m.replace(/0+$/, "").replace(/\.$/, "") : m;
      const n = Number(e);
      return `${mant}e${n < 0 ? "-" : "+"}${String(Math.abs(n)).padStart(2, "0")}`;
    }
    const s = v.toFixed(Math.max(0, digits - 1 - exp));
    return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function colors() {
    return {
      bg: cssVar("--plot-bg"),
      text: cssVar("--text"),
      textLo: cssVar("--text-lo"),
      grid: cssVar("--plot-grid"),
      raw: cssVar("--plot-raw"),
      smooth: cssVar("--plot-smooth"),
      iedf: cssVar("--plot-iedf"),
      mint: cssVar("--mint"),
      mintDeep: cssVar("--mint-deep"),
      red: cssVar("--red"),
    };
  }

  function setStatus(msg, isError = false) {
    const el = $("status");
    el.textContent = msg;
    el.classList.toggle("error", isError);
    $("status-left").textContent = isError ? "Error" : msg;
  }

  // ---------------- Parameters ----------------
  function num(id) {
    const el = $(id);
    const v = Number(el.value);
    const ok = el.value.trim() !== "" && Number.isFinite(v);
    el.classList.toggle("invalid", !ok);
    if (!ok) throw new Error(`Invalid value for "${el.closest("label").querySelector(".lbl").textContent.trim()}"`);
    return v;
  }

  // The panel settings as a plain object (each file of a batch keeps its own copy)
  function readForm() {
    const form = {};
    for (const id of PARAM_IDS) {
      const el = $(id);
      form[id] = el.type === "checkbox" ? el.checked : el.value;
    }
    form.manualRanges = state.manualRanges.map((r) => ({ ...r }));
    return form;
  }

  function setForm(form) {
    for (const id of PARAM_IDS) {
      if (!(id in form)) continue;
      const el = $(id);
      if (el.type === "checkbox") el.checked = Boolean(form[id]);
      else el.value = form[id];
      el.classList.remove("invalid");
    }
    state.manualRanges = (form.manualRanges || []).map((r) => ({ ...r }));
    syncControls();
  }

  // Analysis parameters from a settings object; mark=true flags bad panel fields
  function paramsFromForm(f, mark = false) {
    const num = (id) => {
      const raw = String(f[id] ?? "").trim();
      const v = Number(raw);
      const ok = raw !== "" && Number.isFinite(v);
      if (mark) $(id).classList.toggle("invalid", !ok);
      if (!ok) throw new Error(`Invalid value for "${$(id).closest("label").querySelector(".lbl").textContent.trim()}"`);
      return v;
    };
    const method = f.method;
    let smoothParam = null;
    if (method === "Recursive") smoothParam = num("rec-window");
    else if (method === "Mavg") smoothParam = Math.trunc(num("mavg-window"));
    else if (method === "SG") {
      let win = Math.trunc(num("sg-window"));
      if (win % 2 === 0) win += 1;
      smoothParam = [Math.trunc(num("sg-poly")), win];
    } else if (method === "Manual") smoothParam = { ranges: f.manualRanges || [] };

    return {
      pressure: num("pressure"),
      dIdESmoothEV: num("smooth-didv"),
      smoothMethod: method,
      smoothParam,
      Mi: num("mi"),
      fRf: num("frf") * 1e6,
      Vp: num("vp"),
      Te: num("te"),
      alpha: num("alpha"),
      fluxFactor: RFEA.fluxFactor({
        transmissionPct: num("transmission"),
        nHoles: num("nholes"),
        holeRadiusUm: num("radius"),
      }),
      crossSection: RFEA.CROSS_SECTIONS[f.gas],
      voltageShift: f["shift-on"] ? num("shift") : 0,
    };
  }

  function syncControls() {
    const method = $("method").value;
    document.querySelectorAll("[data-for]").forEach((el) => {
      const on = el.dataset.for === method;
      el.querySelectorAll("input, button").forEach((c) => (c.disabled = !on));
      if (el.classList.contains("manual-row")) el.hidden = !on;
    });
    $("shift").disabled = !$("shift-on").checked;
    const n = state.manualRanges.length;
    $("manual-summary").textContent = n
      ? state.manualRanges.map((r, i) => `${i + 1}) [${fmtG(r.xmin, 3)}, ${fmtG(r.xmax, 3)}] w=${r.window}`).join("  ")
      : "No ranges";
  }

  // ---------------- Analysis ----------------
  let runTimer = null;
  function scheduleRun() {
    clearTimeout(runTimer);
    runTimer = setTimeout(run, 120);
  }

  // Panel changed (or a file was selected): re-analyse the current file with
  // the panel settings. Changing the settings of a reviewed file reopens it.
  function run() {
    syncControls();
    saveForm();
    const f = cur();
    if (!f) return;
    const form = readForm();
    let reopened = false;
    if (JSON.stringify(form) !== JSON.stringify(f.form)) {
      f.form = form;
      f.edited = true;
      if (f.review.status !== "pending") {
        f.review = { status: "pending", note: f.review.note };
        reopened = true;
      }
      saveReview(f);
    }
    const t0 = performance.now();
    analyseFile(f, true);
    showCurrent();
    renderBatch();
    if (f.error) return;
    setStatus(`${f.name} · ${f.result.nTraces} traces averaged · analysed in ${(performance.now() - t0).toFixed(0)} ms` +
      (reopened ? " · settings changed, review reopened" : ""));
  }

  const UNITS = {
    Eavg: "eV", Epeak: "eV", flux: "m⁻² s⁻¹", ni: "m⁻³", tauRatio: "", electrodeVoltage: "V", ionFlux: "",
    doublePair: "eV", dE: "eV", dETheory: "eV", sheathWidth: "mm", mfp: "mm",
  };

  // Double-peak / sheath values shown in the results panel
  function doubleValue(r, k) {
    const dp = r.doublePeak;
    if (!dp) return { text: "—" };
    const m = dp.model;
    if (k === "doublePair") return dp.found ? { text: `${fmtG(dp.Elow, 3)} / ${fmtG(dp.Ehigh, 3)}` } : { text: dp.peaks.length ? "single" : "none", unit: "" };
    if (k === "dE") return dp.found ? { text: fmtG(dp.dE, 3), title: `Peak height ratio low/high: ${fmtG(dp.heightRatio, 3)}` } : { text: "—", unit: "" };
    if (k === "dETheory") return { text: fmtG(m.dETheory, 2), title: `${m.regime} regime; resolution ${fmtG(dp.resolution, 2)} eV` };
    if (k === "sheathWidth") {
      const fromSplit = dp.found && Number.isFinite(dp.sheathFromSplit) ? ` · from ΔE ${fmtG(dp.sheathFromSplit * 1e3, 3)}` : "";
      return { text: fmtG(m.sheathWidth * 1e3, 3) + fromSplit, title: "Child-law sheath width from V_p, T_e, α and n_i; 'from ΔE' inverts the measured splitting" };
    }
    if (k === "mfp") return { text: fmtG(m.mfp * 1e3, 3), title: Number.isFinite(m.sOverMfp) ? `Sheath width / mean free path = ${fmtG(m.sOverMfp, 2)}` : "" };
    return { text: "—" };
  }

  const DOUBLE_KEYS = { doublePair: 1, dE: 1, dETheory: 1, sheathWidth: 1, mfp: 1 };

  function renderResults(r) {
    document.querySelectorAll("#results dd").forEach((dd) => {
      const k = dd.dataset.k;
      if (!r) {
        dd.textContent = "—";
        return;
      }
      const v = r[k];
      dd.title = "";
      if (k in DOUBLE_KEYS) {
        const d = doubleValue(r, k);
        dd.textContent = d.text;
        dd.title = d.title || "";
        if (d.unit === "") return;
      } else if (k === "tauRatio" && (v === null || !Number.isFinite(v))) dd.textContent = "N/A";
      // Semion works out the ion flux only on CSV export; .sdf files do not store it
      else if (k === "ionFlux" && Number.isNaN(v)) dd.textContent = "n/a (.sdf)";
      else dd.textContent = fmtG(v);
      if (UNITS[k]) {
        const u = document.createElement("span");
        u.className = "unit";
        u.textContent = UNITS[k];
        dd.appendChild(u);
      }
    });
  }

  // ---------------- Plots ----------------
  function baseLayout(c) {
    const axis = {
      color: c.text,
      gridcolor: c.grid,
      zerolinecolor: c.grid,
      linecolor: c.text,
      showline: true,
      ticks: "outside",
      tickcolor: c.text,
      exponentformat: "e",
    };
    return {
      paper_bgcolor: c.bg,
      plot_bgcolor: c.bg,
      font: { family: '"Helvetica Neue", Arial, sans-serif', size: 12, color: c.text },
      margin: { l: 70, r: 70, t: 48, b: 52 },
      xaxis: { ...axis, title: { text: "Energy (eV)" } },
      yaxis: { ...axis, title: { text: "Current (A)" } },
      hoverlabel: { font: { family: '"Helvetica Neue", Arial, sans-serif' } },
    };
  }

  const PLOT_CONFIG = {
    responsive: true,
    displaylogo: false,
    toImageButtonOptions: { format: "png", filename: "rfea_plot", scale: 3 },
    modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"],
  };

  function renderPlot() {
    const r = state.result;
    if (!r) return;
    const c = colors();
    const n = Math.min(r.Vavg.length, r.Iavg.length, r.Ismooth.length);
    const V = Array.from(r.Vavg.slice(0, n));
    // Recursive smoothing drops the first two points; align Ismooth to its own V
    const Vs = Array.from(r.Vavg.slice(r.Vavg.length - r.Ismooth.length));
    let E = Array.from(r.E);
    let dI = Array.from(r.dIdE);
    if (E.length > 10) {
      E = E.slice(0, -10);
      dI = dI.slice(0, -10);
    }
    let ymax = -Infinity;
    for (const v of dI) if (Number.isFinite(v) && v > ymax) ymax = v;
    ymax = Number.isFinite(ymax) && ymax > 0 ? ymax * 1.5 : 1;

    const layout = baseLayout(c);
    layout.title = { text: "I–V curve and IEDF", x: 0, xanchor: "left", xref: "paper", font: { size: 15, color: c.text } };
    layout.yaxis2 = {
      ...layout.yaxis,
      title: { text: "IEDF (a.u.)", font: { color: c.iedf } },
      color: c.iedf, linecolor: c.iedf, tickcolor: c.iedf,
      overlaying: "y", side: "right", range: [0, ymax], showgrid: false,
    };
    layout.legend = { x: 0.01, y: 0.99, bgcolor: "rgba(0,0,0,0)", font: { color: c.text } };
    layout.hovermode = "x unified";
    // Recursive: show the protected (unsmoothed) zone around each detected peak
    if (r.peaks && state.params && state.params.smoothMethod === "Recursive") {
      const w = state.params.smoothParam;
      layout.shapes = r.peaks.map((p) => ({
        type: "rect", xref: "x", yref: "paper", x0: p - w, x1: p + w, y0: 0, y1: 1,
        fillcolor: c.mint, opacity: 0.18, line: { width: 0 }, layer: "below",
      }));
      layout.annotations = r.peaks.map((p) => ({
        x: p, y: 1, xref: "x", yref: "paper", yanchor: "bottom", showarrow: false,
        text: "protected", font: { size: 10, color: c.textLo },
      }));
    }

    // Double peak: dashed markers at both peak energies
    const dp = r.doublePeak;
    if (dp && dp.found) {
      layout.shapes = (layout.shapes || []).concat([dp.Elow, dp.Ehigh].map((x) => ({
        type: "line", xref: "x", yref: "paper", x0: x, x1: x, y0: 0, y1: 1,
        line: { color: c.iedf, width: 1.5, dash: "dash" },
      })));
      layout.annotations = (layout.annotations || []).concat([
        { x: dp.Elow, y: 0.93, xref: "x", yref: "paper", xanchor: "right", showarrow: false, text: `E<sub>low</sub> ${dp.Elow.toFixed(1)} eV `, font: { size: 11, color: c.iedf }, bgcolor: c.bg },
        { x: dp.Ehigh, y: 0.93, xref: "x", yref: "paper", xanchor: "left", showarrow: false, text: ` E<sub>high</sub> ${dp.Ehigh.toFixed(1)} eV`, font: { size: 11, color: c.iedf }, bgcolor: c.bg },
        { x: dp.Emid, y: 0.86, xref: "x", yref: "paper", showarrow: false, text: `ΔE = ${dp.dE.toFixed(1)} eV`, font: { size: 11, color: c.iedf }, bgcolor: c.bg },
      ]);
    }

    Plotly.react(plotEl, [
      { x: V, y: Array.from(r.Iavg.slice(0, n)), name: "I", mode: "lines", line: { color: c.raw, width: 6 },
        hovertemplate: "%{y:.4g} A" },
      { x: Vs, y: Array.from(r.Ismooth), name: "I smooth", mode: "lines", line: { color: c.smooth, width: 2 },
        hovertemplate: "%{y:.4g} A" },
      { x: E, y: dI, name: "IEDF", mode: "lines", yaxis: "y2", line: { color: c.iedf, width: 2.5 },
        hovertemplate: "%{y:.4g}" },
    ], layout, PLOT_CONFIG);
  }

  function renderEmptyPlot(message) {
    const c = colors();
    const layout = baseLayout(c);
    layout.annotations = [{
      text: message || "Open .csv or .sdf files to see the I–V curve and IEDF", showarrow: false,
      xref: "paper", yref: "paper", x: 0.5, y: 0.5, font: { color: c.textLo, size: 14 },
    }];
    layout.xaxis.showgrid = layout.yaxis.showgrid = false;
    layout.xaxis.showticklabels = layout.yaxis.showticklabels = false;
    Plotly.react(plotEl, [], layout, { ...PLOT_CONFIG, staticPlot: true });
  }

  // ---------------- File loading ----------------
  async function loadFiles(list) {
    const all = Array.from(list || []);
    const files = all.length > 1 ? all.filter((f) => /\.(csv|sdf)$/i.test(f.name)) : all;
    if (!files.length) {
      if (all.length) setStatus("No .csv or .sdf files among the dropped files.", true);
      return;
    }
    const read = [];
    for (const file of files) {
      try {
        read.push({ name: file.name, size: file.size, data: await file.arrayBuffer() });
      } catch (e) {
        setStatus(`Could not read ${file.name}: ${e.message}`, true);
      }
    }
    if (read.length) await addFiles(read);
    const skipped = all.length - files.length;
    if (skipped > 0) setStatus(`${$("status").textContent} · ${skipped} other file${skipped === 1 ? "" : "s"} skipped`);
  }

  $("file").addEventListener("change", (e) => {
    loadFiles(e.target.files);
    e.target.value = ""; // allow opening the same file again
  });
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => {
    e.preventDefault();
    drop.classList.add("over");
  }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("over")));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    loadFiles(e.dataTransfer.files);
  });
  // Dropping anywhere else should not navigate away from the app
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
  });

  // ---------------- Batch, automatic review, human review ----------------
  // Every opened file is analysed with its own copy of the settings: the
  // panel at the time it was opened, plus pressure / gas / f_rf read from its
  // name. assessQuality() flags it OK, Check or Must review; a person can then
  // change its settings and approve or reject it. Decisions are remembered in
  // this browser (per file name and size) and go into the summary CSV.
  const REVIEW_KEY = "rfea-reviews-v1";
  const AUTO_KEY = "rfea-auto-review-v1";
  const AUTO_IDS = ["auto-names", "snr-review", "snr-check"];
  const FLAG_SHORT = {
    "weak-signal": "Weak signal", noisy: "Noisy", "no-peak": "No peak", "peak-edge": "Peak at sweep end",
    "peak-negative": "Peak ≤ 0 eV", "eavg-negative": "E_avg ≤ 0", "iedf-noise": "IEDF mostly noise",
    "iedf-negative": "Negative IEDF", "traces-disagree": "Traces disagree", "few-traces": "Few traces",
    "no-pressure": "Pressure not in name", "split-mismatch": "ΔE ≠ theory", "double-missing": "Double peak missing", inverted: "Inverted current", error: "Analysis failed",
  };
  const LEVEL_TEXT = { ok: "OK", check: "Check", review: "Must review", error: "Error" };

  function loadReviews() {
    try { return JSON.parse(store.get(REVIEW_KEY) || "{}") || {}; } catch (e) { return {}; }
  }
  const reviewKey = (f) => `${f.name}|${f.size}`;
  function saveReview(f) {
    const all = loadReviews();
    if (f.review.status === "pending" && !f.review.note && !f.edited) delete all[reviewKey(f)];
    else all[reviewKey(f)] = { ...f.review, form: f.edited ? f.form : null };
    store.set(REVIEW_KEY, JSON.stringify(all));
  }

  function autoSettings() {
    const n = (id, d) => {
      const v = Number($(id).value);
      return $(id).value.trim() !== "" && Number.isFinite(v) ? v : d;
    };
    return {
      names: $("auto-names").checked,
      snrReview: n("snr-review", RFEA.QUALITY_DEFAULTS.snrReview),
      snrCheck: n("snr-check", RFEA.QUALITY_DEFAULTS.snrCheck),
    };
  }

  // Panel settings for a file, with the settings found in its name on top
  function formForFile(name, base) {
    const form = { ...base, manualRanges: (base.manualRanges || []).map((r) => ({ ...r })) };
    const auto = autoSettings().names ? RFEA.parseFileName(name) : {};
    const used = {};
    if (auto.pressure !== undefined) { form.pressure = String(auto.pressure); used.pressure = auto.pressure; }
    if (auto.fRfMHz !== undefined) { form.frf = String(auto.fRfMHz); used.fRfMHz = auto.fRfMHz; }
    if (auto.species) {
      // Keep the chosen cross-section when the panel already has this gas (Ar kinetic)
      if (!String(form.gas).startsWith(auto.species)) form.gas = auto.gas;
      form.mi = String(auto.Mi);
      used.species = auto.species;
    }
    return { form, auto: used };
  }

  function analyseFile(f, mark = false) {
    f.error = null;
    try {
      f.params = paramsFromForm(f.form, mark);
      f.result = RFEA.fullAnalysis(f.data, f.params);
    } catch (e) {
      f.result = null;
      f.error = e.message;
    }
    assessFile(f);
  }

  function assessFile(f) {
    if (!f.result) {
      f.quality = { level: "error", flags: [{ level: "review", code: "error", message: f.error }], metrics: {} };
      return;
    }
    const a = autoSettings();
    const q = RFEA.assessQuality(f.result, { snrReview: a.snrReview, snrCheck: a.snrCheck });
    if (a.names && f.auto.pressure === undefined && !f.edited) {
      q.flags.push({ level: "check", code: "no-pressure", message: `Pressure not found in the file name; the panel value (${f.form.pressure} Pa) is used.` });
      if (q.level === "ok") q.level = "check";
    }
    f.quality = q;
  }

  // Overall state of a file for the table and filters
  function statusOf(f) {
    if (f.review.status === "approved") return "approved";
    if (f.review.status === "rejected") return "rejected";
    return f.quality ? f.quality.level : "pending";
  }
  const needsLook = (f) => f.review.status === "pending" && f.quality && f.quality.level !== "ok";
  function statusText(f) {
    const st = statusOf(f);
    if (st === "approved") return f.review.mode === "bulk" ? "Approved (bulk)" : "Approved";
    if (st === "rejected") return "Rejected";
    return LEVEL_TEXT[st] || "…";
  }

  // Flag messages are fixed text plus numbers; only <sub> markup is kept
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const flagHtml = (m) => esc(m).replace(/&lt;(\/?)sub&gt;/g, "<$1sub>");
  const flagText = (m) => String(m).replace(/<\/?sub>/g, "");

  async function addFiles(list) {
    const reviews = loadReviews();
    const base = readForm();
    let first = -1;
    for (const item of list) {
      let idx = state.files.findIndex((f) => f.name === item.name && f.size === item.size);
      const { form, auto } = formForFile(item.name, base);
      const saved = reviews[`${item.name}|${item.size}`];
      const f = {
        name: item.name, size: item.size, data: item.data, auto,
        form: saved && saved.form ? saved.form : form,
        edited: Boolean(saved && saved.form),
        review: saved ? { status: saved.status || "pending", note: saved.note || "", at: saved.at, mode: saved.mode } : { status: "pending", note: "" },
        result: null, quality: null, error: null,
      };
      if (idx >= 0) state.files[idx] = f;
      else idx = state.files.push(f) - 1;
      if (first < 0) first = idx;
    }
    // Analyse in small steps so the page stays responsive on big batches
    const pending = state.files.filter((f) => !f.quality);
    for (let i = 0; i < pending.length; i++) {
      analyseFile(pending[i]);
      if (pending.length > 1 && i % 4 === 3) {
        setStatus(`Analysing ${i + 1} / ${pending.length}…`);
        renderBatch();
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    if (list.length > 1) setView("batch");
    selectFile(first, list.length > 1);
    const sum = summary();
    setStatus(list.length > 1
      ? `${list.length} files analysed · ${sum.review} must review · ${sum.check} to check · ${sum.ok} OK`
      : $("status").textContent);
  }

  function selectFile(i, quiet = false) {
    if (i < 0 || i >= state.files.length) return;
    state.current = i;
    const f = cur();
    setForm(f.form);
    $("file-name").textContent = `${f.name} (${(f.size / 1024).toFixed(0)} kB) — read locally, not uploaded.`;
    if (quiet) {
      // Already analysed by addFiles; only draw it
      if (!f.error) paramsFromForm(f.form, true);
      showCurrent();
      renderBatch();
    } else run();
  }

  function showCurrent() {
    const f = cur();
    const exportIds = ["btn-export-csv", "btn-export-png", "btn-export-svg"];
    if (!f) {
      $("review-bar").hidden = true;
      state.result = null;
      renderResults(null);
      renderEmptyPlot();
      exportIds.forEach((id) => ($(id).disabled = true));
      return;
    }
    state.result = f.result;
    state.params = f.params;
    renderResults(f.result);
    renderReviewBar(); // first, so the plot is drawn at its final size
    if (f.result) renderPlot();
    else {
      renderEmptyPlot(`${f.name}: analysis failed`);
      setStatus(`${f.name}: ${f.error}`, true);
    }
    exportIds.forEach((id) => ($(id).disabled = !f.result));
  }

  function renderReviewBar() {
    const f = cur();
    const bar = $("review-bar");
    bar.hidden = !f;
    if (!f) return;
    const st = statusOf(f);
    bar.className = `review-bar ${st}`;
    $("review-pos").textContent = `${state.current + 1} / ${state.files.length}`;
    $("review-name").textContent = f.name;
    const pill = $("review-pill");
    pill.className = `pill ${st}`;
    pill.textContent = statusText(f);
    if (f.review.status !== "pending" && f.quality && f.quality.level !== "ok") {
      pill.title = `Automatic check: ${LEVEL_TEXT[f.quality.level]}`;
    } else pill.title = "";
    $("review-edited").hidden = !f.edited;
    const ul = $("review-flags");
    ul.textContent = "";
    const flags = f.quality ? f.quality.flags : [];
    if (f.quality && !flags.some((fl) => fl.level !== "info")) {
      const li = document.createElement("li");
      li.className = "ok";
      li.textContent = `No problems found (SNR ${fmtG(f.quality.metrics.snr, 3)}).`;
      ul.appendChild(li);
    }
    for (const fl of flags) {
      const li = document.createElement("li");
      li.className = fl.level;
      li.innerHTML = flagHtml(fl.message);
      ul.appendChild(li);
    }
    if (document.activeElement !== $("review-note")) $("review-note").value = f.review.note || "";
    $("btn-approve").textContent = f.review.status === "approved" ? "Approved ✓" : "Approve";
    $("btn-reject").textContent = f.review.status === "rejected" ? "Rejected" : "Reject";
    $("btn-approve").disabled = !f.result;
    $("btn-prev").disabled = state.current <= 0;
    $("btn-next").disabled = state.current >= state.files.length - 1;
    $("btn-next-flagged").disabled = !state.files.some((g, i) => i !== state.current && needsLook(g));
    $("btn-apply-all").hidden = state.files.length < 2;
    // The bar's height changes with the number of flags: fit the plot to the space left
    if (state.result && !$("view-plot").hidden && plotEl.data) Plotly.Plots.resize(plotEl);
  }

  function summary() {
    const s = { total: state.files.length, review: 0, check: 0, ok: 0, error: 0, approved: 0, rejected: 0, todo: 0 };
    for (const f of state.files) {
      const st = statusOf(f);
      if (st in s) s[st]++;
      if (needsLook(f)) s.todo++;
    }
    s.review += s.error;
    return s;
  }

  function matchesFilter(f, filter) {
    const st = statusOf(f);
    if (filter === "all") return true;
    if (filter === "todo") return needsLook(f);
    if (filter === "review") return st === "review" || st === "error";
    return st === filter;
  }

  function renderBatch() {
    const sum = summary();
    $("batch-count").textContent = sum.total ? String(sum.todo || sum.total) : "";
    $("batch-count").title = sum.todo ? `${sum.todo} to review` : "";
    $("batch-summary").textContent = sum.total
      ? `${sum.total} file${sum.total === 1 ? "" : "s"} · ${sum.review} must review · ${sum.check} check · ${sum.ok} OK · ${sum.approved} approved · ${sum.rejected} rejected`
      : "";
    $("batch-empty").hidden = sum.total > 0;
    ["btn-approve-ok", "btn-export-summary", "btn-clear"].forEach((id) => ($(id).disabled = !sum.total));
    $("btn-approve-ok").disabled = !state.files.some((f) => f.review.status === "pending" && f.quality && f.quality.level === "ok");
    $("btn-remove-rejected").disabled = !sum.rejected;
    const body = $("batch-body");
    body.textContent = "";
    const filter = $("batch-filter").value;
    state.files.forEach((f, i) => {
      if (!matchesFilter(f, filter)) return;
      const tr = document.createElement("tr");
      if (i === state.current) tr.className = "current";
      tr.tabIndex = 0;
      tr.addEventListener("click", () => {
        selectFile(i);
        setView("plot");
      });
      tr.addEventListener("keydown", (e) => {
        if (e.key === "Enter") tr.click();
      });
      const td = (text, cls) => {
        const c = document.createElement("td");
        if (cls) c.className = cls;
        if (text instanceof Node) c.appendChild(text);
        else c.textContent = text;
        tr.appendChild(c);
        return c;
      };
      const r = f.result;
      const fx = (v, d = 4) => (r && Number.isFinite(v) ? fmtG(v, d) : "—");
      td(String(i + 1), "num");
      td(f.name, "file").title = f.edited ? "Own settings for this file" : "";
      const pill = document.createElement("span");
      pill.className = `pill ${statusOf(f)}`;
      pill.textContent = statusText(f);
      td(pill);
      const flags = f.quality ? f.quality.flags.filter((fl) => fl.level !== "info") : [];
      const short = flags.map((fl) => FLAG_SHORT[fl.code] || fl.code);
      const ft = td(short.length ? short.join(" · ") : "—", "flagtext");
      ft.title = flags.map((fl) => flagText(fl.message)).join("\n");
      td(fx(r && r.Eavg), "num");
      td(fx(r && r.Epeak), "num");
      const dp = r && r.doublePeak;
      td(dp && dp.found ? fmtG(dp.dE, 3) : "—", "num").title = dp && dp.found ? `${fmtG(dp.Elow, 3)} and ${fmtG(dp.Ehigh, 3)} eV` : "";
      td(fx(r && r.flux, 3), "num");
      td(f.quality && f.quality.metrics.snr !== undefined ? fmtG(f.quality.metrics.snr, 3) : "—", "num");
      td(String(f.form.pressure) + (f.auto.pressure !== undefined && !f.edited ? "" : " *"), "num").title =
        f.auto.pressure !== undefined && !f.edited ? "From the file name" : "From the panel or edited";
      td(f.form.gas, "gas");
      td(String(f.form.frf), "num");
      td(f.review.note || "", "note");
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "btn ghost";
      rm.textContent = "✕";
      rm.title = `Remove ${f.name} from the batch`;
      rm.setAttribute("aria-label", rm.title);
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        removeFiles([f]);
      });
      rm.addEventListener("keydown", (e) => e.stopPropagation());
      td(rm, "remove");
      body.appendChild(tr);
    });
  }

  // Take files out of the batch; their saved review stays in this browser,
  // so opening them again restores it
  function removeFiles(list) {
    if (!list.length) return;
    const shown = cur();
    state.files = state.files.filter((f) => !list.includes(f));
    if (!state.files.length) {
      state.current = -1;
      showCurrent();
      $("file-name").textContent = "No file selected. Files are read in your browser and never uploaded.";
    } else if (!state.files.includes(shown)) {
      selectFile(Math.min(state.current, state.files.length - 1));
    } else {
      state.current = state.files.indexOf(shown);
      renderReviewBar();
    }
    renderBatch();
    setStatus(list.length === 1 ? `Removed ${list[0].name} from the batch` : `Removed ${list.length} files from the batch`);
  }

  function setView(name) {
    document.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === name)));
    $("view-plot").hidden = name !== "plot";
    $("view-batch").hidden = name !== "batch";
    if (name === "plot") Plotly.Plots.resize(plotEl);
    else renderBatch();
  }

  function nextFlagged() {
    const n = state.files.length;
    for (let k = 1; k <= n; k++) {
      const i = (state.current + k) % n;
      if (needsLook(state.files[i])) return i;
    }
    return -1;
  }

  function decide(status) {
    const f = cur();
    if (!f) return;
    f.review = { status, note: $("review-note").value.trim(), at: new Date().toISOString(), mode: "manual" };
    saveReview(f);
    const next = nextFlagged();
    renderBatch();
    if (next >= 0) {
      selectFile(next);
      setStatus(`${status === "approved" ? "Approved" : "Rejected"} ${f.name} · next to review: ${cur().name}`);
    } else {
      renderReviewBar();
      setStatus(`${status === "approved" ? "Approved" : "Rejected"} ${f.name} · nothing left to review`);
    }
  }

  function exportSummary() {
    const cols = ["file", "status", "automatic_check", "flags", "flag_messages", "review_note", "reviewed_at",
      "Eavg_eV", "Epeak_eV", "flux_m-2s-1", "ni_m-3", "tau_ratio", "electrode_voltage_V", "ion_flux_file", "n_traces",
      "double_peak", "E_low_eV", "E_high_eV", "dE_eV", "dE_theory_eV", "peak_height_ratio_low_high", "sheath_regime",
      "sheath_width_mm", "sheath_width_from_dE_mm", "mean_free_path_mm", "sheath_over_mfp",
      "snr", "negative_iedf_ratio", "trace_spread", "pressure_Pa", "gas", "Mi_u", "f_rf_MHz", "Vp_V", "Te_eV", "alpha",
      "method", "smoothing", "dIdE_smoothing_eV", "voltage_shift_V", "settings"];
    const q = (v) => {
      const t = v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v)) ? "" : String(v);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const rows = [cols.join(",")];
    for (const f of state.files) {
      const r = f.result || {};
      const m = (f.quality && f.quality.metrics) || {};
      const fm = f.form;
      const smoothing = { Recursive: `±${fm["rec-window"]} eV`, Mavg: `${fm["mavg-window"]} pts`, SG: `order ${fm["sg-poly"]}, ${fm["sg-window"]} pts`,
        Manual: (fm.manualRanges || []).map((x) => `[${fmtG(x.xmin, 4)};${fmtG(x.xmax, 4)}] w=${x.window}`).join(" ") }[fm.method];
      rows.push([
        f.name, statusText(f), f.quality ? LEVEL_TEXT[f.quality.level] : "",
        (f.quality ? f.quality.flags : []).map((x) => x.code).join(" "),
        (f.quality ? f.quality.flags : []).map((x) => flagText(x.message)).join(" | "),
        f.review.note, f.review.status !== "pending" ? f.review.at : "",
        r.Eavg, r.Epeak, r.flux, r.ni, r.tauRatio, r.electrodeVoltage, r.ionFlux, r.nTraces,
        ...(() => {
          const dp = r.doublePeak;
          if (!dp) return Array(11).fill("");
          const mm = (x) => (Number.isFinite(x) ? x * 1e3 : "");
          return [dp.found ? "yes" : "no", dp.Elow, dp.Ehigh, dp.dE, dp.model.dETheory, dp.heightRatio, dp.model.regime,
            mm(dp.model.sheathWidth), mm(dp.sheathFromSplit), mm(dp.model.mfp), dp.model.sOverMfp];
        })(),
        m.snr, m.negRatio, m.traceSpread,
        fm.pressure, fm.gas, fm.mi, fm.frf, fm.vp, fm.te, fm.alpha,
        fm.method, smoothing, fm["smooth-didv"], fm["shift-on"] ? fm.shift : 0,
        f.edited ? "edited for this file" : Object.keys(f.auto).length ? `panel + file name (${Object.keys(f.auto).join(", ")})` : "panel",
      ].map(q).join(","));
    }
    const stamp = new Date().toISOString().slice(0, 10);
    download(`rfea_batch_summary_${stamp}.csv`, new Blob([rows.join("\n") + "\n"], { type: "text/csv" }));
    const left = summary().todo;
    if (left) setStatus(`Summary exported · ${left} file${left === 1 ? " still needs" : "s still need"} review`);
  }

  function applySettingsToAll() {
    const f = cur();
    if (!f) return;
    const base = readForm();
    let n = 0;
    for (const g of state.files) {
      if (g === f || g.review.status !== "pending") continue;
      const { form, auto } = formForFile(g.name, base);
      g.form = form;
      g.auto = auto;
      g.edited = false;
      saveReview(g);
      analyseFile(g);
      n++;
    }
    renderBatch();
    renderReviewBar();
    setStatus(`Settings copied to ${n} file${n === 1 ? "" : "s"} not yet reviewed (file-name settings still apply)`);
  }

  // Wiring
  document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  $("btn-prev").addEventListener("click", () => selectFile(state.current - 1));
  $("btn-next").addEventListener("click", () => selectFile(state.current + 1));
  $("btn-next-flagged").addEventListener("click", () => {
    const i = nextFlagged();
    if (i >= 0) selectFile(i);
  });
  $("btn-approve").addEventListener("click", () => decide("approved"));
  $("btn-reject").addEventListener("click", () => decide("rejected"));
  $("review-note").addEventListener("change", () => {
    const f = cur();
    if (!f) return;
    f.review.note = $("review-note").value.trim();
    saveReview(f);
    renderBatch();
  });
  $("btn-apply-all").addEventListener("click", applySettingsToAll);
  $("btn-remove").addEventListener("click", () => cur() && removeFiles([cur()]));
  $("btn-remove-rejected").addEventListener("click", () => removeFiles(state.files.filter((f) => f.review.status === "rejected")));
  $("batch-filter").addEventListener("change", renderBatch);
  $("btn-approve-ok").addEventListener("click", () => {
    const at = new Date().toISOString();
    let n = 0;
    for (const f of state.files) {
      if (f.review.status === "pending" && f.quality && f.quality.level === "ok") {
        f.review = { status: "approved", note: f.review.note, at, mode: "bulk" };
        saveReview(f);
        n++;
      }
    }
    renderBatch();
    renderReviewBar();
    setStatus(`Approved ${n} file${n === 1 ? "" : "s"} without flags`);
  });
  $("btn-export-summary").addEventListener("click", exportSummary);
  $("btn-clear").addEventListener("click", () => {
    if (!confirm(`Remove all ${state.files.length} files from the list? Review decisions stay saved in this browser.`)) return;
    state.files = [];
    state.current = -1;
    showCurrent();
    renderBatch();
    $("file-name").textContent = "No file selected. Files are read in your browser and never uploaded.";
    setStatus("List cleared");
  });

  function saveAuto() {
    const data = {};
    for (const id of AUTO_IDS) data[id] = $(id).type === "checkbox" ? $(id).checked : $(id).value;
    store.set(AUTO_KEY, JSON.stringify(data));
  }
  (function restoreAuto() {
    let data = null;
    try { data = JSON.parse(store.get(AUTO_KEY) || "null"); } catch (e) { data = null; }
    if (!data) return;
    for (const id of AUTO_IDS) {
      if (!(id in data)) continue;
      if ($(id).type === "checkbox") $(id).checked = Boolean(data[id]);
      else $(id).value = data[id];
    }
  })();
  // Thresholds re-check every file; the file-name option applies to files opened next
  for (const id of ["snr-review", "snr-check"]) {
    $(id).addEventListener("input", () => {
      saveAuto();
      state.files.forEach(assessFile);
      renderBatch();
      renderReviewBar();
    });
  }
  $("auto-names").addEventListener("change", saveAuto);

  // ---------------- Exports ----------------
  // Inside claude.ai the page cannot start downloads itself; the viewer's
  // "downloads" capability asks the user to confirm the save instead.
  async function download(name, blob) {
    if (window.claude && typeof window.claude.use === "function") {
      const downloads = await window.claude.use("downloads");
      if (downloads) {
        try {
          await downloads.save({ filename: name, data: blob });
          setStatus(`Saved ${name}`);
        } catch (e) {
          if (e && e.code !== "declined") setStatus(`Could not save ${name}: ${e.message || e.code}`, true);
        }
        return;
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportCsv() {
    const r = state.result;
    if (!r) return;
    const cols = { Vavg: r.Vavg, Iavg: r.Iavg, Ismooth: r.Ismooth, E: r.E, IEDF_dIdE: r.dIdE };
    const names = Object.keys(cols);
    const len = Math.max(...names.map((k) => cols[k].length));
    const rows = [names.join(",")];
    for (let i = 0; i < len; i++) {
      rows.push(names.map((k) => (i < cols[k].length && Number.isFinite(cols[k][i]) ? String(cols[k][i]) : "")).join(","));
    }
    download(baseName() + "_rfea_export.csv", new Blob([rows.join("\n") + "\n"], { type: "text/csv" }));
  }

  function baseName() {
    return (cur() ? cur().name : "rfea").replace(/\.[^.]+$/, "");
  }

  async function exportImage(format) {
    if (!state.result) return;
    const { width, height } = plotEl.getBoundingClientRect();
    const dataUrl = await Plotly.toImage(plotEl, {
      format,
      width: Math.round(width),
      height: Math.round(height),
      scale: format === "png" ? 3 : 1,
    });
    await download(`${baseName()}_rfea_plot.${format}`, dataUrlToBlob(dataUrl));
  }

  function dataUrlToBlob(url) {
    const comma = url.indexOf(",");
    const meta = url.slice(5, comma);
    const payload = url.slice(comma + 1);
    const type = meta.split(";")[0];
    if (meta.includes(";base64")) {
      const bin = atob(payload);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type });
    }
    return new Blob([decodeURIComponent(payload)], { type });
  }

  $("btn-export-csv").addEventListener("click", exportCsv);
  $("btn-export-png").addEventListener("click", () => exportImage("png"));
  $("btn-export-svg").addEventListener("click", () => exportImage("svg"));

  // ---------------- Manual smoothing dialog ----------------
  const dlg = $("manual-dialog");
  let draft = [];
  let selected = -1;
  let rawIV = null;

  function openManual() {
    if (!cur()) {
      setStatus("Open a .csv or .sdf file first.", true);
      return;
    }
    try {
      const shift = $("shift-on").checked ? num("shift") : 0;
      const { table } = RFEA.importFile(cur().data);
      const avg = RFEA.traceAverageAndSmooth(RFEA.separateTraces(table), 10, shift);
      rawIV = { V: Array.from(avg.Vavg), I: Array.from(avg.Iavg) };
    } catch (e) {
      setStatus(`Manual smoothing: ${e.message}`, true);
      return;
    }
    draft = state.manualRanges.map((r) => ({ ...r }));
    selected = draft.length ? 0 : -1;
    dlg.showModal();
    renderManualTable();
    renderManualPlot();
  }

  function renderManualPlot() {
    const c = colors();
    const layout = baseLayout(c);
    layout.margin = { l: 70, r: 20, t: 16, b: 48 };
    layout.dragmode = "select";
    layout.selectdirection = "h";
    layout.showlegend = false;
    layout.shapes = draft.map((r, i) => ({
      type: "rect", xref: "x", yref: "paper", x0: r.xmin, x1: r.xmax, y0: 0, y1: 1,
      fillcolor: c.mint, opacity: i === selected ? 0.75 : 0.35,
      line: { color: i === selected ? c.red : "rgba(0,0,0,0)", width: 1.5 }, layer: "below",
    }));
    layout.annotations = draft.map((r) => ({
      x: (r.xmin + r.xmax) / 2, y: 0.95, xref: "x", yref: "paper", showarrow: false,
      text: `w=${r.window}`, font: { color: c.text, size: 11 }, bgcolor: c.bg, bordercolor: c.mint, borderpad: 2,
    }));
    Plotly.react(manualPlotEl, [{
      x: rawIV.V, y: rawIV.I, mode: "lines", line: { color: c.smooth, width: 2 }, hovertemplate: "%{x:.3f} eV<br>%{y:.4g} A<extra></extra>",
    }], layout, { responsive: true, displaylogo: false, modeBarButtonsToRemove: ["lasso2d", "autoScale2d"] });
  }

  function renderManualTable() {
    const body = $("ranges-body");
    body.textContent = "";
    if (!draft.length) {
      const tr = document.createElement("tr");
      tr.className = "empty";
      tr.innerHTML = '<td colspan="5">No ranges yet — drag across the plot to add one.</td>';
      body.appendChild(tr);
      return;
    }
    draft.forEach((r, i) => {
      const tr = document.createElement("tr");
      if (i === selected) tr.className = "selected";
      tr.addEventListener("click", () => {
        selected = i;
        renderManualTable();
        renderManualPlot();
      });
      const cell = (content) => {
        const td = document.createElement("td");
        td.append(content);
        tr.appendChild(td);
      };
      cell(String(i + 1));
      for (const key of ["xmin", "xmax", "window"]) {
        const inp = document.createElement("input");
        inp.type = "number";
        inp.step = key === "window" ? "1" : "any";
        inp.min = key === "window" ? "1" : "";
        inp.value = key === "window" ? String(r[key]) : fmtG(r[key]);
        inp.addEventListener("change", () => {
          const v = Number(inp.value);
          if (inp.value.trim() === "" || !Number.isFinite(v)) {
            inp.value = String(r[key]);
            return;
          }
          r[key] = key === "window" ? Math.max(1, Math.trunc(v)) : v;
          if (r.xmin > r.xmax) [r.xmin, r.xmax] = [r.xmax, r.xmin];
          renderManualTable();
          renderManualPlot();
        });
        cell(inp);
      }
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn destructive";
      del.textContent = "Delete";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        draft.splice(i, 1);
        selected = Math.min(selected, draft.length - 1);
        renderManualTable();
        renderManualPlot();
      });
      cell(del);
      body.appendChild(tr);
    });
  }

  function bindManualSelection() {
    manualPlotEl.on("plotly_selected", (ev) => {
      if (!ev || !ev.range || !ev.range.x) return;
      const [a, b] = ev.range.x;
      if (Math.abs(b - a) < 1e-12) return;
      draft.push({ xmin: Math.min(a, b), xmax: Math.max(a, b), window: 20 });
      selected = draft.length - 1;
      renderManualTable();
      renderManualPlot();
    });
  }

  $("btn-manual").addEventListener("click", () => {
    openManual();
    if (!manualPlotEl.__bound && manualPlotEl.on) {
      bindManualSelection();
      manualPlotEl.__bound = true;
    }
  });
  $("btn-ranges-clear").addEventListener("click", () => {
    draft = [];
    selected = -1;
    renderManualTable();
    renderManualPlot();
  });
  $("btn-ranges-cancel").addEventListener("click", () => dlg.close());
  $("btn-ranges-ok").addEventListener("click", () => {
    state.manualRanges = draft.slice().sort((p, q) => p.xmin - q.xmin);
    dlg.close();
    run();
  });

  // ---------------- Theme, panel, about ----------------
  function applyTheme(name) {
    document.documentElement.dataset.theme = name;
    store.set("rfea-theme", name);
    document.querySelectorAll("[data-theme-btn]").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.themeBtn === name)));
    $("status-right").textContent = `Basel Mint theme · ${name === "dark" ? "Dark" : "Light"}`;
    if (state.result) renderPlot();
    else renderEmptyPlot();
    if (dlg.open) renderManualPlot();
  }
  document.querySelectorAll("[data-theme-btn]").forEach((b) =>
    b.addEventListener("click", () => applyTheme(b.dataset.themeBtn)));

  $("btn-panel").addEventListener("click", () => {
    const layout = $("layout");
    const hidden = layout.classList.toggle("panel-hidden");
    $("btn-panel").textContent = hidden ? "Show panel" : "Hide panel";
    $("btn-panel").setAttribute("aria-expanded", String(!hidden));
    Plotly.Plots.resize(plotEl);
  });

  $("btn-about").addEventListener("click", () => $("about-dialog").showModal());

  // ---------------- What's new ----------------
  // Newest first. With every release add an entry, bump APP_VERSION and set the
  // same version in sw.js (VERSION = "rfea-<APP_VERSION>").
  const APP_VERSION = "2.4.0";
  const CHANGELOG = [
    {
      version: "2.4.0",
      date: "2026-11-05",
      title: "Double peak and corrected flux units",
      items: [
        "Fixed: flux and n<sub>i</sub> were about 6×10<sup>18</sup> times too small because the collector current was not divided by the elementary charge, and τ<sub>i</sub>/τ<sub>rf</sub> was about 2.5×10<sup>9</sup> times too large. Flux is now in m⁻² s⁻¹ and τ<sub>i</sub>/τ<sub>rf</sub> gives the real sheath regime. Results from earlier versions differ.",
        "Double peak from sheath oscillation: the two highest-energy peaks that stand clearly above the noise give E<sub>low</sub>, E<sub>high</sub> and ΔE, marked on the plot. When the high-energy peak is only a plateau ending in a sharp edge, the edge is used.",
        "Sheath model: ΔE predicted from V<sub>p</sub>, f<sub>rf</sub>, M<sub>i</sub> and the Child-law sheath width, the sheath width worked out from the measured ΔE, and the ion mean free path.",
        "New notes and flags: splitting too small to resolve, collisional sheath (low-energy peaks likely charge exchange), measured ΔE far from theory, double peak expected but not found.",
        "Batch table and summary CSV have the double-peak and sheath columns.",
        "Measurements on a biased or powered electrode: the sheath voltage is V<sub>p</sub> minus the electrode voltage from the file (also for τ<sub>i</sub>/τ<sub>rf</sub>).",
        "Remove files from a batch: ✕ on a row, Remove in the review bar, or Remove rejected. Their saved review stays in this browser.",
        "The noise estimate ignores the slope of the I–V curve, so steep curves are no longer rated as noisier than they are. Files with 2 traces are no longer flagged.",
      ],
    },
    {
      version: "2.3.0",
      date: "2026-11-04",
      title: "Batch analysis with review",
      items: [
        "Open or drop many .csv / .sdf files at once. Each one is analysed automatically and listed in the new Batch view.",
        "Pressure, gas and f<sub>rf</sub> are read from file names such as 25W10PaAr60MHz (13 MHz means 13.56 MHz). This can be turned off.",
        "Automatic checks mark every file OK, Check or Must review and say why: weak or noisy signal, E<sub>peak</sub> at the end of the sweep or ≤ 0 eV, E<sub>avg</sub> ≤ 0 eV, IEDF mostly noise, traces that disagree.",
        "Review each file in the Plot view: change its settings for that file only, add a note, then Approve or Reject. Next flagged jumps to the next file that needs a look.",
        "Export summary CSV lists every file with its results, flags, review decision and settings. Decisions are remembered in this browser.",
      ],
    },
    {
      version: "2.2.0",
      date: "2026-11-04",
      title: "Open .sdf files",
      items: [
        "Semion binary scan files (.sdf) open directly, with no CSV export needed. They give the same I–V traces and electrode voltage as the CSV export.",
        "The imported ion flux shows as n/a for .sdf files because Semion only works it out when it exports a CSV.",
        "The installed app can be set to open .sdf files too.",
      ],
    },
    {
      version: "2.1.1",
      date: "2026-10-23",
      title: "Reliable updates",
      items: [
        "Fixed: after an update, the What’s new button could do nothing because the page mixed old and new files. Each version is now downloaded as one complete set, and the app reloads once when a new version arrives.",
      ],
    },
    {
      version: "2.1.0",
      date: "2026-10-23",
      title: "Better Recursive smoothing",
      items: [
        "Recursive smoothing rewritten: it keeps every significant IEDF peak unsmoothed (shaded on the plot) and smooths the rest with windows in eV, so it works for any voltage step. It no longer fails on sparse 0.5 V sweeps or crashes on round voltage grids.",
        "E<sub>peak</sub> comes from a parabola fitted to the top of the peak instead of the nearest data point.",
        "dI/dE smoothing is now set in eV (default 1 eV, was 50 points).",
        "All methods: each slope is placed at the middle of its voltage step and smoothing windows have an odd number of points. This removes a bias of about half a voltage step in E<sub>peak</sub> and E<sub>avg</sub>.",
        "Mavg window default is 5 points (was 20).",
        "Results differ from earlier versions, and saved settings were reset once because the dI/dE field changed units.",
      ],
    },
    {
      version: "2.0.0",
      date: "2026-10-22",
      title: "RFEA Analyzer in the browser",
      items: [
        "The analysis now runs in any browser, with nothing to install. CSV files are read on your computer and never uploaded.",
        "Installable as an app (Install app button) that works offline and opens .csv files directly.",
        "University of Basel light and dark themes.",
        "Physics fixes: ion density now converts T<sub>e</sub> from eV to joules (it was about 2.5×10⁹ times too small), and the τ<sub>i</sub>/τ<sub>rf</sub> formula and atomic mass unit are corrected.",
        "He Impedans gas works, f<sub>rf</sub> is entered in MHz, and the hole radius default is 400 µm.",
        "Help button linking to the project page.",
      ],
    },
    {
      version: "1.1.4",
      date: "",
      title: "Last Python desktop release",
      items: ["Windows desktop app. Its code stays available in the project history."],
    },
  ];

  function renderWhatsNew() {
    const list = $("whatsnew-list");
    list.textContent = "";
    for (const entry of CHANGELOG) {
      const sec = document.createElement("section");
      const h = document.createElement("h3");
      h.innerHTML = `<span class="ver">${entry.version}</span> ${entry.title}`;
      if (entry.date) {
        const d = document.createElement("span");
        d.className = "date";
        d.textContent = entry.date;
        h.appendChild(d);
      }
      const ul = document.createElement("ul");
      for (const item of entry.items) {
        const li = document.createElement("li");
        li.innerHTML = item; // fixed text from this file, only <sub>/<sup> markup
        ul.appendChild(li);
      }
      sec.append(h, ul);
      list.appendChild(sec);
    }
  }

  $("about-version").textContent = `Version ${APP_VERSION}`;
  // A dot on the button until the newest entry has been opened once
  if (store.get("rfea-seen-version") !== APP_VERSION) $("whatsnew-dot").hidden = false;
  $("btn-whatsnew").addEventListener("click", () => {
    renderWhatsNew();
    $("whatsnew-dialog").showModal();
    store.set("rfea-seen-version", APP_VERSION);
    $("whatsnew-dot").hidden = true;
  });

  // ---------------- Installable app (PWA) ----------------
  // Offline cache; service workers only run over http(s), not from file://
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    // A new release takes over in the background: reload once so the page
    // runs the new files instead of a mix of old and new
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || reloading) return;
      reloading = true;
      location.reload();
    });
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => { /* still works online */ });
  }

  // Chrome/Edge: show our own Install button when the browser offers installation
  let installPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e;
    $("btn-install").hidden = false;
  });
  $("btn-install").addEventListener("click", async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $("btn-install").hidden = true;
  });
  window.addEventListener("appinstalled", () => {
    $("btn-install").hidden = true;
    setStatus("RFEA Analyzer installed");
  });

  // Installed app opened with a .csv or .sdf ("Open with" / double-click on desktop)
  if ("launchQueue" in window) {
    window.launchQueue.setConsumer(async (params) => {
      if (params.files && params.files.length) loadFiles(await Promise.all(params.files.map((h) => h.getFile())));
    });
  }

  // ---------------- Wiring ----------------
  for (const id of PARAM_IDS) {
    const el = $(id);
    el.addEventListener(el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input", scheduleRun);
  }

  restoreForm();
  syncControls();
  applyTheme(document.documentElement.dataset.theme || "light");
})();
