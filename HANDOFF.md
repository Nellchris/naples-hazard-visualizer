# Handoff — current state

The build described in the original handoff is **done**: real EGMS data prepped,
DEM terrain tiled, OSM buildings extruded, and the app built and deployable.
`README.md` is the reference; this file is just what a newcomer needs first.

## Where things stand
- **Pipeline** — all four steps run end-to-end locally against real sources.
  `data/processed/` (~132 MB) is committed so Pages can serve it.
- **App** — MapLibre + deck.gl, no build step. Light/Dark basemap, U/E component
  toggle, DEM terrain, zoom-gated buildings, click→time-series, and playback
  across the 303 acquisition dates.
- **Deploy** — `.github/workflows/deploy.yml` publishes the repo root on push to
  `main`. Site path is `/<repo>/app/`.

## Findings worth not rediscovering
1. **L3 Ortho has no `temporal_coherence`.** `--min-coherence` filters nothing;
   the script warns rather than skipping silently.
2. **`rio rgbify -b -10000 -i 0.1` is Mapbox encoding, not Terrarium.** Terrarium
   is `-b -32768 -i 0.00390625`. Get this wrong and elevations are ~10⁴ m out.
3. **gdal2tiles pads with transparent black**, which `raster-dem` decodes as
   −32768 m. `_dem_fill_nodata.py` fixes it; `03` runs it.
4. **Overpass 406s the default `python-requests` User-Agent.** Not a rate limit —
   retrying alone never helps.
5. **~98% of OSM buildings here have no height tag.** They render as a muted 6 m
   carpet on purpose; `height_source` marks the 1,663 that are real.
6. **deck.gl doesn't know about MapLibre's terrain exaggeration.** Point z is
   pre-multiplied by the same constant so the two stay locked.
7. **Don't drive playback with `requestAnimationFrame`.** It's suspended in
   hidden/background tabs and playback freezes with no error.

## Next steps, if wanted
- Time-series panel could show the E series alongside U for a clicked point.
- Buildings could gain a zoom-13 decimated tier if the 27 MB parse ever bites.
- Multipolygon relation buildings are still skipped (`04`), so a few landmarks
  with courtyards are missing.
