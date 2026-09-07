#!/usr/bin/env python3
"""
_dem_fill_nodata.py — make gdal2tiles' transparent padding safe for MapLibre.

Called by 03_dem_prep.sh; not run on its own normally.

gdal2tiles writes RGBA tiles and pads everything outside the source raster with
transparent BLACK (rgba 0,0,0,0). MapLibre's raster-dem ignores the alpha channel
and decodes the RGB, and under Terrarium rgb(0,0,0) means

    0*256 + 0 + 0/256 - 32768  =  -32768 m

so every padded pixel becomes a 32 km deep pit. On a partly-covered tile that
renders as violent spikes and holes at the edge of the data. Coarse zooms are
almost entirely padding (z8 is ~99.9%), so zooming out wrecks the terrain.

Fix: rewrite fully-transparent pixels to the Terrarium encoding of 0 m —
rgb(128,0,0) — and make them opaque. Padding then reads as flat sea level, which
is both harmless and correct for the sea around this AOI.

Idempotent: tiles with no transparent pixels are left untouched.
"""
import pathlib
import sys

import numpy as np
from osgeo import gdal

gdal.UseExceptions()

# Terrarium encoding of 0 m: h = R*256 + G + B/256 - 32768  ->  R=128, G=0, B=0
ZERO_RGB = (128, 0, 0)


def fix_tile(path):
    """Rewrite one tile in place. Returns True if it needed changing."""
    ds = gdal.Open(str(path))
    if ds.RasterCount < 4:
        return False  # no alpha band, nothing to do

    arr = ds.ReadAsArray()
    width, height = ds.RasterXSize, ds.RasterYSize
    ds = None  # release the file, or CreateCopy can't overwrite it on Windows

    alpha = arr[3]
    mask = alpha == 0
    if not mask.any():
        return False

    arr[0][mask], arr[1][mask], arr[2][mask] = ZERO_RGB
    arr[3][mask] = 255

    driver = gdal.GetDriverByName("MEM")
    mem = driver.Create("", width, height, 4, gdal.GDT_Byte)
    for i in range(4):
        mem.GetRasterBand(i + 1).WriteArray(arr[i])

    png = gdal.GetDriverByName("PNG")
    png.CreateCopy(str(path), mem, strict=0)
    return True


def main():
    root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "data/processed/dem")
    tiles = sorted(root.rglob("*.png"))
    if not tiles:
        raise SystemExit(f"ERROR: no tiles under {root}")

    fixed = 0
    for i, t in enumerate(tiles, 1):
        if fix_tile(t):
            fixed += 1
        if i % 500 == 0:
            print(f"  {i:,}/{len(tiles):,} …", flush=True)

    print(f"nodata fill: {fixed:,} of {len(tiles):,} tiles had transparent "
          f"padding rewritten to 0 m (rgb 128,0,0)")


if __name__ == "__main__":
    main()
