"""Shared helpers for the shadePath build pipeline (stdlib + rasterio only)."""
import gzip
import json
import os
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache")
os.makedirs(CACHE, exist_ok=True)

CANTON_REL = 1702419
CANTON_AREA = 3600000000 + CANTON_REL  # Overpass area id
EPSG_LV95 = "EPSG:2056"
EPSG_WGS = "EPSG:4326"

OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

PET_IDENTIFY = ("https://raster.sitg.ge.ch/arcgis/rest/services/"
                "CLIMAT_PET_14H00_P0_2020/MapServer/identify")
CANOPY_QUERY = ("https://vector.sitg.ge.ch/arcgis/rest/services/"
                "SIPV_ICA_MNC_2023/FeatureServer/0/query")
UA = {"User-Agent": "shadePath/0.1 (heat-aware bike/walk routing for Geneva)"}


def http_post(url, params, timeout=180, retries=4):
    data = urllib.parse.urlencode(params).encode()
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=data, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"POST {url} failed after {retries} tries: {last}")


def overpass(query, timeout=300):
    last = None
    for url in OVERPASS_MIRRORS:
        try:
            raw = http_post(url, {"data": query}, timeout=timeout, retries=2)
            return json.loads(raw.decode())
        except Exception as e:  # noqa: BLE001
            last = e
            print(f"  overpass mirror failed ({url}): {e}")
    raise RuntimeError(f"all overpass mirrors failed: {last}")


# --- coordinate transforms (lazy import rasterio) -------------------------
_tf = {}


def _transformer(src, dst):
    key = (src, dst)
    if key not in _tf:
        from rasterio.warp import transform as _t
        _tf[key] = _t
    return _tf[key]


def wgs_to_lv95(lons, lats):
    t = _transformer(EPSG_WGS, EPSG_LV95)
    xs, ys = t(EPSG_WGS, EPSG_LV95, list(lons), list(lats))
    return xs, ys


def lv95_to_wgs(es, ns):
    t = _transformer(EPSG_LV95, EPSG_WGS)
    xs, ys = t(EPSG_LV95, EPSG_WGS, list(es), list(ns))
    return xs, ys


def save_json(path, obj):
    with open(path, "w") as f:
        json.dump(obj, f)


def load_json(path):
    with open(path) as f:
        return json.load(f)


def save_json_gz(path, obj):
    with gzip.open(path, "wt") as f:
        json.dump(obj, f)


def load_json_gz(path):
    with gzip.open(path, "rt") as f:
        return json.load(f)
