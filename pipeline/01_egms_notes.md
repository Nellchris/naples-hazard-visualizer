# 01 — EGMS download notes (manual step)

EGMS data is pulled interactively from the **EGMS Explorer**, not by a script
(the portal requires selecting tiles on a map). These notes make the choice
reproducible.

## What we use
- **Product level:** Ortho (L3) — GNSS-calibrated, split into vertical (U) and
  east-west (E) components. Start with **U** (vertical); it's the legible
  uplift/subsidence signal. Add **E** later if we want horizontal motion.
- **Tile:** `E46N19` — the 100 km ETRS89-LAEA tile covering Naples / Campi Flegrei.
  Confirmed to fully contain AOI_BBOX (lon 14.05–14.30, lat 40.78–40.92):
  the tile spans lon 13.26–14.49, lat 40.10–41.05.
- **Release window:** whatever the current Explorer offers (we have `2020_2024`).
  Any window works — the prep script is agnostic to the number of date columns.

## Steps
1. Open EGMS Explorer (Copernicus Land Monitoring Service).
2. Pan to Naples; identify the tile (here `E46N19`).
3. Download **Ortho → Vertical (U)**. File name looks like
   `EGMS_L3_E46N19_100km_U_2020_2024_1.csv` (inside a `.zip`).
4. Unzip and place the CSV in `data/raw/egms/`.
5. Run `pipeline/02_egms_prep.py` (see pipeline/README.md).

## Schema reminder (Ortho CSV)
One row per measurement point. Key columns:
`pid, latitude, longitude, easting, northing, temporal_coherence,
mean_velocity, …, <YYYYMMDD time-series columns>`.
Coordinates are provided both as WGS84 (lat/lon) and ETRS89-LAEA (easting/
northing, EPSG:3035). The prep script prefers lon/lat and falls back to
reprojecting easting/northing.
