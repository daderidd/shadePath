#!/usr/bin/env python3
"""Validate the packed graph.bin end-to-end: decode (mirror of graph.ts), snap,
run A* under the real cost model, and confirm higher s -> cooler/shadier route."""
import json
import math
import os
import heapq

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "public", "data")
meta = json.load(open(os.path.join(DATA, "meta.json")))
buf = open(os.path.join(DATA, "graph.bin"), "rb").read()

N, E, G, C = meta["nodeCount"], meta["edgeCount"], meta["geomCount"], meta["csrEdgeCount"]
o = 0
def take(dtype, n):
    global o
    a = np.frombuffer(buf, dtype=dtype, count=n, offset=o); o += n * np.dtype(dtype).itemsize
    return a
nodeX = take("<i4", N); nodeY = take("<i4", N)
eu = take("<u4", E); ev = take("<u4", E)
eLenDm = take("<u2", E); ePet = take("u1", E); eShade = take("u1", E)
eFlagsF = take("u1", E); eFlagsB = take("u1", E)
csrOff = take("<u4", N + 1); csrEdge = take("<u4", C)
geomOff = take("<u4", E + 1); take("<i4", G); take("<i4", G)
assert o == len(buf), f"size mismatch {o} != {len(buf)}"

Q = meta["coordQuant"]; oxLng, oyLat = meta["origin"]
def lng(i): return oxLng + nodeX[i] / Q
def lat(i): return oyLat + nodeY[i] / Q
petMin, petMax, petLo, petHi = meta["petMin"], meta["petMax"], meta["petLo"], meta["petHi"]
K, wH, wS = meta["K"], meta["wHeat"], meta["wShade"]
mPL, mPLa = meta["mPerLng"], meta["mPerLat"]

def petc(e): return petMin + ePet[e] / 255 * (petMax - petMin)
def weight(e, s):
    L = eLenDm[e] / 10
    if s <= 0: return L
    pn = min(1, max(0, (petc(e) - petLo) / (petHi - petLo)))
    disc = wH * pn + wS * (1 - eShade[e] / 255)
    return L * (1 + K * s * disc)

# spatial snap (brute force, fine for a one-off check)
LNG = oxLng + nodeX / Q; LAT = oyLat + nodeY / Q
def snap(ln, la):
    dx = (LNG - ln) * mPL; dy = (LAT - la) * mPLa
    return int(np.argmin(dx * dx + dy * dy))

FOOT, BIKE = 1, 2
def astar(src, dst, modebit, s):
    g = np.full(N, np.inf); g[src] = 0
    came = np.full(N, -1, np.int64); camee = np.full(N, -1, np.int64)
    dLng, dLat = lng(dst), lat(dst)
    def h(n):
        return math.hypot((lng(n) - dLng) * mPL, (lat(n) - dLat) * mPLa) * 0.999
    pq = [(h(src), src)]; closed = np.zeros(N, bool)
    while pq:
        _, u = heapq.heappop(pq)
        if closed[u]: continue
        closed[u] = True
        if u == dst: break
        for k in range(csrOff[u], csrOff[u + 1]):
            e = csrEdge[k]
            if eu[e] == u: v, fl = ev[e], eFlagsF[e]
            else: v, fl = eu[e], eFlagsB[e]
            if not (fl & modebit) or closed[v]: continue
            ng = g[u] + weight(e, s)
            if ng < g[v]:
                g[v] = ng; came[v] = u; camee[v] = e
                heapq.heappush(pq, (ng + h(v), v))
    if came[dst] == -1: return None
    edges = []; cur = dst
    while cur != src:
        edges.append(int(camee[cur])); cur = int(came[cur])
    edges.reverse()
    dist = sum(eLenDm[e] / 10 for e in edges)
    avgpet = sum(petc(e) * eLenDm[e] / 10 for e in edges) / dist
    shade = sum(eShade[e] / 255 * eLenDm[e] / 10 for e in edges) / dist * 100
    return dist, avgpet, shade, len(edges)

print(f"decoded OK: N={N:,} E={E:,} geom={G:,}  bin={len(buf)/1e6:.2f}MB")
print(f"PET band [{petLo:.1f},{petHi:.1f}]  K={K}  flags(foot/bike legal): "
      f"{int((eFlagsF & FOOT).any())}/{int((eFlagsF & BIKE).any())}")

# Plainpalais -> Cornavin (a hot central corridor)
A = snap(6.1428, 46.1947); B = snap(6.1423, 46.2096)
print(f"\nPlainpalais -> Cornavin  (bike)   nodes {A}->{B}")
print(f"  {'s':>5} {'dist_m':>8} {'avgPET':>7} {'shade%':>7} {'edges':>6}")
prev = None
for s in (0.0, 0.35, 0.65, 1.0):
    r = astar(A, B, BIKE, s)
    if r:
        d, p, sh, ne = r
        print(f"  {s:>5.2f} {d:>8.0f} {p:>7.1f} {sh:>7.1f} {ne:>6}")
        prev = r
assert prev, "no route!"

# sanity assertions
r0 = astar(A, B, BIKE, 0.0); r1 = astar(A, B, BIKE, 1.0)
print(f"\nCHECK fastest is shortest: s=0 dist {r0[0]:.0f} <= s=1 dist {r1[0]:.0f} "
      f"-> {'OK' if r0[0] <= r1[0] + 1 else 'FAIL'}")
print(f"CHECK coolest is cooler:  s=1 avgPET {r1[1]:.1f} <= s=0 avgPET {r0[1]:.1f} "
      f"-> {'OK' if r1[1] <= r0[1] + 0.01 else 'FAIL'}")
print(f"CHECK walk routable: {'OK' if astar(A,B,FOOT,0.0) else 'FAIL'}")
