"""
_make_sample_egms.py  —  SYNTHETIC TEST DATA. NOT REAL EGMS MEASUREMENTS.

Generates CSVs matching the real EGMS Ortho (L3) schema column-for-column, so we
can validate 02_egms_prep.py end-to-end before real tiles are processed. Emits
BOTH components:

  U (vertical)   — a Campi Flegrei-style radial UPLIFT bullseye (+~90 mm/yr at the
                   Pozzuoli centre, decaying to ~0 by ~7 km, faint subsidence beyond).
  E (east-west)  — the horizontal signature of the SAME inflating source: ground
                   moves radially outward, so points EAST of centre go + (east) and
                   points WEST go - (west), passing through ~0 at the centre.
                   This is why the E component is NOT a bullseye.

DO NOT SHIP THESE as data.

Real EGMS Ortho header (confirmed):
  pid,mp_type,latitude,longitude,easting,northing,height,height_wgs84,line,pixel,
  rmse,temporal_coherence,amplitude_dispersion,incidence_angle,track_angle,
  los_east,los_north,los_up,mean_velocity,mean_velocity_std,acceleration,
  acceleration_std,seasonality,seasonality_std,<YYYYMMDD>,<YYYYMMDD>,...
"""
import importlib.util
import pathlib

import numpy as np
import pandas as pd
from pyproj import Transformer

_aoi = importlib.util.spec_from_file_location("aoi", pathlib.Path(__file__).with_name("00_aoi.py"))
aoi = importlib.util.module_from_spec(_aoi); _aoi.loader.exec_module(aoi)

RNG = np.random.default_rng(42)
N_POINTS = 6000
CENTER_LON, CENTER_LAT = aoi.CAMPI_FLEGREI_CENTER

# --- scatter points across (a little beyond) the AOI so clipping has work to do
minx, miny, maxx, maxy = aoi.AOI_BBOX
pad = 0.02
lon = RNG.uniform(minx - pad, maxx + pad, N_POINTS)
lat = RNG.uniform(miny - pad, maxy + pad, N_POINTS)

# geometry helpers
dx_km = (lon - CENTER_LON) * 111.0 * np.cos(np.radians(CENTER_LAT))
dy_km = (lat - CENTER_LAT) * 111.0
r_km = np.hypot(dx_km, dy_km)
r_safe = np.where(r_km < 1e-3, 1e-3, r_km)

to3035 = Transformer.from_crs("EPSG:4326", "EPSG:3035", always_xy=True)
easting, northing = to3035.transform(lon, lat)

# --- U: vertical uplift bullseye (mm/yr) --------------------------------------
vel_u = 90.0 * np.exp(-(r_km ** 2) / (2 * 3.0 ** 2))
vel_u = np.where(r_km > 7.0, -2.5, vel_u)
vel_u += RNG.normal(0, 2.0, N_POINTS)

# --- E: east-west component of radial horizontal motion (mm/yr) ---------------
# horizontal magnitude peaks at mid-radius then decays; projected onto the east
# axis via (dx/r). Sign flips E/W of centre, ~0 at centre.
horiz_mag = 40.0 * (r_km / 3.0) * np.exp(-(r_km ** 2) / (2 * 3.0 ** 2))
vel_e = horiz_mag * (dx_km / r_safe)
vel_e += RNG.normal(0, 1.5, N_POINTS)

# --- shared time axis ----------------------------------------------------------
dates = pd.date_range("2018-01-01", "2022-12-31", freq="12D")
years = (dates - dates[0]).days.to_numpy() / 365.25


def build(vel):
    ts = vel[:, None] * years[None, :] + RNG.normal(0, 3.0, (N_POINTS, len(dates)))
    date_cols = {d.strftime("%Y%m%d"): ts[:, i].round(2) for i, d in enumerate(dates)}
    return pd.DataFrame({
        "pid": [f"CFsynt_{i:06d}" for i in range(N_POINTS)],
        "mp_type": 2,
        "latitude": lat.round(6),
        "longitude": lon.round(6),
        "easting": np.round(easting, 3),
        "northing": np.round(northing, 3),
        "height": RNG.uniform(-2, 400, N_POINTS).round(2),
        "height_wgs84": RNG.uniform(40, 450, N_POINTS).round(2),
        "line": RNG.integers(0, 5000, N_POINTS),
        "pixel": RNG.integers(0, 5000, N_POINTS),
        "rmse": RNG.uniform(0.5, 4.0, N_POINTS).round(3),
        "temporal_coherence": RNG.uniform(0.65, 0.99, N_POINTS).round(3),
        "amplitude_dispersion": RNG.uniform(0.05, 0.4, N_POINTS).round(3),
        "incidence_angle": RNG.uniform(30, 45, N_POINTS).round(2),
        "track_angle": RNG.uniform(-15, -8, N_POINTS).round(2),
        "los_east": RNG.uniform(-0.7, 0.7, N_POINTS).round(4),
        "los_north": RNG.uniform(-0.2, 0.2, N_POINTS).round(4),
        "los_up": RNG.uniform(0.6, 0.95, N_POINTS).round(4),
        "mean_velocity": vel.round(2),
        "mean_velocity_std": RNG.uniform(0.3, 1.5, N_POINTS).round(3),
        "acceleration": RNG.normal(0, 2, N_POINTS).round(3),
        "acceleration_std": RNG.uniform(0.2, 1.0, N_POINTS).round(3),
        "seasonality": RNG.uniform(0, 3, N_POINTS).round(3),
        "seasonality_std": RNG.uniform(0.1, 0.8, N_POINTS).round(3),
        **date_cols,
    }), len(date_cols)


OUT = pathlib.Path(__file__).resolve().parents[1] / "data" / "raw" / "egms"
OUT.mkdir(parents=True, exist_ok=True)
for comp, vel in (("U", vel_u), ("E", vel_e)):
    df, n_dates = build(vel)
    path = OUT / f"EGMS_L3_E40N23_100km_{comp}_2018_2022_1_SYNTHETIC.csv"
    df.to_csv(path, index=False)
    print(f"wrote {path.name}  ({len(df):,} rows, {n_dates} date cols, "
          f"mean_velocity {df.mean_velocity.min():+.1f}..{df.mean_velocity.max():+.1f})")
