// Routing Web Worker: owns the graph, snaps endpoints, runs A*, and returns
// ready-to-draw route geometry + stats (the main thread never touches the graph).

import { Graph, loadGraph, edgeCoords, petC, lng, lat, FOOT, BIKE } from "./graph";
import { astar, Step } from "./astar";

let g: Graph | null = null;

export interface RouteResult {
  coords: [number, number][];
  segPet: number[];        // °C per segment (coords.length - 1)
  segShade: number[];      // routing shade 0..1 per segment (= canopy, or time-of-day shade)
  segCanopy: number[];     // static tree-canopy fraction 0..1 per segment (always true cover)
  distance: number;        // metres
  seconds: number;
  avgPet: number;          // length-weighted °C
  shadePct: number;        // length-weighted % shaded (routing shade)
  canopyPct: number;       // length-weighted % under tree canopy (true cover)
}

const SPEED = { foot: 1.35, bike: 4.2 }; // m/s

function build(graph: Graph, steps: Step[], mode: "foot" | "bike"): RouteResult {
  const coords: [number, number][] = [];
  const segPet: number[] = [];
  const segShade: number[] = [];
  const segCanopy: number[] = [];
  let dist = 0, petSum = 0, shadeSum = 0, canopySum = 0;
  for (const { e, dir } of steps) {
    let pts = edgeCoords(graph, e);
    if (dir === -1) pts = pts.reverse();
    const len = graph.eLenDm[e] / 10;
    const pc = petC(graph, e);
    const sh = graph.eShadeActive[e] / 255;  // routing shade (canopy, or time-of-day when selected)
    const cn = graph.eShade[e] / 255;         // true tree canopy (always)
    dist += len; petSum += pc * len; shadeSum += sh * len; canopySum += cn * len;
    const start = coords.length === 0 ? 0 : 1; // avoid duplicating the join vertex
    for (let i = start; i < pts.length; i++) {
      if (coords.length > 0) { segPet.push(pc); segShade.push(sh); segCanopy.push(cn); }
      coords.push(pts[i]);
    }
  }
  return {
    coords, segPet, segShade, segCanopy, distance: dist,
    seconds: dist / SPEED[mode],
    avgPet: dist > 0 ? petSum / dist : 0,
    shadePct: dist > 0 ? (shadeSum / dist) * 100 : 0,
    canopyPct: dist > 0 ? (canopySum / dist) * 100 : 0,
  };
}

