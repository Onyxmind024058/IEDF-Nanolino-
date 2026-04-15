import sys
import os
import webbrowser
import json
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QPushButton, QFileDialog, QDoubleSpinBox, QSpinBox, QComboBox,
    QLabel, QGroupBox, QMessageBox, QSplitter, QDialog,
    QTableWidget, QTableWidgetItem, QHeaderView, QAbstractItemView
)
from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QIcon

import numpy as np
from matplotlib.backends.backend_qtagg import FigureCanvasQTAgg as FigureCanvas
from matplotlib.figure import Figure
from matplotlib.backends.backend_qtagg import NavigationToolbar2QT as NavigationToolbar
from matplotlib.widgets import SpanSelector

from Python_RFEA_Analysis_fcn import (
    full_analysis,
    import_file,
    separate_traces_from_table,
    traceaverage_and_smooth,
)


# ============================================================
# App / GitHub release settings
# ============================================================
APP_VERSION = "1.1.0"
GITHUB_OWNER = "Onyxmind024058"
GITHUB_REPO = "IEDF-Nanolino-"
PREFERRED_ASSET_EXTENSIONS = [".exe", ".msi", ".zip"]


def resource_path(rel_path: str) -> str:
    base = getattr(sys, "_MEIPASS", os.path.abspath("."))
    return os.path.join(base, rel_path)


def normalize_version(v: str) -> str:
    return (v or "").strip().lstrip("v").strip()


def parse_version_tuple(v: str) -> tuple[int, ...]:
    v = normalize_version(v)
    if not v:
        return (0,)

    parts = []
    for chunk in v.split("."):
        digits = ""
        for ch in chunk:
            if ch.isdigit():
                digits += ch
            else:
                break
        parts.append(int(digits) if digits else 0)
    return tuple(parts) if parts else (0,)


def is_newer_version(latest_tag: str, current_version: str) -> bool:
    return parse_version_tuple(latest_tag) > parse_version_tuple(current_version)


def get_latest_github_release(owner: str, repo: str) -> dict:
    url = f"https://api.github.com/repos/{owner}/{repo}/releases/latest"
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": f"{repo}-update-checker",
    }
    req = Request(url, headers=headers, method="GET")
    with urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def choose_best_asset(release: dict) -> str | None:
    assets = release.get("assets", [])
    if not isinstance(assets, list):
        return None

    for ext in PREFERRED_ASSET_EXTENSIONS:
        for asset in assets:
            name = str(asset.get("name", "")).lower()
            url = asset.get("browser_download_url")
            if name.endswith(ext) and url:
                return url

    for asset in assets:
        url = asset.get("browser_download_url")
        if url:
            return url
    return None


def main():
    app = QApplication(sys.argv)
    app.setWindowIcon(QIcon(resource_path("icon.ico")))
    w = MainWindow()
    w.resize(1200, 700)
    w.show()
    sys.exit(app.exec())


class MplCanvas(FigureCanvas):
    def __init__(self, parent=None):
        fig = Figure()
        self.ax1 = fig.add_subplot(111)
        self.ax2 = self.ax1.twinx()
        super().__init__(fig)


class ManualRangeCanvas(FigureCanvas):
    def __init__(self, parent=None):
        fig = Figure()
        self.ax = fig.add_subplot(111)
        super().__init__(fig)


