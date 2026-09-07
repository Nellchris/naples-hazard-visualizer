# WebGL Multi-Scale Urban Hazard & Terrain Visualizer
## Scaffold & Data-Prep Sketch — Naples / Campi Flegrei (Tyrrhenian coast)

---

## 1. Shape of the project

A **static, client-side WebGL app** (GitHub Pages–deployable) that renders three layers over the Naples / Pozzuoli urban corridor:

- **Ground motion** — EGMS InSAR displacement points (vertical + E-W), colored/extruded by velocity
- **Terrain** — Copernicus DEM GLO-30, as 3D relief
- **Buildings** — OSM footprints, extruded by height

Two halves, kept cleanly separate:
- `pipeline/` — runs **once, locally** (Python + GDAL). Downloads raw data, reprojects, clips, exports web-ready files.
- `app/` — the browser app (MapLibre GL JS + deck.gl). Only ever reads the processed outputs.

The pipeline is not deployed; only its outputs are. This keeps the live site free of any processing dependency, same principle as the Lisbon build.

---

## 2. Repo structure

```
naples-hazard-visualizer/
├── README.md
├── .gitignore                     # data/raw/ and node_modules/ ignored
│
├── pipeline/
│   ├── requirements.txt           # geopandas, pyproj, rasterio, rio-rgbify, requests
│   ├── 00_aoi.py                  # single source of truth for the bounding box
│   ├── 01_egms_notes.md           # how to pull the right tiles from EGMS Explorer
│   ├── 02_egms_prep.py            # EPSG:3035 → 4326, clip, → GeoJSON  ← detailed in §4
│   ├── 03_dem_prep.sh             # DEM mosaic → terrain-RGB tiles
│   ├── 04_osm_buildings.py        # Overpass query → simplified GeoJSON
│   └── README.md
│
├── data/
│   ├── raw/                       # downloaded tiles (gitignored — large)
│   │   ├── egms/
│   │   ├── dem/
│   │   └── osm/
│   └── processed/                 # committed or shipped via GitHub Release
│       ├── egms_points.geojson    # geometry + mean_velocity (light)
│       ├── egms_timeseries.parquet# per-point displacement series, keyed by pid
│       ├── buildings.geojson
│       └── dem/                   # terrain-RGB raster tiles (or a .pmtiles)
│
├── app/
│   ├── index.html
│   ├── src/
│   │   ├── config.js              # AOI bbox, color ramps, tile URLs, constants
│   │   ├── map.js                 # MapLibre init, DEM terrain, building extrusion
│   │   ├── egms-layer.js          # deck.gl overlay for the EGMS points
│   │   ├── timeseries.js          # click a point → plot its displacement series
│   │   └── ui.js                  # legend, layer toggles, camera presets
│   └── style/
│       └── app.css
│
└── .github/workflows/
    └── deploy.yml                 # build (if any) + publish app/ to GitHub Pages
```

---

## 3. Study area (starting bounding box)

Centered on the **Pozzuoli / Campi Flegrei caldera through central Naples** — the densest, strongest ground-motion signal in the region, not the Amalfi cliffs (which have sparse InSAR coverage on vegetated slopes).

```
AOI bbox (lon/lat, EPSG:4326):
  minx = 14.05   miny = 40.78
  maxx = 14.30   maxy = 40.92
```

Defined once in `pipeline/00_aoi.py` and again in `app/src/config.js` — every step clips to this, so nothing downstream ever handles the full continental tile.

---

## 4. The EGMS step: tile → reproject → GeoJSON

This is the piece you asked to detail. Four moves.

### 4.1 Pick the product level
Use **Ortho** (L3). It's GNSS-calibrated and gives **vertical (up/down)** and **East-West** displacement as separate files — exactly the components you want for a subsidence/uplift map. (Basic is line-of-sight only and referenced to a local point; less intuitive to color.)

### 4.2 Get the tiles (EGMS Explorer)
1. Open EGMS Explorer, pan to the AOI.
2. Draw/enter the bbox, note which **100 km tile(s)** cover it.
3. Download the **Ortho — vertical** and **Ortho — E-W** CSVs for those tiles into `data/raw/egms/`.

