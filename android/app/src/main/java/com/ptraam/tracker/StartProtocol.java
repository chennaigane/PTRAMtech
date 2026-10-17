package com.ptraam.tracker;

import org.json.JSONObject;

/** The versioned path is deliberately unknown to pre-contract backends. */
final class StartProtocol {
    interface Transport { JSONObject post(String path, JSONObject body) throws Exception; }
    static void requireCompatible(Transport transport) throws Exception {
        final JSONObject capabilities;
        try { capabilities = transport.post("/capabilities", new JSONObject()); }
        catch (Api.Failure e) {
            if (e.status == 404 || e.status == 405) throw new Api.Failure(409,MobileContract.MESSAGE);
            throw e;
        }
        if (!MobileContract.supports(capabilities.opt("stopContract"),
                capabilities.opt("structuredStopAcknowledgement"), capabilities.opt("endpointVersion"))
            || !MobileContract.START_PATH.equals(capabilities.opt("startPath"))
            || !MobileContract.STOP_PATH.equals(capabilities.opt("stopPath")))
            throw new Api.Failure(409,MobileContract.MESSAGE);
    }
    static JSONObject start(Transport transport, String request, String account, JSONObject fix) throws Exception {
        return start(transport,request,account,fix,"");
    }
    static JSONObject start(Transport transport,String request,String account,JSONObject fix,String note)throws Exception {
        // The initial GPS acquisition may take 45 seconds. Recheck using the same
        // authenticated origin/transport immediately before creating a server trip.
        requireCompatible(transport);
        JSONObject response = transport.post(MobileContract.START_PATH,
            new JSONObject().put("stopContract",1).put("requestId",request).put("fix",fix).put("note",note));
        Object lease = response.opt("leaseMs");
        if (!(lease instanceof Number) || ((Number)lease).doubleValue() != ((Number)lease).longValue())
            throw new Api.Failure(409,MobileContract.MESSAGE);
        if (!MobileContract.starts(response.optString("startContract"),response.optString("requestId"),request,
            response.optString("accountId"),account,response.optString("tripId"),response.optLong("leaseMs",-1)))
            throw new Api.Failure(409,MobileContract.MESSAGE);
        return response;
    }
    static void recover(Transport transport, String request, String account) throws Exception {
        JSONObject response = transport.post(MobileContract.START_PATH + "/recover",new JSONObject().put("requestId",request));
        if (!MobileContract.CONTRACT.equals(response.optString("startContract")) || !request.equals(response.optString("requestId"))
            || !account.equals(response.optString("accountId")) || !Boolean.TRUE.equals(response.opt("recovered")))
            throw new Api.Failure(409,"Start recovery requires a compatible Fieldora backend. Stored requests were preserved.");
    }
}
