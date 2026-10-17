package com.ptraam.tracker;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.location.*;
import android.net.*;
import android.os.*;
import android.view.View;
import android.widget.*;
import org.json.JSONObject;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.concurrent.*;

public final class MainActivity extends Activity {
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private static final java.util.concurrent.atomic.AtomicInteger pendingRequests = new java.util.concurrent.atomic.AtomicInteger();
    private final Handler ui = new Handler(Looper.getMainLooper());
    private TextView status, tripStatus, tripGps, tripDetails, syncStatus, networkBanner;
    private WebShell shell;
    private View nativeControls;
    private Button startButton;
    private View activeActions, tripCard;
    private LocationListener startLocation;
    private Runnable locationTimeout;
    private boolean visible, busy, queueReadPending;
    private int generation;
    private final Runnable refresh = new Runnable() { public void run() { updateDashboard(); ui.postDelayed(this, TripService.running == null ? 10000 : 1000); } };

    @Override public void onCreate(Bundle state) {
        super.onCreate(state); TripService.channel(this);
        if (TripService.running == null) TripService.recover(this);
        nativeControls = getLayoutInflater().inflate(R.layout.activity_dashboard, null);
        bindDashboard();
        shell = new WebShell(this, new WebShell.Actions(){
            public void start(String note){if(busy||TripService.running!=null)return;pendingStartNote=note;confirmStart();}
            public void stop(){stopTrip();}
            public void cancelStart(){generation++;cancelLocation();busy=false;}
        });
        setContentView(shell.view); SyncJob.schedule(this);
    }
    @Override public <T extends View> T findViewById(int id) { T view=super.findViewById(id);return view!=null?view:nativeControls==null?null:nativeControls.findViewById(id); }
    @Override public void onBackPressed(){if(shell!=null)shell.back();else super.onBackPressed();}
    @Override protected void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);if(request==WebShell.EXPORT&&shell!=null)shell.exportResult(result,data);}
    private void bindDashboard() {
        status = findViewById(R.id.dashboard_message); tripStatus = findViewById(R.id.trip_status); tripGps = findViewById(R.id.trip_gps);
        tripDetails = findViewById(R.id.trip_details); syncStatus = findViewById(R.id.sync_status); networkBanner = findViewById(R.id.network_banner);
        startButton = findViewById(R.id.start_trip); activeActions = findViewById(R.id.active_trip_actions); tripCard = findViewById(R.id.trip_card);
        String name = Session.name(this), first = name.isEmpty() ? "" : name.trim().split("\\s+")[0];
        int hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY); String greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
        ((TextView)findViewById(R.id.dashboard_greeting)).setText(first.isEmpty() ? getString(R.string.dashboard_greeting) : greeting + ", " + first);
        ((TextView)findViewById(R.id.dashboard_date)).setText(new SimpleDateFormat("dd MMMM yyyy", Locale.getDefault()).format(new Date()));
        boolean driver = "Driver".equalsIgnoreCase(Session.department(this));
        ((TextView)findViewById(R.id.trip_title)).setText(driver ? R.string.driver_duty : R.string.field_trip);
        if (driver) status.setText(R.string.driver_policy);
        startButton.setOnClickListener(v -> confirmStart()); findViewById(R.id.end_trip).setOnClickListener(v -> stopTrip()); findViewById(R.id.view_trip).setOnClickListener(v -> showTripDetails());
        findViewById(R.id.sync_now).setOnClickListener(v -> { SyncJob.schedule(this); status.setText("Sync requested. Android will run it when a network is available."); updateDashboard(); });
        findViewById(R.id.logout).setOnClickListener(v -> logout());
        View.OnClickListener attendance = v -> startActivity(new Intent(this, AttendanceActivity.class));
        findViewById(R.id.attendance_action).setOnClickListener(attendance); findViewById(R.id.quick_attendance).setOnClickListener(attendance); findViewById(R.id.nav_attendance).setOnClickListener(attendance);
        View.OnClickListener trips = v -> startActivity(new Intent(this, TripActivity.class));
        findViewById(R.id.quick_trips).setOnClickListener(trips); findViewById(R.id.nav_trips).setOnClickListener(trips);
        View.OnClickListener leave = v -> startActivity(new Intent(this, LeaveActivity.class)); findViewById(R.id.quick_leave).setOnClickListener(leave); findViewById(R.id.nav_leave).setOnClickListener(leave);
        findViewById(R.id.quick_expenses).setOnClickListener(v -> startActivity(new Intent(this, ExpensesActivity.class)));
        View.OnClickListener profile = v -> startActivity(new Intent(this, ProfileActivity.class)); findViewById(R.id.quick_profile).setOnClickListener(profile); findViewById(R.id.nav_profile).setOnClickListener(profile);
        findViewById(R.id.quick_emergency).setOnClickListener(v -> emergency()); findViewById(R.id.nav_home).setOnClickListener(v -> ((ScrollView)findViewById(R.id.dashboard_scroll)).smoothScrollTo(0, 0));
    }
    private void updateDashboard() {
        if(shell!=null) shell.publish(status.getText().toString(),syncStatus.getText().toString());
        if (!Session.current(this)) { return; }
        boolean active = TripService.running != null; startButton.setVisibility(active ? View.GONE : View.VISIBLE); startButton.setEnabled(!busy && !active); activeActions.setVisibility(active ? View.VISIBLE : View.GONE); tripGps.setVisibility(active ? View.VISIBLE : View.GONE);
        boolean ending = active && TripService.running.isEnding();
        tripStatus.setText(ending ? "ENDING TRIP" : active ? getString(R.string.trip_active).toUpperCase(Locale.ROOT) : getString(R.string.no_active_trip));
        ((Button)findViewById(R.id.end_trip)).setText(ending ? "Stop now" : getString(R.string.end_trip));
        var dashboard = getSharedPreferences("dashboard-state", 0); var tracking = getSharedPreferences("tracking-state", 0);
        long started = dashboard.getLong("tripStartedAt", 0), lastFix = tracking.getLong("lastFix", 0);
        String gpsState = tracking.getString("gpsStatus", "GPS Active"); tripGps.setText(gpsState);
        if (!active && started != 0) { dashboard.edit().remove("tripStartedAt").apply(); started = 0; }
        if (active) {
            StringBuilder details = new StringBuilder();
            if (started > 0) { details.append("Started: ").append(new SimpleDateFormat("h:mm a", Locale.getDefault()).format(new Date(started))); long seconds = Math.max(0, (System.currentTimeMillis() - started) / 1000); details.append("\nDuration: ").append(String.format(Locale.getDefault(), "%02d:%02d:%02d", seconds / 3600, (seconds % 3600) / 60, seconds % 60)); }
            details.append(lastFix == 0 ? "\nWaiting for a GPS fix." : "\nLast GPS fix: " + new SimpleDateFormat("h:mm:ss a", Locale.getDefault()).format(new Date(lastFix))); tripDetails.setText(details.toString().trim());
        } else tripDetails.setText(tracking.getString("endStatus", "").isEmpty()
            ? "GPS collection starts only after you confirm and an accurate location fix is obtained." : tracking.getString("endStatus", ""));
        String journey = tracking.getString("journey-locality:" + Session.account(this), "");
        if (!journey.isEmpty()) tripDetails.append("\n" + journey);
        if (!queueReadPending) {
            queueReadPending = true; String account = Session.account(this);
            QueueIO.execute(() -> {
                int count = 0; boolean pending = true, failed = false;
                try (Queue q = new Queue(this)) { count = q.count(account); pending = q.hasSyncWork(account); }
                catch (RuntimeException e) { failed = true; }
                final int queued = count; final boolean work = pending, error = failed;
                ui.post(() -> {
                    queueReadPending = false;
                    if (!visible || !account.equals(Session.account(this))) return;
                    if (error) { syncStatus.setText("Local queue needs review"); TripService.stop(this,"storage_error"); return; }
                    String phase = tracking.getString("syncPhase", work ? "PENDING" : "SYNCED");
                    if ("AUTH_REQUIRED".equals(phase) || "REVIEW_REQUIRED".equals(phase)) syncStatus.setText(tracking.getString("sync","Queue needs review."));
                    else if ("SYNCING".equals(phase)) syncStatus.setText(getString(R.string.syncing));
                    else if (work) syncStatus.setText(queued + " GPS points; trip synchronization pending.");
                    else syncStatus.setText(getString(R.string.synced));
                });
            });
        }
        if (online()) networkBanner.setVisibility(View.GONE); else { networkBanner.setText("You’re offline. Trip data will remain queued and sync when Android permits."); networkBanner.setVisibility(View.VISIBLE); }
    }
    private String pendingStartNote="";
    private void confirmStart() { if (busy || TripService.running != null) return; new AlertDialog.Builder(this).setTitle("Allow trip location collection?").setMessage("Collect precise GPS for this work trip, including while locked or backgrounded, and upload it to Fieldora?").setNegativeButton(R.string.cancel, null).setPositiveButton("Agree", (d,w) -> permissions()).show(); }
    private void stopTrip() {
        if (busy || TripService.running == null) return;
        if (TripService.running.isEnding()) { TripService.stop(this, "immediate_stop"); updateDashboard(); return; }
        new AlertDialog.Builder(this).setTitle("End current field trip?").setMessage("Fieldora will try for up to 30 seconds to save a fresh final GPS coordinate, while authorization permits. If unavailable, the trip still ends with an unverified destination. Stored data remains queued until acknowledged.")
            .setNegativeButton(R.string.cancel, null).setNeutralButton("Stop now", (d,w) -> { TripService.stop(this, "immediate_stop"); updateDashboard(); })
            .setPositiveButton(R.string.end_trip, (d,w) -> finishTrip()).show();
    }
    private void finishTrip() {
        generation++; cancelLocation();
        TripService.endTrip(this);
        updateDashboard();
    }
    private void showTripDetails() { new AlertDialog.Builder(this).setTitle(R.string.trip_active).setMessage(tripDetails.getText() + "\n\n" + syncStatus.getText()).setPositiveButton(R.string.ok, null).show(); }
    private void unavailable(String feature) { new AlertDialog.Builder(this).setTitle(feature).setMessage(R.string.feature_not_available).setPositiveButton(R.string.ok, null).show(); }
    private void openWorkRequest(String feature) { startActivity(new Intent(this, WorkRequestActivity.class).putExtra(WorkRequestActivity.FEATURE, feature)); }
    private void showProfile() { String name = Session.name(this), role = Session.role(this); new AlertDialog.Builder(this).setTitle(R.string.profile).setMessage((name.isEmpty() ? getString(R.string.dashboard_greeting) : name) + "\n" + (role.isEmpty() ? getString(R.string.role_employee) : role)).setNeutralButton(R.string.settings, (d,w) -> startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())))).setPositiveButton(R.string.ok, null).show(); }
    private void emergency() { new AlertDialog.Builder(this).setTitle(R.string.emergency_title).setMessage(R.string.emergency_message).setNegativeButton(R.string.cancel, null).setPositiveButton(R.string.open_dialler, (d,w) -> startActivity(new Intent(Intent.ACTION_DIAL, Uri.parse("tel:112")))).show(); }
    private void logout() { generation++; busy = false; cancelLocation(); TripService.stop(this, "logout"); try { String token = Session.token(this), origin = Backend.origin(this); send(() -> { try { Api.postToOrigin(origin, "/session/logout", new JSONObject(), token); } catch (Exception ignored) {} }); } catch (Exception ignored) {} Session.clear(this); openLogin(); }
    private void openLogin() { if(shell!=null)shell.login(); }
    private boolean online() { ConnectivityManager m = getSystemService(ConnectivityManager.class); Network n = m.getActiveNetwork(); NetworkCapabilities c = n == null ? null : m.getNetworkCapabilities(n); return c != null && c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET); }
    private void send(Runnable action) { pendingRequests.incrementAndGet(); try { network.execute(() -> { try { action.run(); } finally { ui.post(() -> pendingRequests.decrementAndGet()); } }); } catch (RejectedExecutionException e) { pendingRequests.decrementAndGet(); throw e; } }
    private void fail(String message) { busy = false; status.setText(message); new AlertDialog.Builder(this).setMessage(message).setPositiveButton(R.string.ok, null).show(); updateDashboard(); }
    private void permissions() { if (Session.account(this).isEmpty()) { fail("Sign in before starting a trip."); return; } if (!TripService.permitted(this)) { String[] permissions = Build.VERSION.SDK_INT >= 33 ? new String[]{Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.POST_NOTIFICATIONS} : new String[]{Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION}; requestPermissions(permissions, 10); return; } checkBackendBeforeCapture(); }
    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] grants) { super.onRequestPermissionsResult(code, permissions, grants); if(shell!=null)shell.permissionsResult(code); if (code == 10) { if (TripService.permitted(this)) { status.setText("Permissions granted. Connecting to GPS automatically..."); checkBackendBeforeCapture(); } else fail("Precise location and visible notifications are required. Enable them in Settings, then tap Start trip."); } }
    private void cancelLocation() { if (startLocation != null) { getSystemService(LocationManager.class).removeUpdates(startLocation); startLocation = null; } if (locationTimeout != null) { ui.removeCallbacks(locationTimeout); locationTimeout = null; } }
    private static void requireContract(String origin, String token) throws Exception {
        StartProtocol.requireCompatible((path,body) -> Api.postToOrigin(origin,path,body,token));
    }
    private void checkBackendBeforeCapture() {
        if (!visible || busy) return;
        final String account = Session.account(this), origin = Backend.origin(this);
        final int request = generation;
        busy = true; status.setText("Checking server compatibility...");
        send(() -> {
            try {
                String token = Session.token(this);
                String pending = getSharedPreferences("start-requests",0).getString(account,null);
                if (pending != null) {
                    StartProtocol.recover((path,body) -> Api.postToOrigin(origin,path,body,token),pending,account);
                    if (!getSharedPreferences("start-requests",0).edit().remove(account).commit()) throw new java.io.IOException("Cannot save recovery.");
                }
                requireContract(origin, token);
                runOnUiThread(() -> {
                    if (request != generation) return;
                    busy = false;
                    if (!visible || !Session.current(this) || !account.equals(Session.account(this))
                        || !origin.equals(Backend.origin(this)) || !TripService.permitted(this)) return;
                    captureStart();
                });
            } catch (Exception e) { runOnUiThread(() -> {
                if (request == generation) fail(e instanceof Api.Failure ? e.getMessage()
                    : "Cannot verify server compatibility. Connect to Fieldora and retry. No trip was started.");
            }); }
        });
    }
    private void captureStart() {
        if (!visible || busy) return; LocationManager gps = getSystemService(LocationManager.class); if (!gps.isProviderEnabled(LocationManager.GPS_PROVIDER)) { fail("Enable Location (GPS), then try again outdoors."); return; }
        busy = true; status.setText("Waiting for a fresh GPS fix (up to 45 seconds)…");
        final long requested = SystemClock.elapsedRealtimeNanos();
        startLocation = new LocationListener() { public void onLocationChanged(Location l) { long age = SystemClock.elapsedRealtimeNanos() - l.getElapsedRealtimeNanos(); if (!l.hasAccuracy() || !Float.isFinite(l.getAccuracy()) || l.getAccuracy() <= 0 || l.getAccuracy() > 100 || age < 0 || age > 30000000000L || l.getElapsedRealtimeNanos() < requested || l.isFromMockProvider()) return; cancelLocation(); busy = false; try { startTrip(new JSONObject().put("lat", l.getLatitude()).put("lng", l.getLongitude()).put("accuracy", l.getAccuracy()).put("time", l.getTime())); } catch (Exception e) { fail("Unable to read the GPS fix."); } } public void onProviderDisabled(String provider) { cancelLocation(); fail("GPS was disabled. Trip was not started."); } public void onProviderEnabled(String provider) {} @SuppressWarnings("deprecation") public void onStatusChanged(String provider, int state, Bundle extras) {} };
        locationTimeout = () -> { cancelLocation(); fail("No accurate GPS fix received. Move outdoors and tap Start trip again."); };
        try { gps.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000, 0, startLocation, Looper.getMainLooper()); ui.postDelayed(locationTimeout, 45000); } catch (SecurityException e) { cancelLocation(); fail("Location permission was denied. Trip was not started."); }
    }
    private void startTrip(JSONObject fix) {
        if (!visible || busy) return;
        busy = true; final int request = generation;
        final String account = Session.account(this), origin = Backend.origin(this);
        QueueIO.execute(() -> {
            try (Queue q = new Queue(this)) {
                if (q.pending(account)) { ui.post(() -> { if (request == generation) fail("A previous trip needs synchronization or review before starting another."); }); SyncJob.schedule(this); return; }
            } catch (RuntimeException e) { ui.post(() -> fail("Local queue needs review.")); return; }
            send(() -> {
                var requests = getSharedPreferences("start-requests",0);
                String key = requests.getString(account,null);
                try {
                    final String token = Session.token(this);
                    StartProtocol.Transport transport = (path,body) -> Api.postToOrigin(origin,path,body,token);
                    if (key != null) {
                        StartProtocol.recover(transport,key,account);
                        if (!requests.edit().remove(account).commit()) throw new java.io.IOException("Cannot save recovery.");
                    }
                    key = UUID.randomUUID().toString();
                    if (!requests.edit().putString(account,key).commit()) throw new java.io.IOException("Cannot save trip request.");
                    long requestedAt = SystemClock.elapsedRealtime();
                    JSONObject response = StartProtocol.start(transport,key,account,fix,pendingStartNote);
                    String id = response.getString("tripId");
                    long until = requestedAt + response.getLong("leaseMs");
                    QueueIO.execute(() -> {
                        try (Queue q = new Queue(this)) {
                            q.begin(id,account);
                            if (!requests.edit().remove(account).commit()) { q.stop(id,"start_journal_error",System.currentTimeMillis()); throw new java.io.IOException("Cannot save trip request."); }
                            ui.post(() -> {
                                if (!visible || request != generation || !account.equals(Session.account(this)) || !Session.current(this)
                                    || !TripService.permitted(this) || SystemClock.elapsedRealtime() >= until) {
                                    QueueIO.execute(() -> { try (Queue cancelled = new Queue(this)) { cancelled.stop(id,"start_cancelled",System.currentTimeMillis()); } catch (RuntimeException e) { QueueIO.recoveryRequired(); } finally { SyncJob.schedule(this); } });
                                    busy = false; return;
                                }
                                getSharedPreferences("dashboard-state",0).edit().putLong("tripStartedAt",System.currentTimeMillis()).apply();
                                getSharedPreferences("tracking-state",0).edit().remove("journey-locality:" + account).apply();
                                SyncJob.rememberJourney(this,account,response);
                                try { startForegroundService(new Intent(this,TripService.class).setAction("START").putExtra("tripId",id).putExtra("leaseUntil",until)); }
                                catch (RuntimeException e) { TripService.stop(this,"start_failed"); }
                                busy = false; status.setText("Trip started."); updateDashboard();
                            });
                        } catch (Exception e) { QueueIO.recoveryRequired(); SyncJob.schedule(this); ui.post(() -> { if (request == generation) fail("Trip start needs recovery. Reconnect and retry; stored records are preserved."); }); }
                    });
                } catch (Exception e) {
                    // Keep the durable request ID until cancellation is acknowledged. A tombstone
                    // also prevents a delayed original request from creating a trip after recovery.
                    if (key != null) try {
                        final String token = Session.token(this);
                        StartProtocol.recover((path,body) -> Api.postToOrigin(origin,path,body,token),key,account);
                        requests.edit().remove(account).commit();
                    } catch (Exception unresolved) { /* Next start reconciles this exact request first. */ }
                    ui.post(() -> { if (request == generation) fail("Trip not started locally. A compatible server and network are required; reconnect and retry to resolve any pending request."); });
                }
            });
        });
    }
    @Override public void onResume() { super.onResume(); if(shell!=null)shell.resume(); visible = true; ui.removeCallbacks(refresh); ui.post(refresh); }
    @Override public void onPause() { visible = false; ui.removeCallbacks(refresh); if (startLocation != null) { cancelLocation(); busy = false; status.setText("Start cancelled while app was hidden. Tap Start trip again."); } super.onPause(); }
    @Override public void onDestroy() { generation++; cancelLocation(); if(shell!=null)shell.close(); QueueIO.execute(() -> network.shutdown()); super.onDestroy(); }
}
