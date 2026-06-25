#!/usr/bin/env python3
"""Solar position (NOAA algorithm), dependency-free.

solar_position(dt_utc, lat, lon) -> (azimuth_deg_from_N_clockwise, elevation_deg, declination_deg).
geneva_utc(...) converts a Geneva wall-clock time to UTC (DST-aware via zoneinfo).
The TypeScript twin in src/routing/sun.ts MUST match this within ~0.5 deg.
"""
import math
from datetime import datetime
from zoneinfo import ZoneInfo

UTC = ZoneInfo("UTC")


def geneva_utc(year, month, day, hour, minute=0, tz="Europe/Zurich"):
    return datetime(year, month, day, hour, minute, tzinfo=ZoneInfo(tz)).astimezone(UTC)


def _julian_day(dt):
    y, m = dt.year, dt.month
    d = dt.day + (dt.hour + dt.minute / 60 + dt.second / 3600) / 24.0
    if m <= 2:
        y -= 1
        m += 12
    a = y // 100
    b = 2 - a + a // 4
    return int(365.25 * (y + 4716)) + int(30.6001 * (m + 1)) + d + b - 1524.5


def _clamp(x, lo=-1.0, hi=1.0):
    return max(lo, min(hi, x))


def solar_position(dt_utc, lat, lon):
    """lat/lon in degrees (east positive). dt_utc tz-aware (UTC)."""
    jd = _julian_day(dt_utc)
    jc = (jd - 2451545.0) / 36525.0
    l0 = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360.0
    m = 357.52911 + jc * (35999.05029 - 0.0001537 * jc)
    e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc)
    mr = math.radians(m)
    c = (math.sin(mr) * (1.914602 - jc * (0.004817 + 0.000014 * jc))
         + math.sin(2 * mr) * (0.019993 - 0.000101 * jc)
         + math.sin(3 * mr) * 0.000289)
    true_long = l0 + c
    omega = 125.04 - 1934.136 * jc
    app_long = true_long - 0.00569 - 0.00478 * math.sin(math.radians(omega))
    obliq0 = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60
    obliq = obliq0 + 0.00256 * math.cos(math.radians(omega))
    decl = math.degrees(math.asin(_clamp(math.sin(math.radians(obliq)) * math.sin(math.radians(app_long)))))
    y = math.tan(math.radians(obliq / 2)) ** 2
    eot = 4 * math.degrees(
        y * math.sin(2 * math.radians(l0)) - 2 * e * math.sin(mr)
        + 4 * e * y * math.sin(mr) * math.cos(2 * math.radians(l0))
        - 0.5 * y * y * math.sin(4 * math.radians(l0))
        - 1.25 * e * e * math.sin(2 * mr))
    mins = dt_utc.hour * 60 + dt_utc.minute + dt_utc.second / 60.0
    tst = (mins + eot + 4 * lon) % 1440.0
    ha = tst / 4.0 - 180.0
    if ha < -180:
        ha += 360.0
    lat_r, decl_r, ha_r = math.radians(lat), math.radians(decl), math.radians(ha)
    cos_zen = _clamp(math.sin(lat_r) * math.sin(decl_r) + math.cos(lat_r) * math.cos(decl_r) * math.cos(ha_r))
    zen = math.degrees(math.acos(cos_zen))
    el = 90.0 - zen
    denom = math.cos(lat_r) * math.sin(math.radians(zen))
    if abs(denom) < 1e-9:
        az = 0.0 if lat > decl else 180.0
    else:
        cos_az = _clamp((math.sin(lat_r) * math.cos(math.radians(zen)) - math.sin(decl_r)) / denom)
        a = math.degrees(math.acos(cos_az))
        az = (a + 180.0) % 360.0 if ha > 0 else (540.0 - a) % 360.0
    return az, el, decl


if __name__ == "__main__":
    # sanity: Geneva summer, morning sun in the east, noon near south
    lat, lon = 46.20, 6.14
    for h in (8, 12, 16):
        az, el, decl = solar_position(geneva_utc(2026, 6, 21, h), lat, lon)
        print(f"Geneva 2026-06-21 {h:02d}:00 local -> az {az:6.1f}  el {el:5.1f}  decl {decl:5.2f}")
