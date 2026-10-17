package com.ptraam.tracker;

public final class EndTripCaptureTest {
    static final long START = 100_000_000_000L, WALL = 1_800_000_000_000L;
    static int checks;
    static void check(boolean value, String message) { checks++; if (!value) throw new AssertionError(message); }
    static EndTripCapture begin() { EndTripCapture c = new EndTripCapture(); check(c.begin(START), "first end request"); return c; }
    static boolean fix(EndTripCapture c, long now, long elapsed, float accuracy, boolean mock) {
        return c.accepts(now, elapsed, WALL, WALL - 1000, 13, 80, accuracy, mock);
    }
    public static void main(String[] args) {
        check(MobileContract.validTripId("00000000-0000-4000-8000-000000000001"), "startup retains validated server identity");
        for(String id:new String[]{null,"","trip","../trip","00000000-0000-4000-8000-000000000001-extra"})
            check(!MobileContract.validTripId(id), "malformed startup identity rejected");
        EndTripCapture c = begin();
        check(c.stopReason(START + 1_000_000_000L, 200000, true, true) == null, "valid lease permits capture");
        check(fix(c, START + 2_000_000_000L, START + 1_000_000_000L, 5, false), "fresh accurate final fix");
        check(!c.begin(START + 20_000_000_000L), "duplicate end cannot reset timeout");
        check("endpoint_timeout".equals(c.stopReason(START + EndTripCapture.TIMEOUT_NS, 200000, true, true)), "30-second timeout");
        check(!fix(c, START + EndTripCapture.TIMEOUT_NS, START + EndTripCapture.TIMEOUT_NS, 5, false), "late fix rejected");
        c.finish();
        check(!c.begin(START + 40_000_000_000L), "completed trip cannot reopen");
        check(!fix(c, START + 2_000_000_000L, START + 1_000_000_000L, 5, false), "callback after stop rejected");
        c = begin();
        for (float accuracy : new float[]{0, -1, 101, Float.NaN, Float.POSITIVE_INFINITY})
            check(!fix(c, START + 2_000_000_000L, START + 1_000_000_000L, accuracy, false), "invalid accuracy " + accuracy);
        check(!fix(c, START + 2_000_000_000L, START + 1_000_000_000L, 5, true), "mock fix rejected");
        check(!fix(c, START + 2_000_000_000L, START - 1, 5, false), "cached pre-request fix rejected");
        check(!fix(c, START + 20_000_000_000L, START + 1, 5, false), "stale delivered fix rejected");
        check(!fix(c, START + 2_000_000_000L, START + 3_000_000_000L, 5, false), "future monotonic time rejected");
        check(!c.accepts(START+1, START+1, WALL, WALL+1, 13,80,5,false), "future wall time rejected");
        check(!c.accepts(START+1, START+1, WALL, WALL, Double.NaN,80,5,false), "invalid coordinate rejected");
        check("authorization_ended".equals(c.stopReason(START+1, 100000, true, true)), "lease expiry bypasses wait");
        check("authorization_ended".equals(c.stopReason(START+1, 200000, true, false)), "session/revocation bypasses wait");
        check("permission_revoked".equals(c.stopReason(START+1, 200000, false, true)), "permission loss bypasses wait");
        c.finish(); // emergency / immediate stop
        check(!c.waiting() && !fix(c, START+2, START+1,5,false), "immediate stop cancels pending endpoint");
        c = begin();
        check(c.accepts(START+10_000_000_000L, START, WALL, WALL-10000,13,80,5,false), "exact freshness boundary accepted");
        check(!c.accepts(START+10_000_000_000L, START, WALL+1, WALL-10000,13,80,5,false), "one millisecond beyond boundary rejected");
        for (String stop : new String[]{"service_destroyed", "permission_revoked", "immediate_stop", "authorization_ended"}) {
            c = begin(); c.finish(); c.finish();
            check(!c.waiting() && !c.begin(START+1), stop + " and duplicate termination remain terminal");
            check(!fix(c,START+2,START+1,5,false), stop + " rejects queued location callback");
        }
        check(MobileContract.supports(1,true,1), "compatible server");
        check(!MobileContract.supports(-1,false,-1), "legacy empty response blocked");
        check(!MobileContract.supports(2,true,1), "unknown stop contract blocked");
        check(!MobileContract.supports(1,false,1), "unstructured acknowledgement blocked");
        check(!MobileContract.supports(1,true,2), "unknown endpoint contract blocked");
        check(!MobileContract.supports(1.5,true,1), "fractional stop contract cannot truncate to supported version");
        check(!MobileContract.supports(1,true,1.5), "fractional endpoint version blocked");
        check(!MobileContract.supports("1",true,1), "string stop version rejected");
        check(!MobileContract.supports(1,"true",1), "string acknowledgement capability rejected");
        check(!MobileContract.supports(1,true,null), "missing endpoint version rejected");
        check(MobileContract.acknowledges("trip",2,"trip",1000,"captured",2), "captured ack accepted");
        check(!MobileContract.acknowledges("trip",2,"",0,"",-1), "old empty stop ack rejected");
        check(!MobileContract.acknowledges("trip",2,"trip",1000,"captured",1), "wrong sequence ack rejected");
        check(!MobileContract.acknowledges("trip",2,"other",1000,"captured",2), "wrong trip ack rejected");
        check(!MobileContract.acknowledges("trip",2,"trip",1000,"unverified",2), "inconsistent unverified ack rejected");
        check(MobileContract.acknowledges("trip",2,"trip",1000,"unverified",0), "server safety stop acknowledged conservatively");
        c = begin(); check(c.freeze(), "accepted evidence transitions to terminal before storage");
        check(!c.freeze() && !c.begin(START+1), "duplicate final callback cannot claim persistence twice");
        check(!fix(c,START+2,START+1,5,false), "callbacks during blocked persistence rejected");
        c.finish();check(!c.waiting(), "safety stop during persistence remains terminal");
        String trip="00000000-0000-4000-8000-000000000001";
        check(MobileContract.starts(MobileContract.CONTRACT,"r","r","a","a",trip,300000), "explicit start contract accepted");
        check(!MobileContract.starts("","r","r","a","a",trip,300000), "legacy-shaped start response rejected");
        check(!MobileContract.starts(MobileContract.CONTRACT,"other","r","a","a",trip,300000), "wrong start request rejected");
        check(!MobileContract.starts(MobileContract.CONTRACT,"r","r","other","a",trip,300000), "wrong start account rejected");
        check(!MobileContract.starts(MobileContract.CONTRACT,"r","r","a","a",trip,-1), "missing start lease rejected");
        check(!MobileContract.starts(MobileContract.CONTRACT,"r","r","a","a",trip,300001), "oversized start lease rejected");
        check(!MobileContract.starts(MobileContract.CONTRACT,"r","r","a","a","invalid",1000), "invalid trip ID rejected");
        System.out.println("EndTripCapture: " + checks + " assertions passed");
    }
}
