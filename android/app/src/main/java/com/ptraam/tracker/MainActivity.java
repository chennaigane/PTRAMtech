package com.ptraam.tracker;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.os.*;
import android.location.*;
import android.text.InputType;
import android.widget.*;
import org.json.JSONObject;
import java.util.UUID;
import java.util.concurrent.*;

public final class MainActivity extends Activity {
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private static final java.util.concurrent.atomic.AtomicInteger pendingRequests = new java.util.concurrent.atomic.AtomicInteger();
    private TextView status;
    private TextView tracking;
    private LocationListener startLocation;
    private Runnable locationTimeout;
    private boolean visible, busy;
    private int generation;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Runnable refresh = new Runnable() {
        public void run() {
            try (Queue q = new Queue(MainActivity.this)) {
                var state = getSharedPreferences("tracking-state", 0);
                long lastFix = state.getLong("lastFix", 0);
                tracking.setText((TripService.running == null ? "GPS tracking stopped." : "Trip tracking active. Poor GPS fixes are skipped.")
                    + (TripService.running == null ? "\nStop reason: " + state.getString("reason", "No active trip") : "\n" + (lastFix == 0 ? "Waiting for a GPS fix." : "Last GPS fix: " + new java.util.Date(lastFix)))
                    + "\nQueued GPS points: " + q.count(Session.account(MainActivity.this))
                    + "\n" + state.getString("sync", "")
                    + "\n" + (Session.account(MainActivity.this).isEmpty() ? "Signed out" : "Signed in")
                    + "\nServer: " + (Backend.origin(MainActivity.this).isEmpty() ? "Not configured" : Backend.origin(MainActivity.this)));
            } catch (RuntimeException e) { tracking.setText("Local queue needs review. GPS has been stopped."); TripService.stop(MainActivity.this, "storage_error"); }
            ui.postDelayed(this, 2000);
        }
    };
    public void onCreate(Bundle state) {
        super.onCreate(state); TripService.channel(this);
        // OS death / force-stop never authorizes automatic tracking on reopening.
        if (TripService.running == null) try (Queue q = new Queue(this)) { q.stop("app_interrupted"); }
        LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL); layout.setPadding(24, 32, 24, 24);
        ScrollView scroll = new ScrollView(this); scroll.addView(layout); setContentView(scroll);
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        TextView notice = new TextView(this);
        notice.setText("PTRAAM Enterprises — test build\n\nAfter you tap Start trip and agree, the app requests precise GPS for your work trip. A visible service is intended to continue while locked; reliability has NOT been verified on a physical phone. Stop trip or Log out ends collection. GPS points are encrypted on this phone and sent over HTTPS to your company server. Offline tracking stops when the server authorization expires (at most five minutes); queued points retry when online. Sign in again after session expiry to finish syncing. Force-stop interrupts tracking and never automatically restarts GPS. Use test accounts until your company supplies its privacy contact and retention policy.\n");
        layout.addView(notice);
        EditText backend = new EditText(this); backend.setHint("HTTPS server supplied by Admin"); backend.setSingleLine(true); backend.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI); backend.setText(Backend.origin(this)); layout.addView(backend);
        button(layout, "Save server", () -> {
            if (pendingRequests.get() > 0) { fail("Wait for the current network request to finish before changing the server."); return; }
            if (busy || TripService.running != null) return;
            try { Backend.save(this, backend.getText().toString()); status.setText("Server saved. Sign in with your approved employee account."); }
            catch (Exception e) { fail(e.getMessage()); }
        });
        EditText phone = new EditText(this); phone.setHint("Approved phone number"); phone.setInputType(InputType.TYPE_CLASS_PHONE); layout.addView(phone);
        EditText password = new EditText(this); password.setHint("Password"); password.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD); layout.addView(password);
        status = new TextView(this); layout.addView(status);
        tracking = new TextView(this); layout.addView(tracking);
        button(layout, "Sign in", () -> {
            if (busy || TripService.running != null) return;
            busy = true; int request = generation;
            String origin = Backend.origin(this);
            String p = phone.getText().toString(), secret = password.getText().toString(); password.setText("");
            send(() -> {
                try {
                    JSONObject response = Api.postToOrigin(origin, "/session", new JSONObject().put("phone", p).put("password", secret), null);
                    runOnUiThread(() -> {
                        if (request != generation || isDestroyed()) return;
                        try { Session.save(this, response.getString("accountId"), response.getString("accessToken")); busy = false; status.setText("Signed in"); SyncJob.schedule(this); }
                        catch (Exception e) { fail("Unable to save session"); }
                    });
                } catch (Exception e) { runOnUiThread(() -> { if (request == generation) fail(e instanceof Api.Failure ? e.getMessage() : "Sign-in failed. Check your HTTPS server and network."); }); }
            });
        });
        button(layout, "Start trip", () -> {
            if (busy || TripService.running != null) return;
            new AlertDialog.Builder(this).setTitle("Allow trip location collection?")
                .setMessage("Collect precise GPS for this work trip, including while locked or backgrounded, and upload it to PTRAAM as described above?")
                .setNegativeButton("Cancel", null).setPositiveButton("Agree", (d, w) -> permissions()).show();
        });
        button(layout, "Stop trip", () -> { generation++; busy = false; cancelLocation(); TripService.stop(this, "employee_stopped"); status.setText("Tracking stopped. Queued points and the stop record will sync when online."); });
        button(layout, "Log out", () -> {
            generation++; busy = false; cancelLocation(); TripService.stop(this, "logout");
            try {
                String token = Session.token(this);
                String origin = Backend.origin(this);
                send(() -> { try { Api.postToOrigin(origin, "/session/logout", new JSONObject(), token); } catch (Exception ignored) { /* Server expiry is required for offline logout. */ } });
            } catch (Exception ignored) {}
            Session.clear(this);
            status.setText("Logged out; GPS stopped. Sign in to the same account to deliver queued records.");
        });
        button(layout, "Sync queued trips", () -> { SyncJob.schedule(this); status.setText("Sync requested. Android will run it when online. If your session expired, sign in again."); });
        button(layout, "Location / notification settings", () -> startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:" + getPackageName()))));
        SyncJob.schedule(this);
    }
    private void send(Runnable action) {
        pendingRequests.incrementAndGet();
        try {
            network.execute(() -> {
                try { action.run(); }
                finally { ui.post(() -> pendingRequests.decrementAndGet()); }
            });
        } catch (java.util.concurrent.RejectedExecutionException e) {
            pendingRequests.decrementAndGet();
            throw e;
        }
    }
    private void button(LinearLayout l, String label, Runnable action) { Button b = new Button(this); b.setText(label); b.setOnClickListener(v -> action.run()); l.addView(b); }
    private void fail(String message) { busy = false; status.setText(message); new AlertDialog.Builder(this).setMessage(message).setPositiveButton("OK", null).show(); }
    private void permissions() {
        if (Session.account(this).isEmpty()) { fail("Sign in before starting a trip."); return; }
        if (!TripService.permitted(this)) {
            String[] permissions = Build.VERSION.SDK_INT >= 33 ? new String[]{Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.POST_NOTIFICATIONS}
                : new String[]{Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION};
            requestPermissions(permissions, 10); return;
        }
        captureStart();
    }
    public void onRequestPermissionsResult(int code, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(code, permissions, grants);
        if (code == 10) {
            if (TripService.permitted(this)) { status.setText("Permissions granted. Tap Start trip to begin."); }
            else fail("Precise location and visible notifications are required. Enable them in Settings, then tap Start trip.");
        }
    }
    private void cancelLocation() {
        if (startLocation != null) { getSystemService(LocationManager.class).removeUpdates(startLocation); startLocation = null; }
        if (locationTimeout != null) { ui.removeCallbacks(locationTimeout); locationTimeout = null; }
    }
    private void captureStart() {
        if (!visible || busy) return;
        LocationManager gps = getSystemService(LocationManager.class);
        if (!gps.isProviderEnabled(LocationManager.GPS_PROVIDER)) { fail("Enable Location (GPS), then try again outdoors."); return; }
        busy = true; status.setText("Waiting for a fresh GPS fix (up to 45 seconds)...");
        startLocation = new LocationListener() {
            public void onLocationChanged(Location l) {
                long age = SystemClock.elapsedRealtimeNanos() - l.getElapsedRealtimeNanos();
                if (!l.hasAccuracy() || l.getAccuracy() <= 0 || l.getAccuracy() > 100 || age < 0 || age > 30000000000L || l.isFromMockProvider()) return;
                cancelLocation(); busy = false;
                try { startTrip(new JSONObject().put("lat", l.getLatitude()).put("lng", l.getLongitude()).put("accuracy", l.getAccuracy()).put("time", l.getTime())); }
                catch (Exception e) { fail("Unable to read the GPS fix."); }
            }
            public void onProviderDisabled(String provider) { cancelLocation(); fail("GPS was disabled. Trip was not started."); }
            public void onProviderEnabled(String provider) {}
            @SuppressWarnings("deprecation") public void onStatusChanged(String provider, int status, Bundle extras) {}
        };
        locationTimeout = () -> { cancelLocation(); fail("No accurate GPS fix received. Move outdoors and tap Start trip again."); };
        try { gps.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000, 0, startLocation, Looper.getMainLooper()); ui.postDelayed(locationTimeout, 45000); }
        catch (SecurityException e) { cancelLocation(); fail("Location permission was denied. Trip was not started."); }
    }
    private void startTrip(JSONObject fix) {
        if (!visible || busy) return;
        try (Queue q = new Queue(this)) { if (q.pending(Session.account(this))) { fail("A previous trip needs synchronization or review before starting another."); SyncJob.schedule(this); return; } }
        busy = true; int request = generation;
        String account = Session.account(this);
        var requests = getSharedPreferences("start-requests", 0);
        String key = requests.getString(account, null);
        if (key == null) {
            key = UUID.randomUUID().toString();
            if (!requests.edit().putString(account, key).commit()) { fail("Cannot save trip request."); return; }
        }
        String requestKey = key;
        String origin = Backend.origin(this);
        final String token;
        try { token = Session.token(this); } catch (Exception e) { fail("Sign in again."); return; }
        long requestedAt = SystemClock.elapsedRealtime();
        send(() -> {
            try {
                JSONObject response = Api.postToOrigin(origin, "/trips/start", new JSONObject().put("requestId", requestKey).put("fix", fix), token);
                String id = response.getString("tripId");
                long until = requestedAt + Math.min(300000, Math.max(0, response.getLong("leaseMs")));
                runOnUiThread(() -> {
                    try (Queue q = new Queue(this)) {
                        q.begin(id, account); requests.edit().remove(account).commit();
                        if (!visible || request != generation || !TripService.permitted(this) || SystemClock.elapsedRealtime() >= until) {
                            q.stop("start_cancelled"); SyncJob.schedule(this); busy = false; return;
                        }
                        startForegroundService(new Intent(this, TripService.class).setAction("START").putExtra("tripId", id).putExtra("leaseUntil", until));
                        busy = false;
                    } catch (Exception e) { TripService.stop(this, "start_failed"); fail("Trip could not start safely."); }
                });
            } catch (Exception e) { runOnUiThread(() -> { if (request == generation) fail(e instanceof Api.Failure ? e.getMessage() : "Cannot start trip. Network and server authorization are required."); }); }
        });
    }
    public void onResume() { super.onResume(); visible = true; ui.post(refresh); if (TripService.running != null && !TripService.permitted(this)) TripService.stop(this, "permission_revoked"); }
    public void onPause() { visible = false; ui.removeCallbacks(refresh); if (startLocation != null) { cancelLocation(); busy = false; status.setText("Start cancelled while app was hidden. Tap Start trip again."); } super.onPause(); }
    public void onDestroy() { generation++; cancelLocation(); network.shutdown(); super.onDestroy(); }
}
