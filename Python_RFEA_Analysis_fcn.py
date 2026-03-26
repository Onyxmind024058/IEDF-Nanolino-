from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional, Sequence, Tuple, Union

import numpy as np
import pandas as pd
import re

# Optional deps (needed for SG + peak finding + plots)
from scipy.signal import find_peaks, savgol_filter
from scipy.ndimage import uniform_filter1d
import matplotlib.pyplot as plt


SmoothMethod = Literal["Recursive", "Mavg", "SG"]


def full_analysis(
    filename: str,
    pressure: float,
    boolplot: bool,
    SmoothFactordIdV: int = 50,
    smoothfunctionIV: SmoothMethod = "Recursive",
    smoothIVparam: Union[float, int, Sequence[int], None] = None,
    *,
    # The MATLAB code uses these but doesn't define them inside full_analysis.
    # You can pass them here if you want tau_ratio computed.
    Mi: Optional[float] = None,     # ion mass [u]
    f_rf: Optional[float] = None,   # RF frequency [Hz]
    Vp: Optional[float] = None,     # potential [V]
    Te: float = 3.0,                # electron temperature [eV]
    alpha: float = 3.0,             # scaling factor
) -> Tuple[float, float, np.ndarray, np.ndarray, float, float, float, np.ndarray, np.ndarray, float, Optional[float]]:
    """
    Python translation of the provided MATLAB code.

    Returns:
      (Eavg, flux, dIdE, E, ni, Electrode_Voltage, Ion_flux, Ismooth, Iavg, Epeak, tau_ratio)
    """

    # Defaults matching MATLAB intent
    if smoothIVparam is None:
        smoothIVparam = np.nan
    if smoothfunctionIV == "Mavg" and _is_nan(smoothIVparam):
        smoothIVparam = 20
    if smoothfunctionIV == "SG" and _is_nan(smoothIVparam):
        smoothIVparam = (1, 13)  # (polyorder, window_length) like example [1 13]

    SmoothFactorIV = 10

    Electrode_Voltage, Ion_flux, traces_df = import_file(filename)
    I, V = separate_traces_from_table(traces_df)

    Isth, Iavg, Vavg = traceaverage_and_smooth(I, V, Electrode_Voltage, SmoothFactorIV)

    Eavg, flux, dIdE, E, ni, Epeak, Ismooth = iedf(
        Isth,
        Vavg,
        pressure,
        SmoothFactordIdV=SmoothFactordIdV,
        smoothfunctionIV=smoothfunctionIV,
        smoothIVparam=smoothIVparam,
        Mi=Mi,
        Te=Te,
    )

    if boolplot:
        plotgraphIEDF(Vavg, Iavg, Ismooth, E, dIdE)

    tau_ratio = None
    if (Mi is not None) and (f_rf is not None) and (Vp is not None):
        tau_ratio = tau_ratio_NF(Mi=Mi, f_rf=f_rf, Vp=Vp, ni=ni, Te=Te, alpha=alpha)

    return (
        float(Eavg),
        float(flux),
        dIdE,
        E,
        float(ni),
        float(Electrode_Voltage),
        float(Ion_flux),
        Ismooth,
        Iavg,
        float(Epeak),
        tau_ratio,
        Vavg,
    )


# -----------------------------
# File import / trace separation
# -----------------------------

def import_file(filename: str) -> Tuple[float, float, pd.DataFrame]:
    """
    More robust import:
      - Reads Electrode_Voltage from CSV line 3, column 2
      - Reads Ion_flux from CSV line 6, column 2
      - Reads traces from line 9 onward, tolerating 'trace ...' / headers / junk rows
    """
    with open(filename, "r", encoding="utf-8", errors="replace") as f:
        lines = f.read().splitlines()

    def _read_second_col_as_float(line_idx_1based: int) -> float:
        idx = line_idx_1based - 1
        if idx < 0 or idx >= len(lines):
            raise ValueError(f"File too short: can't read line {line_idx_1based}")

        # split on comma OR semicolon
        parts = re.split(r"[;,]", lines[idx])
        parts = [p.strip() for p in parts if p.strip()]

        if len(parts) < 2:
            raise ValueError(f"Line {line_idx_1based} has <2 columns: {lines[idx]!r}")

        return float(parts[1])

    Electrode_Voltage = _read_second_col_as_float(3)
    Ion_flux = _read_second_col_as_float(6)

    # Traces start at line 9 (1-based)
    trace_text = "\n".join(lines[8:])

    from io import StringIO

    # 1) read without dtype enforcement
    df = pd.read_csv(
        StringIO(trace_text),
        header=None,
        names=["V", "I", "dIdE"],
        usecols=[0, 1, 2],
        sep=None,
        engine="python",
        dtype=str,              # <- read as strings first
        skip_blank_lines=True,
    )

    # 2) coerce to numeric (non-numeric -> NaN)
    for c in ["V", "I", "dIdE"]:
        df[c] = pd.to_numeric(df[c].str.strip(), errors="coerce")

    # 3) keep rows that look like real numeric data OR NaN separators
    #    - We want to retain NaNs in V because separate_traces_from_table uses them as separators.
    #    - Drop rows that are totally non-numeric in all three columns.
    df = df.loc[~(df["V"].isna() & df["I"].isna() & df["dIdE"].isna())].reset_index(drop=True)

    return Electrode_Voltage, Ion_flux, df



