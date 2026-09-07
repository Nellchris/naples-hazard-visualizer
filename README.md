# Naples / Campi Flegrei — WebGL Urban Hazard & Terrain Visualizer

Interactive WebGL scene combining **ground-motion (EGMS InSAR)**, **terrain
(Copernicus DEM GLO-30)**, and **extruded OSM buildings** over the Naples /
Pozzuoli corridor. Entirely free/open-source data and tooling; deploys as a
static site to GitHub Pages.

The strongest signal in the AOI is the **Campi Flegrei bradyseism** — active
caldera uplift of up to ~+90 mm/yr around Pozzuoli.

## Structure
```
pipeline/   data prep (Python + GDAL), run once locally — see pipeline/README.md
data/
  raw/        downloaded source data (gitignored)
  processed/  web-ready outputs the app reads (committed)
app/        MapLibre GL JS + deck.gl client (built in the app phase)
  src/config.js   shared constants — AOI, data paths, color ramp
sample_run/ synthetic-sourced sample outputs for reference (NOT real data)
docs/       design reference (scaffold doc)
```

## Pipeline / app split
`pipeline/` produces files; `app/` consumes them. The live site has no Python or
GDAL dependency — it just fetches the processed GeoJSON / Parquet / tiles. This is
the load-bearing decision; keep it.

## Data status — all three sources built
| layer | source | output | size |
|---|---|---|---|
| Ground motion | EGMS Ortho L3, tile E46N19, 2020–2024, U + E | `egms_points_{U,E}.geojson` + `egms_timeseries_{U,E}.parquet` | 33 MB |
| Terrain | Copernicus DEM GLO-30, tile N40/E014 | `dem/{z}/{x}/{y}.png`, z8–14, 3,838 tiles | 71 MB |
| Buildings | OSM via Overpass | `buildings.geojson`, 88,181 footprints | 27 MB |

`data/processed/` totals ~132 MB. That is fine for GitHub Pages (no single file
is near the 100 MB limit) and `buildings.geojson` gzips 27 MB → 4 MB in transit.

## Running the pipeline
```
pip install -r pipeline/requirements.txt

# EGMS — once per component. Do NOT pass --min-coherence for L3 (see below).
python pipeline/02_egms_prep.py   --input data/raw/egms/EGMS_L3_E46N19_100km_U_2020_2024_1.csv   --outdir data/processed --component U
python pipeline/02_egms_prep.py   --input data/raw/egms/EGMS_L3_E46N19_100km_E_2020_2024_1.csv   --outdir data/processed --component E

bash pipeline/03_dem_prep.sh      # needs GDAL CLI + rio-rgbify
python pipeline/04_osm_buildings.py
```

### QA checklist — check these against the printed report (real data ≠ synthetic)
1. **points raw→AOI > 0.** If 0, the tile/AOI don't overlap (shouldn't happen —
   E46N19 is confirmed) or a column name differs. E46N19 covers lon 13.26–14.49,
   lat 40.10–41.05. Observed: **68,052 → 19,306** per component.
2. **velocity range — differs by component.**
   - **U (vertical):** a strong **positive** (uplift) cluster near Pozzuoli
     (~14.14, 40.83). Observed peak **+145.2 mm/yr** ~0.9 km from the centre,
     decaying monotonically outward. If the peak isn't clearly positive, the E
     file may have been passed as U.
   - **E (east-west):** **mean ~0** with a roughly **symmetric ± range** (radial
     expansion). Observed mean **+1.6**, range −59.1…+70.6, and the sign flips
     across the caldera (west −13.1 / east +24.8 within 6 km). A near-zero mean
     is correct here, not an error.
3. **point count after clip.** 19,306 per component — comfortably inside what raw
   GeoJSON handles. Past ~100k, switch to deck.gl binary attributes or PMTiles
   (docs/ scaffold §4.4).
4. **coherence gate — not applicable to L3.** The Ortho L3 product has **no
   `temporal_coherence` column** (it lives in the L2 products; L3 is already
   quality-screened and GNSS-calibrated). Passing `--min-coherence` now prints a
   warning and applies no filter. `rmse_ts` is the available quality proxy.

### Two traps this pipeline already works around
- **Terrarium ≠ `rgbify -b -10000 -i 0.1`.** rio-rgbify packs
  `value = base + (R·65536 + G·256 + B)·interval`, so those params are **Mapbox**
  Terrain-RGB. Terrarium needs `-b -32768 -i 0.00390625`. Mismatch renders as
  elevations ~10⁴ m out. `03_dem_prep.sh` and `demEncoding` in `app/src/config.js`
  must stay in step.
- **gdal2tiles pads with transparent black.** MapLibre's `raster-dem` ignores the
  alpha channel, and rgb(0,0,0) decodes to −32768 m — deep pits at every partly
  covered tile (99.9% of a z8 tile). `_dem_fill_nodata.py` rewrites that padding
  to encode 0 m; `03` runs it automatically.

## The app
`app/index.html` + ES modules in `app/src/`. No build step, no bundler — MapLibre
GL JS and deck.gl load as UMD globals from a CDN.

| file | role |
|---|---|
| `config.js` | AOI, colour ramps, zoom gates, animation constants — tune here |
| `map.js` | MapLibre init, terrain, buildings, overlay wiring, all UI handlers |
| `egms-layer.js` | point loading, colour ramp, deck.gl layer construction |
| `timeseries.js` | Parquet reader (hyparquet), per-point series + full matrix |
| `timeline.js` | playback controller for the 303 acquisition dates |

Things worth knowing before editing:
- **Point z is pre-multiplied by `TERRAIN.exaggeration`.** MapLibre scales terrain
  by it; deck.gl does not. Both sides read the one constant, so they stay locked.
- **Playback steps on `setTimeout`, not `requestAnimationFrame`.** rAF is
  suspended in background/hidden tabs, which freezes playback with no error.
  Advancing a date is a data step; deck.gl schedules its own repaint.
- **Assets carry `?v=N`.** Bump it in `index.html` *and* every import specifier in
  `app/src/` together — versioning only some paths would load a module twice under
  two URLs and split its state.
- **`[hidden] { display: none !important }`** is load-bearing: panels with an
  explicit `display` otherwise ignore the `hidden` attribute.

## Local preview
Serve the **repo root** (not `app/`) and open `/app/`, matching how
`deploy.yml` publishes:
```
python -m http.server 8765
# → http://127.0.0.1:8765/app/
```

## Deploy
Static, via `.github/workflows/deploy.yml` — it uploads the repo root, so the site
lives at `https://<user>.github.io/<repo>/app/`. Enable Pages with
**Settings → Pages → Source: GitHub Actions**. Processed data is committed so
Pages can serve it; `data/raw/` is gitignored and must stay that way.

## Attribution
- EGMS © European Union, Copernicus Land Monitoring Service / EEA.
- Copernicus WorldDEM-30 © DLR e.V. 2010–2014 and © Airbus DS GmbH 2014–2018,
  provided under COPERNICUS by the EU and ESA.
- Building data © OpenStreetMap contributors (ODbL).
