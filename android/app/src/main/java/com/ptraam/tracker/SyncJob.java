package com.ptraam.tracker;

import android.app.job.*;
import android.content.*;
import android.os.*;
import org.json.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Uploads stored fixes only; this job never starts GPS. */
public class SyncJob extends JobService {
    private static final int MAX_BATCHES_PER_RUN = 10;
    private static final AtomicBoolean running = new AtomicBoolean();
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile boolean cancelled;
    // Main-thread scheduling signals close the commit-versus-jobFinished window.
    private static boolean rescheduleRequested, completionMayBePending;
    Queue openQueue() { return new Queue(this); }
    void recoverQueue(Queue q, String live, long at) { QueueIO.recoverOnce(q,live,at); }
    String account() { return Session.account(this); }
    String token() throws Exception { return Session.token(this); }
    boolean sessionCurrent() { return Session.current(this); }
    JSONObject post(String path, JSONObject body, String token) throws Exception { return Api.postWithToken(this,path,body,token); }
    void executeWorker(Runnable work) { worker.execute(work); }
    void executeStorage(Runnable work) { QueueIO.execute(work); }
    void postControl(Runnable work) { new Handler(Looper.getMainLooper()).post(work); }
    void complete(JobParameters parameters, boolean retry) { jobFinished(parameters,retry); }

    static void rememberJourney(Context c, String account, JSONObject response) {
        JSONObject journey = response.optJSONObject("journey");
        if (journey == null || !"locality-v1".equals(journey.opt("format"))
            || !(journey.opt("from") instanceof String) || !(journey.opt("to") instanceof String)) return;
        String from = journey.optString("from").trim(), to = journey.optString("to").trim();
        if (from.isEmpty() || to.isEmpty() || from.length() > 100 || to.length() > 100) return;
        c.getSharedPreferences("tracking-state",0).edit().putString("journey-locality:" + account,
            from + " → " + to + "\nLocation names: Geoapify / © OpenStreetMap contributors").apply();
    }

