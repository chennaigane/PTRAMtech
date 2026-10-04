package com.ptraam.tracker;

import android.content.Context;
import java.net.URI;

final class Backend {
    static String origin(Context c) {
        return c.getSharedPreferences("backend", 0).getString("origin", BuildConfig.API_ORIGIN);
    }
    static void save(Context c, String input) throws Exception {
        URI u = new URI(input.trim());
        if (!"https".equals(u.getScheme()) || u.getHost() == null || u.getRawUserInfo() != null
                || u.getRawQuery() != null || u.getRawFragment() != null
                || !(u.getRawPath().isEmpty() || "/".equals(u.getRawPath()))
                || u.getPort() == 0 || u.getPort() > 65535) {
            throw new IllegalArgumentException("Enter the HTTPS origin supplied by your Admin, without a path or credentials.");
        }
        if (!Session.account(c).isEmpty()) throw new IllegalStateException("Log out before changing the server.");
        try (Queue q = new Queue(c)) { if (q.pending()) throw new IllegalStateException("Sync queued trips before changing the server."); }
        if (!c.getSharedPreferences("backend", 0).edit().putString("origin", "https://" + u.getRawAuthority()).commit())
            throw new java.io.IOException("Could not save server.");
        c.getSharedPreferences("start-requests", 0).edit().clear().commit();
    }
}
