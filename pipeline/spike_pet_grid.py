#!/usr/bin/env python3
"""Milestone-1 spike #2: map the PET NoData pattern.

Critical question: is PET NoData only over buildings (fine for routing) or also
over streets/open squares (which would break heat-aware routing)?

Uses batched multipoint `identify` (confirmed: returns one value per point per call)
to sample a dense grid, then prints an ASCII map + stats.
"""
import json
import urllib.parse
import urllib.request
from rasterio.warp import transform

SERVICE = ("https://raster.sitg.ge.ch/arcgis/rest/services/"
           "CLIMAT_PET_14H00_P0_2020/MapServer/identify")
RAMP = " .:-=+*o%@"  # cool -> hot (space=coolest), 'X' reserved for NoData


def to_lv95(lon, lat):
    xs, ys = transform("EPSG:4326", "EPSG:2056", [lon], [lat])
    return xs[0], ys[0]


def identify_batch(pts):  # pts: list of (e,n) in LV95
    es = [p[0] for p in pts]; ns = [p[1] for p in pts]
    xmin, ymin, xmax, ymax = min(es)-50, min(ns)-50, max(es)+50, max(ns)+50
    w = max(50, int((xmax-xmin)/10)); h = max(50, int((ymax-ymin)/10))
    params = {
        "f": "json",
        "geometry": json.dumps({"points": [[e, n] for e, n in pts],
                                "spatialReference": {"wkid": 2056}}),
        "geometryType": "esriGeometryMultipoint", "sr": 2056,
        "layers": "all:0", "tolerance": 0,
        "mapExtent": f"{xmin},{ymin},{xmax},{ymax}",
        "imageDisplay": f"{w},{h},96", "returnGeometry": "true",
    }
    data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(SERVICE, data=data,
                                 headers={"User-Agent": "shadePath-spike"})
    with urllib.request.urlopen(req, timeout=60) as r:
        res = json.loads(r.read().decode())
    # Map results back to input order by nearest coordinate (results echo geometry).
    out = {}
    for item in res.get("results", []):
        g = item["geometry"]; v = item["attributes"].get("Stretch.Pixel Value")
        out[(round(g["x"], 1), round(g["y"], 1))] = v
    vals = []
    for e, n in pts:
        v = out.get((round(e, 1), round(n, 1)))
        vals.append(v)
    return vals


def grid_test(label, clon, clat, half_m=200, step_m=20):
    ce, cn = to_lv95(clon, clat)
    coords = []
    ys = list(range(int(cn-half_m), int(cn+half_m)+1, step_m))
    xs = list(range(int(ce-half_m), int(ce+half_m)+1, step_m))
    for n in ys:
        for e in xs:
            coords.append((float(e), float(n)))
    print(f"\n=== {label}  ({len(coords)} pts, {step_m}m spacing, center {clon},{clat}) ===")
    vals = identify_batch(coords)
    # numeric
    nums = [float(v) for v in vals if v not in (None, "NoData")]
    nod = sum(1 for v in vals if v in (None, "NoData"))
    if nums:
        lo, hi = min(nums), max(nums)
        mean = sum(nums)/len(nums)
        print(f"valid={len(nums)}  NoData={nod}  ({100*nod/len(vals):.0f}%)  "
              f"PET min/mean/max = {lo:.1f}/{mean:.1f}/{hi:.1f} °C")
    else:
        lo, hi = 0, 1
        print(f"valid=0  NoData={nod} (100%)  -- all NoData!")
    # ASCII (north up): iterate rows top->bottom
    nx = len(xs)
    print("  (top=North; 'X'=NoData; ' .:-=+*o%@' = cool->hot)")
    for ri in range(len(ys)-1, -1, -1):
        row = ""
        for ci in range(nx):
            v = vals[ri*nx + ci]
            if v in (None, "NoData"):
                row += "X"
            else:
                f = (float(v)-lo)/(hi-lo) if hi > lo else 0
                row += RAMP[min(len(RAMP)-1, int(f*(len(RAMP)-1)))]
        print("   " + row)


if __name__ == "__main__":
    # Big open esplanade (la Plaine de Plainpalais) — should be mostly valid if
    # open paved ground carries PET values.
    grid_test("Plaine de Plainpalais (open esplanade)", 6.1415, 46.1935, 180, 20)
    # Dense mixed block (Jonction-ish) — reveals building-vs-street masking.
    grid_test("Dense urban block (Rue de Carouge area)", 6.1390, 46.1900, 180, 20)
