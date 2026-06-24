#!/usr/bin/env python3
"""Step 10 — bake elegant PNG image-overlays from the raw rasters.

heat:   pet_grid_50m.tif -> fill holes -> warm RGBA ramp -> 3857 (smooth) -> heat.png
canopy: canopy_5m.tif    -> density (average) -> green RGBA ramp -> 3857 -> canopy.png
Writes public/data/{heat,canopy}.png + overlays.json (lng/lat corners for MapLibre
image sources). Single file each — no tiles, no runtime SITG calls.
"""
import json
import os
import subprocess

import rasterio
from rasterio.fill import fillnodata
from rasterio.warp import transform as warp_xy

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "pipeline", "cache")
DATA = os.path.join(ROOT, "public", "data")
os.makedirs(DATA, exist_ok=True)

HEAT_RAMP = """nv 0 0 0 0
24 46 110 180 45
30 40 150 165 70
34 150 205 120 95
37 250 205 80 125
40 242 130 45 155
43 214 48 49 180
48 150 22 70 195
"""
# canopy density 0..1 -> soft green with rising opacity
CANOPY_RAMP = """nv 0 0 0 0
0 0 0 0 0
0.04 95 175 95 35
0.25 60 150 75 110
0.6 42 132 58 165
1 30 112 48 195
"""


def run(cmd):
    print("  $", cmd[0], *(a for a in cmd[1:6]))
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def corners_lnglat(tif):
    with rasterio.open(tif) as ds:
        b = ds.bounds
    xs = [b.left, b.right, b.right, b.left]
    ys = [b.top, b.top, b.bottom, b.bottom]
    lon, lat = warp_xy(ds.crs, "EPSG:4326", xs, ys)
    return [[round(lo, 6), round(la, 6)] for lo, la in zip(lon, lat)]


def make_heat():
    src = os.path.join(CACHE, "pet_grid_50m.tif")
    filled = os.path.join(CACHE, "pet_filled.tif")
    rgba = os.path.join(CACHE, "heat_rgba.tif")
    merc = os.path.join(CACHE, "heat_3857.tif")
    ramp = os.path.join(CACHE, "heat_ramp.txt")
    open(ramp, "w").write(HEAT_RAMP)
    # interpolate over building/rail NoData holes (not the big France void)
    with rasterio.open(src) as ds:
        arr = ds.read(1); prof = ds.profile
        mask = (arr != ds.nodata).astype("uint8")
        arr = fillnodata(arr, mask=mask, max_search_distance=12.0, smoothing_iterations=0)
        prof.update(compress="deflate")
        with rasterio.open(filled, "w", **prof) as out:
            out.write(arr, 1)
    run(["gdaldem", "color-relief", "-alpha", filled, ramp, rgba])
    # coarse output is plenty for a smooth field (source is 50 m); keeps the PNG small.
    run(["gdalwarp", "-t_srs", "EPSG:3857", "-tr", "40", "40", "-r", "cubicspline",
         "-dstnodata", "0", "-overwrite", rgba, merc])
    run(["gdal_translate", "-of", "PNG", "-co", "ZLEVEL=9", merc, os.path.join(DATA, "heat.png")])
    return corners_lnglat(merc)


def make_canopy():
    src = os.path.join(CACHE, "canopy_5m.tif")
    dens = os.path.join(CACHE, "canopy_dens_3857.tif")
    rgba = os.path.join(CACHE, "canopy_rgba.tif")
    ramp = os.path.join(CACHE, "canopy_ramp.txt")
    open(ramp, "w").write(CANOPY_RAMP)
    # average-resample 5 m binary -> ~12 m fractional canopy density in 3857
    run(["gdalwarp", "-t_srs", "EPSG:3857", "-tr", "12", "12", "-r", "average",
         "-ot", "Float32", "-overwrite", src, dens])
    run(["gdaldem", "color-relief", "-alpha", dens, ramp, rgba])
    run(["gdal_translate", "-of", "PNG", rgba, os.path.join(DATA, "canopy.png")])
    return corners_lnglat(rgba)


def main():
    print("heat overlay…");   heat = make_heat()
    print("canopy overlay…"); canopy = make_canopy()
    json.dump({"heat": heat, "canopy": canopy}, open(os.path.join(DATA, "overlays.json"), "w"))
    for name in ("heat.png", "canopy.png"):
        p = os.path.join(DATA, name)
        print(f"  {name}: {os.path.getsize(p)/1e6:.2f} MB")
    print("wrote overlays.json", json.dumps({"heat": heat[:2], "canopy": canopy[:2]}))


if __name__ == "__main__":
    main()
