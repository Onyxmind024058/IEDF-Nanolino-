// RFEA Analyzer web app: wires the form, plots and exports to RFEA (rfea-analysis.js).
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const plotEl = $("plot");
  const manualPlotEl = $("manual-plot");

  const state = {
    text: null,
    fileName: null,
    manualRanges: [],
    result: null,
  };

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

  function readParams() {
    const method = $("method").value;
    let smoothParam = null;
    if (method === "Recursive") smoothParam = num("rec-window");
    else if (method === "Mavg") smoothParam = Math.trunc(num("mavg-window"));
    else if (method === "SG") {
      let win = Math.trunc(num("sg-window"));
      if (win % 2 === 0) win += 1;
      smoothParam = [Math.trunc(num("sg-poly")), win];
    } else if (method === "Manual") smoothParam = { ranges: state.manualRanges };

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
      crossSection: RFEA.CROSS_SECTIONS[$("gas").value],
      voltageShift: $("shift-on").checked ? num("shift") : 0,
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

  function run() {
    syncControls();
    saveForm();
    if (!state.text) return;
    let params;
    try {
      params = readParams();
    } catch (e) {
      setStatus(e.message, true);
      return;
    }
    const t0 = performance.now();
    let r;
    try {
      r = RFEA.fullAnalysis(state.text, params);
    } catch (e) {
      setStatus(`Analysis failed: ${e.message}`, true);
      return;
    }
    state.result = r;
    state.params = params;
    renderResults(r);
    renderPlot();
    ["btn-export-csv", "btn-export-png", "btn-export-svg"].forEach((id) => ($(id).disabled = false));
    setStatus(`${state.fileName} · ${r.nTraces} traces averaged · analysed in ${(performance.now() - t0).toFixed(0)} ms`);
  }

  const UNITS = {
    Eavg: "eV", Epeak: "eV", flux: "m⁻² s⁻¹", ni: "m⁻³", tauRatio: "", electrodeVoltage: "V", ionFlux: "",
  };

  function renderResults(r) {
    document.querySelectorAll("#results dd").forEach((dd) => {
      const k = dd.dataset.k;
      const v = r[k];
      dd.textContent = k === "tauRatio" && (v === null || !Number.isFinite(v)) ? "N/A" : fmtG(v);
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

    Plotly.react(plotEl, [
      { x: V, y: Array.from(r.Iavg.slice(0, n)), name: "I", mode: "lines", line: { color: c.raw, width: 6 },
        hovertemplate: "%{y:.4g} A" },
      { x: Vs, y: Array.from(r.Ismooth), name: "I smooth", mode: "lines", line: { color: c.smooth, width: 2 },
        hovertemplate: "%{y:.4g} A" },
      { x: E, y: dI, name: "IEDF", mode: "lines", yaxis: "y2", line: { color: c.iedf, width: 2.5 },
        hovertemplate: "%{y:.4g}" },
    ], layout, PLOT_CONFIG);
  }

  function renderEmptyPlot() {
    const c = colors();
    const layout = baseLayout(c);
    layout.annotations = [{
      text: "Open a CSV file to see the I–V curve and IEDF", showarrow: false,
      xref: "paper", yref: "paper", x: 0.5, y: 0.5, font: { color: c.textLo, size: 14 },
    }];
    layout.xaxis.showgrid = layout.yaxis.showgrid = false;
    layout.xaxis.showticklabels = layout.yaxis.showticklabels = false;
    Plotly.react(plotEl, [], layout, { ...PLOT_CONFIG, staticPlot: true });
  }

  // ---------------- File loading ----------------
  async function loadFile(file) {
    if (!file) return;
    try {
      state.text = await file.text();
    } catch (e) {
      setStatus(`Could not read ${file.name}: ${e.message}`, true);
      return;
    }
    state.fileName = file.name;
    $("file-name").textContent = `${file.name} (${(file.size / 1024).toFixed(0)} kB) — read locally, not uploaded.`;
    run();
  }

  $("file").addEventListener("change", (e) => loadFile(e.target.files[0]));
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => {
    e.preventDefault();
    drop.classList.add("over");
  }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("over")));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    loadFile(e.dataTransfer.files[0]);
  });
  // Dropping anywhere else should not navigate away from the app
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });

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
    return (state.fileName || "rfea").replace(/\.[^.]+$/, "");
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
    if (!state.text) {
      setStatus("Open a CSV file first.", true);
      return;
    }
    try {
      const shift = $("shift-on").checked ? num("shift") : 0;
      const { table } = RFEA.importFile(state.text);
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
  const APP_VERSION = "2.1.1";
  const CHANGELOG = [
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
        li.innerHTML = item; // fixed text from this file, only <sub> markup
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

  // Installed app opened with a CSV ("Open with" / double-click on desktop)
  if ("launchQueue" in window) {
    window.launchQueue.setConsumer(async (params) => {
      if (params.files && params.files.length) loadFile(await params.files[0].getFile());
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
