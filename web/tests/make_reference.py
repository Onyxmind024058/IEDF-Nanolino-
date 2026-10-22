"""Generate test CSVs and Python reference results for web/tests/compare.mjs.

Run from the repository root:
    python web/tests/make_reference.py web/tests/data
"""
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from Python_RFEA_Analysis_fcn import full_analysis  # noqa: E402

out = Path(sys.argv[1] if len(sys.argv) > 1 else "web/tests/data")
out.mkdir(parents=True, exist_ok=True)


def write_csv(path, V, traces, sep):
    lines = [f"Header{sep}x", f"x{sep}x", f"Electrode voltage{sep}150", f"x{sep}x", f"x{sep}x",
             f"Ion flux{sep}1e19", f"x{sep}x", f"V{sep}I{sep}dIdE"]
    for I in traces:
        lines += [f"{v:.6f}{sep}{i:.8e}{sep}0" for v, i in zip(V, I)]
        lines.append(f"NaN{sep}NaN{sep}0")
    path.write_text("\n".join(lines))


def sigmoid_step(V, E0, width, height):
    return height * (1 - 1 / (1 + np.exp(-(V - E0) / width)))


rng = np.random.default_rng(42)
cases = {}

V = np.linspace(0, 150, 900)
write_csv(out / "single_peak.csv", V,
          [sigmoid_step(V, 70, 3, 1e-6) + 3e-9 * rng.standard_normal(V.size) for _ in range(5)], ";")
cases["single_peak.csv"] = {}

V = np.linspace(-5, 120, 700)
write_csv(out / "bimodal_comma.csv", V,
          [sigmoid_step(V, 30, 2.5, 4e-7) + sigmoid_step(V, 85, 4, 6e-7) + 2e-9 * rng.standard_normal(V.size)
           for _ in range(3)], ",")
cases["bimodal_comma.csv"] = {}

PARAMS = [
    dict(name="recursive", smoothfunctionIV="Recursive", smoothIVparam=10),
    dict(name="mavg", smoothfunctionIV="Mavg", smoothIVparam=20),
    dict(name="sg", smoothfunctionIV="SG", smoothIVparam=(2, 15)),
    dict(name="manual", smoothfunctionIV="Manual",
         smoothIVparam={"ranges": [{"xmin": 0, "xmax": 40, "window": 25}, {"xmin": 90, "xmax": 140, "window": 40}]}),
    dict(name="mavg_shift", smoothfunctionIV="Mavg", smoothIVparam=15, voltage_shift=4.5, SmoothFactordIdV=30),
]

COMMON = dict(pressure=1.0, Mi=40.0, f_rf=13.56e6, Vp=20.0, Te=3.0, alpha=3.0,
              Flux_factor=6.374e5, collision_cross_section=8.8e-19)

ref = []
for csv in cases:
    for p in PARAMS:
        p = dict(p)
        name = p.pop("name")
        kw = dict(COMMON, SmoothFactordIdV=50, voltage_shift=0)
        kw.update(p)
        try:
            Eavg, flux, dIdE, E, ni, ev, ionf, Ismooth, Iavg, Epeak, tau, Vavg = full_analysis(
                str(out / csv), kw.pop("pressure"), False, **kw)
            res = dict(Eavg=Eavg, flux=flux, ni=ni, Epeak=Epeak, tauRatio=tau, electrodeVoltage=ev,
                       ionFlux=ionf, dIdE=list(map(float, dIdE)), E=list(map(float, E)),
                       Ismooth=list(map(float, Ismooth)), Iavg=list(map(float, Iavg)),
                       Vavg=list(map(float, Vavg)))
        except Exception as e:  # recorded so the JS port can be checked to fail too
            res = dict(error=f"{type(e).__name__}: {e}")
        ref.append(dict(csv=csv, case=name, params=dict(COMMON, **{k: v for k, v in kw.items()}), result=res))

(out / "reference.json").write_text(json.dumps(ref))
print(f"{len(ref)} reference cases written to {out}")