Each CSV is **one row per measurement point**, roughly 100 m spacing. Columns (names vary by release — check the header on download) are along the lines of:
- an identifier (`pid`)
- coordinates in **ETRS89-LAEA, EPSG:3035** (easting/northing)
- `mean_velocity`, `mean_velocity_std`, and quality/coherence fields
- one column **per SAR acquisition date** — that's the displacement time series

### 4.3 Reproject + clip (`02_egms_prep.py`)
The one CRS gotcha: EGMS is **EPSG:3035**, the web wants **EPSG:4326**. Representative sketch:

```python
import pandas as pd
import geopandas as gpd

# --- load Ortho vertical (repeat for E-W, or merge on pid) ---
df = pd.read_csv("data/raw/egms/egms_ortho_vertical_<tile>.csv")

# --- build geometry from LAEA easting/northing, then reproject ---
gdf = gpd.GeoDataFrame(
    df,
    geometry=gpd.points_from_xy(df["easting"], df["northing"]),
    crs="EPSG:3035",
).to_crs("EPSG:4326")

# --- clip to AOI ---
minx, miny, maxx, maxy = 14.05, 40.78, 14.30, 40.92
gdf = gdf.cx[minx:maxx, miny:maxy]

# --- split light geometry from heavy time series ---
date_cols = [c for c in gdf.columns if c.startswith("2")]   # per-date columns
gdf[["pid", "mean_velocity", "geometry"]].to_file(
    "data/processed/egms_points.geojson", driver="GeoJSON"
)
gdf[["pid"] + date_cols].to_parquet(
    "data/processed/egms_timeseries.parquet"
)   # loaded lazily when a point is clicked
```

Column names (`easting`, `northing`, `pid`, `mean_velocity`) are **indicative** — align them to the actual header.

### 4.4 Why the split
A dense urban tile can hold hundreds of thousands of points; the full time series inflates the file badly. Keeping the map layer to `geometry + mean_velocity` keeps `egms_points.geojson` small enough to render instantly, while the per-date series sits in Parquet and is fetched only when the user clicks a point for the time-series panel. If the point count still bites at full AOI, the next step up is deck.gl binary attributes or a PMTiles conversion — leave that until it's a real problem.

---

## 5. DEM + OSM prep (brief — same pattern)

**DEM (`03_dem_prep.sh`)** — Copernicus DEM GLO-30 tiles for the AOI from the public AWS S3 bucket, then mosaic → reproject → RGB-encode for MapLibre terrain:

```bash
gdalbuildvrt dem.vrt data/raw/dem/*.tif
gdalwarp -t_srs EPSG:3857 dem.vrt dem_3857.tif
rio rgbify -b -10000 -i 0.1 dem_3857.tif dem_terrarium.tif   # Terrarium encoding
gdal2tiles.py --xyz dem_terrarium.tif data/processed/dem/
```
⚠️ The encoding (`Terrarium` vs `Mapbox`) **must match** the `encoding` you set on MapLibre's `raster-dem` source, or elevations come out silently wrong.

**OSM buildings (`04_osm_buildings.py`)** — Overpass query for `building` with `height` / `building:levels` inside the bbox → GeoJSON → geometry-simplify (mapshaper or `gdf.simplify`) before shipping. Same tight-bbox scoping you used in Lisbon.

---

## 6. How the app wires it (for the main-work phase)

- **`map.js`** — MapLibre map; add the `raster-dem` source + `setTerrain({exaggeration})`; add OSM `fill-extrusion` layer keyed on height.
- **`egms-layer.js`** — `MapboxOverlay({interleaved: true})` so deck.gl points occlude correctly against terrain/buildings; a `ColumnLayer` (or `ScatterplotLayer` to start) reading `egms_points.geojson`, colored by a **diverging ramp** (subsidence − → 0 → uplift +).
- **`timeseries.js`** — on point click, look up `pid` in the Parquet series, plot displacement over time.
- **`ui.js`** — legend, layer toggles, a couple of camera presets (e.g. "Campi Flegrei bullseye").

---

## 7. Suggested first slice (before any 3D)

1. Pull **one EGMS Ortho-vertical tile** over Pozzuoli.
2. Run `02_egms_prep.py` → `egms_points.geojson`.
3. Drop a deck.gl `ColumnLayer` colored by `mean_velocity` on a **flat** MapLibre base — no terrain, no buildings yet.

That puts the "hardest" dataset on screen and proves the whole download → reproject → clip → render pipeline end to end. Terrain and buildings are additive once that spine works.
