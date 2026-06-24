#!/usr/bin/env python3
"""Step 08 — pack the routing graph into a compact binary + meta.json.

Sections in graph.bin (little-endian, lengths derived from counts in meta.json):
  nodeX  i32[N], nodeY  i32[N]                 quantised lng/lat (×Q, rel origin)
  eu u32[E], ev u32[E]                         edge endpoints (node indices)
  eLenDm u16[E]                                edge length (decimetres)
  ePet  u8[E]                                  PET quantised over [petMin,petMax]
  eShade u8[E]                                 shade fraction ×255
  eFlagsF u8[E], eFlagsB u8[E]                 legality u->v / v->u (1 foot,2 bike,4 steps)
  csrOff u32[N+1], csrEdge u32[2E]             node -> incident edge ids
  geomOff u32[E+1], geomX i32[G], geomY i32[G] simplified intermediate points
"""
import os
import pickle

import numpy as np
from shapely.geometry import LineString

from util import CACHE

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "public", "data")
os.makedirs(DATA, exist_ok=True)

Q = 1_000_000          # lng/lat quant (~0.11 m)
SIMPLIFY_DEG = 4.5e-5  # ~5 m Douglas-Peucker for stored geometry
K_DEFAULT, W_HEAT, W_SHADE = 2.0, 0.6, 0.4


def main():
    g = pickle.load(open(os.path.join(CACHE, "graph.pkl"), "rb"))
    nodes = g["node_lonlat"]            # [N,2] lon,lat
    edges = g["edges"]
    pet = np.load(os.path.join(CACHE, "edge_pet.npy"))
    shade = np.load(os.path.join(CACHE, "edge_shade.npy"))
    N, E = len(nodes), len(edges)
    assert len(pet) == E and len(shade) == E
    print(f"N={N:,}  E={E:,}")

    originLng = float(nodes[:, 0].min())
    originLat = float(nodes[:, 1].min())
    nodeX = np.round((nodes[:, 0] - originLng) * Q).astype("<i4")
    nodeY = np.round((nodes[:, 1] - originLat) * Q).astype("<i4")
    bbox = [float(nodes[:, 0].min()), float(nodes[:, 1].min()),
            float(nodes[:, 0].max()), float(nodes[:, 1].max())]

    eu = np.empty(E, "<u4"); ev = np.empty(E, "<u4")
    eLenDm = np.empty(E, "<u2"); eFlagsF = np.empty(E, "u1"); eFlagsB = np.empty(E, "u1")
    geom_x_parts, geom_y_parts = [], []
    geomOff = np.zeros(E + 1, "<u4")

    for i, (u, v, length, ff, fb, geom) in enumerate(edges):
        eu[i] = u; ev[i] = v
        eLenDm[i] = min(65535, int(round(length * 10)))
        eFlagsF[i] = ff; eFlagsB[i] = fb
        # simplified INTERMEDIATE points only (endpoints reconstructed from nodes)
        if len(geom) > 2:
            ls = LineString(geom).simplify(SIMPLIFY_DEG, preserve_topology=False)
            pts = list(ls.coords)[1:-1]
        else:
            pts = []
        for lon, lat in pts:
            geom_x_parts.append(round((lon - originLng) * Q))
            geom_y_parts.append(round((lat - originLat) * Q))
        geomOff[i + 1] = geomOff[i] + len(pts)

    geomX = np.asarray(geom_x_parts, "<i4")
    geomY = np.asarray(geom_y_parts, "<i4")
    G = len(geomX)

    # CSR: node -> incident edge ids
    deg = np.zeros(N, np.int64)
    np.add.at(deg, eu.astype(np.int64), 1)
    np.add.at(deg, ev.astype(np.int64), 1)
    csrOff = np.zeros(N + 1, "<u4")
    csrOff[1:] = np.cumsum(deg)
    csrEdge = np.empty(int(csrOff[-1]), "<u4")
    cursor = csrOff[:-1].astype(np.int64).copy()
    for i in range(E):
        a, b = int(eu[i]), int(ev[i])
        csrEdge[cursor[a]] = i; cursor[a] += 1
        csrEdge[cursor[b]] = i; cursor[b] += 1

    # PET quantisation range + normalization band
    petMin, petMax = float(np.nanmin(pet)), float(np.nanmax(pet))
    ePet = np.clip(np.round((pet - petMin) / (petMax - petMin) * 255), 0, 255).astype("u1")
    eShade = np.clip(np.round(shade * 255), 0, 255).astype("u1")
    petLo = float(np.percentile(pet, 10))
    petHi = float(np.percentile(pet, 90))

    midLat = (bbox[1] + bbox[3]) / 2
    mPerLat = 111_320.0
    mPerLng = 111_320.0 * np.cos(np.radians(midLat))

    # write binary in section order
    out = os.path.join(DATA, "graph.bin")
    with open(out, "wb") as f:
        for arr in (nodeX, nodeY, eu, ev, eLenDm, ePet, eShade, eFlagsF, eFlagsB,
                    csrOff, csrEdge, geomOff, geomX, geomY):
            f.write(arr.tobytes())
    raw = os.path.getsize(out)

    meta = {
        "version": 1, "dataVersion": "PET2020-P0 / canopy2023 / OSM",
        "nodeCount": N, "edgeCount": E, "geomCount": G,
        "csrEdgeCount": int(csrOff[-1]),
        "origin": [originLng, originLat], "coordQuant": Q, "bbox": bbox,
        "petMin": petMin, "petMax": petMax, "petLo": petLo, "petHi": petHi,
        "K": K_DEFAULT, "wHeat": W_HEAT, "wShade": W_SHADE,
        "mPerLng": mPerLng, "mPerLat": mPerLat,
    }
    import json
    json.dump(meta, open(os.path.join(DATA, "meta.json"), "w"), indent=0)

    import gzip
    gz = len(gzip.compress(open(out, "rb").read(), 6))
    print(f"geom points (simplified): {G:,}")
    print(f"PET °C range [{petMin:.1f},{petMax:.1f}]  band lo/hi [{petLo:.1f},{petHi:.1f}]")
    print(f"graph.bin raw {raw/1e6:.2f} MB  -> gzip {gz/1e6:.2f} MB")
    print(f"wrote {out} + meta.json")


if __name__ == "__main__":
    main()
