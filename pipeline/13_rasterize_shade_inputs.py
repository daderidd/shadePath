#!/usr/bin/env python3
"""Step 13 — rasterise height inputs for the shadow ray-march.

Two Float32 grids, both pixel-aligned to cache/canopy_5m.tif (same -te / -ts):
  - cache/buildings_5m.tif : building height (m) from CAD_BATIMENT_HORSOL.HAUTEUR
  - cache/canopy_h_5m.tif  : mean canopy height (m) from SIPV_ICA_MNC_2023.H_MEAN
Open / no-feature cells = 0 height. Mirror of 04_rasterize_canopy.py.
"""
import glob
import os
import subprocess

import rasterio

from util import CACHE

CANOPY_TIF = os.path.join(CACHE, "canopy_5m.tif")          # alignment reference
B_PAGES = sorted(glob.glob(os.path.join(CACHE, "buildings", "page_*.json")))
B_GPKG = os.path.join(CACHE, "buildings.gpkg")
B_TIF = os.path.join(CACHE, "buildings_5m.tif")
CANOPY_GPKG = os.path.join(CACHE, "canopy.gpkg")
CH_TIF = os.path.join(CACHE, "canopy_h_5m.tif")


def run(cmd):
    print("  $", " ".join(str(c) for c in cmd[:6]), "…" if len(cmd) > 6 else "")
    subprocess.run([str(c) for c in cmd], check=True, stdout=subprocess.DEVNULL)


def build_buildings_gpkg():
    if os.path.exists(B_GPKG):
        os.remove(B_GPKG)
    print(f"building {B_GPKG} from {len(B_PAGES)} pages…")
    for i, p in enumerate(B_PAGES):
        if i == 0:
            run(["ogr2ogr", "-f", "GPKG", B_GPKG, p, "-nln", "buildings"])
        else:
            run(["ogr2ogr", "-append", "-f", "GPKG", B_GPKG, p, "-nln", "buildings"])
        if i % 5 == 0:
            print(f"    appended page {i}/{len(B_PAGES)}")


def grid_ref():
    ds = rasterio.open(CANOPY_TIF)
    b = ds.bounds
    return (b.left, b.bottom, b.right, b.top), ds.width, ds.height


def rasterize(gpkg, layer, attr, out, te, w, h):
    if os.path.exists(out):
        os.remove(out)
    run([
        "gdal_rasterize", "-a", attr, "-ot", "Float32", "-init", "0",
        "-a_srs", "EPSG:2056",
        "-te", te[0], te[1], te[2], te[3], "-ts", w, h,
        "-co", "COMPRESS=DEFLATE", "-co", "TILED=YES",
        "-l", layer, gpkg, out,
    ])
    info = subprocess.run(["gdalinfo", "-stats", out], capture_output=True, text=True)
    for line in info.stdout.splitlines():
        if any(k in line for k in ("Size is", "Minimum=", "Pixel Size")):
            print("    " + line.strip())
    print(f"  wrote {out} ({os.path.getsize(out)/1e6:.1f} MB)")


def main():
    if not B_PAGES:
        raise SystemExit("no building pages — run 12_fetch_buildings.py first")
    if not os.path.exists(CANOPY_TIF):
        raise SystemExit("canopy_5m.tif missing — run 04_rasterize_canopy.py first")
    te, w, h = grid_ref()
    print(f"grid ref from canopy_5m.tif: {w}x{h}  te={[round(x) for x in te]}")
    build_buildings_gpkg()
    print("rasterising building heights (HAUTEUR)…")
    rasterize(B_GPKG, "buildings", "HAUTEUR", B_TIF, te, w, h)
    print("rasterising canopy heights (H_MEAN)…")
    rasterize(CANOPY_GPKG, "canopy", "H_MEAN", CH_TIF, te, w, h)
    print("done.")


if __name__ == "__main__":
    main()
