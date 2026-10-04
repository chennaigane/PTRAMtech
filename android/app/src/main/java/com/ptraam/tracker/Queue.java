package com.ptraam.tracker;

import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.location.Location;
import org.json.JSONArray;
import org.json.JSONObject;

/** All sequence allocation and stop boundaries are committed atomically. */
final class Queue extends SQLiteOpenHelper {
    Queue(Context c) { super(c, "trips.db", null, 2); }
    public void onCreate(SQLiteDatabase d) {
        d.execSQL("CREATE TABLE trip(id TEXT PRIMARY KEY, account TEXT NOT NULL, active INTEGER NOT NULL, nextSeq INTEGER NOT NULL DEFAULT 1, lastElapsed INTEGER NOT NULL DEFAULT 0, stoppedAt INTEGER, reason TEXT, closed INTEGER NOT NULL DEFAULT 0)");
        d.execSQL("CREATE TABLE fix(trip TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(trip,seq))");
    }
    public void onUpgrade(SQLiteDatabase d, int old, int version) {
        if (old != 1 || version != 2) throw new IllegalStateException("Migration required");
        try (var r = d.rawQuery("SELECT trip,seq,payload FROM fix", null)) {
            while (r.moveToNext()) d.execSQL("UPDATE fix SET payload=? WHERE trip=? AND seq=?", new Object[]{Session.encrypt(r.getString(2)), r.getString(0), r.getLong(1)});
        } catch (Exception e) { throw new IllegalStateException("Cannot encrypt existing queue", e); }
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
    synchronized void stop(String reason) {
        getWritableDatabase().execSQL("UPDATE trip SET active=0,stoppedAt=?,reason=? WHERE active=1", new Object[]{System.currentTimeMillis(), reason});
    }
    synchronized void add(String id, Location l) throws Exception {
        SQLiteDatabase d = getWritableDatabase(); d.beginTransaction();
        try (var r = d.rawQuery("SELECT nextSeq,lastElapsed FROM trip WHERE id=? AND active=1", new String[]{id})) {
            if (!r.moveToFirst() || l.getElapsedRealtimeNanos() <= r.getLong(1)) return;
            long seq = r.getLong(0);
            JSONObject p = new JSONObject().put("seq", seq).put("time", l.getTime()).put("elapsedMs", l.getElapsedRealtimeNanos() / 1000000)
                .put("lat", l.getLatitude()).put("lng", l.getLongitude()).put("accuracy", l.getAccuracy());
            if (seq > 10000) throw new java.io.IOException("Trip point limit reached");
            d.execSQL("INSERT INTO fix VALUES(?,?,?)", new Object[]{id, seq, Session.encrypt(p.toString())});
            d.execSQL("UPDATE trip SET nextSeq=?,lastElapsed=? WHERE id=?", new Object[]{seq + 1, l.getElapsedRealtimeNanos(), id});
            d.setTransactionSuccessful();
        } finally { d.endTransaction(); }
    }
    synchronized JSONArray trips(String account) throws Exception {
        JSONArray a = new JSONArray();
        try (var r = getReadableDatabase().rawQuery("SELECT id,active,stoppedAt,reason FROM trip WHERE account=? AND closed=0", new String[]{account})) {
            while (r.moveToNext()) a.put(new JSONObject().put("id", r.getString(0)).put("active", r.getInt(1) == 1)
                .put("stoppedAt", r.getLong(2)).put("reason", r.getString(3)));
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
    synchronized void closed(String id) { getWritableDatabase().execSQL("UPDATE trip SET closed=1 WHERE id=? AND active=0", new Object[]{id}); }
}
