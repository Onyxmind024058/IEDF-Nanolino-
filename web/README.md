# RFEA Analyzer — web version

The RFEA analysis running entirely in the browser: no installation, no server,
and CSV files are read locally and never uploaded.

## Use it

- **From a folder:** open `index.html` in Chrome, Edge, Firefox or Safari
  (double-click works; no web server needed, also offline).
- **From a website:** publish this `web/` folder as static files, e.g. with
  GitHub Pages or any university web space.

### Install it as an app

From the website (not from a local folder) the analyzer can be installed like a
normal program. It then has its own window and icon, and works without internet.

- **Chrome / Edge (Windows, macOS, Linux):** click **Install app** in the top bar,
  or the install icon in the address bar. The installed app can then open `.csv`
  files directly ("Open with → RFEA Analyzer").
- **Android (Chrome):** menu ⋮ → **Install app** / **Add to Home screen**.
- **iPhone / iPad (Safari):** Share → **Add to Home Screen**.

New versions are picked up automatically: the app updates itself in the
background and shows the new version the next time it is opened.

Then open a Semion CSV export (button or drag and drop). Results and plots
update as you change parameters. The theme (University of Basel light/dark) and
the last parameters are remembered in the browser.

## Files

| Path | Content |
|---|---|
| `index.html` | Page layout |
| `css/basel.css` | University of Basel theme, same colours as `themes/basel-*.qss` |
| `js/rfea-analysis.js` | The analysis, ported line by line from `Python_RFEA_Analysis_fcn.py` |
| `js/app.js` | Form, plots, manual smoothing, exports |
| `manifest.webmanifest`, `sw.js`, `icons/` | Installable app: name, icons, offline cache |
| `vendor/plotly-2.35.2.min.js` | Plotting library (plotly.js, MIT licence), bundled so the app works offline |

## Differences from the desktop app

- **Recursive smoothing is a new, peak-preserving algorithm** (see the main
  README, section 5.4). Smoothing widths are in eV instead of data points, the
  dI/dE smoothing default is 1 eV instead of 50 points, and slopes are placed at
  the middle of each voltage step. This removes the failures on sparse sweeps
  and a bias of about half a voltage step in E<sub>peak</sub> and E<sub>avg</sub>.
  The exact Python algorithm is still in `js/rfea-analysis.js` as
  `pipeline: "legacy"` and is what `tests/compare.mjs` checks against Python.

- f_rf is entered in MHz instead of Hz.
- The gas list's "He Impedans" entry works (in the desktop app it never matched
  and the analysis failed).
- Manual smoothing ranges are picked on the voltage-shifted curve, the same
  curve the analysis uses.
- The smoothed I–V curve is plotted against its own energy axis (the desktop
  plot is offset by two points with the Recursive method).

## Checking the port against Python

```bash
python web/tests/make_reference.py web/tests/data   # needs numpy, scipy, pandas
node web/tests/compare.mjs web/tests/data           # compares every output array
```

With `pipeline: "legacy"` the JavaScript results match the Python ones to about
1e-12 for all smoothing methods. `web/tests/benchmark.cjs` scores the current
methods against synthetic data with a known IEDF. `web/tests/browser-check.cjs` drives the page in Chromium with
Playwright (load, smoothing methods, manual ranges, exports, themes, phone width);
`web/tests/pwa-check.cjs` serves the app over HTTP and checks installability and
that it starts and analyses a file offline.
