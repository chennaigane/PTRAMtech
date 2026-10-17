package com.ptraam.tracker;

/** Fail closed on old or unknown contracts; never change queue acknowledgement rules. */
final class MobileContract {
    static final String START_PATH = "/trips/start/endpoint-v1";
    static final String STOP_PATH = "/trips/stop/endpoint-v1";
    static final String CONTRACT = "fieldora.endpoint.v1";
    static boolean validTripId(String trip) {
        return trip != null && trip.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");
    }
    static boolean starts(String contract, String request, String expectedRequest, String account, String expectedAccount, String trip, long lease) {
        return CONTRACT.equals(contract) && expectedRequest.equals(request) && expectedAccount.equals(account)
            && validTripId(trip)
            && lease >= 0 && lease <= 300000;
    }
    static final String MESSAGE = "This Fieldora server does not support safe trip completion. Ask Admin to update the backend first. No trip was started; stored GPS data is preserved.";
    static boolean supports(Object stopContract, Object structured, Object endpointVersion) {
        return stopContract instanceof Number && ((Number)stopContract).doubleValue() == 1
            && Boolean.TRUE.equals(structured)
            && endpointVersion instanceof Number && ((Number)endpointVersion).doubleValue() == 1;
    }
    static boolean acknowledges(String expectedId, long expectedSeq, String id, long stoppedAt, String status, long seq) {
        return expectedId.equals(id) && stoppedAt > 0
            && (("captured".equals(status) && expectedSeq > 0 && seq == expectedSeq)
                || ("unverified".equals(status) && seq == 0));
    }
}
