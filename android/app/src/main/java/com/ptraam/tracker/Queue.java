package com.ptraam.tracker;

import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.location.Location;
import org.json.JSONArray;
import org.json.JSONObject;

/** All sequence allocation and stop boundaries are committed atomically. */
class Queue extends SQLiteOpenHelper {
    static final String ROUTE_REVIEW = "Route incomplete: GPS persistence failed. Distance requires review; stored evidence is retained.";
    private final android.content.SharedPreferences routeReview;
    Queue(Context c) { super(c, "trips.db", null, 4); routeReview = c.getSharedPreferences("route-review",0); }
    public void onCreate(SQLiteDatabase d) {
        d.execSQL("CREATE TABLE trip(id TEXT PRIMARY KEY, account TEXT NOT NULL, active INTEGER NOT NULL, nextSeq INTEGER NOT NULL DEFAULT 1, lastElapsed INTEGER NOT NULL DEFAULT 0, stoppedAt INTEGER, reason TEXT, closed INTEGER NOT NULL DEFAULT 0, finalSeq INTEGER NOT NULL DEFAULT 0, lastTime INTEGER NOT NULL DEFAULT 0)");
        d.execSQL("CREATE TABLE fix(trip TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(trip,seq))");
        createWriteJournal(d);
    }
    private static void createWriteJournal(SQLiteDatabase d) {
        d.execSQL("CREATE TABLE route_write(id TEXT PRIMARY KEY, trip TEXT NOT NULL, payload TEXT)");
        d.execSQL("CREATE INDEX route_write_trip ON route_write(trip)");
    }
    public void onUpgrade(SQLiteDatabase d, int old, int version) {
        if (old < 1 || old > 3 || version != 4) throw new IllegalStateException("Migration required");
        if (old < 3) {
        if (old == 1) try (var r = d.rawQuery("SELECT trip,seq,payload FROM fix", null)) {
            while (r.moveToNext()) d.execSQL("UPDATE fix SET payload=? WHERE trip=? AND seq=?", new Object[]{Session.encrypt(r.getString(2)), r.getString(0), r.getLong(1)});
        } catch (Exception e) { throw new IllegalStateException("Cannot encrypt existing queue", e); }
        d.execSQL("ALTER TABLE trip ADD COLUMN finalSeq INTEGER NOT NULL DEFAULT 0");
        d.execSQL("ALTER TABLE trip ADD COLUMN lastTime INTEGER NOT NULL DEFAULT 0");
        // Preserve all encrypted payloads. Recover the timestamp when still queued.
        try (var r = d.rawQuery("SELECT trip,payload FROM fix ORDER BY seq", null)) {
            while (r.moveToNext()) d.execSQL("UPDATE trip SET lastTime=MAX(lastTime,?) WHERE id=?",
                new Object[]{new JSONObject(Session.decrypt(r.getString(1))).getLong("time"), r.getString(0)});
        } catch (Exception e) { throw new IllegalStateException("Cannot migrate queue timestamps", e); }
        }
        createWriteJournal(d);
    }
    synchronized void begin(String id, String account) {
        getWritableDatabase().execSQL("INSERT OR IGNORE INTO trip(id,account,active) VALUES(?,?,1)", new Object[]{id, account});
    }
    synchronized boolean active(String id) {
        try (var r = getReadableDatabase().rawQuery("SELECT active FROM trip WHERE id=?", new String[]{id})) { return r.moveToFirst() && r.getInt(0) == 1; }
    }
    synchronized boolean pending() {
        try (var r = getReadableDatabase().rawQuery("SELECT 1 FROM trip WHERE closed=0 LIMIT 1", null)) { return r.moveToFirst(); }
    }
    synchronized boolean pending(String account) {
        try (var r = getReadableDatabase().rawQuery("SELECT 1 FROM trip WHERE closed=0 AND account=? LIMIT 1", new String[]{account})) { return r.moveToFirst(); }
    }
    synchronized int count(String account) {
        try (var r = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM fix JOIN trip ON fix.trip=trip.id WHERE trip.account=?", new String[]{account})) { r.moveToFirst(); return r.getInt(0); }
    }
    /** Work exists when points need upload or an ended trip still needs its stop acknowledgement. */
    synchronized boolean hasSyncWork(String account) {
        try (var r = getReadableDatabase().rawQuery(
            "SELECT 1 FROM trip LEFT JOIN fix ON fix.trip=trip.id WHERE trip.account=? AND trip.closed=0 AND (fix.seq IS NOT NULL OR trip.active=0) LIMIT 1",
            new String[]{account})) { return r.moveToFirst(); }
    }
    synchronized void stop(String reason) {
        getWritableDatabase().execSQL("UPDATE trip SET active=0,stoppedAt=?,reason=?,finalSeq=0 WHERE active=1", new Object[]{System.currentTimeMillis(), reason});
    }
    synchronized void stop(String id, String reason, long at) {
        getWritableDatabase().execSQL("UPDATE trip SET active=0,stoppedAt=?,reason=?,finalSeq=0 WHERE id=? AND active=1", new Object[]{at, reason, id});
    }
    synchronized void recover(String liveTrip, long at) {
        getWritableDatabase().execSQL("UPDATE trip SET active=0,stoppedAt=?,reason='app_interrupted',finalSeq=0 WHERE active=1 AND id<>?", new Object[]{at, liveTrip == null ? "" : liveTrip});
    }
    synchronized long add(String id, Location l) throws Exception {
        SQLiteDatabase d = getWritableDatabase(); d.beginTransaction();
        try { long seq = insert(d, id, l); d.setTransactionSuccessful(); return seq; }
        finally { d.endTransaction(); }
    }
    /** Commit a review marker BEFORE Keystore/point insertion. No plaintext GPS is stored. */
    synchronized void markWrite(String id, String write) {
        getWritableDatabase().execSQL("INSERT OR IGNORE INTO route_write(id,trip,payload) VALUES(?,?,NULL)", new Object[]{write,id});
    }
    synchronized boolean routeIncomplete(String id) {
        if (routeReview.getBoolean(id,false)) return true;
        try (var r = getReadableDatabase().rawQuery("SELECT 1 FROM route_write WHERE trip=? LIMIT 1", new String[]{id})) { return r.moveToFirst(); }
    }
    /** Retry the same immutable evidence before later FIFO writes allocate their sequences. */
    synchronized void writeTracked(String id, String write, Location l) throws Exception {
        markWrite(id,write);
        String evidence = new JSONObject().put("time",l.getTime()).put("elapsedMs",l.getElapsedRealtimeNanos()/1000000)
            .put("lat",l.getLatitude()).put("lng",l.getLongitude()).put("accuracy",l.getAccuracy()).toString();
        SQLiteDatabase d = getWritableDatabase();
        d.execSQL("UPDATE route_write SET payload=? WHERE id=? AND trip=?", new Object[]{Session.encrypt(evidence),write,id});
        d.beginTransaction();
        try {
            // A closed trip or a sequence/time conflict is not a successful write.
            // Keep its encrypted journal evidence instead of silently clearing the gap.
            if (add(id,l) == 0) throw new java.io.IOException("GPS evidence was not inserted");
            d.execSQL("DELETE FROM route_write WHERE id=? AND trip=?", new Object[]{write,id});
            d.setTransactionSuccessful();
        } finally { d.endTransaction(); }
    }
    private long insert(SQLiteDatabase d, String id, Location l) throws Exception {
        try (var r = d.rawQuery("SELECT nextSeq,lastElapsed,lastTime FROM trip WHERE id=? AND active=1", new String[]{id})) {
            if (!r.moveToFirst() || l.getElapsedRealtimeNanos() / 1000000 <= r.getLong(1) / 1000000 || l.getTime() <= r.getLong(2)) return 0;
            long seq = r.getLong(0);
            JSONObject p = new JSONObject().put("seq", seq).put("time", l.getTime()).put("elapsedMs", l.getElapsedRealtimeNanos() / 1000000)
                .put("lat", l.getLatitude()).put("lng", l.getLongitude()).put("accuracy", l.getAccuracy());
            if (seq > 10000) throw new java.io.IOException("Trip point limit reached");
            d.execSQL("INSERT INTO fix VALUES(?,?,?)", new Object[]{id, seq, Session.encrypt(p.toString())});
            d.execSQL("UPDATE trip SET nextSeq=?,lastElapsed=?,lastTime=? WHERE id=?", new Object[]{seq + 1, l.getElapsedRealtimeNanos(), l.getTime(), id});
            return seq;
        }
    }
    /** Final point, sequence and stop commit together; retries cannot add a second endpoint. */
    synchronized boolean finish(String id, Location endpoint, String reason, long validatedAt) throws Exception {
        if (validatedAt <= 0 || (endpoint != null && (endpoint.getTime() > validatedAt
            || validatedAt - endpoint.getTime() > 10000))) throw new IllegalArgumentException("Invalid stop evidence timestamp");
        SQLiteDatabase d = getWritableDatabase(); d.beginTransaction();
        try {
            if (!active(id)) return false;
            long seq = endpoint == null ? 0 : insert(d, id, endpoint);
            if (endpoint != null && seq == 0) return false;
            d.execSQL("UPDATE trip SET active=0,stoppedAt=?,reason=?,finalSeq=? WHERE id=? AND active=1",
                new Object[]{validatedAt, reason, seq, id});
            d.setTransactionSuccessful();
            return true;
        } finally { d.endTransaction(); }
    }
    synchronized JSONArray trips(String account) throws Exception {
        JSONArray a = new JSONArray();
        try (var r = getReadableDatabase().rawQuery("SELECT id,active,stoppedAt,reason,finalSeq FROM trip WHERE account=? AND closed=0 ORDER BY rowid", new String[]{account})) {
            while (r.moveToNext()) a.put(new JSONObject().put("id", r.getString(0)).put("active", r.getInt(1) == 1)
                .put("stoppedAt", r.getLong(2)).put("reason", r.getString(3)).put("finalSeq", r.getLong(4))
                .put("routeStatus", routeIncomplete(r.getString(0)) ? "review_required" : "recorded"));
        } return a;
    }
    synchronized JSONArray batch(String id) throws Exception {
        JSONArray a = new JSONArray();
        try (var r = getReadableDatabase().rawQuery("SELECT payload FROM fix WHERE trip=? ORDER BY seq LIMIT 100", new String[]{id})) {
            while (r.moveToNext()) a.put(new JSONObject(Session.decrypt(r.getString(0))));
        } return a;
    }
    synchronized void ack(String id, JSONArray sent, long seq) throws Exception {
        if (sent.length() == 0 || seq != sent.getJSONObject(sent.length()-1).getLong("seq")) throw new java.io.IOException("Invalid acknowledgement");
        getWritableDatabase().execSQL("DELETE FROM fix WHERE trip=? AND seq<=?", new Object[]{id, seq});
    }
    synchronized void closed(String id) {
        if (routeIncomplete(id)) throw new IllegalStateException(ROUTE_REVIEW);
        getWritableDatabase().execSQL("UPDATE trip SET closed=1 WHERE id=? AND active=0", new Object[]{id});
    }
}
