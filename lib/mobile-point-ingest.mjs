// SQLite ingestion used by the authenticated mobile API.
// The HTTP layer MUST authenticate a short-lived mobile token and pass its subject
// as accountId. Never trust an employee/account identifier supplied in JSON.
export class PointError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function mobileSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS mobile_trips (
    id TEXT PRIMARY KEY, account TEXT NOT NULL, started_at INTEGER NOT NULL,
    capture_until INTEGER NOT NULL, upload_until INTEGER NOT NULL,
    last_seq INTEGER NOT NULL DEFAULT 0, last_time INTEGER NOT NULL DEFAULT 0,
    last_elapsed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS mobile_points (
    trip TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(trip, seq));`);
}
export function normalize(p) {
  if (!p || !Number.isSafeInteger(p.seq) || p.seq < 1 ||
      !Number.isSafeInteger(p.time) || p.time < 1 ||
      !Number.isSafeInteger(p.elapsedMs) || p.elapsedMs < 1 ||
      !Number.isFinite(p.lat) || Math.abs(p.lat) > 90 ||
      !Number.isFinite(p.lng) || Math.abs(p.lng) > 180 ||
      !Number.isFinite(p.accuracy) || p.accuracy <= 0 || p.accuracy > 100)
    throw new PointError(400, 'Invalid GPS fix');
  return {seq:p.seq, time:p.time, elapsedMs:p.elapsedMs, lat:p.lat, lng:p.lng, accuracy:p.accuracy};
}
export function ingestPoints(db, accountId, tripId, points, now = Date.now(), project = () => {}) {
  if (!accountId) throw new PointError(401, 'Authentication required');
  if (typeof tripId !== 'string' || !Array.isArray(points) || points.length < 1 || points.length > 100)
    throw new PointError(400, 'Invalid batch');
  const normalized = points.map(normalize);
  db.exec('BEGIN IMMEDIATE');
  try {
    const trip = db.prepare('SELECT * FROM mobile_trips WHERE id=? AND account=?').get(tripId, accountId);
    if (!trip) throw new PointError(404, 'Trip not found');
    if (now > trip.upload_until) throw new PointError(410, 'Upload window ended; review retained device queue');
    let seq = trip.last_seq, time = trip.last_time, elapsed = trip.last_elapsed, previous = 0;
    for (const p of normalized) {
      if (p.seq <= previous) throw new PointError(409, 'Batch is not strictly ordered');
      previous = p.seq;
      const payload = JSON.stringify(p);
      if (p.seq <= seq) {
        const old = db.prepare('SELECT payload FROM mobile_points WHERE trip=? AND seq=?').get(tripId, p.seq);
        if (!old || old.payload !== payload) throw new PointError(409, 'Conflicting replay');
        continue; // Lost acknowledgements are safe to retry without duplicate distance.
      }
      if (p.seq !== seq + 1 || p.time <= time || p.elapsedMs <= elapsed)
        throw new PointError(409, 'Out-of-order GPS point');
      if (p.time < trip.started_at || p.time > trip.capture_until || p.time > now + 30000)
        throw new PointError(409, 'Point outside authorized capture interval');
      db.prepare('INSERT INTO mobile_points(trip,seq,payload) VALUES(?,?,?)').run(tripId, p.seq, payload);
      seq = p.seq; time = p.time; elapsed = p.elapsedMs;
    }
    db.prepare('UPDATE mobile_trips SET last_seq=?,last_time=?,last_elapsed=? WHERE id=?').run(seq,time,elapsed,tripId);
    project(); // Publish dashboard evidence in the same transaction as the ACK.
    db.exec('COMMIT');
    return {ackSeq:normalized.at(-1).seq};
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
