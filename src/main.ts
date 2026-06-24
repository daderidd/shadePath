import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";

maplibregl.addProtocol("pmtiles", new Protocol().tile);
import { geocode, Place } from "./geocode";
import { t, getLang, setLang } from "./i18n";
import type { Meta } from "./routing/graph";
import type { RouteResult } from "./routing/worker";

// Absolute base so fetches resolve against the PAGE (not the worker script's /assets/
// path) — required for GitHub Pages project subpaths like /shadePath/.
const BASE = new URL(import.meta.env.BASE_URL, location.href).href;

type Mode = "bike" | "walk";
type Trip = "ab" | "loop";
interface State { mode: Mode; trip: Trip; s: number; a: [number, number] | null; b: [number, number] | null; meta: Meta | null; }
const state: State = { mode: "bike", trip: "ab", s: 0.65, a: null, b: null, meta: null };
let loopSeed = 1;
let lastResult: { c: RouteResult; f: RouteResult; isLoop: boolean } | null = null;
let lastWeather: { now: number; max: number } | null = null;

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
    maybeRoute();
  }
  else if (m.type === "error") { console.error("[worker] init error:", m.error); $("msg").textContent = t("msg_load_fail"); }
  else if (m.type === "route") { const cb = pending.get(m.reqId); if (cb) { pending.delete(m.reqId); cb(m); } }
};
worker.onerror = (e) => console.error("[worker] onerror:", e.message, e.filename, e.lineno);
worker.postMessage({ type: "init", base: BASE });

function route(a: [number, number], b: [number, number], mode: Mode, s: number): Promise<any> {
  const id = ++reqId;
  return new Promise((res) => { pending.set(id, res); worker.postMessage({ type: "route", reqId: id, a, b, mode: mode === "walk" ? "foot" : "bike", s }); });
}
function loopRoute(start: [number, number], targetM: number, mode: Mode, s: number, seed: number): Promise<any> {
  const id = ++reqId;
  return new Promise((res) => { pending.set(id, res); worker.postMessage({ type: "loop", reqId: id, start, targetM, mode: mode === "walk" ? "foot" : "bike", s, seed }); });
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
}

function updateStats(c: RouteResult, f: RouteResult, isLoop = false) {
  lastResult = { c, f, isLoop };
  $("stats").classList.remove("hidden");
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
  $("st-shade").textContent = c.shadePct.toFixed(0) + "%";
  const hero = $("hero");
  if (isLoop) {
    hero.classList.remove("hidden");
    hero.innerHTML = t("hero_loop", (c.distance / 1000).toFixed(1), c.shadePct.toFixed(0));
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

function clearLines() {
  (map.getSource("route") as maplibregl.GeoJSONSource)?.setData(fc([]));
  (map.getSource("fastest") as maplibregl.GeoJSONSource)?.setData(fc([]));
}
function clearRoute() { clearLines(); $("stats").classList.add("hidden"); $("hero").classList.add("hidden"); }

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
    const w = await (await fetch("https://api.open-meteo.com/v1/forecast?latitude=46.2&longitude=6.14&current=temperature_2m&daily=temperature_2m_max&forecast_days=1&timezone=auto")).json();
    lastWeather = { now: Math.round(w.current.temperature_2m), max: Math.round(w.daily.temperature_2m_max[0]) };
    renderConditions();
  } catch { /* offline — leave hidden */ }
}
function renderConditions() {
  if (!lastWeather) return;
  const emoji = lastWeather.max >= 30 ? "🥵" : lastWeather.max >= 24 ? "☀️" : "🌤️";
  const el = $("conditions"); el.classList.remove("hidden");
  el.innerHTML = t("cond", emoji, lastWeather.now, lastWeather.max);
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
  const lo = state.meta?.petLo ?? 30, hi = state.meta?.petHi ?? 42;
  $("legend-lo").textContent = Math.round(lo) + "°";
  $("legend-hi").textContent = Math.round(hi) + "°";
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
function setTrip(t: Trip) {
  state.trip = t;
  $("trip-ab").classList.toggle("active", t === "ab");
  $("trip-loop").classList.toggle("active", t === "loop");
  $("pp-fields").classList.toggle("hidden", t === "loop");
  $("loop-ctrl").classList.toggle("hidden", t !== "loop");
  $("from-label").textContent = t === "loop" ? "Start / finish" : "From";
  clearRoute(); clearLines();
  if (t === "ab") maybeRoute();
}
$("trip-ab").onclick = () => setTrip("ab");
$("trip-loop").onclick = () => setTrip("loop");
($("loop-dist") as HTMLInputElement).addEventListener("input", (e) => {
  $("loop-dist-val").textContent = (e.target as HTMLInputElement).value + " km";
});
$("loop-go").onclick = () => generateLoop();
$("coolspot").onclick = () => nearestCoolSpot();

let slideT: number | undefined;
($("cool") as HTMLInputElement).addEventListener("input", (e) => {
  state.s = parseInt((e.target as HTMLInputElement).value, 10) / 100;
  clearTimeout(slideT); slideT = window.setTimeout(maybeRoute, 60);
});

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
  history.replaceState(null, "", "?" + p.toString());
}
// Parse the shareable URL into state SYNCHRONOUSLY at startup, before the worker
// or map can fire maybeRoute()->syncUrl() and overwrite the params. Markers are
// placed later (on map load); here we only populate state + the slider/mode UI.
function parseUrlIntoState() {
  const p = new URLSearchParams(location.search);
  setModeUI(p.get("m") === "walk" ? "walk" : "bike");
  if (p.get("s")) {
    state.s = Math.min(1, Math.max(0, parseInt(p.get("s")!, 10) / 100));
    ($("cool") as HTMLInputElement).value = String(Math.round(state.s * 100));
  }
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
  if (lastResult) updateStats(lastResult.c, lastResult.f, lastResult.isLoop);
}
$("lang-fr").onclick = () => { setLang("fr"); applyLang(); };
$("lang-en").onclick = () => { setLang("en"); applyLang(); };

parseUrlIntoState();
applyLang();
fetchWeather();
