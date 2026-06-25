# shadePath 🌳

**Keep to the cool side of Geneva.** A tiny, server-free web app that plans a **bike or
walking** route which dodges the worst urban heat and stays in the shade, instead of just
showing you a map of fountains.

It blends open SITG datasets that the official *lieux de fraîcheur* map ignores:

- 🔥 **Heat** (`CLIMAT_PET_14H00_P0_2020`): 10 m raster of *physiological-equivalent temperature*
  at 2 pm on a hot day, the real urban-heat-island signal.
- 🌳 **Tree canopy** (`SIPV_ICA_MNC_2023`): LiDAR canopy footprint and heights (trees > 3 m).
- 🏠 **Building heights** (`CAD_BATIMENT_HORSOL`): footprints with `HAUTEUR`, used to cast shadows.

…plus drinking fountains from OpenStreetMap, shown along your route.

A single **Fastest ↔ Coolest** slider trades a little distance for a cooler, shadier trip, and the
app tells you what you bought (cooler, more time in shade, for a small detour).

## Time of day

Shade moves with the sun, so shadePath is time-aware. Pick a **date and hour** (or leave it on
*now*) and the routing's shade term, the route profile, the sun indicator and the air-temperature
reading all reflect the **actual sun and shade at that moment**, re-derived geometrically by
casting shadows from buildings (opaque) and trees (partial, ~70 % crown transmissivity) for the
sun's position.

The heat layer stays the fixed 2 pm PET pattern (the heat-island reference); only **shade and air
temperature** vary with the clock. Making PET itself vary hourly would need a full mean-radiant-
temperature model (SOLWEIG); that is a planned upgrade the architecture is ready for.

## Route profile

Every route gets a **"Profil du trajet"** strip docked under the map: three soft ribbons along the
journey (heat, tree cover, and the shadePath comfort the router actually optimises). Scrub along it
and a dot rides the route on the map.

## How it works

Everything heavy is **baked at build time** into a compact binary graph plus a per-edge
sun-exposure sidecar, so the live app is a static page with **no backend and no runtime API calls**
(only the optional heat/canopy overlays and the Open-Meteo temperature are online). Routing is an
A\* in a Web Worker over a ~116k-edge canton-wide graph, recomputed live as you drag the slider.

```
pipeline/   one-off build scripts (Python + GDAL): fetch OSM + SITG, sample, ray-march, pack
src/        the app: MapLibre GL UI + routing/ (graph decode, A*, cost, sun) in a Web Worker
public/data graph.bin, meta.json, shade_time.bin, fountains.json, overlays + tiles (committed)
```

### Cost model
For slider `s ∈ [0,1]`:
```
weight(edge) = length · (1 + K · s · discomfort)
discomfort   = wHeat·petNorm + wShade·(1 − shade)
```
`shade` is the static canopy fraction, or the **chosen-time sun-exposure** when a time is selected
(bilinearly interpolated from the baked time bins). `weight ≥ length` always, so A\* stays correct
and admissible and detours stay bounded.

## Run it

```bash
npm install
npm run dev          # open the printed URL
```

To regenerate the baked data (needs Python 3 with rasterio/numpy + GDAL CLI):
```bash
cd pipeline
python3 01_fetch_osm.py            # OSM walk+bike network (Overpass)
python3 02_build_graph.py          # node + classify -> routable graph
python3 03_fetch_canopy.py         # SITG canopy polygons
python3 04_rasterize_canopy.py     # -> 5 m binary canopy raster
python3 05_sample_pet.py           # per-edge PET via SITG identify (cached, resumable)
python3 06_sample_shade.py         # per-edge canopy fraction
python3 07_fetch_fountains.py      # cooling POIs
python3 08_pack.py                 # -> public/data/graph.bin + meta.json
python3 09_heat_grid.py            # canton PET grid (50 m) for the heat overlay
python3 10_make_overlays.py        # -> public/data/heat.png + overlays.json
# time-of-day shade (Tier A):
python3 12_fetch_buildings.py        # SITG building footprints + HAUTEUR
python3 13_rasterize_shade_inputs.py # -> 5 m building + canopy HEIGHT rasters (aligned to canopy)
python3 14_bake_shade_time.py        # ray-march sun-exposure per edge per time bin -> shade_time.bin
# canopy vector overlay (organic tree-crown polygons, streamed):
ogr2ogr -f FlatGeobuf cache/canopy.fgb cache/canopy.gpkg canopy
ogr2ogr -f PMTiles public/data/canopy.pmtiles cache/canopy.fgb -t_srs EPSG:4326 \
  -nln canopy -dsco MINZOOM=10 -dsco MAXZOOM=15 -dsco MAX_SIZE=3000000 -dsco MAX_FEATURES=900000
```
`sun.py` and `src/routing/sun.ts` are the shared NOAA solar-position calc (kept in agreement so the
offline bake and the live UI pick the same sun).

## Features
- **A → B** routing on a *Fastest ↔ Coolest* slider (bike / walk), heat-coloured route, cool-vs-fast delta.
- **Time of day**: date + hour control with a live sun indicator (elevation + direction), hourly air temp.
- **Route profile** ribbons (heat / tree cover / comfort) with scrub-to-map.
- **Shady loops**: start + target distance (run 5–25 km / ride 5–45 km) → shadiest circuit (~0.7 s).
- **Heat field** overlay (baked PNG) + **tree-canopy** vector polygons (PMTiles) + **fountains**, GPX export.
- **Live air temperature** (Open-Meteo); the route's number is a relative *exposure* level, never a fake absolute temperature.
- **Français by default**, FR/EN toggle, collapsible panel, mobile-first, shareable URLs.

## Data & licensing
Heat, canopy, building and fountain layers © **SITG** (open data, *à titre indicatif, sans valeur
juridique*; PET model 2020, canopy 2023). Shade at a chosen hour is a geometric estimate (buildings
and trees versus the sun position), not a clinical metric. Street network and fountains ©
**OpenStreetMap** contributors (ODbL). Temperature © **Open-Meteo**. Basemap © OpenFreeMap / OSM.
Built for Geneva residents during a heatwave. Not affiliated with the Canton.
