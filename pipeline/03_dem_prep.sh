#!/usr/bin/env bash
# 03_dem_prep.sh — Copernicus DEM GLO-30 -> MapLibre terrain-RGB tiles for the AOI.
#
# NOTE: not run in the build sandbox (no S3/GDAL there). Written against the
# confirmed AWS Open Data layout; run locally where GDAL is installed.
#
# Requires:
#   - awscli            (or curl fallback)
#   - GDAL              gdalbuildvrt, gdalwarp, gdal2tiles.py
#   - rio-rgbify        pip install rio-rgbify
#
# Source: AWS Open Data bucket s3://copernicus-dem-30m/  (no AWS account needed).
# Tile naming (1x1 deg): Copernicus_DSM_COG_10_N<lat>_00_E<lon>_00_DEM/<same>.tif
set -euo pipefail
cd "$(dirname "$0")/.."

RAW=data/raw/dem
OUT=data/processed/dem
mkdir -p "$RAW" "$OUT"

# --- 1x1-deg DEM tiles covering the AOI (derived from pipeline/00_aoi.py) -----
TILES=$(python - <<'PY'
import importlib.util, pathlib, math
s = importlib.util.spec_from_file_location("aoi", pathlib.Path("pipeline/00_aoi.py"))
a = importlib.util.module_from_spec(s); s.loader.exec_module(a)
minx, miny, maxx, maxy = a.AOI_BBOX
for lat in range(math.floor(miny), math.floor(maxy) + 1):
    for lon in range(math.floor(minx), math.floor(maxx) + 1):
        ns = "N" if lat >= 0 else "S"; ew = "E" if lon >= 0 else "W"
        print(f"Copernicus_DSM_COG_10_{ns}{abs(lat):02d}_00_{ew}{abs(lon):03d}_00_DEM")
PY
)

# --- download each tile COG (anonymous) ---------------------------------------
for t in $TILES; do
  f="$RAW/$t.tif"
  if [ ! -f "$f" ]; then
    echo "fetching $t"
    aws s3 cp --no-sign-request "s3://copernicus-dem-30m/$t/$t.tif" "$f" \
      || curl -fsSL "https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/$t/$t.tif" -o "$f"
  fi
done

# --- mosaic -> web mercator -> Terrarium RGB -> XYZ tiles ----------------------
gdalbuildvrt "$RAW/dem.vrt" "$RAW"/Copernicus_*.tif
gdalwarp -t_srs EPSG:3857 -r bilinear "$RAW/dem.vrt" "$RAW/dem_3857.tif"
# Terrarium encoding: height = R*256 + G + B/256 - 32768
# rio-rgbify packs value = base + (R*65536 + G*256 + B) * interval, so terrarium
# is base=-32768, interval=1/256. (-b -10000 -i 0.1 would be MAPBOX Terrain-RGB,
# NOT terrarium — keep these matched to demEncoding in app/src/config.js.)
rio rgbify -b -32768 -i 0.00390625 "$RAW/dem_3857.tif" "$RAW/dem_terrarium.tif"
gdal2tiles.py --xyz -z 8-14 -w none "$RAW/dem_terrarium.tif" "$OUT"

# gdal2tiles pads partly-covered tiles with TRANSPARENT BLACK. MapLibre's
# raster-dem ignores alpha, and rgb(0,0,0) decodes to -32768 m under Terrarium,
# so that padding renders as deep pits / spikes. Rewrite it to encode 0 m.
python pipeline/_dem_fill_nodata.py "$OUT"

echo "done -> $OUT"
echo "In MapLibre, add a raster-dem source with encoding: 'terrarium'"
echo "(must match the rgbify -b -32768 -i 0.00390625 params above)."
