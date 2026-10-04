package com.ptraam.tracker;

import android.app.job.*;
import android.content.*;
import android.os.*;
import org.json.*;
import java.util.concurrent.*;

/** Uploads stored fixes only; this job never starts GPS. */
public final class SyncJob extends JobService {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile boolean cancelled;
    static void schedule(Context c) {
        JobScheduler scheduler = c.getSystemService(JobScheduler.class);
        if (scheduler.getPendingJob(7) == null)
            scheduler.schedule(new JobInfo.Builder(7, new ComponentName(c, SyncJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setBackoffCriteria(30000, JobInfo.BACKOFF_POLICY_EXPONENTIAL).build());
    }
    public boolean onStartJob(JobParameters parameters) {
        cancelled = false;
        worker.execute(() -> {
            boolean retry = false;
            String account = Session.account(this);
            try (Queue q = new Queue(this)) {
                if (!account.isEmpty()) {
                    String token = Session.token(this);
                    if (!account.equals(Session.account(this))) throw new Api.Failure(401);
                    JSONArray trips = q.trips(account);
                    for (int i = 0; i < trips.length() && !cancelled; i++) {
                        JSONObject trip = trips.getJSONObject(i); String id = trip.getString("id");
                        JSONArray points = q.batch(id);
                        if (points.length() > 0) {
                            JSONObject response = Api.postWithToken(this, "/trips/points", new JSONObject().put("tripId", id).put("points", points), token);
                            q.ack(id, points, response.getLong("ackSeq"));
                        }
                        if (!trip.getBoolean("active") && q.batch(id).length() == 0) {
                            Api.postWithToken(this, "/trips/stop", new JSONObject().put("tripId", id).put("stoppedAt", trip.getLong("stoppedAt")).put("reason", trip.optString("reason", "stopped")), token);
                            q.closed(id);
                        } else if (q.batch(id).length() > 0) retry = true;
                    }
                    retry = q.pending(account);
                    getSharedPreferences("tracking-state", 0).edit().putString("sync", retry ? "Stored trip still open or waiting to sync." : "All queued trips synchronized.").apply();
                }
            } catch (Api.Failure e) {
                getSharedPreferences("tracking-state", 0).edit().putString("sync", "Sync paused: " + e.getMessage()).apply();
                retry = e.status != 401 && e.status != 403 && e.status != 404 && e.status != 409 && e.status != 410;
                if (!retry) new Handler(Looper.getMainLooper()).post(() -> {
                    if (account.equals(Session.account(this))) TripService.stop(this, "sync_requires_review_or_sign_in");
                });
            } catch (Exception e) { retry = true; getSharedPreferences("tracking-state", 0).edit().putString("sync", "Waiting for network. Encrypted points remain on this phone.").apply(); }
            if (!cancelled) jobFinished(parameters, retry);
        });
        return true;
    }
    public boolean onStopJob(JobParameters parameters) { cancelled = true; return true; }
    public void onDestroy() { cancelled = true; worker.shutdownNow(); super.onDestroy(); }
}
