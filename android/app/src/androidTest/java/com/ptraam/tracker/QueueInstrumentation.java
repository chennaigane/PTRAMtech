package com.ptraam.tracker;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.ContextWrapper;
import android.database.DatabaseErrorHandler;
import android.database.sqlite.SQLiteDatabase;
import android.location.Location;
import android.os.Bundle;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.util.UUID;

/** Device-only SQLite/Keystore regressions. Uses separate cache databases, never the real queue. */
public final class QueueInstrumentation extends Instrumentation {
    private int assertions;
    private void check(boolean condition, String message) { assertions++; if (!condition) throw new AssertionError(message); }
    private Context isolated() {
        File directory = new File(getTargetContext().getCacheDir(), "endpoint-test-" + UUID.randomUUID());
        if (!directory.mkdirs()) throw new IllegalStateException("Cannot create isolated test directory");
        return new ContextWrapper(getTargetContext()) {
            @Override public Context getApplicationContext() { return this; }
            @Override public android.content.SharedPreferences getSharedPreferences(String name,int mode) {
                return super.getSharedPreferences(directory.getName()+"-"+name,mode);
            }
            @Override public File getDatabasePath(String name) { return new File(directory, name); }
            @Override public SQLiteDatabase openOrCreateDatabase(String name, int mode, SQLiteDatabase.CursorFactory factory) {
                return SQLiteDatabase.openOrCreateDatabase(getDatabasePath(name), factory);
            }
            @Override public SQLiteDatabase openOrCreateDatabase(String name, int mode, SQLiteDatabase.CursorFactory factory, DatabaseErrorHandler handler) {
                return SQLiteDatabase.openOrCreateDatabase(getDatabasePath(name).getPath(), factory, handler);
            }
        };
    }
    private Location fix(long offset) {
        Location l = new Location("gps"); l.setLatitude(13); l.setLongitude(80); l.setAccuracy(5);
        l.setTime(System.currentTimeMillis() - 10000 + offset); l.setElapsedRealtimeNanos((10000 + offset) * 1000000);
        return l;
    }
    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            assertions += new LifecycleInstrumentationCases(this,this::isolated).run();
            finalCommitAndRetry(); rollback(); timeout(); delayedPersistence(); interruptedSync(); stoppedCapture(); migration(1); migration(2); migration(3); interruptedWrite(); rejectedTrackedWrite();
            result.putString("stream", "Queue instrumentation: " + assertions + " assertions passed\n");
            finish(Activity.RESULT_OK, result);
        } catch (Throwable error) {
            result.putString("stream", "Queue instrumentation failed: " + error.getClass().getSimpleName() + ": " + error.getMessage());
            finish(Activity.RESULT_CANCELED, result);
        }
    }
    private void finalCommitAndRetry() throws Exception {
        Context context = isolated();
        try (Queue q = new Queue(context)) {
            q.begin("trip", "account"); q.add("trip", fix(1));
            check(q.finish("trip", fix(2), "employee_stopped", System.currentTimeMillis()), "final commit");
            check(!q.active("trip"), "trip inactive only after final insert");
            check(!q.finish("trip", fix(3), "employee_stopped", System.currentTimeMillis()), "duplicate stop is inert");
            q.stop("immediate_stop"); q.add("trip", fix(4));
            JSONArray batch = q.batch("trip"); check(batch.length() == 2, "no post-stop points");
            check(q.trips("account").getJSONObject(0).getLong("finalSeq") == 2, "final sequence retained");
            check(q.trips("other").length() == 0, "account isolation");
            try { q.ack("trip", batch, 1); throw new AssertionError("invalid ack accepted"); } catch (java.io.IOException expected) {}
            check(q.batch("trip").toString().equals(batch.toString()), "failed/lost ack retains encrypted fixes");
        }
        try (Queue q = new Queue(context)) {
            JSONArray batch = q.batch("trip"); check(batch.length() == 2, "restart retains endpoint");
            q.ack("trip", batch, 2); check(q.count("account") == 0, "valid point ack drains fixes");
            check(q.hasSyncWork("account"), "stop still needs acknowledgement");
            check(q.trips("account").getJSONObject(0).getLong("finalSeq") == 2, "endpoint survives point deletion");
            q.closed("trip"); check(!q.pending("account"), "stop ack completes queue");
        }
    }
    private void rollback() throws Exception {
        try (Queue q = new Queue(isolated())) {
            q.begin("trip", "account"); q.add("trip", fix(1));
            q.getWritableDatabase().execSQL("CREATE TRIGGER fail_stop BEFORE UPDATE OF active ON trip BEGIN SELECT RAISE(ABORT,'test failure'); END");
            try { q.finish("trip", fix(2), "employee_stopped", System.currentTimeMillis()); throw new AssertionError("transaction should fail"); }
            catch (android.database.SQLException expected) {}
            check(q.active("trip"), "failed transaction keeps prior active state");
            check(q.batch("trip").length() == 1, "failed stop rolls back final point");
            q.getWritableDatabase().execSQL("DROP TRIGGER fail_stop");
            check(q.finish("trip", fix(3), "employee_stopped", System.currentTimeMillis()), "retry after rollback succeeds");
            check(q.batch("trip").getJSONObject(1).getLong("seq") == 2, "sequence allocation rolled back");
        }
    }
    private void timeout() throws Exception {
        try (Queue q = new Queue(isolated())) {
            q.begin("trip", "account"); q.add("trip", fix(1)); q.stop("endpoint_timeout");
            JSONObject trip = q.trips("account").getJSONObject(0);
            check(!trip.getBoolean("active") && trip.getLong("finalSeq") == 0, "timeout unverified");
            check(q.batch("trip").length() == 1, "timeout retains last fix");
            long stopped = trip.getLong("stoppedAt");q.stop("duplicate");
            check(q.trips("account").getJSONObject(0).getLong("stoppedAt") == stopped, "duplicate preserves stop time");
        }
    }
    private void delayedPersistence() throws Exception {
        Context context = isolated();
        long validatedAt = 1800000000000L;
        Location endpoint = fix(1); endpoint.setTime(validatedAt - 10000);
        // Fixed historical snapshot models an arbitrarily delayed SQLite write without sleeps.
        try (Queue q = new Queue(context)) {
            q.begin("trip", "account");
            check(q.finish("trip", endpoint, "employee_stopped", validatedAt), "boundary fix commits after delay");
            check(q.trips("account").getJSONObject(0).getLong("stoppedAt") == validatedAt, "persist validation snapshot, not write time");
        }
        try (Queue q = new Queue(context)) {
            check(q.trips("account").getJSONObject(0).getLong("stoppedAt") - q.batch("trip").getJSONObject(0).getLong("time") == 10000, "retry preserves exact boundary");
            check(!q.finish("trip", endpoint, "employee_stopped", validatedAt), "delayed duplicate adds no record");
        }
    }
    private void interruptedSync() throws Exception {
        Context context = isolated(); JSONArray sent;
        try (Queue q = new Queue(context)) {
            q.begin("trip", "account"); q.add("trip", fix(1)); q.stop("endpoint_timeout");
            sent = q.batch("trip"); // process dies after server receives batch, before local ACK
        }
        try (Queue q = new Queue(context)) {
            check(q.batch("trip").toString().equals(sent.toString()), "interrupted upload resends identical payload");
            q.ack("trip",sent,1); // process dies after point ACK, before stop ACK
        }
        try (Queue q = new Queue(context)) {
            check(q.batch("trip").length()==0 && q.hasSyncWork("account"), "interrupted stop retains retry work");
            JSONObject trip = q.trips("account").getJSONObject(0);
            check(!MobileContract.acknowledges("trip",0,"",0,"",-1), "legacy response cannot close trip");
            check(q.pending("account"), "failed stop ack preserves queue");
            check(MobileContract.acknowledges("trip",0,"trip",trip.getLong("stoppedAt"),"unverified",0), "retry stop ack valid");
            q.closed("trip"); check(!q.pending("account"), "successful retry closes once");
        }
    }
    private void stoppedCapture() throws Exception {
        for(String reason : new String[]{"service_destroyed","permission_revoked","immediate_stop","authorization_ended"}) {
            try (Queue q = new Queue(isolated())) {
                q.begin("trip","account"); q.add("trip",fix(1));
                EndTripCapture capture = new EndTripCapture(); capture.begin(100000000000L);
                if (reason.equals("permission_revoked")) check("permission_revoked".equals(capture.stopReason(100000000001L,200000,false,true)), "permission loss bypasses capture wait");
                capture.finish(); q.stop(reason); // deterministic service teardown transition
                capture.finish(); q.stop(reason); // repeated destruction / stop
                check(!capture.accepts(100000000002L,100000000001L,1000,1000,13,80,5,false), "late callback rejected after " + reason);
                check(!q.active("trip") && q.batch("trip").length()==1, "prior records survive " + reason);
                check(q.trips("account").getJSONObject(0).getLong("finalSeq")==0, "safety endpoint unverified");
            }
        }
    }
    private void migration(int version) throws Exception {
        Context context = isolated();
        String payload = new JSONObject().put("seq",1).put("time",1000).put("elapsedMs",1000)
            .put("lat",13).put("lng",80).put("accuracy",5).toString();
        String stored = version == 1 ? payload : Session.encrypt(payload);
        try (SQLiteDatabase d = context.openOrCreateDatabase("trips.db",0,null)) {
            d.execSQL("CREATE TABLE trip(id TEXT PRIMARY KEY,account TEXT NOT NULL,active INTEGER NOT NULL,nextSeq INTEGER NOT NULL DEFAULT 1,lastElapsed INTEGER NOT NULL DEFAULT 0,stoppedAt INTEGER,reason TEXT,closed INTEGER NOT NULL DEFAULT 0)");
            d.execSQL("CREATE TABLE fix(trip TEXT NOT NULL,seq INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(trip,seq))");
            if(version==3) {
                d.execSQL("ALTER TABLE trip ADD COLUMN finalSeq INTEGER NOT NULL DEFAULT 0");
                d.execSQL("ALTER TABLE trip ADD COLUMN lastTime INTEGER NOT NULL DEFAULT 0");
            }
            d.execSQL("INSERT INTO trip(id,account,active,nextSeq,lastElapsed) VALUES('trip','account',0,2,1000000000)");
            d.execSQL("INSERT INTO fix VALUES('trip',1,?)",new Object[]{stored});d.setVersion(version);
        }
        try (Queue q = new Queue(context)) {
            check(q.batch("trip").getJSONObject(0).getLong("time") == 1000, "v"+version+" payload preserved");
            check(q.trips("account").getJSONObject(0).getLong("finalSeq") == 0, "legacy endpoint stays unverified");
            check(q.getReadableDatabase().getVersion()==4 && !q.routeIncomplete("trip"),"additive v4 journal migration");
            try (var r = q.getReadableDatabase().rawQuery("SELECT payload FROM fix",null)) {
                r.moveToFirst();check(!r.getString(0).equals(payload), "payload encrypted after migration");
                if (version >= 2) check(r.getString(0).equals(stored), "encrypted ciphertext unchanged");
            }
        }
    }
    private void rejectedTrackedWrite() throws Exception {
        Context context=isolated();
        try(Queue q=new Queue(context)) {
            q.begin("trip","account");q.add("trip",fix(2));
            try { q.writeTracked("trip","older",fix(1));throw new AssertionError("no-op insertion reported success"); }
            catch(java.io.IOException expected) {}
            check(q.routeIncomplete("trip") && q.batch("trip").length()==1,"rejected write retains journal and existing sequence");
            q.finish("trip",fix(3),"employee_stopped",System.currentTimeMillis());
            check(q.trips("account").getJSONObject(0).getString("routeStatus").equals("review_required"),"final endpoint does not verify incomplete route");
            try { q.closed("trip");throw new AssertionError("incomplete trip acknowledged locally"); }
            catch(IllegalStateException expected) {}
            check(q.pending("account"),"review trip cannot be marked synchronized");
            q.begin("fallback","account");q.stop("fallback","local_storage_failed",System.currentTimeMillis());
            check(context.getSharedPreferences("route-review",0).edit().putBoolean("fallback",true).commit(),"durable fallback fixture");
            check(q.routeIncomplete("fallback"),"queue status honors fallback when journal storage was unavailable");
            try { q.closed("fallback");throw new AssertionError("fallback review trip acknowledged locally"); }
            catch(IllegalStateException expected) {}
        }
    }
    private void interruptedWrite() throws Exception {
        Context c=isolated();
        try(Queue q=new Queue(c)) {
            q.begin("trip","account");q.add("trip",fix(1));
            q.markWrite("trip","interrupted"); // Process loss before encryption/point commit.
        }
        try(Queue q=new Queue(c)) {
            q.recover(null,System.currentTimeMillis());
            check(q.routeIncomplete("trip") && !q.active("trip"),"recovery cannot erase interrupted-write evidence");
            check(q.batch("trip").length()==1,"interrupted write preserves existing encrypted route");
        }
    }
}