// Generate a shady loop of ~targetM metres from `start`. Two candidate families:
//   • out-and-back: start -> shadiest point in a bearing -> back (mild reuse penalty)
//     — lets the route dive deep into a park and dwell there, even retracing.
//   • polygon: waypoints around a circle — more varied, area-covering loops.
// Legs are strongly shade-weighted; candidates are scored PRIMARILY on shade so a
// park-hugging out-and-back beats a longer loop that pads distance on hot streets.
function loop(g: Graph, start: [number, number], targetM: number, modeBit: number,
  s: number, seed: number): RouteResult | null {
  const startNode = g.grid.nearest(start[0], start[1], modeBit);
  if (startNode < 0) return null;
  const m = g.meta, E = m.edgeCount, TWO_PI = Math.PI * 2;
  const sLoop = Math.max(s, 0.82); // loops are recreational → lean hard into shade
  const jitter = ((seed % 100) / 100) * TWO_PI;

  type Cand = { steps: Step[]; len: number; comfort: number };
  const tryCand = (K: number, reuse: number, base: number, iters: number, r0: number): Cand | null => {
    let r = r0;
    let cand: Cand | null = null;
    for (let it = 0; it < iters; it++) {
      const seq: number[] = [startNode];
      let okWP = true;
      for (let i = 0; i < K; i++) {
        const ang = base + (K > 1 ? (i / K) * TWO_PI : 0);
        const w = g.grid.nearest(start[0] + (r * Math.cos(ang)) / m.mPerLng,
          start[1] + (r * Math.sin(ang)) / m.mPerLat, modeBit);
        if (w < 0 || w === startNode) { okWP = false; break; }
        seq.push(w);
      }
      if (!okWP) break;
      seq.push(startNode);
      const used = new Uint8Array(E);
      const steps: Step[] = [];
      let ok = true;
      for (let j = 0; j < seq.length - 1; j++) {
        if (seq[j] === seq[j + 1]) continue;
        const leg = astar(g, seq[j], seq[j + 1], modeBit, sLoop, used, reuse);
        if (!leg || leg.length === 0) { ok = false; break; }
        for (const st of leg) { used[st.e] = 1; steps.push(st); }
      }
      if (!ok || steps.length === 0) break;
      // score the candidate on COMFORT (heat + shade), the same discomfort the cost model
      // uses — not shade alone, which at low sun is high everywhere and stops discriminating.
      let len = 0, comfortLen = 0;
      for (const st of steps) {
        const e = st.e, L = g.eLenDm[e] / 10;
        const petNorm = Math.max(0, Math.min(1, (petC(g, e) - m.petLo) / (m.petHi - m.petLo)));
        const discomfort = m.wHeat * petNorm + m.wShade * (1 - g.eShadeActive[e] / 255);
        len += L; comfortLen += (1 - discomfort) * L;
      }
      cand = { steps, len, comfort: len > 0 ? comfortLen / len : 0 };
      if (Math.abs(len - targetM) / targetM < 0.12) break;
      r *= Math.min(1.7, Math.max(0.55, targetM / len));
    }
    return cand;
  };

  // selection at top level (so control-flow analysis tracks `best`)
  let best: Cand | null = null;
  let bestScore = -Infinity;
  const consider = (c: Cand | null) => {
    if (!c) return;
    const score = c.comfort * 2 - (Math.abs(c.len - targetM) / targetM) * 1.2;
    if (score > bestScore) { bestScore = score; best = c; }
  };
  const OB = 6, POLY = 4;
  for (let r = 0; r < OB; r++) consider(tryCand(1, 1.5, jitter + (r / OB) * TWO_PI, 3, targetM / 2.4));
  for (let r = 0; r < POLY; r++) consider(tryCand(4, 2.5, jitter + (r / POLY) * TWO_PI, 2, targetM / 6));

  const chosen = best as Cand | null;
  return chosen ? build(g, chosen.steps, modeBit === FOOT ? "foot" : "bike") : null;
}

