#!/usr/bin/env python3
"""Step 06 — per-edge canopy shade fraction from the 5 m canopy raster.

For each edge, densify its geometry to ~5 m and count the fraction of sample
points that fall under canopy. Writes cache/edge_shade.npy (float32 [E] in [0,1]).
"""
import math
import os
import pickle

import numpy as np
import rasterio

from util import CACHE, wgs_to_lv95

GRAPH = os.path.join(CACHE, "graph.pkl")
TIF = os.path.join(CACHE, "canopy_5m.tif")
OUT = os.path.join(CACHE, "edge_shade.npy")
STEP = 5.0


def main():
    g = pickle.load(open(GRAPH, "rb"))
    edges = g["edges"]
    ds = rasterio.open(TIF)
    band = ds.read(1)
    H, W = band.shape
    inv = ~ds.transform  # world(E,N) -> (col,row) fractional
    print(f"canopy raster {W}x{H}, edges {len(edges):,}")

    # project all geometry to LV95 once
    flat_lon, flat_lat, spans = [], [], []
    for e in edges:
        geom = e[5]
        spans.append((len(flat_lon), len(geom)))
        for lon, lat in geom:
            flat_lon.append(lon); flat_lat.append(lat)
    es, ns = wgs_to_lv95(flat_lon, flat_lat)
    es = np.asarray(es); ns = np.asarray(ns)

    shade = np.zeros(len(edges), dtype=np.float32)
    for ei, (off, cnt) in enumerate(spans):
        xs, ys = es[off:off + cnt], ns[off:off + cnt]
        sx, sy = [], []
        for k in range(cnt - 1):
            x0, y0, x1, y1 = xs[k], ys[k], xs[k + 1], ys[k + 1]
            d = math.hypot(x1 - x0, y1 - y0)
            n = max(1, int(d / STEP))
            for i in range(n):
                t = i / n
                sx.append(x0 + (x1 - x0) * t); sy.append(y0 + (y1 - y0) * t)
        sx.append(xs[-1]); sy.append(ys[-1])
        # world -> pixel
        cols = inv.a * np.asarray(sx) + inv.b * np.asarray(sy) + inv.c
        rows = inv.d * np.asarray(sx) + inv.e * np.asarray(sy) + inv.f
        c = cols.astype(np.int64); r = rows.astype(np.int64)
        m = (c >= 0) & (c < W) & (r >= 0) & (r < H)
        if m.any():
            vals = band[r[m], c[m]]
            shade[ei] = float((vals == 1).mean())
    np.save(OUT, shade)
    print(f"shadeFrac  min/mean/max = {shade.min():.2f}/{shade.mean():.2f}/{shade.max():.2f}")
    print(f"edges >50% shaded: {(shade > 0.5).sum():,} ({100*(shade>0.5).mean():.0f}%)")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