class ManualSmoothingDialog(QDialog):
    """
    Dialog for defining manual smoothing ranges.
    Each range is defined by [xmin, xmax, window].
    """

    def __init__(self, Vavg, Iavg, existing_ranges=None, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Manual smoothing")
        self.resize(1000, 700)

        self.Vavg = np.asarray(Vavg, dtype=float).ravel()
        self.Iavg = np.asarray(Iavg, dtype=float).ravel()
        self.ranges = [dict(r) for r in (existing_ranges or [])]

        root = QVBoxLayout(self)

        self.canvas = ManualRangeCanvas(self)
        self.toolbar = NavigationToolbar(self.canvas, self)

        root.addWidget(self.toolbar)
        root.addWidget(self.canvas, 1)

        info = QLabel(
            "Drag on the plot to add a range. "
            "Each range has its own moving-average window. "
            "Select a row and click Delete selected range to remove it."
        )
        info.setWordWrap(True)
        root.addWidget(info)

        self.table = QTableWidget(0, 3)
        self.table.setHorizontalHeaderLabels(["xmin", "xmax", "window"])
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SingleSelection)
        root.addWidget(self.table)

        btn_row = QHBoxLayout()
        self.btn_delete = QPushButton("Delete selected range")
        self.btn_clear = QPushButton("Clear all")
        self.btn_apply = QPushButton("OK")
        self.btn_cancel = QPushButton("Cancel")

        btn_row.addWidget(self.btn_delete)
        btn_row.addWidget(self.btn_clear)
        btn_row.addStretch(1)
        btn_row.addWidget(self.btn_apply)
        btn_row.addWidget(self.btn_cancel)
        root.addLayout(btn_row)

        self.btn_delete.clicked.connect(self.delete_selected)
        self.btn_clear.clicked.connect(self.clear_all)
        self.btn_apply.clicked.connect(self.accept)
        self.btn_cancel.clicked.connect(self.reject)
        self.table.itemChanged.connect(self.on_table_changed)
        self.table.itemSelectionChanged.connect(self.redraw_plot)

        self.span = SpanSelector(
            self.canvas.ax,
            self.on_span_selected,
            "horizontal",
            useblit=True,
            interactive=False,
            drag_from_anywhere=False,
            props=dict(alpha=0.25, facecolor="tab:blue"),
        )

        self.populate_table()
        self.redraw_plot()

    def on_span_selected(self, xmin, xmax):
        if xmin is None or xmax is None:
            return
        if abs(xmax - xmin) < 1e-12:
            return

        a, b = sorted([float(xmin), float(xmax)])
        self.ranges.append({"xmin": a, "xmax": b, "window": 20})
        self.populate_table(select_last=True)
        self.redraw_plot()

    def populate_table(self, select_last=False):
        self.table.blockSignals(True)
        self.table.setRowCount(len(self.ranges))

        for row, r in enumerate(self.ranges):
            xmin_item = QTableWidgetItem(f"{float(r['xmin']):.6g}")
            xmax_item = QTableWidgetItem(f"{float(r['xmax']):.6g}")
            win_item = QTableWidgetItem(str(int(r["window"])))

            xmin_item.setTextAlignment(Qt.AlignCenter)
            xmax_item.setTextAlignment(Qt.AlignCenter)
            win_item.setTextAlignment(Qt.AlignCenter)

            self.table.setItem(row, 0, xmin_item)
            self.table.setItem(row, 1, xmax_item)
            self.table.setItem(row, 2, win_item)

        self.table.blockSignals(False)

        if select_last and self.ranges:
            self.table.selectRow(len(self.ranges) - 1)

    def on_table_changed(self, item):
        row = item.row()
        col = item.column()
        if row < 0 or row >= len(self.ranges):
            return

        text = item.text().strip()
        try:
            if col == 0:
                self.ranges[row]["xmin"] = float(text)
            elif col == 1:
                self.ranges[row]["xmax"] = float(text)
            elif col == 2:
                win = max(1, int(float(text)))
                self.ranges[row]["window"] = win
                item.setText(str(win))
        except ValueError:
            # restore previous values
            self.populate_table()
            return

        if self.ranges[row]["xmin"] > self.ranges[row]["xmax"]:
            self.ranges[row]["xmin"], self.ranges[row]["xmax"] = (
                self.ranges[row]["xmax"],
                self.ranges[row]["xmin"],
            )
            self.populate_table(select_last=False)

        self.redraw_plot()

    def delete_selected(self):
        row = self.table.currentRow()
        if row < 0 or row >= len(self.ranges):
            return
        del self.ranges[row]
        self.populate_table()
        self.redraw_plot()

    def clear_all(self):
        self.ranges = []
        self.populate_table()
        self.redraw_plot()

    def redraw_plot(self):
        ax = self.canvas.ax
        ax.clear()

        ax.plot(self.Vavg, self.Iavg, linewidth=2)
        ax.set_xlabel("Energy (eV)")
        ax.set_ylabel("Current (A)")
        ax.set_title("Manual smoothing range selection")
        ax.grid(True)

        selected_row = self.table.currentRow()

        for idx, r in enumerate(self.ranges):
            xmin = float(r["xmin"])
            xmax = float(r["xmax"])
            alpha = 0.35 if idx == selected_row else 0.18
            ax.axvspan(xmin, xmax, alpha=alpha)
            xc = 0.5 * (xmin + xmax)
            ymin, ymax = ax.get_ylim()
            ytext = ymin + 0.9 * (ymax - ymin)
            ax.text(
                xc,
                ytext,
                f"w={int(r['window'])}",
                ha="center",
                va="center",
                fontsize=9,
                bbox=dict(boxstyle="round,pad=0.2", alpha=0.35),
            )

        self.canvas.draw_idle()

    def get_ranges(self):
        cleaned = []
        for r in self.ranges:
            xmin = float(r["xmin"])
            xmax = float(r["xmax"])
            win = max(1, int(r["window"]))
            if xmax < xmin:
                xmin, xmax = xmax, xmin
            cleaned.append({"xmin": xmin, "xmax": xmax, "window": win})

        cleaned.sort(key=lambda x: x["xmin"])
        return cleaned


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("RFEA Analyzer")
        self.setWindowIcon(QIcon(resource_path("icon.ico")))

        self.csv_path: Path | None = None
        self._last_left_width = 300

        self.manual_ranges = []

        self.last = {
            "Vavg": None,
            "Iavg": None,
            "Ismooth": None,
            "E": None,
            "dIdE": None,
        }

        root = QWidget()
        self.setCentralWidget(root)
        main_layout = QHBoxLayout(root)
        main_layout.setContentsMargins(6, 6, 6, 6)

        self.splitter = QSplitter(Qt.Horizontal)
        self.splitter.setChildrenCollapsible(True)
        main_layout.addWidget(self.splitter)

        # ---------------- Left panel ----------------
        self.left_panel = QWidget()
        controls = QVBoxLayout(self.left_panel)

        file_box = QGroupBox("File")
        fb = QVBoxLayout(file_box)
        self.btn_open = QPushButton("Open CSV…")
        self.lbl_file = QLabel("No file selected")
        self.lbl_file.setWordWrap(True)
        fb.addWidget(self.btn_open)
        fb.addWidget(self.lbl_file)
        controls.addWidget(file_box)

        param_box = QGroupBox("Parameters")
        pb = QVBoxLayout(param_box)

        self.Flux_factor_wid = QComboBox()
        self.Flux_factor_wid.addItems(["Default: 6.374E5", "High density: 6.32E5", "Low density: 5.30E4"])
        pb.addWidget(QLabel("Flux factor"))
        pb.addWidget(self.Flux_factor_wid)

        self.pressure = QDoubleSpinBox()
        self.pressure.setRange(0.0, 1e9)
        self.pressure.setValue(1.0)
        self.pressure.setDecimals(4)
        pb.addWidget(QLabel("Pressure"))
        pb.addWidget(self.pressure)

        self.smooth_didv = QSpinBox()
        self.smooth_didv.setRange(1, 2000)
        self.smooth_didv.setValue(50)
        pb.addWidget(QLabel("SmoothFactordIdV"))
        pb.addWidget(self.smooth_didv)

        self.smooth_method = QComboBox()
        self.smooth_method.addItems(["Recursive", "Mavg", "SG", "Manual"])
        pb.addWidget(QLabel("smoothfunctionIV"))
        pb.addWidget(self.smooth_method)

        self.Recursive_window = QSpinBox()
        self.Recursive_window.setRange(1, 2000)
        self.Recursive_window.setValue(10)

        self.mavg_window = QSpinBox()
        self.mavg_window.setRange(1, 2000)
        self.mavg_window.setValue(20)

        self.sg_poly = QSpinBox()
        self.sg_poly.setRange(0, 10)
        self.sg_poly.setValue(1)

        self.sg_win = QSpinBox()
        self.sg_win.setRange(3, 2001)
        self.sg_win.setSingleStep(2)
        self.sg_win.setValue(13)

        pb.addWidget(QLabel("Recursive window"))
        pb.addWidget(self.Recursive_window)
        pb.addWidget(QLabel("Mavg window"))
        pb.addWidget(self.mavg_window)
        pb.addWidget(QLabel("SG polyorder"))
        pb.addWidget(self.sg_poly)
        pb.addWidget(QLabel("SG window_length (odd)"))
        pb.addWidget(self.sg_win)

        self.btn_manual_smoothing = QPushButton("Manual smoothing…")
        pb.addWidget(self.btn_manual_smoothing)

        pb.addWidget(QLabel("Vp (V)"))
        self.vp = QDoubleSpinBox()
        self.vp.setRange(0.0, 1e4)
        self.vp.setDecimals(4)
        self.vp.setValue(20.0)
        pb.addWidget(self.vp)

        pb.addWidget(QLabel("Mi (u)"))
        self.mi = QDoubleSpinBox()
        self.mi.setRange(0.1, 500.0)
        self.mi.setDecimals(4)
        self.mi.setValue(40.0)
        pb.addWidget(self.mi)

        pb.addWidget(QLabel("f_rf (Hz)"))
        self.frf = QDoubleSpinBox()
        self.frf.setRange(0.0, 1e10)
        self.frf.setDecimals(2)
        self.frf.setValue(13.56e6)
        pb.addWidget(self.frf)

        pb.addWidget(QLabel("Te (eV)"))
        self.te = QDoubleSpinBox()
        self.te.setRange(0.01, 1e3)
        self.te.setDecimals(4)
        self.te.setValue(3.0)
        pb.addWidget(self.te)

        pb.addWidget(QLabel("alpha (sheath)"))
        self.alpha = QDoubleSpinBox()
        self.alpha.setRange(0.01, 100.0)
        self.alpha.setDecimals(4)
        self.alpha.setValue(3.0)
        pb.addWidget(self.alpha)

        controls.addWidget(param_box)

        self.lbl_manual_summary = QLabel("Manual ranges: none")
        self.lbl_manual_summary.setWordWrap(True)
        controls.addWidget(self.lbl_manual_summary)

        self.lbl_stats = QLabel("")
        self.lbl_stats.setAlignment(Qt.AlignTop)
        self.lbl_stats.setWordWrap(True)
        controls.addWidget(self.lbl_stats, 1)

        self.btn_run = QPushButton("Run / Update")
        controls.addWidget(self.btn_run)

        self.btn_export_csv = QPushButton("Export data (CSV)…")
        self.btn_export_plot = QPushButton("Export plot (PNG/SVG)…")
        controls.addWidget(self.btn_export_csv)
        controls.addWidget(self.btn_export_plot)

        self.btn_check_updates = QPushButton("Check for updates")
        controls.addWidget(self.btn_check_updates)

        self.btn_about = QPushButton("About")
        controls.addWidget(self.btn_about)

        self.btn_toggle_panel = QPushButton("Hide panel")
        controls.addWidget(self.btn_toggle_panel)

        # ---------------- Right panel ----------------
        self.plot_panel = QWidget()
        plot_layout = QVBoxLayout(self.plot_panel)

        self.canvas = MplCanvas(self)
        self.toolbar = NavigationToolbar(self.canvas, self)

        plot_layout.addWidget(self.toolbar)
        plot_layout.addWidget(self.canvas)

        self._hover_text = self.canvas.ax1.text(
            0.02, 0.98, "",
            transform=self.canvas.ax1.transAxes,
            va="top", ha="left"
        )
        self._cid_move = self.canvas.mpl_connect("motion_notify_event", self.on_mouse_move)

        self.splitter.addWidget(self.left_panel)
        self.splitter.addWidget(self.plot_panel)
        self.splitter.setStretchFactor(0, 0)
        self.splitter.setStretchFactor(1, 1)
        self.splitter.setSizes([330, 870])

        self.btn_open.clicked.connect(self.open_file)
        self.btn_run.clicked.connect(self.run)
        self.btn_export_csv.clicked.connect(self.export_csv)
        self.btn_export_plot.clicked.connect(self.export_plot)
        self.btn_check_updates.clicked.connect(lambda: self.check_for_updates(silent=False))
        self.btn_about.clicked.connect(self.show_about)
        self.btn_toggle_panel.clicked.connect(self.toggle_left_panel)
        self.btn_manual_smoothing.clicked.connect(self.open_manual_smoothing_dialog)

        self.smooth_method.currentIndexChanged.connect(self.on_smoothing_method_changed)
        self.smooth_method.currentIndexChanged.connect(self.sync_param_visibility)

        auto_widgets = [
            self.pressure,
            self.smooth_didv,
            self.Recursive_window,
            self.mavg_window,
            self.sg_poly,
            self.sg_win,
            self.vp,
            self.mi,
            self.frf,
            self.te,
            self.alpha,
            self.smooth_method,
            self.Flux_factor_wid,
        ]
        for w in auto_widgets:
            if hasattr(w, "valueChanged"):
                w.valueChanged.connect(self.run)
            if hasattr(w, "currentIndexChanged"):
                w.currentIndexChanged.connect(self.run)

        self.sync_param_visibility()
        self.update_manual_summary()

        QTimer.singleShot(1200, lambda: self.check_for_updates(silent=True))

    def sync_param_visibility(self):
        method = self.smooth_method.currentText()
        self.Recursive_window.setEnabled(method == "Recursive")
        self.mavg_window.setEnabled(method == "Mavg")
        self.sg_poly.setEnabled(method == "SG")
        self.sg_win.setEnabled(method == "SG")
        self.btn_manual_smoothing.setEnabled(method == "Manual")

    def on_smoothing_method_changed(self):
        if self.smooth_method.currentText() == "Manual":
            self.update_manual_summary()

    def update_manual_summary(self):
        if not self.manual_ranges:
            self.lbl_manual_summary.setText("Manual ranges: none")
            return

        txt = [f"Manual ranges: {len(self.manual_ranges)}"]
        for i, r in enumerate(self.manual_ranges, start=1):
            txt.append(
                f"{i}) [{r['xmin']:.3g}, {r['xmax']:.3g}]  w={int(r['window'])}"
            )
        self.lbl_manual_summary.setText("\n".join(txt))

    def toggle_left_panel(self):
        if self.left_panel.isVisible():
            sizes = self.splitter.sizes()
            if sizes and sizes[0] > 0:
                self._last_left_width = sizes[0]
            self.left_panel.hide()
            self.btn_toggle_panel.setText("Show panel")
        else:
            self.left_panel.show()
            self.splitter.setSizes([self._last_left_width, max(300, self.width() - self._last_left_width)])
            self.btn_toggle_panel.setText("Hide panel")

    def open_file(self):
        path, _ = QFileDialog.getOpenFileName(self, "Open CSV", "", "CSV Files (*.csv)")
        if not path:
            return
        self.csv_path = Path(path)
        self.lbl_file.setText(str(self.csv_path))
        self.run()

    def _compute_raw_iv_for_manual_dialog(self):
        if self.csv_path is None or not self.csv_path.exists():
            raise ValueError("Please open a CSV file first.")

        electrode_voltage, ion_flux, traces_df = import_file(str(self.csv_path))
        I, V = separate_traces_from_table(traces_df)
        _, Iavg, Vavg = traceaverage_and_smooth(I, V, electrode_voltage, 10)
        return Vavg, Iavg

    def open_manual_smoothing_dialog(self):
        try:
            Vavg, Iavg = self._compute_raw_iv_for_manual_dialog()
        except Exception as e:
            QMessageBox.warning(self, "Manual smoothing", str(e))
            return

        dlg = ManualSmoothingDialog(
            Vavg=Vavg,
            Iavg=Iavg,
            existing_ranges=self.manual_ranges,
            parent=self,
        )
        if dlg.exec() == QDialog.Accepted:
            self.manual_ranges = dlg.get_ranges()
            self.update_manual_summary()
            if self.smooth_method.currentText() == "Manual":
                self.run()

    def show_about(self):
        name = "RFEA analysis by P. Hiret"
        company = "Universität Basel"
        email = "paul.hiret@unibas.ch"
        version = APP_VERSION

        text = (
            f"<b>{name}</b> <span style='color:gray'>(v{version})</span><br>"
            f"{company}<br>"
            f"<a href='mailto:{email}'>{email}</a>"
        )

        box = QMessageBox(self)
        box.setWindowTitle("About")
        box.setTextFormat(Qt.RichText)
        box.setText(text)
        box.setStandardButtons(QMessageBox.Ok)
        box.exec()

    def check_for_updates(self, silent: bool = False):
        if not GITHUB_OWNER or not GITHUB_REPO or GITHUB_OWNER == "your-github-name" or GITHUB_REPO == "your-repo-name":
            if not silent:
                QMessageBox.information(
                    self,
                    "Updates not configured",
                    "Please set GITHUB_OWNER and GITHUB_REPO in the code first."
                )
            return

        try:
            release = get_latest_github_release(GITHUB_OWNER, GITHUB_REPO)
        except HTTPError as e:
            if not silent:
                QMessageBox.warning(self, "Update check failed", f"GitHub returned an error:\nHTTP {e.code} - {e.reason}")
            return
        except URLError as e:
            if not silent:
                QMessageBox.warning(self, "Update check failed", f"Could not reach GitHub:\n{e}")
            return
        except Exception as e:
            if not silent:
                QMessageBox.warning(self, "Update check failed", f"Unexpected error:\n{e}")
            return

        latest_tag = str(release.get("tag_name", "")).strip()
        release_name = str(release.get("name", "")).strip()
        release_page = str(release.get("html_url", "")).strip()
        release_notes = str(release.get("body", "")).strip()

        if not latest_tag:
            if not silent:
                QMessageBox.information(self, "Updates", "No valid release tag found on GitHub.")
            return

        if not is_newer_version(latest_tag, APP_VERSION):
            if not silent:
                QMessageBox.information(self, "No update available", f"You already have the latest version ({APP_VERSION}).")
            return

        latest_version = normalize_version(latest_tag)
        asset_url = choose_best_asset(release)

        msg = QMessageBox(self)
        msg.setWindowTitle("Update available")
        msg.setIcon(QMessageBox.Information)
        msg.setText(
            f"A newer version is available.\n\n"
            f"Current version: {APP_VERSION}\n"
            f"Latest version: {latest_version}"
        )

        if release_name:
            msg.setInformativeText(release_name)

        if release_notes:
            notes = release_notes[:3000]
            if len(release_notes) > 3000:
                notes += "\n\n[Release notes truncated]"
            msg.setDetailedText(notes)

        btn_download = None
        if asset_url:
            btn_download = msg.addButton("Download update", QMessageBox.AcceptRole)

        btn_release = None
        if release_page:
            btn_release = msg.addButton("Open release page", QMessageBox.ActionRole)

        msg.addButton(QMessageBox.Cancel)
        msg.exec()

        clicked = msg.clickedButton()
        if btn_download is not None and clicked == btn_download:
            webbrowser.open(asset_url)
        elif btn_release is not None and clicked == btn_release:
            webbrowser.open(release_page)

    def on_mouse_move(self, event):
        if event.inaxes not in (self.canvas.ax1, self.canvas.ax2):
            return
        if event.xdata is None:
            return

        V = self.last.get("Vavg")
        I = self.last.get("Iavg")
        Is = self.last.get("Ismooth")
        E = self.last.get("E")
        dIdE = self.last.get("dIdE")

        if V is None or I is None or Is is None or E is None or dIdE is None:
            return

        if event.inaxes == self.canvas.ax1:
            idx = int(np.argmin(np.abs(V - event.xdata)))
            self._hover_text.set_text(
                f"V={V[idx]:.3g}   I={I[idx]:.3g}   Ismooth={Is[idx]:.3g}"
            )
        else:
            idx = int(np.argmin(np.abs(E - event.xdata)))
            self._hover_text.set_text(
                f"E={E[idx]:.3g}   dIdE={dIdE[idx]:.3g}"
            )

        self.canvas.draw_idle()

    def export_csv(self):
        import pandas as pd

        Vavg = self.last.get("Vavg")
        Iavg = self.last.get("Iavg")
        Ismooth = self.last.get("Ismooth")
        E = self.last.get("E")
        dIdE = self.last.get("dIdE")

        if any(x is None for x in [Vavg, Iavg, Ismooth, E, dIdE]):
            QMessageBox.warning(self, "Nothing to export", "Run the analysis first.")
            return

        path, _ = QFileDialog.getSaveFileName(
            self,
            "Save data as CSV",
            "rfea_export.csv",
            "CSV Files (*.csv)"
        )
        if not path:
            return

        arrays = {
            "Vavg": np.asarray(Vavg).ravel(),
            "Iavg": np.asarray(Iavg).ravel(),
            "Ismooth": np.asarray(Ismooth).ravel(),
            "E": np.asarray(E).ravel(),
            "IEDF_dIdE": np.asarray(dIdE).ravel(),
        }
        maxlen = max(a.size for a in arrays.values())

        def pad(a):
            a = np.asarray(a).ravel()
            if a.size == maxlen:
                return a
            out = np.full(maxlen, np.nan, dtype=float)
            out[:a.size] = a
            return out

        df = pd.DataFrame({k: pad(v) for k, v in arrays.items()})

        try:
            df.to_csv(path, index=False)
        except Exception as e:
            QMessageBox.critical(self, "Export failed", str(e))
            return

        QMessageBox.information(self, "Export complete", f"Saved:\n{path}")

    def export_plot(self):
        path, selected_filter = QFileDialog.getSaveFileName(
            self,
            "Save plot as…",
            "rfea_plot.png",
            "PNG Image (*.png);;SVG Vector (*.svg)"
        )
        if not path:
            return

        if selected_filter.startswith("PNG") and not path.lower().endswith(".png"):
            path += ".png"
        elif selected_filter.startswith("SVG") and not path.lower().endswith(".svg"):
            path += ".svg"

        try:
            self.canvas.figure.savefig(path, dpi=300, bbox_inches="tight")
        except Exception as e:
            QMessageBox.critical(self, "Export failed", str(e))
            return

        QMessageBox.information(self, "Export complete", f"Saved:\n{path}")

    def run(self):
        self.sync_param_visibility()

        if self.csv_path is None or not self.csv_path.exists():
            return

        pressure = float(self.pressure.value())
        SmoothFactordIdV = int(self.smooth_didv.value())
        method = self.smooth_method.currentText()

        Flux_factor_string = self.Flux_factor_wid.currentText()
        if  Flux_factor_string == "High density: 6.32E5":
            Flux_factor = 6.32e5
        elif Flux_factor_string == "Low density: 5.30E4":
            Flux_factor = 5.3e4
        else:
            Flux_factor = 6.374e5

        if method == "Recursive":
            smoothIVparam = int(self.Recursive_window.value())
        elif method == "Mavg":
            smoothIVparam = int(self.mavg_window.value())
        elif method == "SG":
            win = int(self.sg_win.value())
            if win % 2 == 0:
                win += 1
            smoothIVparam = (int(self.sg_poly.value()), win)
        elif method == "Manual":
            smoothIVparam = {"ranges": self.manual_ranges}
        else:
            smoothIVparam = None

        Vp = float(self.vp.value())
        Mi = float(self.mi.value())
        f_rf = float(self.frf.value())
        Te = float(self.te.value())
        alpha = float(self.alpha.value())

        try:
            (
                Eavg, flux, dIdE, E, ni,
                Electrode_Voltage, Ion_flux,
                Ismooth, Iavg, Epeak, tau_ratio,
                Vavg
            ) = full_analysis(
                str(self.csv_path),
                pressure,
                boolplot=False,
                SmoothFactordIdV=SmoothFactordIdV,
                smoothfunctionIV=method,
                smoothIVparam=smoothIVparam,
                Mi=Mi,
                f_rf=f_rf,
                Vp=Vp,
                Te=Te,
                alpha=alpha,
                Flux_factor= Flux_factor
            )
        except Exception as e:
            QMessageBox.critical(self, "Analysis failed", str(e))
            return

        tau_str = f"{tau_ratio:.6g}" if (tau_ratio is not None and np.isfinite(tau_ratio)) else "N/A"

        self.last["Vavg"] = np.asarray(Vavg).ravel()
        self.last["Iavg"] = np.asarray(Iavg).ravel()
        self.last["Ismooth"] = np.asarray(Ismooth).ravel()
        self.last["E"] = np.asarray(E).ravel()
        self.last["dIdE"] = np.asarray(dIdE).ravel()

        self.lbl_stats.setText(
            f"Eavg: {Eavg:.6g}\n"
            f"Flux: {flux:.6g}\n"
            f"ni (Valid only for Ar 3eV): {ni:.6g}\n"
            f"Epeak: {Epeak:.6g}\n"
            f"Tau ratio (tau_i/tau_rf): {tau_str}\n"
            f"Electrode_Voltage: {Electrode_Voltage:.6g}\n"
            f"Ion_flux (imported): {Ion_flux:.6g}"
        )

        ax1, ax2 = self.canvas.ax1, self.canvas.ax2
        ax1.clear()
        ax2.clear()

        self._hover_text = ax1.text(
            0.02, 0.98, "",
            transform=ax1.transAxes,
            va="top", ha="left"
        )

        V = np.asarray(Vavg).ravel()
        I = np.asarray(Iavg).ravel()
        Is = np.asarray(Ismooth).ravel()
        E = np.asarray(E).ravel()
        dI = np.asarray(dIdE).ravel()

        n_iv = min(len(V), len(I), len(Is))
        V, I, Is = V[:n_iv], I[:n_iv], Is[:n_iv]

        n_e = min(len(E), len(dI))
        E, dI = E[:n_e], dI[:n_e]

        if n_e > 10:
            E, dI = E[:-10], dI[:-10]

        ax1.plot(V, I, color="black", linewidth=2.5, label="I")
        ax1.plot(V, Is, color="green", linewidth=2.5, label="Ismooth")
        ax1.set_xlabel("Energy (eV)")
        ax1.set_ylabel("Current (A)", color="black")
        ax1.tick_params(axis="y", colors="black")
        ax1.spines["left"].set_color("black")
        ax1.grid(True)
        ax1.legend(loc="upper left")

        ax2.plot(E, dI, color="red", linewidth=2.5)
        ax2.set_ylabel("IEDF (a.u.)", color="red")
        ax2.yaxis.set_label_position("right")
        ax2.yaxis.tick_right()
        ax2.tick_params(axis="y", colors="red")
        ax2.spines["right"].set_color("red")

        if len(dI) > 0 and np.any(np.isfinite(dI)):
            ymax = np.nanmax(dI) * 1.5
            if not np.isfinite(ymax) or ymax <= 0:
                ymax = 1.0
        else:
            ymax = 1.0
        ax2.set_ylim(0, ymax)

        ax1.set_title("I–V curve and IEDF")
        self.canvas.draw()


if __name__ == "__main__":
    main()