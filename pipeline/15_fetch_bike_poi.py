#!/usr/bin/env python3
"""Step 15 — fetch bike repair POIs from OSM.

Public self-service repair stations, bike shops, and pumps across the canton.
Writes ../public/data/bike_poi.json: [{"lon","lat","t","n"?}] where
t = 'r' (public repair station), 's' (bike shop), 'p' (pump / compressed air).
Mirrors 07_fetch_fountains.py. Shops/stations are often mapped as buildings
(ways), so we use nwr + `out center` and de-dup near-duplicate node/way pairs.
"""
import json
import os
from collections import Counter

from util import CANTON_AREA, overpass

OUT = os.path.join(os.path.dirname(__file__), "..", "public", "data", "bike_poi.json")

QUERY = f"""
[out:json][timeout:180];
area({CANTON_AREA})->.ge;
(
  nwr["amenity"="bicycle_repair_station"](area.ge);
  nwr["shop"="bicycle"](area.ge);
  nwr["amenity"="compressed_air"](area.ge);
);
out center tags qt;
"""


def classify(tags):
    if tags.get("amenity") == "bicycle_repair_station":
        return "r"
    if tags.get("shop") == "bicycle":
        return "s"
    if tags.get("amenity") == "compressed_air":
        return "p"
    return None


def main():
    data = overpass(QUERY, timeout=180)
    pts = []
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        cat = classify(tags)
        if not cat:
            continue
        if el["type"] == "node":
            lon, lat = el.get("lon"), el.get("lat")
        else:  # way / relation -> representative point
            c = el.get("center", {})
            lon, lat = c.get("lon"), c.get("lat")
        if lon is None or lat is None:
            continue
        rec = {"lon": round(lon, 6), "lat": round(lat, 6), "t": cat}
        name = tags.get("name")
        if name:
            rec["n"] = name[:60]
        pts.append(rec)

    # de-dup: a shop mapped as both a node and a building way lands ~same spot
    seen, uniq = set(), []
    for p in pts:
        k = (p["t"], round(p["lon"], 4), round(p["lat"], 4))
        if k in seen:
            continue
        seen.add(k)
        uniq.append(p)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(uniq, open(OUT, "w"))
    c = Counter(p["t"] for p in uniq)
    print(f"bike POIs: {len(uniq):,}  (repair {c['r']}, shops {c['s']}, pumps {c['p']})")
    print(f"wrote {OUT} ({os.path.getsize(OUT) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
