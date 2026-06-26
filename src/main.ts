import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";

maplibregl.addProtocol("pmtiles", new Protocol().tile);
import { geocode, Place } from "./geocode";
import { t, getLang, setLang } from "./i18n";
import type { Meta } from "./routing/graph";
import type { RouteResult } from "./routing/worker";
import { sunForGeneva, genevaNow } from "./routing/sun";

// Absolute base so fetches resolve against the PAGE (not the worker script's /assets/
// path) — required for GitHub Pages project subpaths like /shadePath/.
const BASE = new URL(import.meta.env.BASE_URL, location.href).href;

type Mode = "bike" | "walk";
type Trip = "ab" | "loop";
interface TimeSel { y: number; m: number; d: number; h: number; }
interface State { mode: Mode; trip: Trip; s: number; a: [number, number] | null; b: [number, number] | null; meta: Meta | null; time: TimeSel; timeNow: boolean; }
const state: State = { mode: "walk", trip: "ab", s: 0.65, a: null, b: null, meta: null, time: genevaNow(), timeNow: true };
let loopSeed = 1;
let shadeReady = false;
let lastResult: { c: RouteResult; f: RouteResult; isLoop: boolean } | null = null;
let lastWeather: { now: number; max: number; hours: number[] } | null = null;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- worker ----------
const worker = new Worker(new URL("./routing/worker.ts", import.meta.url), { type: "module" });
let reqId = 0;
const pending = new Map<number, (r: any) => void>();
worker.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === "ready") {
    state.meta = m.meta;
    if (map.getLayer("route")) {
      map.setPaintProperty("route", "line-color", petRamp());
      map.setPaintProperty("route-glow", "line-color", petRamp());
    }
    updateLegend();
    updateTimeUI();
    maybeRoute();
    if (m.meta.shadeTime) worker.postMessage({ type: "loadShade", base: BASE });
  }
  else if (m.type === "shadeReady") { shadeReady = true; updateTimeUI(); if (state.trip === "ab") maybeRoute(); }
  else if (m.type === "shadeError") { console.warn("[shade]", m.error); }
  else if (m.type === "error") { console.error("[worker] init error:", m.error); $("msg").textContent = t("msg_load_fail"); }
  else if (m.type === "route") { const cb = pending.get(m.reqId); if (cb) { pending.delete(m.reqId); cb(m); } }
};
worker.onerror = (e) => console.error("[worker] onerror:", e.message, e.filename, e.lineno);
worker.postMessage({ type: "init", base: BASE });

// Time-bin selector for the worker: declination + local hour of the chosen time.
// undefined until the shade sidecar is loaded -> worker falls back to static canopy.
function currentBinSel(): { decl: number; hour: number } | undefined {
  if (!shadeReady || !state.meta?.shadeTime) return undefined;
  const { y, m, d, h } = state.time;
  return { decl: sunForGeneva(y, m, d, h).decl, hour: h };
}
function route(a: [number, number], b: [number, number], mode: Mode, s: number): Promise<any> {
  const id = ++reqId;
  return new Promise((res) => { pending.set(id, res); worker.postMessage({ type: "route", reqId: id, a, b, mode: mode === "walk" ? "foot" : "bike", s, binSel: currentBinSel() }); });
}
function loopRoute(start: [number, number], targetM: number, mode: Mode, s: number, seed: number): Promise<any> {
  const id = ++reqId;
  return new Promise((res) => { pending.set(id, res); worker.postMessage({ type: "loop", reqId: id, start, targetM, mode: mode === "walk" ? "foot" : "bike", s, seed, binSel: currentBinSel() }); });
}

// ---------- map ----------
const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/positron",
  center: [6.143, 46.204],
  zoom: 12.4,
  attributionControl: false,
});
(window as any).map = map; // exposed for debugging / automated checks
map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }), "bottom-right");

