#!/usr/bin/env python3
"""Step 05 — sample mean PET (°C) per edge from the SITG raster MapServer.

Strategy (validated by the M1 spikes):
  * sample each edge every ~20 m along its geometry, snapped to the 10 m PET grid;
  * batch-identify unique cells (<=1200 / call, multipoint -> one value per point);
  * gap-fill NoData cells from nearest valid neighbour within ~20 m (buildings/rail);
  * per-edge meanPET = mean of resolved samples (NaN if entirely outside model).
Resumable: every queried cell is cached to cache/pet_cells.json.
"""
import json
import math
import os
import time

import numpy as np

from util import CACHE, PET_IDENTIFY, http_post, wgs_to_lv95

GRAPH = os.path.join(CACHE, "graph.pkl")
CELLS = os.path.join(CACHE, "pet_cells.json")
OUT = os.path.join(CACHE, "edge_pet.npy")

GRID = 10.0          # PET raster resolution (m)
STEP = 20.0          # sample spacing along edge (m)
BATCH = 1200         # points per identify call (< maxRecordCount 2000)
NEIGH = [(10, 0), (-10, 0), (0, 10), (0, -10),
         (10, 10), (-10, -10), (10, -10), (-10, 10),
         (20, 0), (-20, 0), (0, 20), (0, -20)]


def snap(e, n):
    return (round(e / GRID) * GRID, round(n / GRID) * GRID)


def edge_samples_lv95(geom_en):
    """Yield snapped (e,n) cells along an edge polyline (LV95)."""
    pts = []
    for (x0, y0), (x1, y1) in zip(geom_en, geom_en[1:]):
        d = math.hypot(x1 - x0, y1 - y0)
        steps = max(1, int(d / STEP))
        for i in range(steps):
            t = i / steps
            pts.append(snap(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))
    pts.append(snap(*geom_en[-1]))
    # dedup consecutive
    out = []
    for p in pts:
        if not out or out[-1] != p:
            out.append(p)
    return out


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
    raw = http_post(PET_IDENTIFY, params, timeout=120)
    res = json.loads(raw.decode())
    out = {}
    for it in res.get("results", []):
        g = it["geometry"]
        v = it["attributes"].get("Stretch.Pixel Value")
        out[snap(g["x"], g["y"])] = None if v in (None, "NoData") else float(v)
    return out


def query_cells(cells, cache):
    """Query every cell not already cached; update cache in place."""
    todo = sorted({c for c in cells if f"{c[0]:.0f}_{c[1]:.0f}" not in cache})
    print(f"  cells to query: {len(todo):,} (cached {len(cache):,})")
    for i in range(0, len(todo), BATCH):
        chunk = todo[i:i + BATCH]
        res = identify(chunk)
        for c in chunk:
            cache[f"{c[0]:.0f}_{c[1]:.0f}"] = res.get(c)  # None if NoData/missing
        if (i // BATCH) % 10 == 0:
            json.dump(cache, open(CELLS, "w"))
            print(f"    {i + len(chunk):,}/{len(todo):,}")
        time.sleep(0.2)
    json.dump(cache, open(CELLS, "w"))


def main():
    import pickle
    g = pickle.load(open(GRAPH, "rb"))
    edges = g["edges"]
    print(f"edges: {len(edges):,}")

    # project all geometry to LV95 once
    flat_lon, flat_lat, spans = [], [], []
    for e in edges:
        geom = e[5]
        spans.append((len(flat_lon), len(geom)))
        for lon, lat in geom:
            flat_lon.append(lon); flat_lat.append(lat)
    es, ns = wgs_to_lv95(flat_lon, flat_lat)

    # per-edge snapped sample cells
    edge_cells = []
    all_cells = set()
    for off, cnt in spans:
        geom_en = [(es[off + k], ns[off + k]) for k in range(cnt)]
        cells = edge_samples_lv95(geom_en)
        edge_cells.append(cells)
        all_cells.update(cells)
    print(f"unique sample cells: {len(all_cells):,}")

    cache = json.load(open(CELLS)) if os.path.exists(CELLS) else {}
    query_cells(all_cells, cache)

    # gap-fill: query neighbours of NoData cells that were sampled
    nodata = {c for c in all_cells if cache.get(f"{c[0]:.0f}_{c[1]:.0f}") is None}
    neigh = set()
    for (e, n) in nodata:
        for dx, dy in NEIGH:
            neigh.add((e + dx, n + dy))
    neigh -= all_cells
    if neigh:
        print(f"gap-fill: querying {len(neigh):,} neighbour cells for {len(nodata):,} NoData cells")
        query_cells(neigh, cache)

    def val(e, n):
        return cache.get(f"{e:.0f}_{n:.0f}")

    def resolve(e, n):
        v = val(e, n)
        if v is not None:
            return v
        for dx, dy in NEIGH:
            v = val(e + dx, n + dy)
            if v is not None:
                return v
        return None

    edge_pet = np.full(len(edges), np.nan, dtype=np.float32)
    undef = 0
    for ei, cells in enumerate(edge_cells):
        vals = [resolve(*c) for c in cells]
        vals = [v for v in vals if v is not None]
        if vals:
            edge_pet[ei] = sum(vals) / len(vals)
        else:
            undef += 1
    defined = np.isfinite(edge_pet)
    med = float(np.nanmedian(edge_pet))
    edge_pet[~defined] = med  # neutral fill for the rare out-of-model edge
    np.save(OUT, edge_pet)
    print(f"edges with PET: {defined.sum():,}/{len(edges):,}  undefined(border)={undef}")
    print(f"PET °C  min/median/mean/max = {np.nanmin(edge_pet[defined]):.1f}/"
          f"{med:.1f}/{edge_pet[defined].mean():.1f}/{np.nanmax(edge_pet[defined]):.1f}")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