let shadeBuf: Uint8Array | null = null;
// Point g.eShadeActive at the time-of-day shade interpolated from the sidecar
// (bilinear in declination value x local hour), or back at the static canopy
// when no time is selected / the sidecar is not loaded. Result stays in [0,255]
// (convex combination) so A* admissibility is preserved.
function applyBin(graph: Graph, binSel?: { decl: number; hour: number }) {
  const st = graph.meta.shadeTime;
  if (!binSel || !graph.shadeBins || !st) { graph.eShadeActive = graph.eShade; return; }
  const E = st.edgeCount, Hn = st.hours.length, bins = graph.shadeBins;
  const order = st.decl.map((_, i) => i).sort((a, b) => st.decl[a] - st.decl[b]);
  const sd = order.map((i) => st.decl[i]);
  let k = 0; while (k < sd.length - 2 && sd[k + 1] < binSel.decl) k++;
  const di0 = order[k], di1 = order[k + 1];
  let fd = sd[k + 1] === sd[k] ? 0 : (binSel.decl - sd[k]) / (sd[k + 1] - sd[k]);
  fd = fd < 0 ? 0 : fd > 1 ? 1 : fd;
  const hrs = st.hours;
  let j = 0; while (j < hrs.length - 2 && hrs[j + 1] < binSel.hour) j++;
  let fh = hrs[j + 1] === hrs[j] ? 0 : (binSel.hour - hrs[j]) / (hrs[j + 1] - hrs[j]);
  fh = fh < 0 ? 0 : fh > 1 ? 1 : fh;
  const b00 = (di0 * Hn + j) * E, b01 = (di0 * Hn + j + 1) * E;
  const b10 = (di1 * Hn + j) * E, b11 = (di1 * Hn + j + 1) * E;
  if (!shadeBuf || shadeBuf.length !== E) shadeBuf = new Uint8Array(E);
  const buf = shadeBuf;
  for (let e = 0; e < E; e++) {
    const top = bins[b00 + e] + (bins[b01 + e] - bins[b00 + e]) * fh;
    const bot = bins[b10 + e] + (bins[b11 + e] - bins[b10 + e]) * fh;
    const v = top + (bot - top) * fd;
    buf[e] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  graph.eShadeActive = buf;
}

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg.type === "init") {
    try {
      g = await loadGraph(msg.base);
      (self as any).postMessage({ type: "ready", meta: g.meta });
    } catch (err: any) {
      (self as any).postMessage({ type: "error", error: String(err?.stack || err) });
    }
    return;
  }
  if (msg.type === "loadShade" && g) {
    try {
      const st = g.meta.shadeTime;
      if (!st) { (self as any).postMessage({ type: "shadeError", error: "no shadeTime in meta" }); return; }
      const arr = new Uint8Array(await (await fetch(msg.base + st.binFile)).arrayBuffer());
      const need = st.edgeCount * st.dates.length * st.hours.length;
      if (st.edgeCount !== g.meta.edgeCount || arr.length !== need) {
        (self as any).postMessage({ type: "shadeError", error: "shade_time size/edge mismatch" }); return;
      }
      g.shadeBins = arr;
      (self as any).postMessage({ type: "shadeReady" });
    } catch (err: any) {
      (self as any).postMessage({ type: "shadeError", error: String(err?.message || err) });
    }
    return;
  }
  if (msg.type === "loop" && g) {
    const { reqId, start, targetM, mode, s, seed, binSel } = msg as {
      reqId: number; start: [number, number]; targetM: number;
      mode: "foot" | "bike"; s: number; seed: number; binSel?: { decl: number; hour: number };
    };
    applyBin(g, binSel);
    const res = loop(g, start, targetM, mode === "foot" ? FOOT : BIKE, s, seed);
    if (!res) { (self as any).postMessage({ type: "route", reqId, ok: false, error: "couldn't build a loop here — try a different start or distance" }); return; }
    (self as any).postMessage({ type: "route", reqId, ok: true, chosen: res, fastest: res, isLoop: true });
    return;
  }
  if (msg.type === "route" && g) {
    const { reqId, a, b, mode, s, binSel } = msg as {
      reqId: number; a: [number, number]; b: [number, number];
      mode: "foot" | "bike"; s: number; binSel?: { decl: number; hour: number };
    };
    const modeBit = mode === "foot" ? FOOT : BIKE;
    applyBin(g, binSel);
    const src = g.grid.nearest(a[0], a[1], modeBit);
    const dst = g.grid.nearest(b[0], b[1], modeBit);
    if (src < 0 || dst < 0) {
      (self as any).postMessage({ type: "route", reqId, ok: false, error: "no node nearby" });
      return;
    }
    const chosenSteps = astar(g, src, dst, modeBit, s);
    if (!chosenSteps) {
      (self as any).postMessage({ type: "route", reqId, ok: false, error: "no route found" });
      return;
    }
    const fastestSteps = s > 0 ? astar(g, src, dst, modeBit, 0) : chosenSteps;
    const chosen = build(g, chosenSteps, mode);
    const fastest = fastestSteps ? build(g, fastestSteps, mode) : chosen;
    const snapA: [number, number] = [lng(g, src), lat(g, src)];
    const snapB: [number, number] = [lng(g, dst), lat(g, dst)];
    (self as any).postMessage({ type: "route", reqId, ok: true, chosen, fastest, snapA, snapB });
  }
};
