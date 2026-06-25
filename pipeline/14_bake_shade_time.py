#!/usr/bin/env python3
"""Step 14 — bake per-edge SHADE per time bin (geometric sun-exposure).

For each time bin (date x hour, Geneva local), march a ray from each densified
edge sample toward the sun through two 5 m height grids:
  - buildings_5m.tif (opaque: blocks hard -> shade 1)
  - canopy_h_5m.tif  (partial: one tau=0.7 attenuation per contiguous crown run)
Per-edge value = mean SHADE over samples (1 = fully shaded, 0 = fully sunlit),
stored Uint8. Output: public/data/shade_time.bin (bin-major) + meta.json.shadeTime.

Mirrors 06_sample_shade.py's densify(5 m)+project(WGS84->LV95) machinery.
Usage:  python3 14_bake_shade_time.py [probe]   (probe = 1 date, stats only, no write)
"""
import json
import math
import os
import pickle
import sys
import time

import numpy as np
import rasterio

from util import CACHE, wgs_to_lv95
from sun import solar_position, geneva_utc

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "public", "data")
GRAPH = os.path.join(CACHE, "graph.pkl")
B_TIF = os.path.join(CACHE, "buildings_5m.tif")
CH_TIF = os.path.join(CACHE, "canopy_h_5m.tif")
OUT_BIN = os.path.join(DATA, "shade_time.bin")
META = os.path.join(DATA, "meta.json")

LAT, LON = 46.20, 6.14          # canton centroid (sun position reference)
STEP = 5.0                      # densify + raymarch step (m) == raster res
DMAX = 350.0                    # max shadow reach (m)  ~ Hmax / tan(10deg)
TAU = 0.7                       # crown transmissivity per contiguous canopy run
EL_MIN = 3.0                    # sun below this -> fully shaded (night/horizon)

# warm-season declination anchors (each serves its symmetric calendar date)
DATES = [(2026, 6, 21), (2026, 8, 5), (2026, 9, 23), (2026, 5, 5)]
HOURS = list(range(6, 22))      # 06:00 .. 21:00 local


def build_samples(edges):
    """Densify every edge to ~STEP m; return LV95 sample coords + per-sample edge id."""
    flat_lon, flat_lat, spans = [], [], []
    for e in edges:
        geom = e[5]
        spans.append((len(flat_lon), len(geom)))
        for lon, lat in geom:
            flat_lon.append(lon); flat_lat.append(lat)
    es, ns = wgs_to_lv95(flat_lon, flat_lat)
    es = np.asarray(es); ns = np.asarray(ns)
    sx, sy, sedge = [], [], []
    for ei, (off, cnt) in enumerate(spans):
        xs, ys = es[off:off + cnt], ns[off:off + cnt]
        for k in range(cnt - 1):
            x0, y0, x1, y1 = xs[k], ys[k], xs[k + 1], ys[k + 1]
            d = math.hypot(x1 - x0, y1 - y0)
            n = max(1, int(d / STEP))
            for i in range(n):
                t = i / n
                sx.append(x0 + (x1 - x0) * t); sy.append(y0 + (y1 - y0) * t); sedge.append(ei)
        sx.append(xs[-1]); sy.append(ys[-1]); sedge.append(ei)
    return (np.asarray(sx), np.asarray(sy), np.asarray(sedge, dtype=np.int64))


