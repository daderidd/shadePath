// Decode the baked binary routing graph (CSR) and provide coord + spatial-snap helpers.

export interface Meta {
  version: number;
  dataVersion: string;
  nodeCount: number;
  edgeCount: number;
  geomCount: number;
  csrEdgeCount: number;
  origin: [number, number];
  coordQuant: number;
  bbox: [number, number, number, number];
  petMin: number;
  petMax: number;
  petLo: number;
  petHi: number;
  K: number;
  wHeat: number;
  wShade: number;
  mPerLng: number;
  mPerLat: number;
}

export interface Graph {
  meta: Meta;
  nodeX: Int32Array;
  nodeY: Int32Array;
  eu: Uint32Array;
  ev: Uint32Array;
  eLenDm: Uint16Array;
  ePet: Uint8Array;
  eShade: Uint8Array;
  eFlagsF: Uint8Array;
  eFlagsB: Uint8Array;
  csrOff: Uint32Array;
  csrEdge: Uint32Array;
  geomOff: Uint32Array;
  geomX: Int32Array;
  geomY: Int32Array;
  nodeMask: Uint8Array;   // per-node OR of incident edge legality (1 foot, 2 bike)
  grid: SpatialGrid;
}

export const FOOT = 1, BIKE = 2, STEPS = 4;

export function lng(g: Graph, i: number): number {
  return g.meta.origin[0] + g.nodeX[i] / g.meta.coordQuant;
}
export function lat(g: Graph, i: number): number {
  return g.meta.origin[1] + g.nodeY[i] / g.meta.coordQuant;
}
export function petC(g: Graph, e: number): number {
  return g.meta.petMin + (g.ePet[e] / 255) * (g.meta.petMax - g.meta.petMin);
}

/** Full edge polyline in [lng,lat], from u to v including reconstructed endpoints. */
export function edgeCoords(g: Graph, e: number): [number, number][] {
  const Q = g.meta.coordQuant, ox = g.meta.origin[0], oy = g.meta.origin[1];
  const out: [number, number][] = [[lng(g, g.eu[e]), lat(g, g.eu[e])]];
  for (let k = g.geomOff[e]; k < g.geomOff[e + 1]; k++) {
    out.push([ox + g.geomX[k] / Q, oy + g.geomY[k] / Q]);
  }
  out.push([lng(g, g.ev[e]), lat(g, g.ev[e])]);
  return out;
}

export async function loadGraph(base: string): Promise<Graph> {
  const meta: Meta = await (await fetch(base + "data/meta.json")).json();
  const buf = await (await fetch(base + "data/graph.bin")).arrayBuffer();
  const N = meta.nodeCount, E = meta.edgeCount, G = meta.geomCount, C = meta.csrEdgeCount;
  let o = 0;
  // slice() copies into fresh, 4-byte-aligned buffers so typed-array views never misalign
  const i32 = (n: number) => { const a = new Int32Array(buf.slice(o, o + n * 4)); o += n * 4; return a; };
  const u32 = (n: number) => { const a = new Uint32Array(buf.slice(o, o + n * 4)); o += n * 4; return a; };
  const u16 = (n: number) => { const a = new Uint16Array(buf.slice(o, o + n * 2)); o += n * 2; return a; };
  const u8 = (n: number) => { const a = new Uint8Array(buf.slice(o, o + n)); o += n; return a; };

  const nodeX = i32(N), nodeY = i32(N);
  const eu = u32(E), ev = u32(E);
  const eLenDm = u16(E);
  const ePet = u8(E), eShade = u8(E), eFlagsF = u8(E), eFlagsB = u8(E);
  const csrOff = u32(N + 1), csrEdge = u32(C);
  const geomOff = u32(E + 1), geomX = i32(G), geomY = i32(G);

  // per-node legality mask: a node "has a bike/foot edge" if any incident edge does
  const nodeMask = new Uint8Array(N);
  for (let e = 0; e < E; e++) {
    const m = eFlagsF[e] | eFlagsB[e];
    nodeMask[eu[e]] |= m; nodeMask[ev[e]] |= m;
  }

  const g: Graph = {
    meta, nodeX, nodeY, eu, ev, eLenDm, ePet, eShade, eFlagsF, eFlagsB,
    csrOff, csrEdge, geomOff, geomX, geomY, nodeMask, grid: null as unknown as SpatialGrid,
  };
  g.grid = new SpatialGrid(g);
  return g;
}

// --- uniform spatial grid for nearest-node snapping ---------------------
export class SpatialGrid {
  private cells = new Map<number, number[]>();
  private readonly cell = 0.0035; // ~270 m
  private readonly minLng: number;
  private readonly minLat: number;
  private readonly cols: number;
  constructor(private g: Graph) {
    const [mnLng, mnLat, mxLng] = g.meta.bbox;
    this.minLng = mnLng; this.minLat = mnLat;
    this.cols = Math.ceil((mxLng - mnLng) / this.cell) + 1;
    for (let i = 0; i < g.meta.nodeCount; i++) {
      const k = this.key(lng(g, i), lat(g, i));
      let arr = this.cells.get(k);
      if (!arr) this.cells.set(k, (arr = []));
      arr.push(i);
    }
  }
  private key(ln: number, la: number): number {
    const cx = Math.floor((ln - this.minLng) / this.cell);
    const cy = Math.floor((la - this.minLat) / this.cell);
    return cy * this.cols + cx;
  }
  /** Nearest node; if mask>0, only nodes with an incident edge for that mode. */
  nearest(ln: number, la: number, mask = 0): number {
    const g = this.g, mPL = g.meta.mPerLng, mPLa = g.meta.mPerLat;
    const cx = Math.floor((ln - this.minLng) / this.cell);
    const cy = Math.floor((la - this.minLat) / this.cell);
    let best = -1, bestD = Infinity;
    for (let r = 0; r < 60; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
          const arr = this.cells.get((cy + dy) * this.cols + (cx + dx));
          if (!arr) continue;
          for (const i of arr) {
            if (mask && (g.nodeMask[i] & mask) === 0) continue;
            const ex = (lng(g, i) - ln) * mPL, ey = (lat(g, i) - la) * mPLa;
            const d = ex * ex + ey * ey;
            if (d < bestD) { bestD = d; best = i; }
          }
        }
      }
      if (best >= 0 && r >= 1) break; // found something + checked one extra ring
    }
    return best;
  }
}
