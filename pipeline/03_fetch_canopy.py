#!/usr/bin/env python3
"""Step 03 — fetch the SITG tree-canopy polygons (SIPV_ICA_MNC_2023).

Paginates the FeatureServer as EsriJSON (carries wkid=2056 reliably), generalised
to ~1 m (we rasterise at 5 m). Writes cache/canopy/page_####.json. Resumable:
skips pages already on disk.
"""
import json
import os

from util import CACHE, CANOPY_QUERY, http_post

OUTDIR = os.path.join(CACHE, "canopy")
os.makedirs(OUTDIR, exist_ok=True)
PAGE = 4000


def fetch_page(offset):
    params = {
        "where": "1=1",
        "outFields": "OBJECTID",
        "returnGeometry": "true",
        "outSR": "2056",
        "orderByFields": "OBJECTID",
        "resultOffset": offset,
        "resultRecordCount": PAGE,
        "maxAllowableOffset": "1.0",   # generalise ~1 m -> fewer vertices
        "geometryPrecision": "1",
        "f": "json",
    }
    raw = http_post(CANOPY_QUERY, params, timeout=180)
    return json.loads(raw.decode())


def main():
    offset, page_no, total = 0, 0, 0
    while True:
        path = os.path.join(OUTDIR, f"page_{page_no:04d}.json")
        if os.path.exists(path):
            data = json.load(open(path))
        else:
            data = fetch_page(offset)
            json.dump(data, open(path, "w"))
        feats = data.get("features", [])
        total += len(feats)
        print(f"  page {page_no:3d}  offset {offset:>7,}  +{len(feats):>5} feats  "
              f"(total {total:,})")
        if len(feats) < PAGE and not data.get("exceededTransferLimit"):
            break
        if len(feats) == 0:
            break
        offset += PAGE
        page_no += 1
    print(f"done: {total:,} canopy polygons across {page_no + 1} pages")


if __name__ == "__main__":
    main()
