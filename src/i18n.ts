// Tiny i18n. French is the default (Geneva); choice persists in localStorage.
export type Lang = "fr" | "en";

type Entry = { fr: string; en: string };
const D: Record<string, Entry> = {
  tagline: { fr: "restez du côté frais de Genève", en: "keep to the cool side of Geneva" },
  mode_bike: { fr: "🚲 Vélo", en: "🚲 Bike" },
  mode_walk: { fr: "🚶 Marche", en: "🚶 Walk" },
  trip_ab: { fr: "A → B", en: "A → B" },
  trip_loop: { fr: "⟳ Boucle ombragée", en: "⟳ Shady loop" },
  lbl_from: { fr: "Départ", en: "From" },
  lbl_from_loop: { fr: "Départ / arrivée", en: "Start / finish" },
  lbl_to: { fr: "Arrivée", en: "To" },
  ph_search: { fr: "Cherchez une adresse ou touchez la carte", en: "Search an address or tap the map" },
  swap: { fr: "⇅ inverser", en: "⇅ swap" },
  loop_dist: { fr: "Distance de la boucle", en: "Loop distance" },
  loop_go: { fr: "⟳ Trouver la boucle la plus ombragée", en: "⟳ Find the shadiest loop" },
  sl_fast: { fr: "⚡ Rapide", en: "⚡ Fastest" },
  sl_cool: { fr: "Frais 🌳", en: "Coolest 🌳" },
  st_distance: { fr: "distance", en: "distance" },
  st_time: { fr: "durée", en: "time" },
  st_exposure: { fr: "exposition", en: "heat exposure" },
  st_trees: { fr: "sous les arbres", en: "under trees" },
  layers: { fr: "Calques de la carte", en: "Map layers" },
  ly_heat: { fr: "🔥 Chaleur (PET, 14h jour chaud)", en: "🔥 Heat (PET, 2pm hot day)" },
  ly_shade: { fr: "🌳 Canopée arborée", en: "🌳 Tree canopy" },
  ly_fount: { fr: "💧 Fontaines", en: "💧 Fountains" },
  legend_title: { fr: "Chaleur à 14h", en: "Heat at 2pm" },
  legend_scale: { fr: "frais · chaud", en: "cooler · hotter" },
  caveat: {
    fr: "La chaleur montre le <b>motif</b> modélisé un après-midi chaud (où sont les îlots) — pas la température actuelle. La valeur du jour est indiquée en haut.",
    en: "Heat shows the modelled <b>pattern</b> on a hot afternoon (where the islands are) — not live temperature. Today's reading is shown up top.",
  },
  credit: {
    fr: 'Chaleur &amp; canopée : <a href="https://sitg.ge.ch" target="_blank" rel="noopener">SITG</a> (PET 2020 / canopée 2023, indicatif). Température : <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a>. Carte &amp; réseau : © <a href="https://openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>. Sans serveur · sans pistage.',
    en: 'Heat &amp; canopy: <a href="https://sitg.ge.ch" target="_blank" rel="noopener">SITG</a> (PET 2020 / canopy 2023, indicative). Temperature: <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a>. Map &amp; network: © <a href="https://openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>. No server · no tracking.',
  },
  // dynamic
  lvl_low: { fr: "Faible", en: "Low" },
  lvl_mod: { fr: "Modérée", en: "Moderate" },
  lvl_high: { fr: "Élevée", en: "High" },
  lvl_sev: { fr: "Sévère", en: "Severe" },
  hero_heat: { fr: "<b>{0}% moins exposé à la chaleur</b>", en: "<b>{0}% less heat exposure</b>" },
  hero_shade_more: { fr: "<b>+{0}% sous les arbres</b>", en: "<b>+{0}% under trees</b>" },
  hero_for: { fr: "pour {0}", en: "for {0}" },
  extra_none: { fr: "aucun détour", en: "no detour" },
  hero_loop: {
    fr: "⟳ Boucle de <b>{0} km</b> · <b>{1}% sous les arbres</b> · la plus ombragée trouvée à cette distance. Touchez encore pour une autre.",
    en: "⟳ <b>{0} km</b> loop · <b>{1}% under trees</b> · the shadiest found at this distance. Tap again for another.",
  },
  cond: { fr: "{0} Genève <b>{1}°</b> maintenant · jusqu'à <b>{2}°</b> aujourd'hui", en: "{0} Geneva <b>{1}°</b> now · up to <b>{2}°</b> today" },
  msg_no_route: { fr: "Aucun itinéraire trouvé entre ces points.", en: "No route found between those points." },
  msg_set_start: { fr: "Touchez la carte (ou cherchez) pour définir le départ.", en: "Tap the map (or search) to set your start point." },
  msg_finding: { fr: "Recherche de la boucle la plus ombragée… (quelques secondes)", en: "Finding the shadiest loop… (a few seconds)" },
  msg_no_loop: { fr: "Aucune boucle ici — essayez un autre départ ou une autre distance.", en: "No loop here — try another start or distance." },
  msg_load_fail: { fr: "Échec du chargement des données d'itinéraire.", en: "Failed to load routing data." },
  pin_map: { fr: "📍 point sur la carte", en: "📍 map point" },
  pin_shared: { fr: "📍 point partagé", en: "📍 shared point" },
  pin_start: { fr: "📍 départ", en: "📍 start" },
  foun_drink: { fr: "💧 Eau potable", en: "💧 Drinking water" },
  foun_feat: { fr: "⛲ Fontaine / point d'eau", en: "⛲ Water feature" },
};

let lang: Lang = (typeof localStorage !== "undefined" && (localStorage.getItem("lang") as Lang)) || "fr";

export function getLang(): Lang { return lang; }
export function setLang(l: Lang) { lang = l; try { localStorage.setItem("lang", l); } catch { /* ignore */ } }
export function t(key: string, ...args: (string | number)[]): string {
  let s = D[key]?.[lang] ?? D[key]?.en ?? key;
  args.forEach((a, i) => { s = s.split(`{${i}}`).join(String(a)); });
  return s;
}
