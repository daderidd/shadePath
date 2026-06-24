#!/usr/bin/env python3
"""Step 02 — build a routable graph from raw OSM.

Noding is exact because OSM ways share node IDs at junctions: a node used by >=2
ways (or a way endpoint) becomes a routing vertex; intermediate nodes become edge
geometry. Each edge stores per-direction legality (foot / bike, respecting oneway)
and true length in metres (computed in EPSG:2056).

Output cache/graph.pkl:
  node_lonlat : float64 [N,2]
  edges       : list of (u, v, length_m, flags_fwd, flags_bwd, geom_lonlat)
                flags bits -> 1=foot, 2=bike, 4=steps
"""
import math
import os
import pickle
from collections import Counter

import numpy as np

from util import CACHE, load_json, wgs_to_lv95

RAW = os.path.join(CACHE, "osm_raw.json")
OUT = os.path.join(CACHE, "graph.pkl")

F_FOOT, F_BIKE, F_STEPS = 1, 2, 4

FOOT_HW = {"footway", "path", "pedestrian", "steps", "living_street", "residential",
           "service", "unclassified", "track", "tertiary", "tertiary_link",
           "secondary", "secondary_link", "primary", "primary_link", "road",
           "cycleway", "corridor", "crossing"}
BIKE_HW = {"cycleway", "path", "track", "living_street", "residential", "service",
           "unclassified", "tertiary", "tertiary_link", "secondary",
           "secondary_link", "primary", "primary_link", "road", "bridleway"}
YES = {"yes", "designated", "permissive", "official"}
NO = {"no", "private"}


def classify(tags):
    """Return (foot, bike_fwd, bike_bwd, steps) booleans."""
    hw = tags.get("highway", "")
    foot_v = tags.get("foot", "")
    bic_v = tags.get("bicycle", "")
    access = tags.get("access", "")
    blocked = access in NO

    foot = ((hw in FOOT_HW and foot_v not in NO and not blocked) or foot_v in YES)
    steps = hw == "steps"

    bike = (hw in BIKE_HW) or bic_v in YES
    if hw in ("footway", "pedestrian") and bic_v not in YES:
        bike = False
    if hw == "steps":
        bike = False
    if bic_v in NO or bic_v == "dismount":
        bike = False
    if blocked and bic_v not in YES:
        bike = False

    bike_fwd = bike_bwd = bike
    oneway = tags.get("oneway", "")
    onb = tags.get("oneway:bicycle", "")
    cw = " ".join(tags.get(k, "") for k in ("cycleway", "cycleway:left",
                                            "cycleway:right", "cycleway:both"))
    if oneway in ("yes", "true", "1"):
        bike_bwd = False
    elif oneway in ("-1", "reverse"):
        bike_fwd = False
    if onb == "no" or "opposite" in cw:        # contraflow cycling allowed
        bike_fwd = bike_bwd = bike
    return foot, bike_fwd, bike_bwd, steps


def main():
    raw = load_json(RAW)
    ways = raw["ways"]
    nodes = {int(k): v for k, v in raw["nodes"].items()}
    print(f"loaded {len(ways):,} ways, {len(nodes):,} nodes")

    # --- find junctions (routing vertices) ---
    use = Counter()
    for w in ways:
        for nid in w["nodes"]:
            use[nid] += 1
        use[w["nodes"][0]] += 1
        use[w["nodes"][-1]] += 1
    junction = {nid for nid, c in use.items() if c >= 2}
    print(f"junctions: {len(junction):,}")

    # --- project all node coords to LV95 once (for lengths) ---
    ids = list(nodes.keys())
    lons = [nodes[i][0] for i in ids]
    lats = [nodes[i][1] for i in ids]
    es, ns = wgs_to_lv95(lons, lats)
    lv95 = {i: (es[k], ns[k]) for k, i in enumerate(ids)}

    # --- split ways into edges at junctions ---
    node_idx = {}          # osm id -> compact routing index
    node_lonlat = []

    def vid(osm_id):
        j = node_idx.get(osm_id)
        if j is None:
            j = len(node_lonlat)
            node_idx[osm_id] = j
            node_lonlat.append(nodes[osm_id])
        return j

    edges = []
    skipped = 0
    for w in ways:
        foot, bf, bb, steps = classify(w["tags"])
        if not (foot or bf or bb):
            continue
        flags_f = (F_FOOT if foot else 0) | (F_BIKE if bf else 0) | (F_STEPS if steps else 0)
        flags_b = (F_FOOT if foot else 0) | (F_BIKE if bb else 0) | (F_STEPS if steps else 0)
        nl = [n for n in w["nodes"] if n in nodes]
        if len(nl) < 2:
            skipped += 1
            continue
        start = 0
        for i in range(1, len(nl)):
            if nl[i] in junction or i == len(nl) - 1:
                sub = nl[start:i + 1]
                if len(sub) >= 2 and sub[0] != sub[-1]:
                    length = 0.0
                    for a, b in zip(sub, sub[1:]):
                        (ax, ay), (bx, by) = lv95[a], lv95[b]
                        length += math.hypot(bx - ax, by - ay)
                    if length > 0:
                        geom = [nodes[n] for n in sub]
                        edges.append((vid(sub[0]), vid(sub[-1]), length,
                                      flags_f, flags_b, geom))
                start = i

    node_lonlat = np.asarray(node_lonlat, dtype=np.float64)
    print(f"graph: nodes={len(node_lonlat):,}  edges={len(edges):,}  "
          f"(skipped {skipped} degenerate ways)")
    tot_km = sum(e[2] for e in edges) / 1000
    geom_pts = sum(len(e[5]) for e in edges)
    print(f"network length: {tot_km:,.0f} km   geometry points: {geom_pts:,}")

    with open(OUT, "wb") as f:
        pickle.dump({"node_lonlat": node_lonlat, "edges": edges}, f,
                    protocol=pickle.HIGHEST_PROTOCOL)
    print(f"wrote {OUT} ({os.path.getsize(OUT)/1e6:.1f} MB)")


if __name__ == "__main__":
    main()