let firstSymbol: string | undefined;
let mapReady = false;
map.on("load", async () => {
  const layers = map.getStyle().layers || [];
  firstSymbol = layers.find((l) => l.type === "symbol")?.id;

  // Baked heat + canopy image overlays (no runtime SITG calls). Each is added
  // independently so a missing one never blocks the other.
  try {
    const ov = await (await fetch(BASE + "data/overlays.json")).json();
    if (ov.heat) {
      map.addSource("heat", { type: "image", url: BASE + "data/heat.png", coordinates: ov.heat });
      map.addLayer({ id: "heat", type: "raster", source: "heat", paint: { "raster-opacity": 0.78, "raster-resampling": "linear", "raster-fade-duration": 500 } }, firstSymbol);
    } else { ($("ly-heat") as HTMLInputElement).checked = false; $("legend").classList.add("hidden"); }
  } catch (e) { console.warn("overlays not available", e); }

  // Tree canopy as crisp VECTOR polygons (LiDAR crowns) — the organic look of the
  // cantonal app. Streamed from a single PMTiles file via HTTP range requests.
  try {
    const pm = "pmtiles://" + new URL(BASE + "data/canopy.pmtiles", location.href).href;
    map.addSource("canopy", { type: "vector", url: pm });
    // two-tone by tree height (H_MEAN, metres): low scrub light, tall crowns dark
    const heightColor: any = ["interpolate", ["linear"], ["coalesce", ["get", "H_MEAN"], 8],
      3, "#bfe3ad", 8, "#82c863", 15, "#46a14b", 25, "#2c7a39"];
    map.addLayer({
      id: "canopy-fill", type: "fill", source: "canopy", "source-layer": "canopy",
      layout: { visibility: "none" },
      paint: { "fill-color": heightColor, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 12, 0.4, 16, 0.6] },
    }, firstSymbol);
    map.addLayer({
      id: "canopy-outline", type: "line", source: "canopy", "source-layer": "canopy",
      layout: { visibility: "none" },
      paint: { "line-color": "#2c7a39", "line-width": ["interpolate", ["linear"], ["zoom"], 13, 0.3, 16, 0.9], "line-opacity": 0.5 },
    }, firstSymbol);
  } catch (e) { console.warn("canopy vector not available", e); }

  map.addSource("fastest", { type: "geojson", data: fc([]) });
  map.addSource("route", { type: "geojson", data: fc([]) });
  map.addSource("fountains", { type: "geojson", data: fc([]) });

  map.addLayer({ id: "fastest", type: "line", source: "fastest", layout: { "line-cap": "round" }, paint: { "line-color": "#6b7a85", "line-width": 3, "line-dasharray": [1.4, 1.6], "line-opacity": 0.75 } });
  map.addLayer({ id: "route-glow", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-width": ["interpolate", ["linear"], ["zoom"], 11, 10, 16, 22], "line-color": petRamp(), "line-blur": 8, "line-opacity": 0.45 } });
  map.addLayer({ id: "route-casing", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 11, 6, 16, 11] } });
  map.addLayer({ id: "route", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-width": ["interpolate", ["linear"], ["zoom"], 11, 3.5, 16, 7], "line-color": petRamp() } });
  map.addLayer({ id: "fountains", type: "circle", source: "fountains", paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, ["case", ["get", "near"], 4, 2], 16, ["case", ["get", "near"], 7, 4]], "circle-color": ["case", ["==", ["get", "t"], "d"], "#2f9ed8", "#7fcfc6"], "circle-stroke-color": "#fff", "circle-stroke-width": ["case", ["get", "near"], 2, 1], "circle-opacity": ["case", ["get", "near"], 1, 0.55] } });

  loadFountains();
  updateLegend();
  // place markers for endpoints already parsed from the URL, then enable drawing
  if (state.a) { placeMarker("a", state.a); ($("from") as HTMLInputElement).value = t("pin_shared"); }
  if (state.b) { placeMarker("b", state.b); ($("to") as HTMLInputElement).value = t("pin_shared"); }
  mapReady = true;
  maybeRoute();
});

map.on("click", (e) => {
  // a tap on a fountain identifies it instead of setting a route point
  if (map.getLayer("fountains")) {
    const hits = map.queryRenderedFeatures(
      [[e.point.x - 9, e.point.y - 9], [e.point.x + 9, e.point.y + 9]] as any,
      { layers: ["fountains"] });
    if (hits.length) {
      const f = hits[0] as any;
      new maplibregl.Popup({ offset: 12, closeButton: false, className: "foun-pop" })
        .setLngLat(f.geometry.coordinates.slice())
        .setHTML(`<b>${f.properties.t === "d" ? t("foun_drink") : t("foun_feat")}</b>`)
        .addTo(map);
      return;
    }
  }
  const pt: [number, number] = [e.lngLat.lng, e.lngLat.lat];
  if (state.trip === "loop") { setEndpoint("a", pt, t("pin_start")); return; }
  if (!state.a) setEndpoint("a", pt, t("pin_map"));
  else if (!state.b) setEndpoint("b", pt, t("pin_map"));
  else { clearRoute(); setEndpoint("a", pt, t("pin_map")); setEndpoint("b", null, ""); }
});

map.on("mouseenter", "fountains", () => { map.getCanvas().style.cursor = "pointer"; });
map.on("mouseleave", "fountains", () => { map.getCanvas().style.cursor = ""; });

// ---------- markers ----------
const markers: Record<"a" | "b", maplibregl.Marker | null> = { a: null, b: null };
function placeMarker(which: "a" | "b", pt: [number, number]) {
  if (markers[which]) { markers[which]!.remove(); markers[which] = null; }
  const el = document.createElement("div"); el.className = `mk ${which}`;
  const mk = new maplibregl.Marker({ element: el, draggable: true, anchor: "bottom" }).setLngLat(pt).addTo(map);
  mk.on("dragend", () => { const ll = mk.getLngLat(); state[which] = [ll.lng, ll.lat]; ($(which === "a" ? "from" : "to") as HTMLInputElement).value = state.trip === "loop" ? t("pin_start") : t("pin_map"); if (state.trip === "loop") generateLoop(); else maybeRoute(); });
  markers[which] = mk;
}
function setEndpoint(which: "a" | "b", pt: [number, number] | null, label: string) {
  state[which] = pt;
  ($(which === "a" ? "from" : "to") as HTMLInputElement).value = pt ? label : "";
  if (pt) placeMarker(which, pt);
  else if (markers[which]) { markers[which]!.remove(); markers[which] = null; }
  maybeRoute();
}

