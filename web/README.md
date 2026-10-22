# RFEA Analyzer — web version

The RFEA analysis running entirely in the browser: no installation, no server,
and CSV files are read locally and never uploaded.

## Use it

- **From a folder:** open `index.html` in Chrome, Edge, Firefox or Safari
  (double-click works; no web server needed, also offline).
- **From a website:** publish this `web/` folder as static files, e.g. with
  GitHub Pages or any university web space.

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
| `vendor/plotly-2.35.2.min.js` | Plotting library (plotly.js, MIT licence), bundled so the app works offline |

## Differences from the desktop app

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

The JavaScript results match the Python ones to about 1e-12 for all smoothing
methods. `web/tests/browser-check.cjs` drives the page in Chromium with
Playwright (load, smoothing methods, manual ranges, exports, themes, phone width).