    static void schedule(Context c) {
        Context app = c.getApplicationContext();
        if (Looper.myLooper() != Looper.getMainLooper()) {
            new Handler(Looper.getMainLooper()).post(() -> schedule(app)); return;
        }
        if (running.get()) { rescheduleRequested = true; return; }
        JobScheduler scheduler = app.getSystemService(JobScheduler.class);
        // A just-finished job can still appear pending until JobScheduler processes its ACK.
        if (completionMayBePending || scheduler.getPendingJob(7) == null) {
            int result = scheduler.schedule(new JobInfo.Builder(7,new ComponentName(app,SyncJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setBackoffCriteria(30000,JobInfo.BACKOFF_POLICY_EXPONENTIAL).build());
            if (result == JobScheduler.RESULT_SUCCESS) completionMayBePending = false;
        }
    }
    public boolean onStartJob(JobParameters parameters) {
        if (!running.compareAndSet(false, true)) {
            // A cancelled worker can still be finishing an HTTP request. Returning false
            // would consume the replacement job without arranging another attempt.
            postControl(() -> complete(parameters, true));
            return true;
        }
        cancelled = false; rescheduleRequested = false; completionMayBePending = false;
        String live = TripService.liveTrip(); long recoveryAt = System.currentTimeMillis();
        executeStorage(() -> {
            try (Queue q = openQueue()) { recoverQueue(q,live,recoveryAt); }
            catch (RuntimeException ignored) { /* Worker will retain/report the storage error. */ }
            if (cancelled) { postControl(() -> running.set(false)); return; }
            try { executeWorker(() -> {
            boolean retry = false;
            boolean blocked = false;
            String account = account();
            var state = getSharedPreferences("tracking-state", 0);
            state.edit().putString("syncPhase", "SYNCING").putString("sync", "Syncing stored GPS points…")
                .putLong("syncLastAttemptAt", System.currentTimeMillis()).apply();
            try (Queue q = openQueue()) {
                if (!account.isEmpty()) {
                    String token = token();
                    if (!account.equals(account())) throw new Api.Failure(401);
                    JSONArray trips = q.trips(account);
                    int batches = 0;
                    for (int i = 0; i < trips.length() && !cancelled && batches < MAX_BATCHES_PER_RUN; i++) {
                        JSONObject trip = trips.getJSONObject(i); String id = trip.getString("id");
                        if (q.routeIncomplete(id) || getSharedPreferences("route-review",0).getBoolean(id,false)) {
                            state.edit().putString("endStatus",Queue.ROUTE_REVIEW).apply();
                            throw new Api.Failure(409,Queue.ROUTE_REVIEW);
                        }
                        JSONArray points = q.batch(id);
                        while (points.length() > 0 && !cancelled && batches < MAX_BATCHES_PER_RUN) {
                            JSONObject response = post("/trips/points/endpoint-v1", new JSONObject().put("tripId", id).put("points", points), token);
                            q.ack(id, points, response.getLong("ackSeq"));
                            batches++; points = q.batch(id);
                        }
                        if (!cancelled && !trip.getBoolean("active") && points.length() == 0) {
                            // The upload can outlive the initial snapshot. Never acknowledge
                            // a complete route after persistence has raised a review marker.
                            if (q.routeIncomplete(id)) throw new Api.Failure(409,Queue.ROUTE_REVIEW);
                            long finalSeq = trip.getLong("finalSeq");
                            JSONObject endpoint = new JSONObject().put("status", finalSeq > 0 ? "captured" : "unverified");
                            if (finalSeq > 0) endpoint.put("seq", finalSeq);
                            JSONObject response = post(MobileContract.STOP_PATH, new JSONObject().put("tripId", id)
                                .put("stoppedAt", trip.getLong("stoppedAt")).put("reason", trip.optString("reason", "stopped")).put("endpoint", endpoint), token);
                            String endpointStatus = response.optString("endpointStatus");
                            if (!MobileContract.acknowledges(id, finalSeq, response.optString("tripId"),
                                response.optLong("stoppedAt"), endpointStatus, response.optLong("finalSeq", -1)))
                                throw new Api.Failure(409, "Stop acknowledgement requires backend review.");
                            q.closed(id);
                            rememberJourney(this,account,response);
                            state.edit().putString("endStatus", "captured".equals(endpointStatus)
                                ? "Trip ended. Final GPS coordinate acknowledged by Fieldora."
                                : "Trip ended and synchronized. Destination unverified; recorded GPS retained on Fieldora.").apply();
                        }
                    }
                    retry = q.hasSyncWork(account);
                    int pending = q.count(account);
                    state.edit().putString("syncPhase", retry ? "RETRY_PENDING" : "SYNCED")
                        .putInt("syncPendingCount", pending).putInt("syncRetryCount", 0)
                        .putString("sync", retry ? pending + " GPS points waiting to sync." : "All queued trips synchronized.").apply();
                }
            } catch (Api.Failure e) {
                if (e.status == 401 || e.status == 403) postControl(() -> {
                    if (TripService.running != null && account.equals(account())) TripService.stop(this, "authorization_ended");
                });
                retry = e.status == 404 || e.status == 405 || e.status == 408 || e.status == 429 || e.status >= 500;
                blocked = !retry;
                String phase = (e.status == 401 || e.status == 403) ? "AUTH_REQUIRED" : retry ? "RETRY_PENDING" : "REVIEW_REQUIRED";
                String message = (e.status == 401 || e.status == 403) ? "Sign in again to sync stored GPS points."
                    : retry ? "Server unavailable — retry scheduled." : Queue.ROUTE_REVIEW.equals(e.getMessage()) ? Queue.ROUTE_REVIEW : "Stored GPS points need review before they can sync.";
                state.edit().putString("syncPhase", phase).putString("sync", message)
                    .putInt("syncRetryCount", state.getInt("syncRetryCount", 0) + 1).apply();
            } catch (Exception e) {
                retry = true;
                state.edit().putString("syncPhase", "RETRY_PENDING").putString("sync", "Offline — stored GPS points will retry automatically.")
                    .putInt("syncRetryCount", state.getInt("syncRetryCount", 0) + 1).apply();
            } finally {
                final boolean reschedule = retry, reviewRequired = blocked;
                // FIFO with trip persistence: no database read runs on the control thread.
                executeStorage(() -> {
                    boolean remainingWork = reschedule;
                    if (!reschedule && !reviewRequired && sessionCurrent() && account.equals(account())) {
                        try (Queue q = openQueue()) { remainingWork = q.hasSyncWork(account); }
                        catch (RuntimeException e) { remainingWork = true; }
                    }
                    final boolean retryWork = remainingWork;
                    postControl(() -> {
                        running.set(false);
                        if (!cancelled) {
                            boolean next = retryWork || rescheduleRequested;
                            completionMayBePending = !next;
                            complete(parameters,next);
                        }
                    });
                });
            }
        }); } catch (RejectedExecutionException stopped) {
            postControl(() -> { running.set(false); if (!cancelled) complete(parameters,true); });
        }
        });
        return true;
    }
    public boolean onStopJob(JobParameters parameters) { cancelled = true; return true; }
    public void onDestroy() { cancelled = true; worker.shutdownNow(); super.onDestroy(); }
}
