package com.ptraam.tracker;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Process-wide FIFO. Service destruction never interrupts an atomic queue write. */
final class QueueIO {
    private static final ExecutorService writer = Executors.newSingleThreadExecutor();
    private static boolean recovered;
    // Called only on this FIFO, before starts. Never mistake a newly queued start for a crashed trip.
    static void recoverOnce(Queue queue, String liveTrip, long at) {
        if (recovered) return;
        queue.recover(liveTrip, at); recovered = true;
    }
    static void recoveryRequired() { recovered = false; }
    static void execute(Runnable work) { writer.execute(work); }
}
