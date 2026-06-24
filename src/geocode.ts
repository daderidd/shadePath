// Address search via the free Swiss geo.admin SearchServer (no API key required).

export interface Place { label: string; lng: number; lat: number; }

// Canton-of-Geneva bbox (LV95) to bias/clip results.
const GE_BBOX = "2484900,1108200,2514000,1136500";

export async function geocode(query: string): Promise<Place[]> {
  if (query.trim().length < 2) return [];
  const url = "https://api3.geo.admin.ch/rest/services/api/SearchServer?" +
    new URLSearchParams({
      searchText: query,
      type: "locations",
      origins: "address,gg25,zipcode,gazetteer",
      sr: "2056",
      bbox: GE_BBOX,
      limit: "6",
    });
  try {
    const r = await fetch(url);
    const data = await r.json();
    return (data.results || []).map((x: any) => ({
      label: String(x.attrs.label).replace(/<[^>]+>/g, ""),
      lng: x.attrs.lon, // SearchServer returns lon/lat in WGS84 regardless of sr
      lat: x.attrs.lat,
    }));
  } catch {
    return [];
  }
}
