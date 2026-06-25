// The route cost model. Single slider s in [0,1] (0 = Fastest, 1 = Coolest).
//
//   weight(e) = len * (1 + K * s * discomfort)
//   discomfort = wHeat * petNorm + wShade * (1 - shadeFrac)   in [0,1]
//   petNorm    = clamp((petC - petLo) / (petHi - petLo), 0, 1)
//
// weight is always >= len, so Dijkstra/A* stay correct, the Euclidean heuristic
// stays admissible, and the worst an edge can cost is len*(1+K*s) -> bounded detours.

import { Graph } from "./graph";

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function edgeWeight(g: Graph, e: number, s: number): number {
  const len = g.eLenDm[e] / 10;
  if (s <= 0) return len;
  const m = g.meta;
  const petc = m.petMin + (g.ePet[e] / 255) * (m.petMax - m.petMin);
  const petNorm = clamp01((petc - m.petLo) / (m.petHi - m.petLo));
  const shade = g.eShadeActive[e] / 255;  // = static canopy, or time-of-day shade when selected
  const discomfort = m.wHeat * petNorm + m.wShade * (1 - shade);
  return len * (1 + m.K * s * discomfort);
}
