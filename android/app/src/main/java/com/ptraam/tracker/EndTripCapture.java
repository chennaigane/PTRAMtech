package com.ptraam.tracker;

/** Monotonic, single-use final-fix gate. No Android dependencies: exercised on the host JVM. */
final class EndTripCapture {
    static final long TIMEOUT_NS = 30_000_000_000L;
    private long requestedAt;
    private boolean waiting, finished;

    boolean begin(long now) {
        if (waiting || finished) return false;
        requestedAt = now;
        waiting = true;
        return true;
    }
    boolean waiting() { return waiting; }
    boolean freeze() {
        if (!waiting || finished) return false;
        finish(); return true;
    }
    void finish() { waiting = false; finished = true; }
    String stopReason(long now, long leaseUntilMs, boolean permission, boolean authorized) {
        if (!permission) return "permission_revoked";
        if (!authorized || now / 1_000_000 >= leaseUntilMs) return "authorization_ended";
        if (waiting && now - requestedAt >= TIMEOUT_NS) return "endpoint_timeout";
        return null;
    }
    boolean accepts(long now, long fixElapsed, long wallNow, long fixTime,
                    double latitude, double longitude, float accuracy, boolean mock) {
        return waiting && now - requestedAt < TIMEOUT_NS
            && fixElapsed >= requestedAt && fixElapsed <= now && now - fixElapsed <= 10_000_000_000L
            && fixTime > 0 && fixTime <= wallNow && wallNow - fixTime <= 10000
            && Double.isFinite(latitude) && Math.abs(latitude) <= 90
            && Double.isFinite(longitude) && Math.abs(longitude) <= 180
            && Float.isFinite(accuracy) && accuracy > 0 && accuracy <= 100 && !mock;
    }
}
