#!/usr/bin/env python3
"""Step 04 — rasterise canopy polygons to a 5 m binary shade grid (EPSG:2056).

Builds cache/canopy.gpkg from the EsriJSON pages (ogr2ogr), then gdal_rasterize
into cache/canopy_5m.tif over the canton bbox (1 = under canopy, 0 = open).
"""
import glob
import math
import os
import subprocess

from util import CACHE, wgs_to_lv95

PAGES = sorted(glob.glob(os.path.join(CACHE, "canopy", "page_*.json")))
GPKG = os.path.join(CACHE, "canopy.gpkg")
TIF = os.path.join(CACHE, "canopy_5m.tif")
RES = 5.0
# canton WGS bbox (+ small margin) -> LV95 extent
WGS_BBOX = (5.95, 46.12, 6.32, 46.37)  # lon_min, lat_min, lon_max, lat_max


def run(cmd):
    print("  $", " ".join(cmd[:6]), "…" if len(cmd) > 6 else "")
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL)


def build_gpkg():
    if os.path.exists(GPKG):
        os.remove(GPKG)
    print(f"building {GPKG} from {len(PAGES)} pages…")
    for i, p in enumerate(PAGES):
        if i == 0:
            run(["ogr2ogr", "-f", "GPKG", GPKG, p, "-nln", "canopy"])
        else:
            run(["ogr2ogr", "-append", "-f", "GPKG", GPKG, p, "-nln", "canopy"])
        if i % 10 == 0:
            print(f"    appended page {i}/{len(PAGES)}")


def te_lv95():
    lons = [WGS_BBOX[0], WGS_BBOX[2], WGS_BBOX[0], WGS_BBOX[2]]
    lats = [WGS_BBOX[1], WGS_BBOX[1], WGS_BBOX[3], WGS_BBOX[3]]
    es, ns = wgs_to_lv95(lons, lats)
    xmin = math.floor(min(es) / RES) * RES
    ymin = math.floor(min(ns) / RES) * RES
    xmax = math.ceil(max(es) / RES) * RES
    ymax = math.ceil(max(ns) / RES) * RES
    return xmin, ymin, xmax, ymax


def main():
    if not PAGES:
        raise SystemExit("no canopy pages — run 03_fetch_canopy.py first")
    build_gpkg()
    xmin, ymin, xmax, ymax = te_lv95()
    if os.path.exists(TIF):
        os.remove(TIF)
    print(f"rasterising at {RES} m over [{xmin:.0f},{ymin:.0f},{xmax:.0f},{ymax:.0f}]…")
    run([
        "gdal_rasterize", "-burn", "1", "-init", "0", "-ot", "Byte",
        "-a_srs", "EPSG:2056",
        "-te", str(xmin), str(ymin), str(xmax), str(ymax),
        "-tr", str(RES), str(RES),
        "-co", "COMPRESS=DEFLATE", "-co", "TILED=YES",
        "-l", "canopy", GPKG, TIF,
    ])
    # quick stats
    out = subprocess.run(["gdalinfo", "-stats", TIF], capture_output=True, text=True)
    for line in out.stdout.splitlines():
        if "Size is" in line or "Mean=" in line or "Pixel Size" in line:
            print("  " + line.strip())
    print(f"wrote {TIF} ({os.path.getsize(TIF)/1e6:.1f} MB)")


if __name__ == "__main__":
    main()