// ---------- routing + drawing ----------
let drawSeq = 0;
async function generateLoop() {
  if (!state.meta || !mapReady) return;
  if (!state.a) { $("msg").textContent = t("msg_set_start"); return; }
  const km = parseInt(($("loop-dist") as HTMLInputElement).value, 10);
  const seq = ++drawSeq;
  document.body.classList.add("routing");
  $("msg").textContent = t("msg_finding");
  const r = await loopRoute(state.a, km * 1000, state.mode, state.s, loopSeed++);
  if (seq !== drawSeq) return;
  document.body.classList.remove("routing");
  if (!r.ok) { $("msg").textContent = t("msg_no_loop"); clearLines(); return; }
  $("msg").textContent = "";
  drawRoute(r.chosen as RouteResult, r.chosen as RouteResult, true);
}

async function maybeRoute() {
  if (state.trip === "loop") return; // loops are generated on demand via the button
  syncUrl();
  if (!state.a || !state.b || !state.meta || !mapReady) return;
  const seq = ++drawSeq;
  document.body.classList.add("routing");
  $("msg").textContent = "";
  const r = await route(state.a, state.b, state.mode, state.s);
  if (seq !== drawSeq) return; // superseded
  document.body.classList.remove("routing");
  if (!r.ok) { $("msg").textContent = t("msg_no_route"); clearLines(); return; }
  drawRoute(r.chosen as RouteResult, r.fastest as RouteResult);
}

function drawRoute(chosen: RouteResult, fastest: RouteResult, isLoop = false) {
  // chosen, colored by PET per segment
  const feats = [] as any[];
  for (let i = 0; i < chosen.coords.length - 1; i++) {
    feats.push({ type: "Feature", properties: { pet: chosen.segPet[i] }, geometry: { type: "LineString", coordinates: [chosen.coords[i], chosen.coords[i + 1]] } });
  }
  (map.getSource("route") as maplibregl.GeoJSONSource).setData(fc(feats));
  const showFastest = !isLoop && state.s > 0 && fastest.distance > 0 && Math.abs(fastest.distance - chosen.distance) > 5;
  (map.getSource("fastest") as maplibregl.GeoJSONSource).setData(
    showFastest ? fc([{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: fastest.coords } }]) : fc([]));
  updateStats(chosen, fastest, isLoop);
  markNearFountains(chosen.coords);
  fitTo(chosen.coords);
  renderProfile(chosen);
}

