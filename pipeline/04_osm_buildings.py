#!/usr/bin/env python3
"""
04_osm_buildings.py — OSM building footprints (with height) for the AOI -> GeoJSON.

NOTE: not run in the build sandbox (Overpass isn't reachable there). Written to
run locally / in Claude Code.

Queries Overpass for buildings inside AOI_BBOX, derives a height in metres
(explicit `height`, else `building:levels` * 3 m, else a default), simplifies the
geometry, and writes data/processed/buildings.geojson for MapLibre fill-extrusion.

First pass handles `way` buildings (the vast majority). Multipolygon `relation`
buildings are skipped — revisit only if a landmark is visibly missing.

Requires: requests, geopandas, shapely  (see requirements.txt)
"""
import importlib.util
import pathlib
import sys
import time

import requests
import geopandas as gpd
from shapely.geometry import Polygon

spec = importlib.util.spec_from_file_location("aoi", pathlib.Path(__file__).with_name("00_aoi.py"))
aoi = importlib.util.module_from_spec(spec); spec.loader.exec_module(aoi)
minx, miny, maxx, maxy = aoi.AOI_BBOX

OVERPASS = "https://overpass-api.de/api/interpreter"
# Mirror used if the primary is busy/unavailable.
OVERPASS_MIRRORS = [OVERPASS, "https://overpass.kumi.systems/api/interpreter"]
# overpass-api.de returns 406 to the default python-requests User-Agent, so
# identify the project explicitly (also the polite thing to do).
HEADERS = {"User-Agent": "naples-hazard-visualizer/1.0 (EGMS+DEM+OSM static viz)"}
# Overpass bbox order is (south, west, north, east)
QUERY = f"""
[out:json][timeout:180];
( way["building"]({miny},{minx},{maxy},{maxx}); );
out geom;
"""

LEVEL_M = 3.0        # assumed metres per storey
DEFAULT_HEIGHT = 6.0 # fallback when no height/levels tag
MIN_HEIGHT = 3.0     # floor: a few OSM buildings are tagged height=0, which
                     # would extrude to nothing. Applies to tagged values only —
                     # it never inflates DEFAULT_HEIGHT.
MIN_AREA_M2 = 40.0   # drop sheds/garages/kiosks (~6.3 m square). They cost
                     # tessellation but add nothing at the zooms where the
                     # extrusion is visible. Buildings with a REAL height tag are
                     # never dropped, however small — those are the landmarks.


def to_height(tags):
    """Return (height_m, source) where source is 'tagged' or 'default'.

    'tagged' means the height came from OSM (height or building:levels);
    'default' means nothing was tagged and DEFAULT_HEIGHT was assumed. The app
    uses this flag to avoid presenting the assumed heights as real data.
    """
    h = tags.get("height")
    if h:
        try:
            return max(float(str(h).split()[0].replace(",", ".")), MIN_HEIGHT), "tagged"
        except ValueError:
            pass
    lv = tags.get("building:levels")
    if lv:
        try:
            return max(float(str(lv).split(";")[0]) * LEVEL_M, MIN_HEIGHT), "tagged"
        except ValueError:
            pass
    return DEFAULT_HEIGHT, "default"


def fetch_overpass(attempts=4):
    """POST the query, retrying on rate-limit/timeout and falling back to a mirror."""
    last = None
    for i in range(attempts):
        url = OVERPASS_MIRRORS[i % len(OVERPASS_MIRRORS)]
        try:
            print(f"querying Overpass ({url}) ...", file=sys.stderr)
            resp = requests.post(url, data={"data": QUERY},
                                 headers=HEADERS, timeout=300)
            if resp.status_code in (429, 502, 503, 504):
                raise requests.HTTPError(f"{resp.status_code} busy")
            resp.raise_for_status()
            return resp.json().get("elements", [])
        except Exception as exc:                      # noqa: BLE001 - retry any transport error
            last = exc
            wait = 15 * (i + 1)
            print(f"  attempt {i + 1} failed ({exc}); retrying in {wait}s",
                  file=sys.stderr)
            time.sleep(wait)
    raise SystemExit(f"ERROR: Overpass unreachable after {attempts} attempts: {last}")


def main():
    elements = fetch_overpass()

    feats = []
    for el in elements:
        if el.get("type") != "way":
            continue
        coords = [(p["lon"], p["lat"]) for p in el.get("geometry", [])]
        if len(coords) < 4:
            continue
        poly = Polygon(coords)
        if not poly.is_valid or poly.is_empty:
            poly = poly.buffer(0)
            if poly.is_empty:
                continue
        height, source = to_height(el.get("tags", {}))
        feats.append({"geometry": poly,
                      "height": round(height, 1),
                      "height_source": source})

    gdf = gpd.GeoDataFrame(feats, crs="EPSG:4326")
    gdf = aoi.clip_mask(gdf)

    # Cull tiny untagged footprints. Area is measured in EPSG:3035 (equal-area,
    # metres) — computing it on lon/lat degrees would be meaningless.
    before = len(gdf)
    area_m2 = gdf.to_crs("EPSG:3035").area
    gdf = gdf[(area_m2 >= MIN_AREA_M2) | (gdf["height_source"] == "tagged")]
    print(f"cull < {MIN_AREA_M2:.0f} m² (untagged only): {before:,} -> {len(gdf):,}")

    gdf["geometry"] = gdf.simplify(0.00002)   # ~2 m tolerance, trims vertices

    out = pathlib.Path("data/processed/buildings.geojson")
    out.parent.mkdir(parents=True, exist_ok=True)
    gdf.to_file(out, driver="GeoJSON")
    tagged = int((gdf.height_source == "tagged").sum())
    print(f"wrote {out}  ({len(gdf):,} buildings, "
          f"height min/med/max {gdf.height.min():.0f}/"
          f"{gdf.height.median():.0f}/{gdf.height.max():.0f} m)")
    print(f"  height_source: {tagged:,} tagged ({tagged / len(gdf) * 100:.1f}%), "
          f"{len(gdf) - tagged:,} default @ {DEFAULT_HEIGHT:.0f} m "
          f"— treat this layer as urban context, not height data")


if __name__ == "__main__":
    main()
