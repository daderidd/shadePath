# Tier A — Time-of-day shade for shadePath (implementation plan)

## Goal
Let users pick a **date and time** and have routing, the heat framing, and the
"Profil du trajet" ribbons respond to the **actual sun/shade geometry at that moment**,
rather than only the fixed 14h pattern.

We do this by **re-deriving sun exposure geometrically** (buildings + trees vs sun
position), not by scaling the 14h PET raster (which is not defensible — the shade pattern
reorganises through the day). Honest framing: **"sun exposure + air temperature"**. The
SITG 14h PET stays as the static **heat-island reference** ("où sont les îlots").

Grounded by literature (SOLWEIG/UMEP, RayMan, CoolWalks, HeiGIT, Cool routes); see the
`pet-time-dynamic-litreview` memory note.

## What changes, conceptually
- **Keep:** PET 14h as the heat-island pattern layer and the route's heat colouring.
- **Add:** a time-resolved **sun-exposure (shade)** value per edge, selected by date/time.
- **Cost model:** the shade term `(1 - shadeFrac)` switches from the static canopy fraction
  to the **shade at the chosen time** (buildings + trees). Heat term unchanged.
- **Ribbons:** the 🌳 ribbon becomes "ombre à HHh"; the ⚖️ composite recomputes; the 🌡️ PET
  ribbon stays (it is the heat pattern, time-independent here).

## Data
- **Have:** LiDAR tree-canopy height model (SITG `SIPV_ICA_MNC_2023`, H_MEAN).
- **Need (gating): building heights.** Options, all open, EPSG:2056:
  1. **SITG building footprints + height** (cantonal, matches our stack) — preferred for a
     clean "opaque buildings" mask.
  2. **swisstopo swissBUILDINGS3D 3.0** (per-EGID heights).
  3. **swisstopo swissSURFACE3D Raster** or SITG **MNS** (full DSM incl. veg+buildings); if
     used, subtract the terrain model (MNT) to get a normalised surface (nDSM).
- **Decision:** treat **buildings as opaque** (footprints + height) and **trees as partial**
  shade (canopy heights we already have), because tree crowns are not opaque. This is more
  accurate than a merged DSM and reuses our canopy data.

## Modelling approach (offline, baked)
Compute a **sun-exposure value per edge per time bin**. Two routes:
- **(A) Custom shadow ray-caster — recommended for Tier A.** For each (date, hour): compute
  sun azimuth/elevation; for each sample point along each edge, march toward the sun and test
  whether a building (opaque) or canopy (partial, transmissivity ~0.7 blocking when leaf-on)
  intersects the ray above the sun line. Aggregate to a per-edge sun-exposure fraction
  (0 = fully shaded, 1 = fully sunlit). Fast, controllable, tailored to the graph.
- **(B) UMEP/SOLWEIG — the Tier B upgrade.** Full spatial Tmrt from DSM+CDSM+SVF per hour,
  then sample per edge. More rigorous (real radiant load, not just binary shade), heavier.
  Keep as the validation/upgrade path; not needed for Tier A.

## Time discretisation
Solar geometry depends on **declination (date)** and **hour**, and repeats symmetrically
across the year, so a handful of declination samples covers everything.
- **Dates:** ~3–4 declination steps spanning the **warm season** (heat-relevant): e.g. summer
  solstice, equinox, and 1–2 in between; optionally winter solstice for completeness. Each
  serves two calendar dates by symmetry. Runtime maps chosen date → declination → interpolate.
- **Hours:** daylight, hourly (e.g. 06:00–21:00).
- **Budget:** ~4 dates × ~15 hours ≈ 60 bins. Per edge 1 byte (Uint8 0–255) ×
  ~116k edges × 60 ≈ ~7 MB raw, far less gzipped (sun exposure is spatially coherent). Start
  coarser (warm-season only, ~30 bins) and refine.

