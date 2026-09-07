# pipeline/ — data prep (run once, locally)

Turns raw open data into web-ready files under `data/processed/`. The app only
ever reads those outputs; none of this runs on the deployed site.

```
pip install -r pipeline/requirements.txt
```

## Order

**00_aoi.py** — the AOI bounding box. Single source of truth; edit here only.

**01_egms_notes.md** — how the EGMS tile was chosen (manual Explorer download).

**02_egms_prep.py** — EGMS Ortho CSV → points GeoJSON + time-series Parquet.
```
python pipeline/02_egms_prep.py \
  --input data/raw/egms/EGMS_L3_E46N19_100km_U_2020_2024_1.csv \
  --outdir data/processed --component U --min-coherence 0.7
```
Outputs: `data/processed/egms_points_U.geojson`, `egms_timeseries_U.parquet`.
Read the QA report it prints — see the checklist in the root README.

Don't pass `--min-coherence` for L3: the Ortho product has no `temporal_coherence`
column, so it filters nothing (the script now says so instead of skipping quietly).
The parquet is written in 2048-row row groups so the app can pull one point's
series without decoding the whole file.

**03_dem_prep.sh** — Copernicus GLO-30 → Terrarium-encoded terrain tiles.
```
bash pipeline/03_dem_prep.sh
```
Needs GDAL + `rio-rgbify`. Outputs `data/processed/dem/{z}/{x}/{y}.png` (z8–14).

Two encoding traps, both handled here — see the root README for the detail:
`rgbify` params must be `-b -32768 -i 0.00390625` for **Terrarium** (not the
Mapbox `-b -10000 -i 0.1`), and `_dem_fill_nodata.py` rewrites gdal2tiles'
transparent-black padding, which MapLibre would otherwise decode as −32768 m.

**04_osm_buildings.py** — OSM footprints (with height) → GeoJSON.
```
python pipeline/04_osm_buildings.py
```
Outputs `data/processed/buildings.geojson` (88,181 footprints).

Sends a real User-Agent — `overpass-api.de` answers the default `python-requests`
one with `406` — and retries with backoff across a mirror. Untagged footprints
under 40 m² are culled; buildings with a real `height`/`building:levels` tag are
kept at any size, and `height_source` records which is which.

## Validated vs. not
- `02_egms_prep.py` — validated end-to-end against a schema-accurate synthetic
  sample (see `sample_run/` and `_make_sample_egms.py`).
- `03` and `04` — now run end-to-end locally as well: DEM tiles verified by
  decoding tile pixels back against the source raster (sea reads exactly 0.00 m),
  buildings verified against the Overpass response.
