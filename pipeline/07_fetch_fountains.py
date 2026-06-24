#!/usr/bin/env python3
"""Step 07 — fetch cooling POIs (fountains / drinking water) from OSM.

Geneva's "bornes-fontaines" and drinking fountains are well mapped in OSM.
Writes ../public/data/fountains.json: [{"lon","lat","t"}] where t = 'd' (drinkable)
or 'f' (fountain/water feature).
"""
import json
import os

from util import CANTON_AREA, overpass

OUT = os.path.join(os.path.dirname(__file__), "..", "public", "data", "fountains.json")

QUERY = f"""
[out:json][timeout:180];
area({CANTON_AREA})->.ge;
(
  node["amenity"="drinking_water"](area.ge);
  node["amenity"="fountain"](area.ge);
  node["man_made"="water_tap"]["drinking_water"!="no"](area.ge);
  node["amenity"="water_point"](area.ge);
  node["natural"="spring"]["drinking_water"="yes"](area.ge);
);
out body qt;
"""


def main():
    data = overpass(QUERY, timeout=180)
    pts = []
    for el in data.get("elements", []):
        if el["type"] != "node":
            continue
        t = el.get("tags", {})
        drinkable = (t.get("amenity") in ("drinking_water", "water_point")
                     or t.get("man_made") == "water_tap"
                     or t.get("drinking_water") == "yes")
        pts.append({"lon": round(el["lon"], 6), "lat": round(el["lat"], 6),
                    "t": "d" if drinkable else "f"})
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(pts, open(OUT, "w"))
    nd = sum(1 for p in pts if p["t"] == "d")
    print(f"fountains: {len(pts):,}  (drinkable {nd:,}, other {len(pts)-nd:,})")
    print(f"wrote {OUT} ({os.path.getsize(OUT)/1024:.0f} KB)")


if __name__ == "__main__":
    main()
