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
    QLabel, QGroupBox, QMessageBox, QSplitter
)
from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QIcon

import numpy as np
from matplotlib.backends.backend_qtagg import FigureCanvasQTAgg as FigureCanvas
from matplotlib.figure import Figure
from matplotlib.backends.backend_qtagg import NavigationToolbar2QT as NavigationToolbar

from Python_RFEA_Analysis_fcn import full_analysis


# ============================================================
# App / GitHub release settings
# ============================================================
APP_VERSION = "1.0.3"
GITHUB_OWNER = "Onyxmind024058"
GITHUB_REPO = "IEDFbyPH"

# Optional:
# If you only want to auto-open a specific asset type when an update exists,
# list extensions in order of preference.
PREFERRED_ASSET_EXTENSIONS = [".exe", ".msi", ".zip"]


def resource_path(rel_path: str) -> str:
    base = getattr(sys, "_MEIPASS", os.path.abspath("."))
    return os.path.join(base, rel_path)


def normalize_version(v: str) -> str:
    return (v or "").strip().lstrip("v").strip()


def parse_version_tuple(v: str) -> tuple[int, ...]:
    """
    Simple numeric version parser:
    '1.2.3' -> (1, 2, 3)
    'v1.2.3' -> (1, 2, 3)
    '1.2' -> (1, 2)

    Non-numeric suffixes are ignored in each dot-separated chunk:
    '1.2.3-beta1' -> (1, 2, 3)
    """
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
        if digits == "":
            parts.append(0)
        else:
            parts.append(int(digits))
    return tuple(parts) if parts else (0,)


def is_newer_version(latest_tag: str, current_version: str) -> bool:
    return parse_version_tuple(latest_tag) > parse_version_tuple(current_version)


def get_latest_github_release(owner: str, repo: str) -> dict:
    """
    Fetch latest GitHub release metadata.
    """
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
    """
    Pick the first release asset matching preferred extensions.
    Falls back to None if nothing matches.
    """
    assets = release.get("assets", [])
    if not isinstance(assets, list):
        return None

    # Try preferred extensions first
    for ext in PREFERRED_ASSET_EXTENSIONS:
        for asset in assets:
            name = str(asset.get("name", "")).lower()
            url = asset.get("browser_download_url")
            if name.endswith(ext) and url:
                return url

    # Fallback: first asset with browser_download_url
    for asset in assets:
        url = asset.get("browser_download_url")
        if url:
            return url

    return None


def main():
    app = QApplication(sys.argv)
    app.setWindowIcon(QIcon(resource_path("icon.ico")))
    w = MainWindow()
    w.resize(1100, 650)
    w.show()
    sys.exit(app.exec())


class MplCanvas(FigureCanvas):
    def __init__(self, parent=None):
        fig = Figure()
        self.ax1 = fig.add_subplot(111)
        self.ax2 = self.ax1.twinx()
        super().__init__(fig)


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("RFEA Analyzer")
        self.setWindowIcon(QIcon(resource_path("icon.ico")))

        self.csv_path: Path | None = None
        self._last_left_width = 300

        # Holds latest computed arrays for exporting / hover
        self.last = {
            "Vavg": None,
            "Iavg": None,
            "Ismooth": None,
            "E": None,
            "dIdE": None,
        }

        # ---------------- Root / splitter ----------------
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
        self.smooth_method.addItems(["Recursive", "Mavg", "SG"])
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

        # ---------------- Splitter setup ----------------
        self.splitter.addWidget(self.left_panel)
        self.splitter.addWidget(self.plot_panel)
        self.splitter.setStretchFactor(0, 0)
        self.splitter.setStretchFactor(1, 1)
        self.splitter.setSizes([300, 800])

        # ---------------- Signals ----------------
        self.btn_open.clicked.connect(self.open_file)
        self.btn_run.clicked.connect(self.run)
        self.btn_export_csv.clicked.connect(self.export_csv)
        self.btn_export_plot.clicked.connect(self.export_plot)
        self.btn_check_updates.clicked.connect(lambda: self.check_for_updates(silent=False))
        self.btn_about.clicked.connect(self.show_about)
        self.btn_toggle_panel.clicked.connect(self.toggle_left_panel)
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
        ]
        for w in auto_widgets:
            if hasattr(w, "valueChanged"):
                w.valueChanged.connect(self.run)
            if hasattr(w, "currentIndexChanged"):
                w.currentIndexChanged.connect(self.run)

        self.sync_param_visibility()

        # Silent update check shortly after startup
        QTimer.singleShot(1200, lambda: self.check_for_updates(silent=True))

    def sync_param_visibility(self):
        method = self.smooth_method.currentText()
        self.Recursive_window.setEnabled(method == "Recursive")
        self.mavg_window.setEnabled(method == "Mavg")
        self.sg_poly.setEnabled(method == "SG")
        self.sg_win.setEnabled(method == "SG")

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
                QMessageBox.warning(
                    self,
                    "Update check failed",
                    f"GitHub returned an error:\nHTTP {e.code} - {e.reason}"
                )
            return
        except URLError as e:
            if not silent:
                QMessageBox.warning(
                    self,
                    "Update check failed",
                    f"Could not reach GitHub:\n{e}"
                )
            return
        except Exception as e:
            if not silent:
                QMessageBox.warning(
                    self,
                    "Update check failed",
                    f"Unexpected error:\n{e}"
                )
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
                QMessageBox.information(
                    self,
                    "No update available",
                    f"You already have the latest version ({APP_VERSION})."
                )
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

        if method == "Recursive":
            smoothIVparam = int(self.Recursive_window.value())
        elif method == "Mavg":
            smoothIVparam = int(self.mavg_window.value())
        else:
            win = int(self.sg_win.value())
            if win % 2 == 0:
                win += 1
            smoothIVparam = (int(self.sg_poly.value()), win)

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