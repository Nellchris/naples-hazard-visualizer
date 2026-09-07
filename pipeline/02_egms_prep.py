#!/usr/bin/env python3
"""
02_egms_prep.py — turn a raw EGMS Ortho CSV into web-ready files.

    raw EGMS Ortho CSV  ->  egms_points.geojson   (geometry + mean_velocity, light)
                        ->  egms_timeseries.parquet (per-point displacement series)

Works on the real EGMS Ortho (L3) vertical or E-W CSVs, and on the synthetic
sample from _make_sample_egms.py (same schema).

Design notes
------------
* Geometry: the Ortho CSV carries both WGS84 (latitude/longitude) and
  ETRS89-LAEA (easting/northing, EPSG:3035). We prefer lon/lat when present and
  fall back to reprojecting easting/northing from EPSG:3035 -> EPSG:4326.
* Time series: date columns are headed YYYYMMDD. We split them out into a
  Parquet keyed by pid so the map layer (points.geojson) stays small and fast;
  the series is fetched only when a point is clicked.

Usage
-----
    python 02_egms_prep.py --input data/raw/egms/<tile>.csv --outdir data/processed
    # optional: --min-coherence 0.7   --no-timeseries   --component U
"""
import argparse
import re
import pathlib
import importlib.util

import numpy as np
import pandas as pd
import geopandas as gpd

# -- load AOI (filename starts with a digit, so import by path) ----------------
_spec = importlib.util.spec_from_file_location(
    "aoi", pathlib.Path(__file__).with_name("00_aoi.py"))
aoi = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(aoi)

DATE_RE = re.compile(r"^\d{8}$")           # YYYYMMDD time-series column
LON_CANDS = ("longitude", "lon", "lng")
LAT_CANDS = ("latitude", "lat")
E_CANDS = ("easting", "east", "x")
N_CANDS = ("northing", "north", "y")


def _first_present(cols, candidates):
    lower = {c.lower(): c for c in cols}
    for cand in candidates:
        if cand in lower:
            return lower[cand]
    return None


def build_geometry(df):
    """Return a GeoDataFrame in EPSG:4326, from lon/lat if present else 3035."""
    lon_c = _first_present(df.columns, LON_CANDS)
    lat_c = _first_present(df.columns, LAT_CANDS)
    if lon_c and lat_c:
        geom = gpd.points_from_xy(df[lon_c], df[lat_c])
        return gpd.GeoDataFrame(df, geometry=geom, crs="EPSG:4326"), "lon/lat (WGS84)"

    e_c = _first_present(df.columns, E_CANDS)
    n_c = _first_present(df.columns, N_CANDS)
    if e_c and n_c:
        gdf = gpd.GeoDataFrame(
            df, geometry=gpd.points_from_xy(df[e_c], df[n_c]), crs="EPSG:3035")
        return gdf.to_crs("EPSG:4326"), "easting/northing (EPSG:3035 -> 4326)"

    raise SystemExit("ERROR: no lon/lat or easting/northing columns found. "
                     f"Columns seen: {list(df.columns)[:12]}...")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", required=True, help="raw EGMS Ortho CSV")
    ap.add_argument("--outdir", default="data/processed")
    ap.add_argument("--min-coherence", type=float, default=None,
                    help="drop points below this temporal_coherence (e.g. 0.7)")
    ap.add_argument("--no-timeseries", action="store_true",
                    help="skip writing the parquet time series")
    ap.add_argument("--component", default="U", choices=["U", "E"],
                    help="label only: U=vertical, E=east-west (for output names)")
    args = ap.parse_args()

    outdir = pathlib.Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    df = pd.read_csv(args.input)
    n_raw = len(df)
    date_cols = [c for c in df.columns if DATE_RE.match(str(c))]

    if "mean_velocity" not in df.columns:
        raise SystemExit("ERROR: 'mean_velocity' column missing — is this an EGMS CSV?")

    gdf, geom_src = build_geometry(df)

    # optional quality gate
    if args.min_coherence is not None:
        if "temporal_coherence" in gdf.columns:
            before = len(gdf)
            gdf = gdf[gdf["temporal_coherence"] >= args.min_coherence]
            print(f"coherence >= {args.min_coherence}: {before:,} -> {len(gdf):,}")
        else:
            print("WARNING: --min-coherence passed but no 'temporal_coherence' "
                  "column (L3 Ortho has none) — no filter applied.")

    # clip to AOI
    gdf = aoi.clip_mask(gdf)
    if gdf.empty:
        raise SystemExit("ERROR: no points fall inside AOI_BBOX — check the tile/bbox.")

    # --- light map layer ------------------------------------------------------
    keep = ["pid", "mean_velocity"]
    # height_ortho is the point's orthometric elevation (m). The app uses it as
    # the z in [lon, lat, z] so points sit on the DEM surface instead of at sea
    # level once terrain is enabled.
    if "height_ortho" in gdf.columns:
        keep.append("height_ortho")
    if "temporal_coherence" in gdf.columns:
        keep.append("temporal_coherence")
    points = gdf[keep + ["geometry"]].copy()
    pts_path = outdir / f"egms_points_{args.component}.geojson"
    points.to_file(pts_path, driver="GeoJSON")

    # --- heavy time series (optional) ----------------------------------------
    ts_path = None
    if date_cols and not args.no_timeseries:
        ts = gdf[["pid"] + date_cols].copy()
        ts_path = outdir / f"egms_timeseries_{args.component}.parquet"
        # Small row groups so the app can pull ONE point's series without
        # decoding the whole file: the browser reader skips every row group that
        # doesn't span the requested row. A single row group (the default here,
        # ~19k rows) would force a full decode on every click.
        ts.to_parquet(ts_path, index=False, row_group_size=2048)

    # --- QA report ------------------------------------------------------------
    v = points["mean_velocity"]
    bx = points.total_bounds
    print("\n--- EGMS prep QA -------------------------------------------------")
    print(f"input            : {args.input}")
    print(f"geometry source  : {geom_src}")
    print(f"points  raw->AOI : {n_raw:,} -> {len(points):,}")
    print(f"velocity mm/yr   : min {v.min():+.1f} | mean {v.mean():+.1f} | max {v.max():+.1f}")
    if "height_ortho" in points.columns:
        h = points["height_ortho"]
        print(f"height_ortho m   : min {h.min():.1f} | mean {h.mean():.1f} | max {h.max():.1f}")
    print(f"output bbox      : {bx[0]:.4f}, {bx[1]:.4f}, {bx[2]:.4f}, {bx[3]:.4f}")
    print(f"date columns     : {len(date_cols)}")
    print(f"wrote            : {pts_path}")
    if ts_path:
        print(f"wrote            : {ts_path}")
    print("------------------------------------------------------------------")


if __name__ == "__main__":
    main()
