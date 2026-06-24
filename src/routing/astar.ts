// A* over the CSR graph with the dynamic (slider-dependent) cost model.

import { Graph, lng, lat } from "./graph";
import { edgeWeight } from "./cost";

export interface Step { e: number; dir: 1 | -1; }

// Binary min-heap keyed by f-score (parallel arrays of node + priority).
class Heap {
  private node: Int32Array;
  private prio: Float64Array;
  private n = 0;
  constructor(cap: number) { this.node = new Int32Array(cap); this.prio = new Float64Array(cap); }
  get size() { return this.n; }
  push(node: number, prio: number) {
    if (this.n >= this.node.length) { // grow
      const nn = new Int32Array(this.node.length * 2); nn.set(this.node); this.node = nn;
      const np = new Float64Array(this.prio.length * 2); np.set(this.prio); this.prio = np;
    }
    let i = this.n++; this.node[i] = node; this.prio[i] = prio;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.prio[p] <= this.prio[i]) break;
      this.swap(i, p); i = p;
    }
  }
  pop(): number {
    const top = this.node[0];
    this.n--;
    if (this.n > 0) {
      this.node[0] = this.node[this.n]; this.prio[0] = this.prio[this.n];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < this.n && this.prio[l] < this.prio[m]) m = l;
        if (r < this.n && this.prio[r] < this.prio[m]) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    const tn = this.node[a]; this.node[a] = this.node[b]; this.node[b] = tn;
    const tp = this.prio[a]; this.prio[a] = this.prio[b]; this.prio[b] = tp;
  }
}

/**
 * Find a route src -> dst for the given mode bit and slider s. Returns ordered steps or null.
 * `used` (per-edge flag) + `reuse` multiplier discourage re-traversing edges — used by the
 * loop generator to make the return leg differ from the outbound leg.
 */
export function astar(g: Graph, src: number, dst: number, modeBit: number, s: number,
  used?: Uint8Array, reuse = 1): Step[] | null {
  const N = g.meta.nodeCount;
  const gScore = new Float64Array(N).fill(Infinity);
  const cameFrom = new Int32Array(N).fill(-1);
  const cameEdge = new Int32Array(N).fill(-1);
  const cameDir = new Int8Array(N);
  const closed = new Uint8Array(N);

  const mPL = g.meta.mPerLng, mPLa = g.meta.mPerLat;
  const dLng = lng(g, dst), dLat = lat(g, dst);
  const h = (n: number) => {
    const ex = (lng(g, n) - dLng) * mPL, ey = (lat(g, n) - dLat) * mPLa;
    return Math.sqrt(ex * ex + ey * ey) * 0.999; // admissible (weight >= length >= chord)
  };

  const heap = new Heap(1 << 16);
  gScore[src] = 0;
  heap.push(src, h(src));

  while (heap.size) {
    const u = heap.pop();
    if (closed[u]) continue;
    closed[u] = 1;
    if (u === dst) break;
    const gu = gScore[u];
    for (let k = g.csrOff[u]; k < g.csrOff[u + 1]; k++) {
      const e = g.csrEdge[k];
      let v: number, dir: 1 | -1, flags: number;
      if (g.eu[e] === u) { v = g.ev[e]; dir = 1; flags = g.eFlagsF[e]; }
      else { v = g.eu[e]; dir = -1; flags = g.eFlagsB[e]; }
      if ((flags & modeBit) === 0) continue;
      if (closed[v]) continue;
      let w = edgeWeight(g, e, s);
      if (used && used[e]) w *= reuse;
      const ng = gu + w;
      if (ng < gScore[v]) {
        gScore[v] = ng;
        cameFrom[v] = u; cameEdge[v] = e; cameDir[v] = dir;
        heap.push(v, ng + h(v));
      }
    }
  }

  if (cameFrom[dst] === -1 && src !== dst) return null;
  const steps: Step[] = [];
  let cur = dst;
  while (cur !== src && cur !== -1) {
    steps.push({ e: cameEdge[cur], dir: cameDir[cur] as 1 | -1 });
    cur = cameFrom[cur];
  }
  if (cur === -1) return null;
  steps.reverse();
  return steps;
}
