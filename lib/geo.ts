export type Point = {lat: number, lng: number, accuracy: number, time: number};

/** Great-circle distance in metres. */
export function distance(a: {lat: number, lng: number}, b: {lat: number, lng: number}) {
  const r = Math.PI / 180;
  const v = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lng - a.lng) * r / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(v), Math.sqrt(1 - v));
}

const MAX_ACCURACY_M = 100;   // ignore rough fixes
const MAX_SPEED_MS = 55;      // ~200 km/h; faster jumps are GPS glitches
const MIN_STEP_M = 20;        // a stationary phone wanders; real movement must exceed this

/**
 * Trip distance in km from GPS samples.
 * Measures from the last counted position (the anchor), so slow movement in traffic
 * accumulates instead of being discarded as jitter, while a parked phone's drift
 * (up to twice the fixes' accuracy) is not counted. Gaps (tunnels, lost signal) count as a
 * straight line, which never overstates the real road distance.
 */
export function tripKm(points: Point[]) {
  let km = 0, anchor: Point | null = null;
  for (const p of points) {
    if (!(p.accuracy <= MAX_ACCURACY_M)) continue;
    if (!anchor) { anchor = p; continue; }
    const seconds = (p.time - anchor.time) / 1000;
    if (seconds <= 0) continue;
    const metres = distance(anchor, p);
    if (metres / seconds > MAX_SPEED_MS) continue; // glitch: skip this point, keep the anchor
    if (metres > Math.max(MIN_STEP_M, 2 * Math.max(anchor.accuracy, p.accuracy))) { km += metres / 1000; anchor = p; }
  }
  return +km.toFixed(3);
}