// ---------- thermal profile ribbon ("Profil thermique") ----------
let scrubMk: maplibregl.Marker | null = null;
function showScrub(ll: [number, number]) {
  if (!scrubMk) { const d = document.createElement("div"); d.className = "scrub-dot"; scrubMk = new maplibregl.Marker({ element: d }).setLngLat(ll).addTo(map); }
  else { scrubMk.setLngLat(ll); (scrubMk.getElement() as HTMLElement).style.display = "block"; }
}
function hideScrub() { if (scrubMk) (scrubMk.getElement() as HTMLElement).style.display = "none"; }
function segLen(p: [number, number], q: [number, number]) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (q[1] - p[1]) * r, dLng = (q[0] - p[0]) * r, la1 = p[1] * r, la2 = q[1] * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
function petColor(pet: number, lo: number, hi: number) {
  const t = Math.max(0, Math.min(1, (pet - lo) / (hi - lo)));
  const stops: [number, number[]][] = [[0, [42, 167, 201]], [.25, [92, 201, 166]], [.5, [244, 183, 64]], [.75, [238, 123, 52]], [1, [226, 59, 46]]];
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) if (t >= stops[i][0] && t <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
  const f = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
  const ch = (k: number) => Math.round(a[1][k] + (b[1][k] - a[1][k]) * f);
  return `rgb(${ch(0)},${ch(1)},${ch(2)})`;
}
function renderProfile(chosen: RouteResult) {
  const m = state.meta, coords = chosen.coords, el = $("profile");
  if (!m || coords.length < 2) { el.classList.add("hidden"); return; }
  const lo = m.petLo, hi = m.petHi;
  const segShade = chosen.segShade ?? [], hasShade = segShade.length > 0;
  const cum = [0];
  for (let i = 0; i < coords.length - 1; i++) cum.push(cum[i] + segLen(coords[i], coords[i + 1]));
  const total = cum[cum.length - 1] || 1;
  const N = 80, pet: number[] = [], shd: number[] = [];
  let j = 0;
  for (let k = 0; k <= N; k++) { const d = (k / N) * total; while (j < cum.length - 2 && cum[j + 1] < d) j++; pet.push(chosen.segPet[Math.min(j, chosen.segPet.length - 1)]); shd.push(hasShade ? segShade[Math.min(j, segShade.length - 1)] : 0); }
  const sm = (a: number[]) => a.map((v, i) => ((a[i - 1] ?? v) + v + (a[i + 1] ?? v)) / 3);
  const petNorm = pet.map((p) => Math.max(0, Math.min(1, (p - lo) / (hi - lo))));
  const comfort = sm(petNorm.map((v) => 1 - v));  // PET ribbon: fat where cool, thin where hot
  const shade = sm(shd.map((v) => Math.max(0, Math.min(1, v))));
  const cool = sm(petNorm.map((pn, i) => 1 - (m.wHeat * pn + m.wShade * (1 - (shd[i] || 0)))));
  el.classList.remove("hidden");
  const W = Math.max(220, (el.clientWidth || 320) - 28);
  const lerpc = (a: number[], b: number[], tt: number) => `rgb(${Math.round(a[0] + (b[0] - a[0]) * tt)},${Math.round(a[1] + (b[1] - a[1]) * tt)},${Math.round(a[2] + (b[2] - a[2]) * tt)})`;
  const green = (k: number) => lerpc([214, 234, 205], [38, 110, 52], shade[k]);
  const comp = (k: number) => lerpc([201, 96, 64], [31, 158, 143], cool[k]);
  const ribbon = (mag: number[], fill: (k: number) => string, accent: string, fid: string, H = 28) => {
    const mid = H / 2, maxR = H / 2 - 1, xs = (k: number) => (k / N) * W;
    let c = "";
    for (let k = 0; k <= N; k++) { const r = (1 + Math.max(0, Math.min(1, mag[k])) * (maxR - 1)).toFixed(1); c += `<circle cx="${xs(k).toFixed(1)}" cy="${mid}" r="${r}" fill="${fill(k)}"/>`; }
    return `<svg class="pf-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs><filter id="${fid}" x="-2%" y="-40%" width="104%" height="180%"><feGaussianBlur stdDeviation="0.9"/></filter></defs><line x1="2" y1="${mid}" x2="${(W - 2).toFixed(1)}" y2="${mid}" stroke="${accent}" stroke-width="1.2" stroke-opacity="0.4" stroke-linecap="round"/><g filter="url(#${fid})" fill-opacity="0.4">${c}</g></svg>`;
  };
  const mk = (icon: string, label: string, accent: string, svg: string) => `<div class="pf-row"><span class="pf-rl" style="color:${accent}">${icon} ${label}</span>${svg}</div>`;
  let rows = mk("🌡️", t("pf_heat"), "#d97b3f", ribbon(comfort, (k) => petColor(pet[k], lo, hi), "#d97b3f", "pffP"));
  const shadeLabel = shadeReady ? t("pf_shade_time", state.time.h) : t("pf_shade");
  if (hasShade) rows += mk("🌳", shadeLabel, "#2c7a39", ribbon(shade, green, "#2c7a39", "pffS")) + mk("⚖️", t("pf_score"), "#1f9e8f", ribbon(cool, comp, "#1f9e8f", "pffC"));
  el.innerHTML = `<div class="pf-title">${t("pf_title")} <span>· ${t("pf_sub")}</span></div><div class="pf-rows">${rows}<div class="pf-cursor"></div><div class="pf-tip"></div></div><div class="pf-ends"><span>${t("lbl_from")}</span><span>${t("lbl_to")}</span></div>`;
  const rowsEl = el.querySelector(".pf-rows") as HTMLElement, cursor = el.querySelector(".pf-cursor") as HTMLElement, tip = el.querySelector(".pf-tip") as HTMLElement;
  const move = (cx: number) => {
    const r = rowsEl.getBoundingClientRect(); let f = (cx - r.left) / r.width; f = Math.max(0, Math.min(1, f));
    const dd = f * total; let jj = 0; while (jj < cum.length - 2 && cum[jj + 1] < dd) jj++;
    const s0 = cum[jj], s1 = cum[jj + 1], tt = s1 > s0 ? (dd - s0) / (s1 - s0) : 0, a = coords[jj], b = coords[jj + 1];
    showScrub([a[0] + (b[0] - a[0]) * tt, a[1] + (b[1] - a[1]) * tt]);
    cursor.style.display = "block"; cursor.style.left = f * r.width + "px";
    const pp = chosen.segPet[Math.min(jj, chosen.segPet.length - 1)], nn = Math.max(0, Math.min(1, (pp - lo) / (hi - lo)));
    const lvl = nn < .25 ? t("lvl_low") : nn < .5 ? t("lvl_mod") : nn < .75 ? t("lvl_high") : t("lvl_sev");
    const sp = hasShade ? ` · 🌳 ${Math.round(segShade[Math.min(jj, segShade.length - 1)] * 100)}%` : "";
    tip.textContent = `🌡️ ${lvl}${sp}`;
    tip.style.display = "block"; tip.style.left = f * r.width + "px";
  };
  rowsEl.onpointermove = (e) => move((e as PointerEvent).clientX);
  rowsEl.onpointerleave = () => { cursor.style.display = "none"; tip.style.display = "none"; hideScrub(); };
}