## Storage / baking
- Bake a **sidecar binary** `public/data/shade_time.bin` = `edgeCount × bins` Uint8, so the
  base `graph.bin` stays unchanged and load is optional/lazy.
- Extend `meta.json` with the bin schedule: the list of (declination/date, hour) and how to
  map a datetime to bin indices for interpolation.

## Cost-model integration
- Time-aware discomfort: `discomfort = wHeat·petNorm + wShade·(1 − shadeAtTime)`, where
  `shadeAtTime` is the baked sun-exposure for the selected bin (bilinear interp across the two
  nearest declination × hour bins). `edgeWeight` in `cost.ts` reads it; weights/K unchanged.
- `s=0` still equals the shortest path (weight ≥ length preserved).

## Runtime / UI
- **Date + time control** in the panel (compact date picker + hour slider). Default = now.
- **Sun position** computed client-side (NOAA/SunCalc algorithm) for display (a small "soleil
  à X°" indicator), and to pick/interpolate bins.
- **Worker** loads `shade_time.bin`; `route()`/`loop()` use the selected bin's shade.
- **Profile:** 🌳 ribbon → "ombre à HHh"; ⚖️ composite recomputes; 🌡️ PET unchanged.
- **Air temperature:** Open-Meteo **hourly** for the chosen day/hour drives the conditions chip
  and the relative-exposure wording (so "now" framing follows the chosen time).
- **Copy/honesty:** caveat updated — "ombre estimée par géométrie solaire (bâtiments + arbres)
  à l'heure choisie ; motif de chaleur = modèle 14h". No claim of full PET at arbitrary times.

## Honesty / scientific framing
- Geometric sun-exposure (buildings + trees vs sun) is defensible and matches the cited
  routing/shade literature.
- We do **not** recompute wind/humidity/longwave, so we do not claim full PET at arbitrary
  hours. Shade + air-temp is the honest, dominant-driver model; the disclaimer says so.
- **Validation:** spot-check a few edges against SOLWEIG/RayMan or known shadow behaviour
  (e.g. N-S vs E-W street at 9h / 14h / 18h; morning shadows fall west).

## Milestones (de-risk in order)
1. **Data spike (gating):** acquire + verify building heights (source, resolution, CRS 2056,
   licence, coverage). Confirm canopy alignment. Decide footprints-vs-nDSM.
2. **Ray-caster prototype:** one (date, hour); sanity-check shadows on a known block; confirm
   azimuth/elevation correctness.
3. **Full bake:** all bins → `shade_time.bin`; verify size and a hand-checked edge across hours
   (sunlit midday, shaded morning).
4. **Routing integration:** worker loads the sidecar; time-aware cost; verify `s=0` == shortest
   and that the route changes sensibly between 9h / 14h / 18h.
5. **UI:** date/time control, sun indicator, ribbon "ombre à l'heure", hourly air-temp, copy.
6. **Polish + deploy.**

## Risks / open items
- **Building data** resolution/coverage/gaps → conservative default (no data = no building
  shade for that cell).
- **Tree transmissivity:** crowns are semi-transparent; model as partial blocking (~0.7
  leaf-on), seasonal leaf-off later.
- **Bin count vs storage:** start coarse (warm season), refine; interpolate to avoid visible
  jumps between bins.
- **Performance:** sidecar load + Uint8 index per edge is cheap; bilinear bin interp is a few
  multiplies per edge.
- **Scope creep:** Tier A is shade + air-temp only; full Tmrt/PET is Tier B (SOLWEIG).

## Verification
- **Offline:** shadows point away from the sun (morning → west); N-S vs E-W exposure differs by
  hour as the canyon literature predicts; sunlit fraction rises toward midday on open streets.
- **App:** pick 9h / 14h / 18h on a sample route — the 🌳 ribbon and the chosen route change
  sensibly; `s=0` stays shortest; the air-temp/exposure chip follows the chosen hour.