def separate_traces_from_table(traces_table: pd.DataFrame) -> Tuple[np.ndarray, np.ndarray]:
    Vcol = traces_table["V"].to_numpy(dtype=float)
    Icol = traces_table["I"].to_numpy(dtype=float)

    # Split into segments separated by NaN in V
    nan_idx = np.flatnonzero(np.isnan(Vcol))
    # Add boundaries
    boundaries = np.r_[ -1, nan_idx, Vcol.size ]
    segments = []
    for a, b in zip(boundaries[:-1], boundaries[1:]):
        seg = slice(a + 1, b)
        if b - (a + 1) > 0:
            segments.append(seg)

    # Keep only segments that have numeric V and I
    Vs, Is = [], []
    for seg in segments:
        v = Vcol[seg]
        i = Icol[seg]
        if np.all(np.isfinite(v)) and np.all(np.isfinite(i)):
            Vs.append(v)
            Is.append(i)

    if not Vs:
        raise ValueError("No numeric trace segments found (check NaN separators / file format).")

    # Ensure same length (MATLAB assumes equal lengths)
    nrow = min(len(v) for v in Vs)
    Vs = [v[:nrow] for v in Vs]
    Is = [i[:nrow] for i in Is]
    V = np.column_stack(Vs)
    I = np.column_stack(Is)
    return I, V



# -----------------------------
# Averaging / smoothing helpers
# -----------------------------

