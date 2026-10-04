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

public final class TripService extends Service implements LocationListener {
    static final String CHANNEL = "trip-tracking";
    static volatile TripService running;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private Queue queue;
    private LocationManager gps;
    private String trip;
    private long leaseUntil;
    private boolean checking;
    private final Runnable tick = new Runnable() {
        public void run() {
            if (trip == null) return;
            if (!permitted(TripService.this) || !gps.isProviderEnabled(LocationManager.GPS_PROVIDER)) { end("permission_or_gps_revoked"); return; }
            if (SystemClock.elapsedRealtime() >= leaseUntil) { end("policy_lease_expired"); return; }
            if (!checking) {
                checking = true;
                String requestedTrip = trip;
                long requestedAt = SystemClock.elapsedRealtime();
                network.execute(() -> {
                    try {
                        JSONObject response = Api.post(TripService.this, "/trips/lease", new JSONObject().put("tripId", requestedTrip), true);
                        main.post(() -> {
                            checking = false;
                            if (!requestedTrip.equals(trip)) return;
                            if (!response.optBoolean("active", false)) { end("policy_ended"); return; }
                            leaseUntil = requestedAt + Math.min(300000, Math.max(0, response.optLong("leaseMs", 0)));
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
        // Main thread: disable storage before requesting service teardown, even when no service exists.
        try (Queue q = new Queue(c)) { q.stop(reason); }
        catch (RuntimeException ignored) { /* Storage failure must not prevent GPS teardown. */ }
        finally {
            if (running != null) running.end(reason);
            else c.stopService(new Intent(c, TripService.class));
            SyncJob.schedule(c);
        }
    }
    public void onCreate() { super.onCreate(); queue = new Queue(this); gps = getSystemService(LocationManager.class); channel(this); }
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "STOP".equals(intent.getAction())) { end("employee_stopped"); return START_NOT_STICKY; }
        if (trip != null) return START_NOT_STICKY;
        if (intent == null || !"START".equals(intent.getAction()) || !permitted(this)) { end("start_denied"); return START_NOT_STICKY; }
        trip = intent.getStringExtra("tripId");
        leaseUntil = intent.getLongExtra("leaseUntil", 0);
        if (trip == null || !queue.active(trip) || SystemClock.elapsedRealtime() >= leaseUntil) { end("invalid_start"); return START_NOT_STICKY; }
        try {
            Intent stop = new Intent(this, TripService.class).setAction("STOP");
            PendingIntent stopAction = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            PendingIntent open = PendingIntent.getActivity(this, 2, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            Notification n = new Notification.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setContentTitle("PTRAAM trip tracking active").setContentText("Collecting GPS for your trip. Tap Stop trip to end.")
                .setContentIntent(open).setOngoing(true).setCategory(Notification.CATEGORY_SERVICE)
                .setVisibility(Notification.VISIBILITY_PRIVATE).addAction(new Notification.Action.Builder(null, "Stop trip", stopAction).build()).build();
            if (Build.VERSION.SDK_INT >= 29) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION); else startForeground(1, n);
            running = this;
            getSharedPreferences("tracking-state", 0).edit().putLong("lastFix", 0).putString("reason", "").apply();
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) { end("permission_revoked"); return START_NOT_STICKY; }
            gps.requestLocationUpdates(LocationManager.GPS_PROVIDER, 10000, 0, this, Looper.getMainLooper());
            main.post(tick);
        } catch (RuntimeException e) { end("location_start_failed"); }
        return START_NOT_STICKY;
    }
    public void onLocationChanged(Location l) {
        if (trip == null) return;
        if (!permitted(this) || SystemClock.elapsedRealtime() >= leaseUntil) { end("permission_or_policy_expired"); return; }
        long age = SystemClock.elapsedRealtimeNanos() - l.getElapsedRealtimeNanos();
        if (age < 0 || age > 60000000000L || !l.hasAccuracy() || l.getAccuracy() <= 0 || l.getAccuracy() > 100 || l.isFromMockProvider()) return;
        try { queue.add(trip, l); getSharedPreferences("tracking-state", 0).edit().putLong("lastFix", l.getTime()).apply(); SyncJob.schedule(this); }
        catch (Exception e) { end("local_storage_failed"); }
    }
    public void onProviderDisabled(String provider) { if (LocationManager.GPS_PROVIDER.equals(provider)) end("gps_disabled"); }
    public void onProviderEnabled(String provider) {}
    @SuppressWarnings("deprecation") public void onStatusChanged(String provider, int status, Bundle extras) {}
    private void end(String reason) {
        getSharedPreferences("tracking-state", 0).edit().putString("reason", reason).apply();
        trip = null; main.removeCallbacksAndMessages(null);
        try { gps.removeUpdates(this); } catch (RuntimeException ignored) {}
        try { queue.stop(reason); } catch (RuntimeException ignored) {}
        finally { running = null; stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); SyncJob.schedule(this); }
    }
    public void onDestroy() {
        trip = null; running = null; main.removeCallbacksAndMessages(null);
        try { gps.removeUpdates(this); } catch (RuntimeException ignored) {}
        try { queue.stop("service_destroyed"); } catch (RuntimeException ignored) {}
        finally { queue.close(); network.shutdownNow(); super.onDestroy(); }
    }
    public IBinder onBind(Intent intent) { return null; }
}
