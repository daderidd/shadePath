// Routing Web Worker: owns the graph, snaps endpoints, runs A*, and returns
// ready-to-draw route geometry + stats (the main thread never touches the graph).

import { Graph, loadGraph, edgeCoords, petC, lng, lat, FOOT, BIKE } from "./graph";
import { astar, Step } from "./astar";

let g: Graph | null = null;

export interface RouteResult {
  coords: [number, number][];
  segPet: number[];        // °C per segment (coords.length - 1)
  distance: number;        // metres
  seconds: number;
  avgPet: number;          // length-weighted °C
  shadePct: number;        // length-weighted % under canopy
}

const SPEED = { foot: 1.35, bike: 4.2 }; // m/s

function build(graph: Graph, steps: Step[], mode: "foot" | "bike"): RouteResult {
  const coords: [number, number][] = [];
  const segPet: number[] = [];
  let dist = 0, petSum = 0, shadeSum = 0;
  for (const { e, dir } of steps) {
    let pts = edgeCoords(graph, e);
    if (dir === -1) pts = pts.reverse();
    const len = graph.eLenDm[e] / 10;
    const pc = petC(graph, e);
    dist += len; petSum += pc * len; shadeSum += (graph.eShade[e] / 255) * len;
    const start = coords.length === 0 ? 0 : 1; // avoid duplicating the join vertex
    for (let i = start; i < pts.length; i++) {
      if (coords.length > 0) segPet.push(pc);
      coords.push(pts[i]);
    }
  }
  return {
    coords, segPet, distance: dist,
    seconds: dist / SPEED[mode],
    avgPet: dist > 0 ? petSum / dist : 0,
    shadePct: dist > 0 ? (shadeSum / dist) * 100 : 0,
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

  type Cand = { steps: Step[]; len: number; shade: number };
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
      let len = 0, shadeLen = 0;
      for (const st of steps) {
        const L = g.eLenDm[st.e] / 10; len += L; shadeLen += (g.eShade[st.e] / 255) * L;
      }
      cand = { steps, len, shade: len > 0 ? shadeLen / len : 0 };
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
    const score = c.shade * 2 - (Math.abs(c.len - targetM) / targetM) * 1.2;
    if (score > bestScore) { bestScore = score; best = c; }
  };
  const OB = 6, POLY = 4;
  for (let r = 0; r < OB; r++) consider(tryCand(1, 1.5, jitter + (r / OB) * TWO_PI, 3, targetM / 2.4));
  for (let r = 0; r < POLY; r++) consider(tryCand(4, 2.5, jitter + (r / POLY) * TWO_PI, 2, targetM / 6));

  const chosen = best as Cand | null;
  return chosen ? build(g, chosen.steps, modeBit === FOOT ? "foot" : "bike") : null;
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
  if (msg.type === "loop" && g) {
    const { reqId, start, targetM, mode, s, seed } = msg as {
      reqId: number; start: [number, number]; targetM: number;
      mode: "foot" | "bike"; s: number; seed: number;
    };
    const res = loop(g, start, targetM, mode === "foot" ? FOOT : BIKE, s, seed);
    if (!res) { (self as any).postMessage({ type: "route", reqId, ok: false, error: "couldn't build a loop here — try a different start or distance" }); return; }
    (self as any).postMessage({ type: "route", reqId, ok: true, chosen: res, fastest: res, isLoop: true });
    return;
  }
  if (msg.type === "route" && g) {
    const { reqId, a, b, mode, s } = msg as {
      reqId: number; a: [number, number]; b: [number, number];
      mode: "foot" | "bike"; s: number;
    };
    const modeBit = mode === "foot" ? FOOT : BIKE;
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
