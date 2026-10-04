package com.ptraam.tracker;

import android.content.Context;
import org.json.JSONObject;
import java.net.URL;
import javax.net.ssl.HttpsURLConnection;

final class Api {
    static class Failure extends java.io.IOException {
        final int status;
        Failure(int status) { this(status, "API request failed (" + status + ")"); }
        Failure(int status, String message) { super(message); this.status = status; }
    }
    static JSONObject post(Context c, String path, JSONObject body, boolean authenticated) throws Exception {
        return postWithToken(c, path, body, authenticated ? Session.token(c) : null);
    }
    static JSONObject postWithToken(Context c, String path, JSONObject body, String token) throws Exception {
        return postToOrigin(Backend.origin(c), path, body, token);
    }
    static JSONObject postToOrigin(String origin, String path, JSONObject body, String token) throws Exception {
        if (origin.isEmpty()) throw new java.io.IOException("Configure the HTTPS server supplied by your Admin first.");
        HttpsURLConnection h = (HttpsURLConnection) new URL(origin + "/api/mobile/v1" + path).openConnection();
        try {
            h.setInstanceFollowRedirects(false); h.setConnectTimeout(10000); h.setReadTimeout(10000);
            h.setRequestMethod("POST"); h.setRequestProperty("Content-Type", "application/json");
            if (token != null) h.setRequestProperty("Authorization", "Bearer " + token);
            h.setDoOutput(true);
            try (var out = h.getOutputStream()) { out.write(body.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
            int code = h.getResponseCode();
            try (var in = code == 200 ? h.getInputStream() : h.getErrorStream()) {
                if (in == null) throw new Failure(code);
                java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
                byte[] buffer = new byte[4096]; int count;
                while ((count = in.read(buffer)) != -1) {
                    if (bytes.size() + count > 65536) throw new java.io.IOException("Oversized response");
                    bytes.write(buffer, 0, count);
                }
                JSONObject response;
                try { response = new JSONObject(bytes.toString("UTF-8")); }
                catch (Exception e) { throw new Failure(code, "Server returned an unexpected response. Check the backend URL."); }
                if (code != 200) throw new Failure(code, response.optString("error", "API request failed (" + code + ")"));
                return response;
            }
        } finally { h.disconnect(); }
    }
}
