package com.ptraam.tracker;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.*;
import android.os.*;
import java.util.concurrent.*;
import org.json.JSONObject;

public class TripService extends Service implements LocationListener {
    static final String CHANNEL = "trip-tracking";
    static volatile TripService running;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private LocationManager gps;
    private String trip;
    private String account;
    private long leaseUntil;
    private boolean checking, listening, terminating, ready, destroyed;
    private final EndTripCapture ending = new EndTripCapture();
    private final java.util.concurrent.atomic.AtomicInteger outstandingWrites = new java.util.concurrent.atomic.AtomicInteger();
    // Only the FIFO storage executor accesses this latch. Later success must not erase a gap.
    private boolean routeWriteFailed;
    int outstandingWrites() { return outstandingWrites.get(); }
    // Package-scoped platform seams let instrumentation invoke the actual service callbacks.
    Queue openQueue() { return new Queue(this); }
    void executeStorage(Runnable work) { QueueIO.execute(work); }
    boolean locationPermission() { return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED; }
    String currentAccount() { return Session.account(this); }
    boolean authorized() { return Session.current(this); }
    boolean validateToken() { return Session.valid(this); }
    void removeLocations() { gps.removeUpdates(this); }
    void requestLocations(long interval) {
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED)
            throw new SecurityException("Location permission revoked before listener registration");
        gps.requestLocationUpdates(LocationManager.GPS_PROVIDER, interval, 0, this, Looper.getMainLooper());
    }
    boolean gpsEnabled() { return gps.isProviderEnabled(LocationManager.GPS_PROVIDER); }
    boolean canStart() { return permitted(this); }
    void foreground(Notification n) { if (Build.VERSION.SDK_INT >= 29) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION); else startForeground(1,n); }
    void finishService() { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); }
    void scheduleSync() { SyncJob.schedule(this); }
    void startLeaseChecks() { main.post(tick); }
    static String liveTrip() { return running == null || running.terminating ? null : running.trip; }
    static void recover(Context c) {
        Context app = c.getApplicationContext(); String live = liveTrip(); long at = System.currentTimeMillis();
        QueueIO.execute(() -> { try (Queue q = new Queue(app)) { QueueIO.recoverOnce(q, live, at); }
            catch (RuntimeException e) { app.getSharedPreferences("tracking-state",0).edit().putString("syncPhase","REVIEW_REQUIRED").putString("sync","Local recovery needs review.").apply(); }
            SyncJob.schedule(app);
        });
    }
    private final Runnable guard = new Runnable() {
        public void run() {
            if (trip == null || !checkSafety()) return;
            main.postDelayed(this, Math.max(1, Math.min(1000, leaseUntil - SystemClock.elapsedRealtime())));
        }
    };
    private final Runnable tick = new Runnable() {
        public void run() {
            if (trip == null) return;
            if (!checkSafety()) return;
            ensureLocationListener();
            if (trip == null) return;
            if (!checking) {
                checking = true;
                String requestedTrip = trip;
                long requestedAt = SystemClock.elapsedRealtime();
                network.execute(() -> {
                    try {
                        JSONObject response = Api.post(TripService.this, "/trips/lease/endpoint-v1", new JSONObject().put("tripId", requestedTrip), true);
                        main.post(() -> {
                            checking = false;
                            if (!requestedTrip.equals(trip)) return;
                            if (!response.optBoolean("active", false)) { end("policy_ended"); return; }
                            leaseUntil = requestedAt + Math.min(300000, Math.max(0, response.optLong("leaseMs", 0)));
                            checkSafety();
                        });
                    } catch (Exception e) {
                        main.post(() -> {
                            checking = false;
                            if (requestedTrip.equals(trip) && e instanceof Api.Failure && (((Api.Failure)e).status == 401 || ((Api.Failure)e).status == 403 || ((Api.Failure)e).status == 404 || ((Api.Failure)e).status == 410)) end("authorization_ended");
                        });
                    }
                });
            }
            SyncJob.schedule(TripService.this);
            main.postDelayed(this, 15000);
        }
    };
    static void channel(Context c) {
        c.getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel(CHANNEL, "Active trip tracking", NotificationManager.IMPORTANCE_LOW));
    }
    static boolean permitted(Context c) {
        NotificationManager n = c.getSystemService(NotificationManager.class);
        NotificationChannel channel = n.getNotificationChannel(CHANNEL);
        return c.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            && n.areNotificationsEnabled() && channel != null && channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }
    static void stop(Context c, String reason) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            new Handler(Looper.getMainLooper()).post(() -> stop(c.getApplicationContext(), reason));
            return;
        }
        // Safety stops remove the listener before any potentially blocking storage work.
        if (running != null) { running.end(reason); return; }
        c.stopService(new Intent(c, TripService.class));
        Context app = c.getApplicationContext();
        QueueIO.execute(() -> { try (Queue q = new Queue(app)) { q.stop(reason); }
            catch (RuntimeException e) { QueueIO.recoveryRequired(); app.getSharedPreferences("tracking-state",0).edit().putString("endStatus","GPS stopped; local queue needs review.").apply(); }
            finally { SyncJob.schedule(app); }
        });
    }
    static void endTrip(Context c) {
        if (running != null) running.requestEnd();
        else stop(c, "endpoint_unavailable");
    }
    boolean isEnding() { return ending.waiting() || terminating; }
    public void onCreate() {
        super.onCreate(); gps = getSystemService(LocationManager.class); channel(this);
    }
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (terminating) return START_NOT_STICKY;
        if (intent != null && ("STOP".equals(intent.getAction()) || "STOP_NOW".equals(intent.getAction()))) {
            String target = intent.getStringExtra("tripId");
            if (trip != null && target != null && !trip.equals(target)) return START_NOT_STICKY;
            if ("STOP_NOW".equals(intent.getAction())) end("immediate_stop"); else requestEnd();
            return START_NOT_STICKY;
        }
        if (trip != null) return START_NOT_STICKY;
        if (intent == null || !"START".equals(intent.getAction())) { end("start_denied"); return START_NOT_STICKY; }
        String incomingTrip = intent.getStringExtra("tripId");
        if (!MobileContract.validTripId(incomingTrip)) { end("invalid_start"); return START_NOT_STICKY; }
        trip = incomingTrip;
        account = currentAccount();
        leaseUntil = intent.getLongExtra("leaseUntil", 0);
        // MainActivity has already committed this identity; denial must close it too.
        if (!canStart()) { end("start_denied"); return START_NOT_STICKY; }
        if (trip == null || !authorized() || SystemClock.elapsedRealtime() >= leaseUntil) { end("invalid_start"); return START_NOT_STICKY; }
        try {
            Intent stop = new Intent(this, TripService.class).setAction("STOP").putExtra("tripId", trip);
            PendingIntent stopAction = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            PendingIntent open = PendingIntent.getActivity(this, 2, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            Notification n = notification(open, stopAction, "Location tracking is active for your field trip.");
            foreground(n);
            running = this;
            getSharedPreferences("tracking-state", 0).edit().putLong("lastFix", 0).putString("reason", "").putString("endStatus", "").putString("gpsStatus", "GPS Active").apply();
            String requestedTrip = trip;
            main.post(guard);
            executeStorage(() -> {
                boolean active = false;
                try (Queue q = openQueue()) { active = q.active(requestedTrip) && validateToken(); }
                catch (RuntimeException ignored) {}
                final boolean allowed = active;
                main.post(() -> {
                    if (terminating || !requestedTrip.equals(trip)) return;
                    if (!allowed) { end("invalid_start"); return; }
                    if (!checkSafety()) return;
                    try { ready = true; requestLocations(10000); listening = true; startLeaseChecks(); }
                    catch (RuntimeException e) { end("location_start_failed"); }
                });
            });
        } catch (RuntimeException e) { end("location_start_failed"); }
        return START_NOT_STICKY;
    }
    public void onLocationChanged(Location l) {
        if (trip == null || terminating || !ready) return;
        if (!checkSafety()) return;
        if (ending.waiting()) {
            long validatedAt = System.currentTimeMillis();
            if (!ending.accepts(SystemClock.elapsedRealtimeNanos(), l.getElapsedRealtimeNanos(), validatedAt, l.getTime(),
                l.getLatitude(), l.getLongitude(), l.hasAccuracy() ? l.getAccuracy() : Float.NaN, mock(l))) return;
            if (!ending.freeze()) return;
            end("employee_stopped", new Location(l), validatedAt);
            return;
        }
        long age = SystemClock.elapsedRealtimeNanos() - l.getElapsedRealtimeNanos();
        if (age < 0 || age > 60000000000L || !l.hasAccuracy() || !Float.isFinite(l.getAccuracy()) || l.getAccuracy() <= 0 || l.getAccuracy() > 100 || mock(l)) return;
        String id = trip; Location frozen = new Location(l);
        String write = java.util.UUID.randomUUID().toString();
        outstandingWrites.incrementAndGet();
        executeStorage(() -> {
            boolean saved = false;
            try {
                for (int attempt = 0; attempt < 2 && !saved; attempt++) {
                    try (Queue q = openQueue()) { q.writeTracked(id,write,frozen); saved = true; }
                    catch (Exception e) { /* One bounded retry, ahead of all later points/closure. */ }
                }
                if (saved) {
                    main.post(() -> { if (!terminating && id.equals(trip)) getSharedPreferences("tracking-state",0).edit().putLong("lastFix",frozen.getTime()).putString("gpsStatus","GPS Active").apply(); });
                } else {
                    routeWriteFailed = true;
                    // Independent fallback if SQLite itself could not retain the journal marker.
                    getSharedPreferences("route-review",0).edit().putBoolean(id,true).commit();
                    reportRouteReview();
                    main.post(() -> { if (!terminating && id.equals(trip)) end("local_storage_failed"); });
                }
            } finally { outstandingWrites.decrementAndGet(); scheduleSync(); }
        });
    }
    private void reportRouteReview() {
        getSharedPreferences("tracking-state",0).edit().putString("syncPhase","REVIEW_REQUIRED")
            .putString("sync",Queue.ROUTE_REVIEW).putString("endStatus",Queue.ROUTE_REVIEW).apply();
    }
    public void onProviderDisabled(String provider) { if (LocationManager.GPS_PROVIDER.equals(provider)) { if (ending.waiting()) end("endpoint_gps_disabled"); else locationUnavailable("Location is unavailable. Turn on device location to continue accurate trip tracking."); } }
    public void onProviderEnabled(String provider) { if (LocationManager.GPS_PROVIDER.equals(provider)) ensureLocationListener(); }
    @SuppressWarnings("deprecation") public void onStatusChanged(String provider, int status, Bundle extras) {}
    @SuppressWarnings("deprecation") private static boolean mock(Location l) { return Build.VERSION.SDK_INT >= 31 ? l.isMock() : l.isFromMockProvider(); }
    private boolean checkSafety() {
        if (terminating) return false;
        String reason = ending.stopReason(SystemClock.elapsedRealtimeNanos(), leaseUntil,
            locationPermission(),
            account != null && account.equals(currentAccount()) && authorized());
        if (reason != null) { end(reason); return false; }
        return trip != null;
    }
    private void requestEnd() {
        if (trip == null || !ready) { end("endpoint_unavailable"); return; }
        if (!checkSafety() || !ending.begin(SystemClock.elapsedRealtimeNanos())) return;
        getSharedPreferences("tracking-state", 0).edit().putString("gpsStatus", "Ending trip: waiting up to 30 seconds for final GPS.").apply();
        main.postDelayed(() -> { if (trip != null && ending.waiting()) end("endpoint_timeout"); }, 30000);
        try {
            if (!gpsEnabled()) { end("endpoint_gps_disabled"); return; }
            removeLocations();
            requestLocations(1000);
            listening = true;
            updateNotification("Ending trip: waiting up to 30 seconds for final GPS. Stop now skips the endpoint.");
        } catch (SecurityException e) { end("permission_revoked"); }
        catch (RuntimeException e) { end("endpoint_unavailable"); }
    }
    private Notification notification(PendingIntent open, PendingIntent stop, String text) {
        Notification.Builder builder = new Notification.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("Fieldora — Field Trip Active").setContentText(text).setContentIntent(open)
            .setOngoing(true).setCategory(Notification.CATEGORY_SERVICE).setVisibility(Notification.VISIBILITY_PRIVATE);
        if (!terminating) builder.addAction(new Notification.Action.Builder(null, ending.waiting() ? "Stop now" : "End trip", stop).build());
        return builder.build();
    }
    private void locationUnavailable(String message) {
        if (trip == null) return;
        listening = false;
        getSharedPreferences("tracking-state", 0).edit().putString("gpsStatus", message).apply();
        try { removeLocations(); } catch (RuntimeException ignored) {}
        updateNotification(message);
    }
    void updateNotification(String message) {
        Intent stop = new Intent(this, TripService.class).setAction(ending.waiting() ? "STOP_NOW" : "STOP").putExtra("tripId", trip);
        PendingIntent stopAction = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent open = PendingIntent.getActivity(this, 2, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        getSystemService(NotificationManager.class).notify(1, notification(open, stopAction, message));
    }
    private void ensureLocationListener() {
        if (trip == null || terminating || !ready) return;
        if (!locationPermission()) { end("permission_revoked"); return; }
        if (!gpsEnabled()) { locationUnavailable("Location is unavailable. Turn on device location to continue accurate trip tracking."); return; }
        if (!listening) try {
            requestLocations(ending.waiting() ? 1000 : 10000); listening = true;
            getSharedPreferences("tracking-state", 0).edit().putString("gpsStatus", "GPS Active").apply();
        } catch (SecurityException e) { end("permission_revoked"); }
    }
    private void end(String reason) { end(reason, null, System.currentTimeMillis()); }
    private void end(String reason, Location endpoint, long at) {
        if (terminating) return;
        terminating = true; ending.finish();
        final String id = trip;
        listening = false; main.removeCallbacksAndMessages(null);
        try { removeLocations(); } catch (RuntimeException ignored) {}
        getSharedPreferences("tracking-state",0).edit().putString("reason",reason)
            .putString("gpsStatus","GPS stopped; saving trip.").putString("endStatus","GPS stopped; local persistence pending.").apply();
        try { updateNotification("GPS stopped. Saving trip safely; synchronization pending."); }
        catch (RuntimeException ignored) { /* Revoked notification permission cannot delay teardown. */ }
        // Keep the service alive while committing, but no GPS or safety control waits on storage.
        executeStorage(() -> {
            String message;
            try (Queue q = openQueue()) {
                if (outstandingWrites.get() != 0) throw new IllegalStateException("GPS writes must finish before closure");
                if (id != null && routeWriteFailed) q.markWrite(id,"failed:"+id);
                boolean captured = id != null && endpoint != null && q.finish(id, endpoint, reason, at);
                if (!captured && id != null) q.stop(id, reason, at);
                boolean incomplete = id != null && (q.routeIncomplete(id) || getSharedPreferences("route-review",0).getBoolean(id,false));
                if (incomplete) reportRouteReview();
                message = incomplete ? Queue.ROUTE_REVIEW : captured ? "Trip ended. Final GPS coordinate saved; synchronization pending."
                    : "Trip ended. Destination unverified; recorded GPS retained for synchronization.";
            } catch (Exception e) {
                // A failed transaction leaves previous records intact. Try an unverified closure.
                try (Queue q = openQueue()) { if (id != null) q.stop(id,"endpoint_storage_failed",at); }
                catch (RuntimeException ignored) { QueueIO.recoveryRequired(); }
                message = routeWriteFailed ? Queue.ROUTE_REVIEW : "GPS stopped. Final capture was not saved; local queue needs review.";
            }
            getSharedPreferences("tracking-state",0).edit().putString("endStatus",message).apply();
            scheduleSync();
            main.post(() -> { if (running == this) running = null; trip = null; if (!destroyed) finishService(); });
        });
    }
    public void onDestroy() {
        destroyed = true;
        if (!terminating) end("service_destroyed");
        if (running == this) running = null;
        listening = false; main.removeCallbacksAndMessages(null);
        try { removeLocations(); } catch (RuntimeException ignored) {}
        // Do not interrupt QueueIO: an in-flight final transaction owns the stop evidence.
        network.shutdownNow(); super.onDestroy();
    }
    public IBinder onBind(Intent intent) { return null; }
}
