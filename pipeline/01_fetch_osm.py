#!/usr/bin/env python3
"""Step 01 — fetch the walk+bike highway network for the canton of Geneva via Overpass.

Outputs cache/osm_raw.json: {"ways":[{id,nodes,tags}], "nodes":{id:[lon,lat]}}.
Excludes motorways/trunk and non-routable highway values; keeps everything a
pedestrian or cyclist could legally use (classification happens in step 02).
"""
import os
from util import CACHE, CANTON_AREA, overpass, save_json

OUT = os.path.join(CACHE, "osm_raw.json")

# highway values that are never foot- or bike-routable -> drop at fetch time
DROP_HW = ("motorway|motorway_link|trunk|trunk_link|construction|proposed|"
           "raceway|abandoned|platform|bus_stop|elevator|services|rest_area")

QUERY = f"""
[out:json][timeout:600];
area({CANTON_AREA})->.ge;
(
  way["highway"]["highway"!~"^({DROP_HW})$"]["area"!~"yes"](area.ge);
);
out body qt;
>;
out skel qt;
"""


def main():
    print("Fetching canton walk+bike network from Overpass (this can take a minute)…")
    data = overpass(QUERY, timeout=600)
    ways, nodes = [], {}
    for el in data.get("elements", []):
        if el["type"] == "way" and "nodes" in el:
            ways.append({"id": el["id"], "nodes": el["nodes"],
                         "tags": el.get("tags", {})})
        elif el["type"] == "node":
            nodes[el["id"]] = [el["lon"], el["lat"]]
    print(f"  ways={len(ways):,}  nodes={len(nodes):,}")
    save_json(OUT, {"ways": ways, "nodes": nodes})
    sz = os.path.getsize(OUT) / 1e6
    print(f"  wrote {OUT} ({sz:.1f} MB)")


if __name__ == "__main__":
    main()
