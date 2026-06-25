// Solar position (NOAA algorithm) — TypeScript twin of pipeline/sun.py.
// Drives the sun indicator and time-bin selection. Must match sun.py within ~0.5 deg.
// Geneva reference; Europe/Zurich DST handled explicitly (EU rule).

const LAT = 46.20, LON = 6.14;
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const clamp = (x: number, lo = -1, hi = 1) => (x < lo ? lo : x > hi ? hi : x);

// last Sunday (UTC day-of-month) of a 0-indexed month
function lastSunday(year: number, monthIdx0: number): number {
  const d = new Date(Date.UTC(year, monthIdx0 + 1, 0)); // last day of the month
  return d.getUTCDate() - d.getUTCDay();
}
// Europe/Zurich offset in hours for a Geneva wall-clock date: CET=+1, CEST=+2
function zurichOffset(y: number, m: number, d: number): number {
  const marL = lastSunday(y, 2), octL = lastSunday(y, 9);   // last Sun Mar / Oct
  const onOrAfter = (mm: number, dd: number, bm: number, bd: number) => mm > bm || (mm === bm && dd >= bd);
  const dst = onOrAfter(m, d, 3, marL) && !onOrAfter(m, d, 10, octL);
  return dst ? 2 : 1;
}

/** A Geneva wall-clock (y, m=1..12, d, hour) -> the UTC instant. */
export function genevaToUTC(y: number, m: number, d: number, hour: number): Date {
  return new Date(Date.UTC(y, m - 1, d, hour - zurichOffset(y, m, d), 0, 0));
}

function julianDay(utc: Date): number {
  let y = utc.getUTCFullYear(), mo = utc.getUTCMonth() + 1;
  const day = utc.getUTCDate() + (utc.getUTCHours() + utc.getUTCMinutes() / 60 + utc.getUTCSeconds() / 3600) / 24;
  if (mo <= 2) { y -= 1; mo += 12; }
  const A = Math.floor(y / 100), B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (mo + 1)) + day + B - 1524.5;
}

export interface Sun { az: number; el: number; decl: number; }

export function solarPosition(utc: Date, lat = LAT, lon = LON): Sun {
  const jc = (julianDay(utc) - 2451545.0) / 36525.0;
  const l0 = ((280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360 + 360) % 360;
  const m = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
  const mr = m * D2R;
  const c = Math.sin(mr) * (1.914602 - jc * (0.004817 + 0.000014 * jc))
    + Math.sin(2 * mr) * (0.019993 - 0.000101 * jc) + Math.sin(3 * mr) * 0.000289;
  const trueLong = l0 + c;
  const omega = 125.04 - 1934.136 * jc;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * D2R);
  const obliq0 = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const obliq = obliq0 + 0.00256 * Math.cos(omega * D2R);
  const decl = Math.asin(clamp(Math.sin(obliq * D2R) * Math.sin(appLong * D2R))) * R2D;
  const y = Math.tan(obliq / 2 * D2R) ** 2;
  const eot = 4 * R2D * (y * Math.sin(2 * l0 * D2R) - 2 * e * Math.sin(mr)
    + 4 * e * y * Math.sin(mr) * Math.cos(2 * l0 * D2R)
    - 0.5 * y * y * Math.sin(4 * l0 * D2R) - 1.25 * e * e * Math.sin(2 * mr));
  const mins = utc.getUTCHours() * 60 + utc.getUTCMinutes() + utc.getUTCSeconds() / 60;
  const tst = (mins + eot + 4 * lon) % 1440;
  let ha = tst / 4 - 180; if (ha < -180) ha += 360;
  const latR = lat * D2R, declR = decl * D2R;
  const cosZen = clamp(Math.sin(latR) * Math.sin(declR) + Math.cos(latR) * Math.cos(declR) * Math.cos(ha * D2R));
  const zen = Math.acos(cosZen) * R2D;
  const el = 90 - zen;
  const denom = Math.cos(latR) * Math.sin(zen * D2R);
  let az: number;
  if (Math.abs(denom) < 1e-9) az = lat > decl ? 0 : 180;
  else {
    const a = Math.acos(clamp((Math.sin(latR) * Math.cos(zen * D2R) - Math.sin(declR)) / denom)) * R2D;
    az = ha > 0 ? (a + 180) % 360 : (540 - a) % 360;
  }
  return { az, el, decl };
}

/** Sun for a Geneva wall-clock time. */
export function sunForGeneva(y: number, m: number, d: number, hour: number): Sun {
  return solarPosition(genevaToUTC(y, m, d, hour));
}

/** Current Geneva wall-clock parts (DST-correct via Intl). */
export function genevaNow(): { y: number; m: number; d: number; h: number } {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23",
  });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date())) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour };
}

const CARD = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
export function cardinal(az: number): string {
  return CARD[Math.round(az / 45) % 8];
}