def traceaverage_and_smooth(
    I: np.ndarray,
    V: np.ndarray,
    Electrode_Voltage: float,
    SmoothFactorIV: int,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    Vavg = np.mean(V, axis=1) - Electrode_Voltage
    Iavg = np.mean(I, axis=1)
    Isth = smooth_1d(Iavg, SmoothFactorIV)
    return Isth, Iavg, Vavg


def smooth_1d(y: np.ndarray, window: int) -> np.ndarray:
    """
    MATLAB's smooth(...) is not one thing; a reasonable analogue is a moving average.
    Uses odd window >= 1.
    """
    y = np.asarray(y, dtype=float)
    if window is None:
        return y
    window = int(max(1, window))
    # uniform_filter1d handles edges nicely
    return uniform_filter1d(y, size=window, mode="nearest")


def _is_nan(x) -> bool:
    try:
        return bool(np.isnan(x))
    except Exception:
        return False


# -----------------------------
# IEDF + smoothing modes
# -----------------------------

def iedf(
    I: np.ndarray,
    V: np.ndarray,
    pressure: float,
    *,
    SmoothFactordIdV: int = 50,
    smoothfunctionIV: SmoothMethod = "Recursive",
    smoothIVparam: Union[float, int, Sequence[int]] = np.nan,
    Mi: float,
    Te: float,
) -> Tuple[float, float, np.ndarray, np.ndarray, float, float, np.ndarray]:
    """
    Returns: Eavg, flux, dIdE, E, ni, Epeak, Ismooth
    """
    I = np.asarray(I, dtype=float).ravel()
    V = np.asarray(V, dtype=float).ravel()

    if smoothfunctionIV == "Recursive":
        Epeakex, Ismooth, Vex = smoothIV_SinglePeak(I[2:], V[2:], Epeak=np.nan, Epeak_temp=np.nan, Window=smoothIVparam)
        dIdE = np.diff(np.r_[np.finfo(float).eps, Ismooth]) / np.diff(np.r_[np.finfo(float).eps, Vex])
        dIdE = smooth_1d(dIdE[1:], SmoothFactordIdV)
        E = Vex[1:]
        Epeak = Epeakex

    elif smoothfunctionIV == "Mavg":
        w = 20 if _is_nan(smoothIVparam) else int(smoothIVparam)
        Ismooth = smooth_1d(I, w)
        dIdE = np.diff(np.r_[np.finfo(float).eps, Ismooth]) / np.diff(np.r_[np.finfo(float).eps, V])
        dIdE = smooth_1d(dIdE[1:], SmoothFactordIdV)
        E = V[1:]
        Epeak = float(E[np.nanargmax(dIdE)]) if dIdE.size else np.nan

    elif smoothfunctionIV == "SG":
        if _is_nan(smoothIVparam):
            polyorder, win = 1, 13
        else:
            polyorder, win = smoothIVparam  # expecting (polyorder, window_length)

        win = int(win)
        polyorder = int(polyorder)
        if win % 2 == 0:
            win += 1
        win = max(win, polyorder + 2 + (polyorder + 2) % 2)

        Ismooth = savgol_filter(I, window_length=win, polyorder=polyorder, mode="interp")
        dIdE = np.diff(np.r_[np.finfo(float).eps, Ismooth]) / np.diff(np.r_[np.finfo(float).eps, V])
        dIdE = smooth_1d(dIdE[1:], SmoothFactordIdV)
        E = V[1:]
        Epeak = float(E[np.nanargmax(dIdE)]) if dIdE.size else np.nan

    else:
        raise ValueError(f"Unknown smoothfunctionIV: {smoothfunctionIV!r}")

    # Ion flux calculation
    valid = (E > 0) & (dIdE > 0)
    S = np.trapezoid(dIdE[valid], E[valid]) if np.any(valid) else 0.0

    corr_fac = ion_flux_pressure_correction(pressure)
    flux = S * corr_fac

    # MATLAB: v_Bohm = sqrt(3/(40*1.66e-27));  (note: dimensionally odd, but kept as-is)
    v_Bohm = np.sqrt(Te / (Mi * 1.66e-27))
    ni = flux / (0.6 * v_Bohm) if v_Bohm != 0 else np.nan

    Eavg = (np.sum(E * dIdE) / np.sum(dIdE)) if np.sum(dIdE) != 0 else np.nan

    return float(Eavg), float(flux), dIdE, E, float(ni), float(Epeak), Ismooth


def smoothIV_SinglePeak(
    I: np.ndarray,
    V: np.ndarray,
    Epeak: float = np.nan,
    Epeak_temp: float = np.nan,
    Window: int = 10,
) -> Tuple[float, np.ndarray, np.ndarray]:
    """
    Recursive single-peak smoothing logic translated from MATLAB.

    Returns:
      Epeakex, Iex, Vex
    """
    I = np.asarray(I, dtype=float).ravel()
    V = np.asarray(V, dtype=float).ravel()
    x = int(Window)

    def _detect_peak_energy(dIdE: np.ndarray, Vx: np.ndarray) -> float:
        # MATLAB searches dIdE(10:end-100) over V(10:end-100)
        lo = 9
        hi = max(lo + 1, dIdE.size - 100)
        yy = dIdE[lo:hi]
        xx = Vx[lo:hi]
        if yy.size < 5:
            return float(Vx[np.nanargmax(dIdE)])

        prom = np.nanmax(yy)
        peaks, props = find_peaks(yy, prominence=prom)
        if peaks.size == 0:
            peaks, props = find_peaks(yy, prominence=0.7 * prom)

        if peaks.size == 0:
            return float(xx[np.nanargmax(yy)])

        # take the most prominent peak
        prominences = props.get("prominences", np.ones_like(peaks, dtype=float))
        best = int(peaks[np.argmax(prominences)])
        return float(xx[best])

    if _is_nan(Epeak):
        dIdE = np.diff(np.r_[np.finfo(float).eps, I]) / np.diff(np.r_[np.finfo(float).eps, V])
        dIdE = smooth_1d(dIdE, 100)
        Epeak_temp = _detect_peak_energy(dIdE, V)

        I1 = I[V < (Epeak_temp - x)]
        I2 = I[(V > (Epeak_temp - x)) & (V < (Epeak_temp + x))]
        I3 = I[V > (Epeak_temp + x)]

        I1s = smooth_1d(I1, 200)
        I3s = smooth_1d(I3, 200)
        Ismooth = np.r_[I1s, I2, I3s]

        return smoothIV_SinglePeak(Ismooth, V, Epeak=Epeak_temp, Epeak_temp=np.nan, Window=Window)

    # second stage: compare peaks
    if (not _is_nan(Epeak_temp)) and (abs(Epeak_temp - Epeak) < 0.1):
        return float(Epeak), I, V

    dIdE = np.diff(np.r_[np.finfo(float).eps, I]) / np.diff(np.r_[np.finfo(float).eps, V])
    dIdE = smooth_1d(dIdE, 100)
    Epeak_temp2 = _detect_peak_energy(dIdE, V)

    I1 = I[V < (Epeak_temp2 - x)]
    I2 = I[(V > (Epeak_temp2 - x)) & (V < (Epeak_temp2 + x))]
    I3 = I[V > (Epeak_temp2 + x)]

    I1s = smooth_1d(I1, 200)
    I3s = smooth_1d(I3, 200)
    Ismooth = np.r_[I1s, I2, I3s]

    return smoothIV_SinglePeak(Ismooth, V, Epeak=Epeak_temp2, Epeak_temp=Epeak, Window=Window)


# -----------------------------
# Physics helpers + plotting
# -----------------------------

def ion_flux_pressure_correction(pressure: float) -> float:
    fix_corr = 1.12e-3
    Ng = 3.25e22 * pressure * 0.0075
    IMF = 1.0 / (Ng * 8.8e-19)
    Pc = np.exp(-fix_corr / IMF)
    corr_fac = 6.374e5 / Pc
    return float(corr_fac)


def plotgraphIEDF(V, Iavg, Isth, E, dIdE):
    import numpy as np
    import matplotlib.pyplot as plt

    V = np.asarray(V).ravel()
    Iavg = np.asarray(Iavg).ravel()
    Isth = np.asarray(Isth).ravel()
    E = np.asarray(E).ravel()
    dIdE = np.asarray(dIdE).ravel()

    # --- Match lengths for IV curves ---
    n_iv = min(len(V), len(Iavg), len(Isth))
    Vp = V[:n_iv]
    Iavgp = Iavg[:n_iv]
    Isthp = Isth[:n_iv]

    fig, ax1 = plt.subplots()

    # ----- Left axis: I–V -----
    ax1.plot(Vp, Iavgp, color="black", linewidth=3, label="Current")
    ax1.plot(Vp, Isthp, color="green", linewidth=3, label="Smoothed")

    ax1.set_xlabel("Energy (eV)")
    ax1.set_ylabel("Current (A)", color="black")
    ax1.tick_params(axis="y", colors="black")

    ax1.spines["left"].set_color("black")
    ax1.spines["right"].set_color("red")
    ax1.spines["top"].set_color("black")
    ax1.spines["bottom"].set_color("black")

    ax1.grid(True)
    ax1.legend()
    ax1.set_title("I–V curve and IEDF")

    # ----- Right axis: IEDF -----
    ax2 = ax1.twinx()

    n_e = min(len(E), len(dIdE))
    Ep = E[:n_e]
    dIdEp = dIdE[:n_e]

    # MATLAB trims last 10 points
    if n_e > 10:
        Ep = Ep[:-10]
        dIdEp = dIdEp[:-10]

    ax2.plot(Ep, dIdEp, color="red", linewidth=3, label="IEDF")

    ax2.set_ylabel("IEDF (a.u.)", color="red")
    ax2.tick_params(axis="y", colors="red")
    ax2.spines["right"].set_color("red")

    ymax = np.nanmax(dIdEp) * 1.5 if np.isfinite(np.nanmax(dIdEp)) else 1.0
    ax2.set_ylim(0, ymax)

    plt.show()



def tau_ratio_NF(Mi: float, f_rf: float, Vp: float, ni: float, Te: float = 3.0, alpha: float = 3.0) -> float:
    e = 1.602e-19
    eps0 = 8.85e-12
    u = 1.61e-27

    Lde = np.sqrt(eps0 * Te / e / ni)
    s = alpha * Lde * (Vp / Te) ** (3 / 4)
    tau_i = 3 * s * np.sqrt((Mi * u) / 2 * e * Vp)
    tau_rf = 1.0 / f_rf
    return float(tau_i / tau_rf)
