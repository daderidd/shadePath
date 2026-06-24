#!/usr/bin/env python3
"""Step 11 — build the canopy vector tiles (PMTiles) from the EsriJSON pages.

Rebuilds cache/canopy.gpkg (with H_MEAN), converts to FlatGeobuf, then to a single
public/data/canopy.pmtiles via GDAL's PMTiles driver (tippecanoe not required).
Run after 03_fetch_canopy.py. H_MEAN drives the height-based two-tone styling.
"""
import glob
import os
import subprocess

from util import CACHE

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGES = sorted(glob.glob(os.path.join(CACHE, "canopy", "page_*.json")))
GPKG = os.path.join(CACHE, "canopy.gpkg")
FGB = os.path.join(CACHE, "canopy.fgb")
PMT = os.path.join(ROOT, "public", "data", "canopy.pmtiles")


def run(cmd):
    print("  $", cmd[0], *cmd[1:4], "…")
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    if not PAGES:
        raise SystemExit("no canopy pages — run 03_fetch_canopy.py first")
    for p in (GPKG, FGB, PMT):
        if os.path.exists(p):
            os.remove(p)
    print(f"building {GPKG} from {len(PAGES)} pages…")
    for i, p in enumerate(PAGES):
        run(["ogr2ogr"] + (["-append"] if i else []) + ["-f", "GPKG", GPKG, p, "-nln", "canopy"])
        if i % 15 == 0:
            print(f"    page {i}/{len(PAGES)}")
    print("-> FlatGeobuf…")
    run(["ogr2ogr", "-f", "FlatGeobuf", FGB, GPKG, "canopy"])
    print("-> PMTiles…")
    # round H_MEAN to integer metres (enough for two-tone styling, much smaller tiles)
    run(["ogr2ogr", "-f", "PMTiles", PMT, FGB, "-t_srs", "EPSG:4326", "-nln", "canopy",
         "-sql", "SELECT CAST(H_MEAN AS integer) AS H_MEAN FROM canopy",
         "-dsco", "MINZOOM=10", "-dsco", "MAXZOOM=15",
         "-dsco", "MAX_SIZE=3000000", "-dsco", "MAX_FEATURES=900000"])
    print(f"wrote {PMT} ({os.path.getsize(PMT)/1e6:.1f} MB)")


if __name__ == "__main__":
    main()
