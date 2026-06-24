#!/usr/bin/env python3
"""Milestone-1 spike #3: do STREET CENTERLINES carry PET values?

For real street polylines (lon/lat), densify to 10 m and batch-identify. Report:
  - raw NoData% (exact cell)
  - gap-filled NoData% (nearest valid within ~15 m, the production strategy)
If gap-filled NoData ~0, heat-aware routing is viable.
"""
import json, math, urllib.parse, urllib.request
from rasterio.warp import transform

SERVICE = ("https://raster.sitg.ge.ch/arcgis/rest/services/"
           "CLIMAT_PET_14H00_P0_2020/MapServer/identify")

STREETS = {
    "Rue du Rhône (central canyon)":      [(6.1455,46.2049),(6.1520,46.2036),(6.1585,46.2032)],
    "Bd Georges-Favon (wide avenue)":     [(6.1410,46.2010),(6.1430,46.1985),(6.1455,46.1958)],
    "Rue de Carouge (commercial)":        [(6.1400,46.1955),(6.1370,46.1905),(6.1345,46.1855)],
    "Quai Gustave-Ador (lakeside)":       [(6.1530,46.2070),(6.1600,46.2055),(6.1670,46.2040)],
    "Ch. residential (Champel)":          [(6.1490,46.1900),(6.1520,46.1870),(6.1545,46.1845)],
}
NEIGH = [(0,0),(12,0),(-12,0),(0,12),(0,-12),(12,12),(-12,-12),(12,-12),(-12,12)]


def to_lv95_many(lonlats):
    lons=[p[0] for p in lonlats]; lats=[p[1] for p in lonlats]
    xs,ys=transform("EPSG:4326","EPSG:2056",lons,lats); return list(zip(xs,ys))


def densify(pts_lv95, step=10.0):
    out=[]
    for (x0,y0),(x1,y1) in zip(pts_lv95,pts_lv95[1:]):
        d=math.hypot(x1-x0,y1-y0); n=max(1,int(d/step))
        for i in range(n):
            t=i/n; out.append((x0+(x1-x0)*t, y0+(y1-y0)*t))
    out.append(pts_lv95[-1]); return out


def identify_batch(pts):
    es=[p[0] for p in pts]; ns=[p[1] for p in pts]
    xmin,ymin,xmax,ymax=min(es)-50,min(ns)-50,max(es)+50,max(ns)+50
    w=max(50,min(4096,int((xmax-xmin)/10))); h=max(50,min(4096,int((ymax-ymin)/10)))
    params={"f":"json",
        "geometry":json.dumps({"points":[[e,n] for e,n in pts],"spatialReference":{"wkid":2056}}),
        "geometryType":"esriGeometryMultipoint","sr":2056,"layers":"all:0","tolerance":0,
        "mapExtent":f"{xmin},{ymin},{xmax},{ymax}","imageDisplay":f"{w},{h},96","returnGeometry":"true"}
    data=urllib.parse.urlencode(params).encode()
    req=urllib.request.Request(SERVICE,data=data,headers={"User-Agent":"shadePath-spike"})
    with urllib.request.urlopen(req,timeout=60) as r: res=json.loads(r.read().decode())
    out={}
    for it in res.get("results",[]):
        g=it["geometry"]; out[(round(g["x"]),round(g["y"]))]=it["attributes"].get("Stretch.Pixel Value")
    def val(e,n): return out.get((round(e),round(n)))
    return val


def main():
    tot_raw_nd=tot=tot_gf_nd=0
    for name,wp in STREETS.items():
        line=densify(to_lv95_many(wp),10.0)
        # candidate cloud = each centerline pt + neighbors
        cands=[]
        for (e,n) in line:
            for dx,dy in NEIGH: cands.append((e+dx,n+dy))
        val=identify_batch(cands)
        raw_nd=gf_nd=0
        pet_vals=[]
        for (e,n) in line:
            exact=val(e,n)
            if exact in (None,"NoData"): raw_nd+=1
            # gap-fill: nearest valid among neighbors
            best=None
            for dx,dy in NEIGH:
                v=val(e+dx,n+dy)
                if v not in (None,"NoData"):
                    best=float(v); break
            if best is None: gf_nd+=1
            else: pet_vals.append(best)
        npts=len(line)
        mean=sum(pet_vals)/len(pet_vals) if pet_vals else float("nan")
        print(f"{name:38s}  n={npts:3d}  raw NoData={100*raw_nd/npts:4.0f}%  "
              f"gap-filled NoData={100*gf_nd/npts:4.0f}%  meanPET={mean:.1f}°C")
        tot+=npts; tot_raw_nd+=raw_nd; tot_gf_nd+=gf_nd
    print("-"*100)
    print(f"{'TOTAL':38s}  n={tot:3d}  raw NoData={100*tot_raw_nd/tot:4.0f}%  "
          f"gap-filled NoData={100*tot_gf_nd/tot:4.0f}%")


if __name__=="__main__":
    main()