function updateStats(c: RouteResult, f: RouteResult, isLoop = false) {
  lastResult = { c, f, isLoop };
  $("stats").classList.remove("hidden");
  $("gpx").classList.remove("hidden");
  $("st-dist").textContent = c.distance >= 1000 ? (c.distance / 1000).toFixed(1) + " km" : Math.round(c.distance) + " m";
  $("st-time").textContent = Math.max(1, Math.round(c.seconds / 60)) + " min";
  // Relative heat EXPOSURE (where the route sits in the heat pattern) — not a fake
  // absolute temperature. Actual air temp is shown live in the conditions chip.
  const m = state.meta!;
  const petNorm = Math.min(1, Math.max(0, (c.avgPet - m.petLo) / (m.petHi - m.petLo)));
  const lv = petNorm < 0.25 ? [t("lvl_low"), "#2aa7c9"] : petNorm < 0.5 ? [t("lvl_mod"), "#36b39a"]
    : petNorm < 0.75 ? [t("lvl_high"), "#ee7b34"] : [t("lvl_sev"), "#e23b2e"];
  const pe = $("st-pet");
  pe.textContent = lv[0]; pe.style.color = lv[1];
  pe.title = `PET ≈ ${c.avgPet.toFixed(0)}° (modelled, hot afternoon)`;
  $("st-shade").textContent = c.canopyPct.toFixed(0) + "%";  // true tree cover (time-independent)
  const hero = $("hero");
  if (isLoop) {
    hero.classList.remove("hidden");
    hero.innerHTML = t("hero_loop", (c.distance / 1000).toFixed(1), c.canopyPct.toFixed(0));
    return;
  }
  if (state.s > 0 && f.distance > 0) {
    // Percentage reduction in relative heat EXPOSURE vs the fastest route (no fake
    // °C anchor): exposure = normalised PET within the city's heat band.
    const norm = (pet: number) => Math.min(1, Math.max(0, (pet - m.petLo) / (m.petHi - m.petLo)));
    const nf = norm(f.avgPet), nc = norm(c.avgPet);
    const pctCooler = nf > 0.06 ? Math.round(((nf - nc) / nf) * 100) : 0;
    const dShade = Math.round(c.shadePct - f.shadePct);
    const dDist = c.distance - f.distance;
    const parts: string[] = [];
    if (pctCooler >= 5) parts.push(t("hero_heat", pctCooler));
    if (dShade >= 3) parts.push(t("hero_shade_more", dShade));
    if (parts.length) {
      hero.classList.remove("hidden");
      const extra = dDist > 20 ? `+${dDist >= 1000 ? (dDist / 1000).toFixed(1) + " km" : Math.round(dDist) + " m"}` : t("extra_none");
      hero.innerHTML = `🌳 ${parts.join(" · ")} — ${t("hero_for", extra)}`;
    } else { hero.classList.add("hidden"); }
  } else { hero.classList.add("hidden"); }
}

