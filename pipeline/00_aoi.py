"""
00_aoi.py — single source of truth for the study area.

Every pipeline step imports AOI_BBOX from here so the app and the data
can never drift out of sync. Mirror these exact numbers in app/src/config.js.

Area: Pozzuoli / Campi Flegrei caldera through central Naples.
This is where EGMS point density and the ground-motion signal are both
strongest — not the Amalfi cliffs, which have sparse InSAR coverage.
"""

# (min_lon, min_lat, max_lon, max_lat) in EPSG:4326
AOI_BBOX = (14.05, 40.78, 14.30, 40.92)

# Approx. centre of the Campi Flegrei uplift bullseye (Pozzuoli), for camera presets.
CAMPI_FLEGREI_CENTER = (14.139, 40.827)


def clip_mask(gdf):
    """Return gdf clipped to AOI_BBOX (expects EPSG:4326 geometry)."""
    minx, miny, maxx, maxy = AOI_BBOX
    return gdf.cx[minx:maxx, miny:maxy]