def bin_shade(sx, sy, sedge, n_edges, Hb, Hc, inv, W, H, hmax, az, el):
    """Per-edge mean SHADE (1 - sunlit) for one sun position."""
    if el <= EL_MIN:
        return np.full(n_edges, 255, dtype=np.uint8)   # fully shaded
    az_r = math.radians(az)
    dx, dy = math.sin(az_r), math.cos(az_r)            # LV95 ground vector toward the sun
    tan_el = math.tan(math.radians(el))
    npts = sx.shape[0]
    runs = np.zeros(npts, dtype=np.int16)
    prev_can = np.zeros(npts, dtype=bool)
    active = np.ones(npts, dtype=bool)                  # False once building-blocked
    nsteps = int(DMAX / STEP)
    for k in range(1, nsteps + 1):
        d = k * STEP
        zray = d * tan_el
        if zray > hmax:
            break                                      # no caster can be this tall
        px = sx + dx * d; py = sy + dy * d
        col = (inv.a * px + inv.b * py + inv.c).astype(np.int64)
        row = (inv.d * px + inv.e * py + inv.f).astype(np.int64)
        inb = active & (col >= 0) & (col < W) & (row >= 0) & (row < H)
        if not inb.any():
            break
        rr, cc = row[inb], col[inb]
        hb = Hb[rr, cc]; hc = Hc[rr, cc]
        idx = np.where(inb)[0]
        blocked = hb >= zray
        active[idx[blocked]] = False
        can = (~blocked) & (hc >= zray)
        newrun = idx[can & (~prev_can[idx])]
        runs[newrun] += 1
        pc = np.zeros(npts, dtype=bool); pc[idx[can]] = True
        prev_can = pc
    sunlit = (TAU ** runs.astype(np.float32))          # 1 if no crown runs
    sunlit[~active] = 0.0                               # building shadow
    shade = 1.0 - sunlit
    sums = np.bincount(sedge, weights=shade, minlength=n_edges)
    cnts = np.bincount(sedge, minlength=n_edges)
    mean = np.where(cnts > 0, sums / np.maximum(cnts, 1), 0.0)
    return np.clip(np.round(mean * 255), 0, 255).astype(np.uint8)


def main():
    probe = len(sys.argv) > 1 and sys.argv[1] == "probe"
    dates = DATES[:1] if probe else DATES
    g = pickle.load(open(GRAPH, "rb"))
    edges = g["edges"]; E = len(edges)
    db = rasterio.open(B_TIF); Hb = db.read(1); inv = ~db.transform; H, W = Hb.shape
    Hc = rasterio.open(CH_TIF).read(1)
    hmax = float(max(Hb.max(), Hc.max()))
    print(f"edges {E:,}  raster {W}x{H}  hmax {hmax:.0f} m  | building+canopy ray-march")
    t0 = time.time()
    sx, sy, sedge = build_samples(edges)
    print(f"samples {sx.shape[0]:,}  (built in {time.time()-t0:.1f}s)")

    decl = []
    for (y, m, d) in dates:
        _, _, dc = solar_position(geneva_utc(y, m, d, 12), LAT, LON)
        decl.append(round(dc, 3))
    bins, sun = [], []
    for (y, m, d) in dates:
        for h in HOURS:
            az, el, _ = solar_position(geneva_utc(y, m, d, h), LAT, LON)
            bins.append((az, el)); sun.append([round(az, 1), round(el, 1)])

    cols = []
    for bi, (az, el) in enumerate(bins):
        tb = time.time()
        col = bin_shade(sx, sy, sedge, E, Hb, Hc, inv, W, H, hmax, az, el)
        cols.append(col)
        di, hi = bi // len(HOURS), bi % len(HOURS)
        print(f"  bin {bi:2d}  {dates[di]} {HOURS[hi]:02d}h  az{az:5.0f} el{el:4.0f}  "
              f"meanShade {col.mean()/255:.2f}  ({time.time()-tb:.1f}s)")

    arr = np.stack(cols)  # [bins, E] bin-major
    if probe:
        print("\n[probe] per-hour mean shade (date 0):")
        for hi, h in enumerate(HOURS):
            print(f"   {h:02d}h  {cols[hi].mean()/255:.3f}")
        print(f"[probe] static canopy mean (eShade) for comparison: "
              f"{np.load(os.path.join(CACHE,'edge_shade.npy')).mean():.3f}")
        print("[probe] no files written.")
        return

    os.makedirs(DATA, exist_ok=True)
    arr.astype(np.uint8).tofile(OUT_BIN)
    meta = json.load(open(META))
    meta["shadeTime"] = {
        "binFile": "data/shade_time.bin",
        "edgeCount": E,
        "layout": "bin-major-u8",
        "tau": TAU,
        "dates": [f"{y:04d}-{m:02d}-{d:02d}" for (y, m, d) in dates],
        "decl": decl,
        "hours": HOURS,
        "tz": "Europe/Zurich",
        "sun": sun,
    }
    json.dump(meta, open(META, "w"), separators=(",", ":"))
    print(f"\nwrote {OUT_BIN} ({os.path.getsize(OUT_BIN)/1e6:.2f} MB, {arr.shape[0]} bins x {E} edges)")
    print(f"updated {META} with shadeTime block ({len(bins)} bins)")
    print(f"total {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
