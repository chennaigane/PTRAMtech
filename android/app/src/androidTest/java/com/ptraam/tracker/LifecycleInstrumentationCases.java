package com.ptraam.tracker;

import android.app.Instrumentation;
import android.app.Notification;
import android.app.job.JobParameters;
import android.content.Context;
import android.content.Intent;
import android.location.Location;
import android.os.SystemClock;
import org.json.JSONObject;
import java.util.concurrent.*;
import java.util.function.Supplier;

/** Invokes real service/job/protocol entry points; only platform I/O is substituted. */
final class LifecycleInstrumentationCases {
    private final Instrumentation instrumentation;
    private final Supplier<Context> contexts;
    private int checks;
    LifecycleInstrumentationCases(Instrumentation i, Supplier<Context> contexts) { this.instrumentation=i; this.contexts=contexts; }
    private void check(boolean value,String message) { checks++; if(!value) throw new AssertionError(message); }
    private void main(Runnable work) { instrumentation.runOnMainSync(work); }
    private void await(CountDownLatch latch) throws Exception { check(latch.await(5,TimeUnit.SECONDS),"bounded callback completed"); }
    private void drain(ExecutorService executor) throws Exception { executor.submit(() -> {}).get(5,TimeUnit.SECONDS); instrumentation.waitForIdleSync(); }
    private Location fix(boolean earlier) {
        Location l=new Location("gps"); l.setLatitude(13);l.setLongitude(80);l.setAccuracy(5);
        l.setTime(System.currentTimeMillis()-(earlier?1000:0));l.setElapsedRealtimeNanos(SystemClock.elapsedRealtimeNanos()-(earlier?1000000000L:0));return l;
    }
    private final class ServiceCase extends TripService {
        Context context;
        final ExecutorService disk=Executors.newSingleThreadExecutor();
        final CountDownLatch started=new CountDownLatch(1), entered=new CountDownLatch(1), release=new CountDownLatch(1);
        boolean permission=true, notifications=true, session=true, blocked, failWrite, failStop, detached, ordinaryBlocked;
        int ordinaryFailures, ordinaryAttempts;
        final CountDownLatch ordinaryEntered=new CountDownLatch(1);
        int listeners, finished, stops;
        void attach(Context c) { context=c; attachBaseContext(c); }
        @Override Queue openQueue() { return new Queue(context) {
            @Override synchronized long add(String id,Location point) throws Exception {
                if(ordinaryBlocked) {
                    ordinaryEntered.countDown();
                    if(!release.await(5,TimeUnit.SECONDS)) throw new java.io.IOException("test ordinary storage timeout");
                    if(++ordinaryAttempts<=ordinaryFailures) throw new java.io.IOException("injected ordinary write failure");
                }
                return super.add(id,point);
            }
            @Override synchronized boolean finish(String id,Location point,String reason,long at) throws Exception {
                if(blocked) { entered.countDown(); if(!release.await(5,TimeUnit.SECONDS)) throw new java.io.IOException("test storage timeout"); }
                if(failWrite) throw new java.io.IOException("injected storage failure");
                return super.finish(id,point,reason,at);
            }
            @Override synchronized void stop(String id,String reason,long at) {
                stops++;
                if(failStop) throw new android.database.sqlite.SQLiteException("injected closure failure");
                super.stop(id,reason,at);
            }
        }; }
        @Override void executeStorage(Runnable work) { disk.execute(work); }
        @Override boolean locationPermission() { return permission; }
        @Override boolean canStart() { return permission && notifications; }
        @Override String currentAccount() { return "account"; }
        @Override boolean authorized() { return session; }
        @Override boolean validateToken() { return session; }
        @Override void requestLocations(long interval) { detached=false;listeners++;started.countDown(); }
        @Override void removeLocations() { detached=true; }
        @Override boolean gpsEnabled() { return true; }
        @Override void foreground(Notification n) {}
        @Override void finishService() { finished++; }
        @Override void updateNotification(String message) {}
        @Override void scheduleSync() {}
        @Override void startLeaseChecks() {}
    }
    private ServiceCase service(Context c) throws Exception {
        try(Queue q=new Queue(c)) { q.begin("00000000-0000-4000-8000-000000000001","account"); }
        ServiceCase[] result=new ServiceCase[1];
        main(() -> { result[0]=new ServiceCase(); result[0].attach(c); result[0].onCreate();
            result[0].onStartCommand(new Intent().setAction("START").putExtra("tripId","00000000-0000-4000-8000-000000000001").putExtra("leaseUntil",SystemClock.elapsedRealtime()+300000),0,1); });
        await(result[0].started);
        main(() -> result[0].onLocationChanged(fix(true))); drain(result[0].disk);
        return result[0];
    }
    private void blockedFinal() throws Exception {
        Context c=contexts.get();ServiceCase s=service(c); s.blocked=true;
        try {
            Location point=fix(false);
            main(() -> {
                TripService.endTrip(c); // actual dashboard entry
                s.onStartCommand(new Intent().setAction("STOP").putExtra("tripId","00000000-0000-4000-8000-000000000001"),0,2); // duplicate notification
                // Must be acquired after the request, not a cached pre-request location.
                point.setElapsedRealtimeNanos(SystemClock.elapsedRealtimeNanos());point.setTime(System.currentTimeMillis());
                s.onLocationChanged(point);
            });
            await(s.entered);
            main(() -> {
                check(s.detached,"GPS detached while SQLite is deliberately blocked");
                int before=s.listeners;
                point.setLatitude(42); // caller mutation cannot alter the frozen endpoint
                TripService.stop(c,"immediate_stop");
                s.permission=false;s.onLocationChanged(fix(false));s.onProviderEnabled("gps");
                s.onDestroy();s.onLocationChanged(fix(false));
                check(s.listeners==before && s.detached,"late callbacks and destruction cannot restart GPS");
            });
        } finally { s.release.countDown();drain(s.disk);s.disk.shutdown(); }
        try(Queue q=new Queue(c)) {
            check(!q.active("00000000-0000-4000-8000-000000000001"),"final closure commits after release");
            check(q.batch("00000000-0000-4000-8000-000000000001").length()==2,"duplicate actions add only one endpoint");
            check(q.batch("00000000-0000-4000-8000-000000000001").getJSONObject(1).getDouble("lat")==13,"frozen final coordinates preserved");
            check(q.trips("account").getJSONObject(0).getLong("finalSeq")==2,"destruction did not downgrade committed final evidence");
        }
    }
    private void startupDenied() throws Exception {
        String id="00000000-0000-4000-8000-000000000001";
        for(boolean permissionDenial:new boolean[]{true,false}) {
            Context c=contexts.get();String original;
            try(Queue q=new Queue(c)) { q.begin(id,"account");q.add(id,fix(true));q.begin("unrelated","other");original=q.batch(id).toString(); }
            ServiceCase s=new ServiceCase();
            try {
                s.disk.execute(() -> {
                    s.entered.countDown();
                    try { if(!s.release.await(5,TimeUnit.SECONDS)) throw new AssertionError("denial storage timeout"); }
                    catch(InterruptedException e) { throw new AssertionError(e); }
                });
                await(s.entered);
                main(() -> {
                    s.attach(c);s.onCreate();s.permission=!permissionDenial;s.notifications=permissionDenial;
                    Intent start=new Intent().setAction("START").putExtra("tripId",id).putExtra("leaseUntil",SystemClock.elapsedRealtime()+300000);
                    s.onStartCommand(start,0,1);s.onStartCommand(start,0,2);
                    s.onLocationChanged(fix(false));
                    check(s.listeners==0 && s.detached,"startup denial never registers GPS");
                    check(s.stops==0 && s.finished==0,"denial returns without waiting for blocked storage");
                });
                s.release.countDown();
                drain(s.disk);
                check(s.stops==1 && s.finished==1,"duplicate denial schedules only one asynchronous closure and teardown");
                try(Queue q=new Queue(c)) {
                    JSONObject ended=q.trips("account").getJSONObject(0);
                    check(!q.active(id) && ended.getString("reason").equals("start_denied"),"denied startup closes specific committed trip");
                    check(q.active("unrelated") && original.equals(q.batch(id).toString()),"denial preserves other trips and queued evidence");
                    check(ended.getLong("finalSeq")==0 && q.hasSyncWork("account"),"denial remains unverified and awaits strict server ACK");
                }
            } finally { s.release.countDown();main(s::onDestroy);drain(s.disk);s.disk.shutdown(); }
        }
    }
    private void ordinaryFailureDuringEnd() throws Exception {
        String id="00000000-0000-4000-8000-000000000001";
        for(int failures:new int[]{1,2}) {
            Context c=contexts.get();ServiceCase s=service(c);
            s.ordinaryBlocked=true;s.ordinaryFailures=failures;
            try {
                main(() -> {
                    Location ordinary=fix(false);ordinary.setTime(ordinary.getTime()-100);ordinary.setElapsedRealtimeNanos(ordinary.getElapsedRealtimeNanos()-100000000L);
                    s.onLocationChanged(ordinary);
                });
                await(s.ordinaryEntered);
                main(() -> {
                    TripService.endTrip(c);s.onLocationChanged(fix(false));
                    check(s.detached && s.outstandingWrites()==1,"final capture detaches before blocked ordinary write finishes");
                    s.onStartCommand(new Intent().setAction("STOP").putExtra("tripId",id),0,3);
                });
            } finally { s.release.countDown();drain(s.disk); }
            check(s.ordinaryAttempts==2 && s.outstandingWrites()==0,"ordinary evidence retried once before final sequence allocation");
            try(Queue q=new Queue(c)) {
                int expected=failures==1?3:2;
                check(!q.active(id) && q.batch(id).length()==expected,"final transaction succeeds without duplicating retry evidence");
                check(q.trips("account").getJSONObject(0).getLong("finalSeq")==expected,"final point and closure remain atomic");
                check(q.routeIncomplete(id)==(failures==2),"persistent failure survives queue reopen; recovered retry clears marker");
                check(q.trips("account").getJSONObject(0).getString("routeStatus").equals(failures==2?"review_required":"recorded"),"final trip status reflects missing ordinary route evidence");
                if(failures==2) {
                    try(var row=q.getReadableDatabase().rawQuery("SELECT payload FROM route_write WHERE payload IS NOT NULL",null)) {
                        check(row.moveToFirst() && !row.getString(0).contains("lat"),"failed candidate retained encrypted for review");
                    }
                    check(c.getSharedPreferences("tracking-state",0).getString("endStatus","").equals(Queue.ROUTE_REVIEW),"successful endpoint cannot hide incomplete route");
                }
            }
            main(s::onDestroy);drain(s.disk);s.disk.shutdown();
            if(failures==2) {
                int[] requests={0};JobCase j=job(c,(path,body) -> { requests[0]++;return ack(path,body); });
                main(() -> j.onStartJob(null));await(j.completed);
                check(requests[0]==0 && !j.retry,"sync holds incomplete trip for review without weakening ACKs");
                check(c.getSharedPreferences("tracking-state",0).getString("syncPhase","").equals("REVIEW_REQUIRED"),"sync cannot replace review with success");
                try(Queue q=new Queue(c)) { check(q.pending("account") && q.batch(id).length()==2 && q.routeIncomplete(id),"sync retains all unacknowledged evidence and review marker"); }
                main(j::onDestroy);j.disk.shutdown();
            }
        }
    }
    private void lifecycleStops() throws Exception {
        for(String reason:new String[]{"destroy","permission","authorization","notification","storage"}) {
            Context c=contexts.get();ServiceCase s=service(c);
            try {
                main(() -> {
                    TripService.endTrip(c);
                    if(reason.equals("destroy")) s.onDestroy();
                    else if(reason.equals("permission")) { s.permission=false;s.onLocationChanged(fix(false)); }
                    else if(reason.equals("authorization")) { s.session=false;s.onLocationChanged(fix(false)); }
                    else if(reason.equals("notification")) s.onStartCommand(new Intent().setAction("STOP_NOW").putExtra("tripId","00000000-0000-4000-8000-000000000001"),0,3);
                    else { s.failWrite=true;s.onLocationChanged(fix(false)); }
                    check(s.detached,"actual callback detached GPS: "+reason);
                    s.onLocationChanged(fix(false));
                });
                drain(s.disk);
                try(Queue q=new Queue(c)) {
                    check(!q.active("00000000-0000-4000-8000-000000000001"),"closure survives "+reason);
                    check(q.batch("00000000-0000-4000-8000-000000000001").length()==1,"earlier encrypted point retained: "+reason);
                    check(q.trips("account").getJSONObject(0).getLong("finalSeq")==0,"unverified safety/storage fallback: "+reason);
                }
            } finally { main(s::onDestroy);drain(s.disk);s.disk.shutdown(); }
        }
    }
    private void failedClosureRecovery() throws Exception {
        Context c=contexts.get();CountDownLatch initialized=new CountDownLatch(1);
        QueueIO.execute(() -> { try(Queue q=new Queue(c)) { QueueIO.recoverOnce(q,null,System.currentTimeMillis()); } finally { initialized.countDown(); } });await(initialized);
        ServiceCase s=service(c);s.failWrite=true;s.failStop=true;
        try {
            main(() -> { TripService.endTrip(c);s.onLocationChanged(fix(false));check(s.detached,"all storage failures still detach GPS"); });drain(s.disk);
            try(Queue q=new Queue(c)) { check(q.active("00000000-0000-4000-8000-000000000001") && q.batch("00000000-0000-4000-8000-000000000001").length()==1,"failed closure leaves original durable records intact"); }
            CountDownLatch recovered=new CountDownLatch(1);
            QueueIO.execute(() -> { try(Queue q=new Queue(c)) { QueueIO.recoverOnce(q,null,System.currentTimeMillis()); } finally { recovered.countDown(); } });await(recovered);
            try(Queue q=new Queue(c)) { check(!q.active("00000000-0000-4000-8000-000000000001") && q.batch("00000000-0000-4000-8000-000000000001").length()==1,"storage failure rearms recovery within same process"); }
        } finally { main(s::onDestroy);drain(s.disk);s.disk.shutdown(); }
    }
    private final class JobCase extends SyncJob {
        Context context;StartProtocol.Transport transport;
        final ExecutorService disk=Executors.newSingleThreadExecutor();
        final CountDownLatch completed=new CountDownLatch(1),control=new CountDownLatch(1);
        boolean retry;
        boolean holdInitial;
        Runnable held, heldControl;
        boolean holdControl;
        final CountDownLatch controlHeld=new CountDownLatch(1);
        void attach(Context c) { context=c;attachBaseContext(c); }
        @Override Queue openQueue() { return new Queue(context); }
        @Override void recoverQueue(Queue q,String live,long at) { q.recover(live,at); }
        @Override String account() { return "account"; }
        @Override String token() { return "test-token"; }
        @Override boolean sessionCurrent() { return true; }
        @Override JSONObject post(String path,JSONObject body,String token) throws Exception { return transport.post(path,body); }
        @Override void executeStorage(Runnable r) { if(holdInitial) { holdInitial=false;held=r; } else disk.execute(r); }
        @Override void postControl(Runnable r) {
            Runnable callback=() -> { try { r.run(); } finally { control.countDown(); } };
            if(holdControl) { holdControl=false;heldControl=callback;controlHeld.countDown(); }
            else super.postControl(callback);
        }
        @Override void complete(JobParameters p,boolean retry) { this.retry=retry;completed.countDown(); }
    }
    private JobCase job(Context c,StartProtocol.Transport transport) {
        JobCase[] result=new JobCase[1];main(() -> { result[0]=new JobCase();result[0].attach(c);result[0].transport=transport; });return result[0];
    }
    private JSONObject ack(String path,JSONObject body) throws Exception {
        if(path.equals("/trips/points/endpoint-v1")) return new JSONObject().put("ackSeq",body.getJSONArray("points").getJSONObject(0).getLong("seq"));
        check(path.equals("/trips/stop/endpoint-v1"),"stop uses version-specific route");
        return new JSONObject().put("tripId",body.getString("tripId")).put("stoppedAt",body.getLong("stoppedAt")).put("endpointStatus","unverified").put("finalSeq",0);
    }
    private void interruptedSync() throws Exception {
        Context c=contexts.get();
        try(Queue q=new Queue(c)) { q.begin("00000000-0000-4000-8000-000000000001","account");q.add("00000000-0000-4000-8000-000000000001",fix(true));q.stop("immediate_stop"); }
        CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);
        String[] original=new String[1];
        JobCase first=job(c,(path,body) -> { original[0]=body.toString();entered.countDown();if(!release.await(5,TimeUnit.SECONDS)) throw new java.io.IOException("timeout");throw new java.io.IOException("lost HTTP acknowledgement"); });
        JobCase replacement=job(c,this::ack);
        try {
            main(() -> first.onStartJob(null));await(entered);
            main(() -> { check(first.onStopJob(null),"cancelled job requests retry");replacement.onStartJob(null); });
            await(replacement.completed);check(replacement.retry,"replacement schedules retry while old HTTP worker owns slot");
        } finally { release.countDown(); }
        await(first.control);drain(first.disk);
        try(Queue q=new Queue(c)) { check(q.batch("00000000-0000-4000-8000-000000000001").length()==1,"lost HTTP ACK retains encrypted payload"); }
        JobCase retry=job(c,(path,body) -> { if(path.equals("/trips/points/endpoint-v1"))check(body.toString().equals(original[0]),"actual retry resends identical payload");return ack(path,body); });
        main(() -> retry.onStartJob(null));await(retry.completed);check(!retry.retry,"successful retry drains work");
        try(Queue q=new Queue(c)) { check(!q.pending("account"),"queue closed only after structured stop ACK"); }
        for(JobCase j:new JobCase[]{first,replacement,retry}) { main(j::onDestroy);j.disk.shutdown(); }
    }
    private void reviewDuringUpload() throws Exception {
        Context c=contexts.get();String id="00000000-0000-4000-8000-000000000001";
        try(Queue q=new Queue(c)) { q.begin(id,"account");q.add(id,fix(true));q.stop(id,"employee_stopped",System.currentTimeMillis()); }
        int[] stops={0};
        JobCase j=job(c,(path,body) -> {
            if(path.equals(MobileContract.STOP_PATH)) stops[0]++;
            else try(Queue q=new Queue(c)) { q.markWrite(id,"late-failure"); }
            return ack(path,body);
        });
        try {
            main(() -> j.onStartJob(null));await(j.completed);
            check(stops[0]==0 && !j.retry,"review raised during upload prevents server completion");
            try(Queue q=new Queue(c)) { check(q.pending("account") && q.routeIncomplete(id),"late review survives upload acknowledgement"); }
            check(c.getSharedPreferences("tracking-state",0).getString("syncPhase","").equals("REVIEW_REQUIRED"),"late review cannot report synchronization success");
        } finally { main(j::onDestroy);drain(j.disk);j.disk.shutdown(); }
    }
    private void cancelledBeforeWorker() throws Exception {
        Context c=contexts.get();JobCase cancelled=job(c,this::ack);cancelled.holdInitial=true;
        main(() -> { cancelled.onStartJob(null);check(cancelled.onStopJob(null),"cancel before worker starts");cancelled.onDestroy(); });
        cancelled.disk.execute(cancelled.held);await(cancelled.control);drain(cancelled.disk);
        JobCase replacement=job(c,this::ack);main(() -> replacement.onStartJob(null));await(replacement.completed);
        check(!replacement.retry,"cancelled deferred worker releases global job ownership");
        main(replacement::onDestroy);cancelled.disk.shutdown();replacement.disk.shutdown();
    }
    private void commitAtCompletion() throws Exception {
        Context c=contexts.get();JobCase j=job(c,this::ack);j.holdControl=true;
        main(() -> j.onStartJob(null));await(j.controlHeld);
        // The worker found no work, but persistence commits before its completion callback.
        try(Queue q=new Queue(c)) { q.begin("late","account");q.stop("immediate_stop"); }
        main(() -> { SyncJob.schedule(c);j.heldControl.run(); });await(j.completed);
        check(j.retry,"commit racing job completion requests another run");
        main(j::onDestroy);j.disk.shutdown();
    }
    private void recoveredRestart() throws Exception {
        Context c=contexts.get();String persisted;
        try(Queue q=new Queue(c)) {
            q.begin("00000000-0000-4000-8000-000000000001","account");q.add("00000000-0000-4000-8000-000000000001",fix(true));persisted=q.batch("00000000-0000-4000-8000-000000000001").toString();
            try(var row=q.getReadableDatabase().rawQuery("SELECT payload FROM fix",null)) {
                row.moveToFirst();check(!row.getString(0).contains("lat"),"restart fixture encrypted at rest");
            }
        } // Simulate process loss: no stop callback, then a fresh job with reopened database.
        JobCase restarted=job(c,(path,body) -> {
            if(path.equals("/trips/points/endpoint-v1")) check(body.getJSONArray("points").toString().equals(persisted),"new component recovers exact encrypted route");
            else check(body.getJSONObject("endpoint").getString("status").equals("unverified"),"crash before final commit cannot invent final evidence");
            return ack(path,body);
        });
        main(() -> restarted.onStartJob(null));await(restarted.completed);
        try(Queue q=new Queue(c)) { check(!q.pending("account"),"orphan active trip recovered and acknowledged"); }
        main(restarted::onDestroy);restarted.disk.shutdown();
    }
    private void mixedStop() throws Exception {
        Context c=contexts.get();try(Queue q=new Queue(c)) { q.begin("00000000-0000-4000-8000-000000000001","account");q.stop("immediate_stop"); }
        JobCase old=job(c,(path,body) -> { check(path.equals("/trips/stop/endpoint-v1"),"old revision cannot accept legacy stop path");throw new Api.Failure(404); });
        main(() -> old.onStartJob(null));await(old.completed);check(old.retry,"old revision response retries without discarding stop");
        try(Queue q=new Queue(c)) { check(q.pending("account"),"pending stop retained against old revision"); }
        JobCase next=job(c,this::ack);main(() -> next.onStartJob(null));await(next.completed);
        try(Queue q=new Queue(c)) { check(!q.pending("account"),"compatible revision completes same stop"); }
        main(old::onDestroy);main(next::onDestroy);old.disk.shutdown();next.disk.shutdown();
    }
    private void protocol() throws Exception {
        String request="request",account="account";
        for(int status:new int[]{404,405,401,403,503}) {
            try {
                StartProtocol.start((path,body) -> {
                    check(path.equals("/capabilities"),"compatibility probe cannot start a trip");
                    throw new Api.Failure(status);
                },request,account,new JSONObject());
                throw new AssertionError("incompatible or unavailable backend accepted");
            } catch(Api.Failure expected) {
                check(expected.status==(status==404||status==405?409:status),"capability failure retains auth/offline semantics");
            }
        }
        JSONObject supported=new JSONObject().put("stopContract",1).put("structuredStopAcknowledgement",true)
            .put("endpointVersion",1).put("startPath",MobileContract.START_PATH).put("stopPath",MobileContract.STOP_PATH);
        StartProtocol.requireCompatible((path,body) -> supported);
        for(String field:new String[]{"stopContract","structuredStopAcknowledgement","endpointVersion","startPath","stopPath"}) {
            JSONObject missing=new JSONObject(supported.toString());missing.remove(field);
            try { StartProtocol.requireCompatible((path,body) -> missing);throw new AssertionError("missing capability accepted"); }
            catch(Api.Failure expected) { check(expected.status==409 && expected.getMessage().equals(MobileContract.MESSAGE),"missing capability gives backend-first message"); }
        }
        try { StartProtocol.start((path,body) -> { if(path.equals("/capabilities")) return supported;check(path.equals(MobileContract.START_PATH),"never falls back to legacy start");throw new Api.Failure(404); },request,account,new JSONObject());throw new AssertionError("old revision accepted"); }
        catch(Api.Failure expected) { check(expected.status==404,"old revision cannot create trip"); }
        try { StartProtocol.start((path,body) -> path.equals("/capabilities") ? supported : new JSONObject().put("tripId","00000000-0000-4000-8000-000000000001").put("leaseMs",1000),request,account,new JSONObject());throw new AssertionError("unversioned response accepted"); }
        catch(Api.Failure expected) { check(expected.status==409,"explicit response contract required"); }
        int[] calls={0};
        JSONObject accepted=StartProtocol.start((path,body) -> {
            if(calls[0]++==0) { check(path.equals("/capabilities"),"capability recheck precedes creation");return supported; }
            check(path.equals(MobileContract.START_PATH) && body.getInt("stopContract")==1,"compatible creation keeps versioned stop contract");
            return new JSONObject().put("startContract",MobileContract.CONTRACT).put("requestId",request).put("accountId",account)
                .put("tripId","00000000-0000-4000-8000-000000000001").put("leaseMs",1000);
        },request,account,new JSONObject());
        check(calls[0]==2 && accepted.getLong("leaseMs")==1000,"compatible backend still starts through production protocol");
        StartProtocol.recover((path,body) -> new JSONObject().put("startContract",MobileContract.CONTRACT).put("requestId",request).put("accountId",account).put("recovered",true),request,account);
        check(true,"acknowledged recovery");
    }
    private void localityAcknowledgement() throws Exception {
        Context c=contexts.get();String id="00000000-0000-4000-8000-000000000001";
        try(Queue q=new Queue(c)) { q.begin(id,"account");q.stop(id,"endpoint_timeout",System.currentTimeMillis()); }
        JSONObject journey=new JSONObject().put("format","locality-v1").put("from","From area").put("to","To area");
        JobCase invalid=job(c,(path,body) -> new JSONObject().put("journey",journey));
        main(() -> invalid.onStartJob(null));await(invalid.completed);
        try(Queue q=new Queue(c)) { check(q.pending("account"),"journey text cannot replace structured stop acknowledgement"); }
        check(c.getSharedPreferences("tracking-state",0).getString("journey-locality:account","").isEmpty(),"invalid ACK cannot publish locality as completion");
        main(invalid::onDestroy);invalid.disk.shutdown();
        JobCase valid=job(c,(path,body) -> ack(path,body).put("journey",journey));
        main(() -> valid.onStartJob(null));await(valid.completed);
        try(Queue q=new Queue(c)) { check(!q.pending("account"),"valid structured stop ACK closes locality trip"); }
        check(c.getSharedPreferences("tracking-state",0).getString("journey-locality:account","").contains("From area"),"valid ACK retains locality for dashboard");
        check(c.getSharedPreferences("tracking-state",0).getString("journey-locality:other","").isEmpty(),"locality cache is account scoped");
        main(valid::onDestroy);valid.disk.shutdown();
    }
    int run() throws Exception { startupDenied();ordinaryFailureDuringEnd();blockedFinal();lifecycleStops();failedClosureRecovery();interruptedSync();reviewDuringUpload();cancelledBeforeWorker();commitAtCompletion();recoveredRestart();mixedStop();protocol();localityAcknowledgement();return checks; }
}
