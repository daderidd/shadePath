# shadePath 🌳

**Keep to the cool side of Geneva.** A tiny, server-free web app that plans a **bike or
walking** route which dodges the worst urban heat and stays under the trees — instead of just
showing you a map of fountains.

It blends two open SITG datasets the official *lieux de fraîcheur* map ignores:

- 🔥 **Heat** — `CLIMAT_PET_14H00_P0_2020`: 10 m raster of *physiological-equivalent temperature*
  at 2 pm on a hot day (the real urban-heat-island signal).
- 🌳 **Shade** — `SIPV_ICA_MNC_2023`: LiDAR tree-canopy footprint (251,801 polygons, trees > 3 m).

…plus drinking fountains from OpenStreetMap, shown along your route.

A single **Fastest ↔ Coolest** slider trades a little distance for a cooler, shadier trip, and the
app tells you exactly what you bought: *"the cool route is 2.1 °C cooler and +18 % under trees for
+240 m."*

## How it works

Everything heavy is **baked at build time** into one compact binary graph, so the live app is a
static page with **zero backend and zero runtime API calls** (the heat/canopy *overlays* are the
only optional online layers). Routing is an A\* in a Web Worker over a ~116k-edge canton-wide graph
— recomputed live as you drag the slider, in milliseconds.

```
pipeline/   one-off build scripts (Python + GDAL): fetch OSM + SITG, sample, pack -> public/data/*
src/        the app: MapLibre GL UI + routing/ (graph decode, A*, cost model) in a Web Worker
public/data graph.bin (routing graph), meta.json, fountains.json   <- generated, not in git
```

### Cost model
For slider `s ∈ [0,1]`:
```
weight(edge) = length · (1 + K · s · discomfort)
discomfort   = wHeat·petNorm + wShade·(1 − shadeFraction)
```
`weight ≥ length` always, so A\* stays correct and admissible and detours stay bounded.

## Run it

```bash
npm install
npm run dev          # open the printed URL
```

To regenerate the baked data (needs Python 3 with rasterio/numpy/shapely + GDAL CLI):
```bash
cd pipeline
python3 01_fetch_osm.py        # OSM walk+bike network (Overpass)
python3 02_build_graph.py      # node + classify -> routable graph
python3 03_fetch_canopy.py     # SITG canopy polygons
python3 04_rasterize_canopy.py # -> 5 m shade raster
python3 05_sample_pet.py       # per-edge PET via SITG identify (cached, resumable)
python3 06_sample_shade.py     # per-edge canopy fraction
python3 07_fetch_fountains.py  # cooling POIs
python3 08_pack.py             # -> public/data/graph.bin + meta.json
python3 09_heat_grid.py        # canton PET grid (50 m) for the heat overlay
python3 10_make_overlays.py    # -> public/data/heat.png + overlays.json
# canopy vector overlay (organic tree-crown polygons, streamed):
ogr2ogr -f FlatGeobuf cache/canopy.fgb cache/canopy.gpkg canopy
ogr2ogr -f PMTiles public/data/canopy.pmtiles cache/canopy.fgb -t_srs EPSG:4326 \
  -nln canopy -dsco MINZOOM=10 -dsco MAXZOOM=15 -dsco MAX_SIZE=3000000 -dsco MAX_FEATURES=900000
```

## Features
- **A → B** routing on a *Fastest ↔ Coolest* slider (bike / walk), heat-coloured route, "cool vs fast" delta.
- **Shady loops** — start + target distance (run 5–25 km / ride 5–45 km) → shadiest circuit (~0.7 s).
- **Heat field** overlay (baked PNG) + **tree-canopy** vector polygons (PMTiles) + **fountains**.
- **Live air temperature** (Open-Meteo) shown alongside the modelled heat *pattern* — the route's number is a
  relative *exposure* level, never a fake absolute temperature.
- **Français by default**, FR/EN toggle. Mobile-first. Shareable URLs.

## Data & licensing
Heat, canopy and fountain layers © **SITG** (open data, *à titre indicatif, sans valeur
juridique*; PET model 2020, canopy 2023, snapshot of the hottest hour — not live weather). Street
network and fountains © **OpenStreetMap** contributors (ODbL). Basemap © OpenFreeMap / OSM.
Built for Geneva residents during a heatwave. Not affiliated with the Canton.