function downloadGPX() {
  if (!lastResult) return;
  const coords = lastResult.c.coords;
  const isLoop = lastResult.isLoop;
  const name = `shadePath ${isLoop ? "loop" : "route"} (${state.mode})`;
  const pts = coords.map((c) => `<trkpt lat="${c[1].toFixed(6)}" lon="${c[0].toFixed(6)}"/>`).join("\n");
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="shadePath" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${name}</name><time>${new Date().toISOString()}</time></metadata>
<trk><name>${name}</name><trkseg>
${pts}
</trkseg></trk>
</gpx>`;
  const url = URL.createObjectURL(new Blob([gpx], { type: "application/gpx+xml" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `shadepath-${isLoop ? "loop" : "route"}-${state.mode}.gpx`;
  a.click();
  URL.revokeObjectURL(url);
}

function clearLines() {
  (map.getSource("route") as maplibregl.GeoJSONSource)?.setData(fc([]));
  (map.getSource("fastest") as maplibregl.GeoJSONSource)?.setData(fc([]));
  $("profile").classList.add("hidden"); hideScrub();
}
function clearRoute() { clearLines(); $("stats").classList.add("hidden"); $("hero").classList.add("hidden"); $("gpx").classList.add("hidden"); }

// ---------- nearest cool spot (route to the closest drinking fountain) ----------
function getGeo(): Promise<[number, number] | null> {
  return new Promise((res) => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(
      (p) => res([p.coords.longitude, p.coords.latitude]),
      () => res(null),
      { enableHighAccuracy: true, timeout: 7000, maximumAge: 60000 });
  });
}
async function nearestCoolSpot() {
  if (!state.meta || !mapReady || !fountainData.length) return;
  if (state.trip === "loop") setTrip("ab"); // route A -> fountain, not a loop
  let origin = state.a;
  if (!origin) {
    $("msg").textContent = t("msg_locating");
    origin = await getGeo();
    $("msg").textContent = "";
  }
  if (!origin) origin = [map.getCenter().lng, map.getCenter().lat];
  const mPL = state.meta.mPerLng, mPLa = state.meta.mPerLat;
  const pick = (drinkOnly: boolean) => {
    let best: any = null, bd = Infinity;
    for (const f of fountainData) {
      if (drinkOnly && f.properties.t !== "d") continue;
      const [fx, fy] = f.geometry.coordinates;
      const dx = (fx - origin![0]) * mPL, dy = (fy - origin![1]) * mPLa, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = f; }
    }
    return best;
  };
  const f = pick(true) || pick(false);
  if (!f) { $("msg").textContent = t("msg_no_water"); return; }
  setEndpoint("a", origin, t("pin_you"));
  setEndpoint("b", f.geometry.coordinates.slice() as [number, number], t("pin_water"));
  new maplibregl.Popup({ offset: 12, closeButton: false, className: "foun-pop" })
    .setLngLat(f.geometry.coordinates.slice())
    .setHTML(`<b>${f.properties.t === "d" ? t("foun_drink") : t("foun_feat")}</b>`)
    .addTo(map);
}

// ---------- live conditions (honest framing for the heat pattern) ----------
async function fetchWeather() {
  try {
    const w = await (await fetch("https://api.open-meteo.com/v1/forecast?latitude=46.2&longitude=6.14&current=temperature_2m&hourly=temperature_2m&daily=temperature_2m_max&forecast_days=1&timezone=auto")).json();
    lastWeather = { now: Math.round(w.current.temperature_2m), max: Math.round(w.daily.temperature_2m_max[0]), hours: (w.hourly?.temperature_2m || []).map((x: number) => Math.round(x)) };
    renderConditions();
  } catch { /* offline — leave hidden */ }
}
function renderConditions() {
  if (!lastWeather) return;
  const emoji = lastWeather.max >= 30 ? "🥵" : lastWeather.max >= 24 ? "☀️" : "🌤️";
  const el = $("conditions"); el.classList.remove("hidden");
  const gn = genevaNow();
  const today = state.time.y === gn.y && state.time.m === gn.m && state.time.d === gn.d;
  if (state.timeNow || !lastWeather.hours.length) {
    el.innerHTML = t("cond", emoji, lastWeather.now, lastWeather.max);
  } else {
    const tH = today && lastWeather.hours[state.time.h] != null ? lastWeather.hours[state.time.h] : lastWeather.now;
    el.innerHTML = t("cond_at", emoji, tH, state.time.h, lastWeather.max);
  }
}

// ---------- fountains ----------
let fountainData: any[] = [];
async function loadFountains() {
  try {
    const pts = await (await fetch(BASE + "data/fountains.json")).json();
    fountainData = pts.map((p: any) => ({ type: "Feature", properties: { t: p.t, near: false }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } }));
    (map.getSource("fountains") as maplibregl.GeoJSONSource).setData(fc(fountainData));
  } catch { /* ignore */ }
}
function markNearFountains(coords: [number, number][]) {
  if (!fountainData.length || !state.meta) return;
  const mPL = state.meta.mPerLng, mPLa = state.meta.mPerLat, R2 = 60 * 60;
  for (const f of fountainData) {
    const [fx, fy] = f.geometry.coordinates; let near = false;
    for (let i = 0; i < coords.length; i += 2) {
      const ex = (coords[i][0] - fx) * mPL, ey = (coords[i][1] - fy) * mPLa;
      if (ex * ex + ey * ey < R2) { near = true; break; }
    }
    f.properties.near = near;
  }
  (map.getSource("fountains") as maplibregl.GeoJSONSource).setData(fc(fountainData));
}

// ---------- helpers ----------
function fc(features: any[]) { return { type: "FeatureCollection", features } as any; }
function petRamp(): any {
  const lo = state.meta?.petLo ?? 30, hi = state.meta?.petHi ?? 42, mid = (lo + hi) / 2;
  return ["interpolate", ["linear"], ["get", "pet"],
    lo, "#2aa7c9", lo + (mid - lo) / 2, "#5cc9a6", mid, "#f4b740", mid + (hi - mid) / 2, "#ee7b34", hi, "#e23b2e"];
}
function updateLegend() {
  /* legend uses fixed frais/chaud end labels now, no numeric °C values */
}
function fitTo(coords: [number, number][]) {
  const b = new maplibregl.LngLatBounds(coords[0], coords[0]);
  for (const c of coords) b.extend(c);
  map.fitBounds(b, { padding: { top: 60, bottom: 60, left: 380, right: 60 }, maxZoom: 16, duration: 600 });
}

// ---------- UI wiring ----------
function setModeUI(m: Mode) {
  state.mode = m;
  $("mode-bike").classList.toggle("active", m === "bike");
  $("mode-walk").classList.toggle("active", m === "walk");
  updateLoopMax();
}
function setMode(m: Mode) { setModeUI(m); maybeRoute(); }
$("mode-bike").onclick = () => setMode("bike");
$("mode-walk").onclick = () => setMode("walk");

// ---------- trip type (A→B vs shady loop) ----------
function updateLoopMax() {
  const el = $("loop-dist") as HTMLInputElement;
  const max = state.mode === "bike" ? 45 : 25;
  el.max = String(max);
  if (+el.value > max) { el.value = String(max); }
  $("loop-dist-val").textContent = el.value + " km";
}
function setTrip(trip: Trip) {
  state.trip = trip;
  $("trip-ab").classList.toggle("active", trip === "ab");
  $("trip-loop").classList.toggle("active", trip === "loop");
  $("pp-fields").classList.toggle("hidden", trip === "loop");
  $("loop-ctrl").classList.toggle("hidden", trip !== "loop");
  $("slider-wrap").classList.toggle("hidden", trip === "loop"); // loops always maximise shade
  $("from-label").textContent = trip === "loop" ? t("lbl_from_loop") : t("lbl_from");
  clearRoute(); clearLines();
  if (trip === "ab") maybeRoute();
}
$("trip-ab").onclick = () => setTrip("ab");
$("trip-loop").onclick = () => setTrip("loop");
($("loop-dist") as HTMLInputElement).addEventListener("input", (e) => {
  $("loop-dist-val").textContent = (e.target as HTMLInputElement).value + " km";
});
$("loop-go").onclick = () => generateLoop();
$("coolspot").onclick = () => nearestCoolSpot();
$("gpx").onclick = () => downloadGPX();
$("sheet-handle").onclick = () => $("panel").classList.toggle("collapsed");
$("panel-toggle").onclick = () => { const c = $("panel").classList.toggle("panel-collapsed"); $("panel-toggle").textContent = c ? "›" : "‹"; };

let slideT: number | undefined;
($("cool") as HTMLInputElement).addEventListener("input", (e) => {
  state.s = parseInt((e.target as HTMLInputElement).value, 10) / 100;
  clearTimeout(slideT); slideT = window.setTimeout(maybeRoute, 60);
});

// ---------- time of day ----------
function updateTimeUI() {
  const { y, m, d, h } = state.time, z = (n: number) => String(n).padStart(2, "0");
  ($("t-date") as HTMLInputElement).value = `${y}-${z(m)}-${z(d)}`;
  ($("t-hour") as HTMLInputElement).value = String(h);
  $("t-hourval").textContent = `${h}h`;
  const sp = sunForGeneva(y, m, d, h);
  const dirs = getLang() === "fr" ? ["N", "NE", "E", "SE", "S", "SO", "O", "NO"] : ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const dir = dirs[Math.round(sp.az / 45) % 8];
  $("sun-ind").textContent = sp.el > 0 ? `☀️ ${Math.round(sp.el)}° ${dir}` : `🌙 ${t("sun_night")}`;
  $("t-now").classList.toggle("active", state.timeNow);
  maybeSunLight(); // keep the 3D light in sync with the chosen hour
}
function applyTime() {
  state.timeNow = false; updateTimeUI();
  if (state.trip === "loop") generateLoop(); else maybeRoute();
}
($("t-hour") as HTMLInputElement).addEventListener("input", () => { $("t-hourval").textContent = ($("t-hour") as HTMLInputElement).value + "h"; });
($("t-hour") as HTMLInputElement).addEventListener("change", () => { state.time = { ...state.time, h: parseInt(($("t-hour") as HTMLInputElement).value, 10) }; applyTime(); });
($("t-date") as HTMLInputElement).addEventListener("change", () => { const v = ($("t-date") as HTMLInputElement).value; if (v) { const [y, m, d] = v.split("-").map(Number); state.time = { y, m, d, h: state.time.h }; } applyTime(); });
$("t-now").onclick = () => { state.time = genevaNow(); state.timeNow = true; updateTimeUI(); if (state.trip === "loop") generateLoop(); else maybeRoute(); };

$("swap").onclick = () => {
  const a = state.a, b = state.b;
  setEndpoint("a", b, b ? "📍 map point" : "");
  setEndpoint("b", a, a ? "📍 map point" : "");
};

// when canopy raster is on, ease off the heat layer so both read
function setLayer(id: string, on: boolean) { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none"); }
($("ly-heat") as HTMLInputElement).onchange = (e) => { const on = (e.target as HTMLInputElement).checked; setLayer("heat", on); $("legend").classList.toggle("hidden", !on); };
($("ly-shade") as HTMLInputElement).onchange = (e) => { const on = (e.target as HTMLInputElement).checked; setLayer("canopy-fill", on); setLayer("canopy-outline", on); };
($("ly-fount") as HTMLInputElement).onchange = (e) => setLayer("fountains", (e.target as HTMLInputElement).checked);

// ---------- 3D buildings (extrude OpenFreeMap heights; light follows the sun) ----------
let is3D = false;
let buildings3dAdded = false;
function addBuildingsLayer() {
  const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
  map.addLayer({
    id: "buildings3d", type: "fill-extrusion", source: "openmaptiles", "source-layer": "building", minzoom: 13,
    filter: ["!=", ["get", "hide_3d"], true],
    paint: {
      "fill-extrusion-color": ["interpolate", ["linear"], ["coalesce", ["get", "render_height"], 0], 0, "#e7ddcb", 25, "#d3c7b2", 60, "#b9ab92"],
      "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 13, 0, 14.5, ["coalesce", ["get", "render_height"], 0]],
      "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
      "fill-extrusion-vertical-gradient": true,
      "fill-extrusion-opacity": 0.95,
    },
  }, firstSymbol);
}
function maybeSunLight() {
  if (!mapReady || !is3D) return;
  const { y, m, d, h } = state.time;
  const sp = sunForGeneva(y, m, d, h); // real solar position -> already date-aware (declination = season)
  // "Daytime-ness": keyed to the real elevation, so day -> dusk -> night follows the actual
  // (date-dependent) sunrise/sunset. Stays ~1 while the sun is comfortably up, eases to 0 at night.
  const day = Math.max(0, Math.min(1, (sp.el + 4) / 12));
  // Direction = real sun azimuth, but don't let the light graze so low that rooftops go dark
  // through the long summer evenings: clamp the lighting elevation to a readable floor.
  const polar = Math.max(4, Math.min(82, 90 - Math.max(sp.el, 33)));
  const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
  const mix = (c1: number[], c2: number[], t: number) =>
    `rgb(${lerp(c1[0], c2[0], t)},${lerp(c1[1], c2[1], t)},${lerp(c1[2], c2[2], t)})`;
  const color = mix([150, 161, 199], [255, 247, 236], day); // dusk/night blue -> warm daylight
  const intensity = 0.18 + 0.34 * day;                      // ~0.52 by day, ~0.18 at night
  map.setLight({ anchor: "map", color, intensity, position: [1.5, sp.az, polar] });
}
function set3D(on: boolean) {
  is3D = on;
  if (on && !buildings3dAdded) { addBuildingsLayer(); buildings3dAdded = true; }
  setLayer("buildings3d", on);
  maybeSunLight();
  const cam: any = { pitch: on ? 55 : 0, duration: 800, essential: true };
  if (on && map.getZoom() < 14.5) cam.zoom = 15.5; // fly in so buildings are visible
  map.easeTo(cam);
}
$("view3d").onclick = () => { set3D(!is3D); $("view3d").classList.toggle("active", is3D); $("view3d").textContent = is3D ? "2D" : "3D"; };

// ---------- geocode autocomplete ----------
function wireSearch(inputId: string, sugId: string, which: "a" | "b") {
  const input = $(inputId) as HTMLInputElement;
  const sug = $(sugId) as HTMLUListElement;
  let t: number | undefined;
  input.addEventListener("input", () => {
    clearTimeout(t);
    const q = input.value;
    if (q.startsWith("📍")) return;
    t = window.setTimeout(async () => {
      const places = await geocode(q);
      renderSug(sug, places, (p) => {
        input.value = p.label; sug.classList.remove("open");
        setEndpoint(which, [p.lng, p.lat], p.label);
        map.flyTo({ center: [p.lng, p.lat], zoom: 14 });
      });
    }, 200);
  });
  input.addEventListener("focus", () => { if (sug.children.length) sug.classList.add("open"); });
  document.addEventListener("click", (e) => { if (!sug.contains(e.target as Node) && e.target !== input) sug.classList.remove("open"); });
}
function renderSug(ul: HTMLUListElement, places: Place[], pick: (p: Place) => void) {
  ul.innerHTML = "";
  if (!places.length) { ul.classList.remove("open"); return; }
  for (const p of places) {
    const li = document.createElement("li"); li.textContent = p.label;
    li.onclick = () => pick(p); ul.appendChild(li);
  }
  ul.classList.add("open");
}
wireSearch("from", "from-sug", "a");
wireSearch("to", "to-sug", "b");

// ---------- shareable URL ----------
function syncUrl() {
  const p = new URLSearchParams();
  p.set("m", state.mode); p.set("s", String(Math.round(state.s * 100)));
  if (state.a) p.set("a", state.a.map((x) => x.toFixed(5)).join(","));
  if (state.b) p.set("b", state.b.map((x) => x.toFixed(5)).join(","));
  if (!state.timeNow) { const z = (n: number) => String(n).padStart(2, "0"); p.set("t", `${state.time.y}${z(state.time.m)}${z(state.time.d)}${z(state.time.h)}`); }
  history.replaceState(null, "", "?" + p.toString());
}
// Parse the shareable URL into state SYNCHRONOUSLY at startup, before the worker
// or map can fire maybeRoute()->syncUrl() and overwrite the params. Markers are
// placed later (on map load); here we only populate state + the slider/mode UI.
function parseUrlIntoState() {
  const p = new URLSearchParams(location.search);
  setModeUI(p.get("m") === "bike" ? "bike" : "walk");
  if (p.get("s")) {
    state.s = Math.min(1, Math.max(0, parseInt(p.get("s")!, 10) / 100));
    ($("cool") as HTMLInputElement).value = String(Math.round(state.s * 100));
  }
  const pt = p.get("t");
  if (pt && /^\d{10}$/.test(pt)) { state.time = { y: +pt.slice(0, 4), m: +pt.slice(4, 6), d: +pt.slice(6, 8), h: +pt.slice(8, 10) }; state.timeNow = false; }
  const pa = p.get("a")?.split(",").map(Number);
  const pb = p.get("b")?.split(",").map(Number);
  if (pa?.length === 2 && pa.every(Number.isFinite)) state.a = [pa[0], pa[1]];
  if (pb?.length === 2 && pb.every(Number.isFinite)) state.b = [pb[0], pb[1]];
}
// ---------- language (FR default) ----------
function applyLang() {
  const lang = getLang();
  document.documentElement.lang = lang;
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n!); });
  document.querySelectorAll<HTMLInputElement>("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh!); });
  document.querySelectorAll<HTMLElement>("[data-i18n-html]").forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml!); });
  $("from-label").textContent = state.trip === "loop" ? t("lbl_from_loop") : t("lbl_from");
  $("lang-fr").classList.toggle("active", lang === "fr");
  $("lang-en").classList.toggle("active", lang === "en");
  for (const which of ["a", "b"] as const) {
    const inp = $(which === "a" ? "from" : "to") as HTMLInputElement;
    if (inp.value.startsWith("📍")) inp.value = state.trip === "loop" && which === "a" ? t("pin_start") : t("pin_map");
  }
  renderConditions();
  updateTimeUI();
  if (lastResult) { updateStats(lastResult.c, lastResult.f, lastResult.isLoop); renderProfile(lastResult.c); }
}
$("lang-fr").onclick = () => { setLang("fr"); applyLang(); };
$("lang-en").onclick = () => { setLang("en"); applyLang(); };

parseUrlIntoState();
applyLang();
updateTimeUI();
fetchWeather();
