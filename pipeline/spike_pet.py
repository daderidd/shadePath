#!/usr/bin/env python3
"""Milestone-1 spike: can we read real PET (°C) values from the SITG raster MapServer?

Tests two things:
  1. Single-point `identify` -> exact pixel value (and sanity of units).
  2. Multipoint `identify` -> does it return one value PER point in a single call?
     (decides automated batch sampling vs. needing a manual GeoTIFF download.)

Stdlib only (urllib) + rasterio for WGS84->LV95 transform.
"""
import json
import urllib.parse
import urllib.request
from rasterio.warp import transform

SERVICE = ("https://raster.sitg.ge.ch/arcgis/rest/services/"
           "CLIMAT_PET_14H00_P0_2020/MapServer/identify")

# (label, lon, lat)  -- WGS84
POINTS = [
    ("Plainpalais (open paved square, expect HOT)", 6.1428, 46.1947),
    ("Parc des Bastions (tree-shaded park, cooler)", 6.1455, 46.1995),
    ("Rade / lake water (expect COLD)",              6.1530, 46.2080),
    ("Cornavin station forecourt (expect HOT)",      6.1420, 46.2100),
]


def to_lv95(lon, lat):
    xs, ys = transform("EPSG:4326", "EPSG:2056", [lon], [lat])
    return xs[0], ys[0]


def post(params):
    data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(SERVICE, data=data,
                                 headers={"User-Agent": "shadePath-spike"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def identify_single(e, n):
    box = 500  # map extent box (m) around the point
    params = {
        "f": "json",
        "geometry": json.dumps({"x": e, "y": n}),
        "geometryType": "esriGeometryPoint",
        "sr": 2056,
        "layers": "all:0",
        "tolerance": 1,
        "mapExtent": f"{e-box},{n-box},{e+box},{n+box}",
        "imageDisplay": "100,100,96",  # ~10 m/px to match raster
        "returnGeometry": "false",
    }
    return post(params)


def identify_multipoint(pts_lv95):
    es = [p[0] for p in pts_lv95]
    ns = [p[1] for p in pts_lv95]
    xmin, xmax = min(es) - 500, max(es) + 500
    ymin, ymax = min(ns) - 500, max(ns) + 500
    w = max(50, int((xmax - xmin) / 10))
    h = max(50, int((ymax - ymin) / 10))
    params = {
        "f": "json",
        "geometry": json.dumps({"points": [[e, n] for e, n in pts_lv95],
                                "spatialReference": {"wkid": 2056}}),
        "geometryType": "esriGeometryMultipoint",
        "sr": 2056,
        "layers": "all:0",
        "tolerance": 1,
        "mapExtent": f"{xmin},{ymin},{xmax},{ymax}",
        "imageDisplay": f"{w},{h},96",
        "returnGeometry": "true",
    }
    return post(params)


def main():
    print("=== SINGLE-POINT identify ===")
    lv95 = []
    for label, lon, lat in POINTS:
        e, n = to_lv95(lon, lat)
        lv95.append((e, n))
        try:
            res = identify_single(e, n)
            results = res.get("results", [])
            vals = [r.get("attributes", {}) for r in results]
            print(f"\n{label}\n  LV95 = ({e:.1f}, {n:.1f})  -> {len(results)} result(s)")
            for a in vals:
                print("   ", json.dumps(a, ensure_ascii=False))
        except Exception as ex:
            print(f"\n{label}: ERROR {ex}")

    print("\n\n=== MULTIPOINT identify (batch test) ===")
    try:
        res = identify_multipoint(lv95)
        results = res.get("results", [])
        print(f"sent {len(lv95)} points -> got {len(results)} result(s)")
        print(json.dumps(res, ensure_ascii=False, indent=2)[:2500])
    except Exception as ex:
        print(f"MULTIPOINT ERROR {ex}")


if __name__ == "__main__":
    main()
