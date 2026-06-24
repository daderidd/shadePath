#!/usr/bin/env python3
"""Step 09a — sample a canton-wide PET grid for a smooth heat-field overlay.

ArcGIS's default raster symbology is an ugly dark stretch, so we bake our own.
Samples PET on a 50 m grid via batched identify (resumable cache), writes a
Float32 GeoTIFF (EPSG:2056, NoData -9999). Building/rail holes are left NoData
here and interpolated later by gdal_fillnodata.
"""
import json
import os
import time

import numpy as np
import rasterio
from rasterio.transform import from_origin

from util import CACHE, PET_IDENTIFY, http_post

CELLS = os.path.join(CACHE, "pet_grid_cells.json")
OUT = os.path.join(CACHE, "pet_grid_50m.tif")
# canton extent (LV95) — matches canopy_5m.tif
XMIN, YMIN, XMAX, YMAX = 2484925, 1108225, 2513925, 1136495
RES = 50.0
BATCH = 1400


def identify(cells):
    es = [c[0] for c in cells]; ns = [c[1] for c in cells]
    xmin, ymin, xmax, ymax = min(es) - 50, min(ns) - 50, max(es) + 50, max(ns) + 50
    w = max(50, min(4096, int((xmax - xmin) / 10)))
    h = max(50, min(4096, int((ymax - ymin) / 10)))
    params = {
        "f": "json",
        "geometry": json.dumps({"points": [[e, n] for e, n in cells],
                                "spatialReference": {"wkid": 2056}}),
        "geometryType": "esriGeometryMultipoint", "sr": 2056,
        "layers": "all:0", "tolerance": 0,
        "mapExtent": f"{xmin},{ymin},{xmax},{ymax}",
        "imageDisplay": f"{w},{h},96", "returnGeometry": "true",
    }
    res = json.loads(http_post(PET_IDENTIFY, params, timeout=120).decode())
    out = {}
    for it in res.get("results", []):
        g = it["geometry"]; v = it["attributes"].get("Stretch.Pixel Value")
        out[(round(g["x"]), round(g["y"]))] = None if v in (None, "NoData") else float(v)
    return out


def main():
    cols = int((XMAX - XMIN) / RES)
    rows = int((YMAX - YMIN) / RES)
    print(f"grid {cols}x{rows} = {cols*rows:,} cells @ {RES} m")

    centers = []  # (key, e, n, c, r)
    for r in range(rows):
        n = YMAX - (r + 0.5) * RES
        for c in range(cols):
            e = XMIN + (c + 0.5) * RES
            centers.append((f"{round(e)}_{round(n)}", round(e), round(n), c, r))

    cache = json.load(open(CELLS)) if os.path.exists(CELLS) else {}
    todo = [(e, n) for k, e, n, c, r in centers if k not in cache]
    print(f"to query: {len(todo):,} (cached {len(cache):,})")
    for i in range(0, len(todo), BATCH):
        chunk = todo[i:i + BATCH]
        res = identify(chunk)
        for (e, n) in chunk:
            v = res.get((e, n))
            cache[f"{e}_{n}"] = v
        if (i // BATCH) % 10 == 0:
            json.dump(cache, open(CELLS, "w"))
            print(f"  {i+len(chunk):,}/{len(todo):,}")
        time.sleep(0.15)
    json.dump(cache, open(CELLS, "w"))

    grid = np.full((rows, cols), -9999.0, dtype=np.float32)
    for k, e, n, c, r in centers:
        v = cache.get(k)
        if v is not None:
            grid[r, c] = v
    transform = from_origin(XMIN, YMAX, RES, RES)
    with rasterio.open(OUT, "w", driver="GTiff", height=rows, width=cols, count=1,
                       dtype="float32", crs="EPSG:2056", transform=transform,
                       nodata=-9999.0, compress="deflate") as dst:
        dst.write(grid, 1)
    valid = grid[grid > -9999]
    print(f"valid {valid.size:,}/{grid.size:,}  PET min/med/max = "
          f"{valid.min():.1f}/{np.median(valid):.1f}/{valid.max():.1f}")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
