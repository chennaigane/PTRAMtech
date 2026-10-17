package com.ptraam.tracker;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Tokens are private to this installation; Android backup is disabled. */
final class Session {
    private static synchronized SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore"); ks.load(null);
        if (!ks.containsAlias("ptraam-session")) {
            KeyGenerator g = KeyGenerator.getInstance("AES", "AndroidKeyStore");
            g.init(new KeyGenParameterSpec.Builder("ptraam-session", KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            g.generateKey();
        }
        return (SecretKey) ks.getKey("ptraam-session", null);
    }
    static void save(Context c, String account, String token, long expiresAt, String name, String role, String department) throws Exception {
        if (expiresAt <= System.currentTimeMillis()) throw new java.io.IOException("Session is already expired");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
        if (!c.getSharedPreferences("session", 0).edit().putString("account", account)
            .putLong("expiresAt", expiresAt)
            .putString("name", name == null ? "" : name.trim())
            .putString("role", role == null ? "" : role.trim())
            .putString("department", department == null ? "" : department.trim())
            .putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .putString("token", Base64.encodeToString(cipher.doFinal(token.getBytes(java.nio.charset.StandardCharsets.UTF_8)), Base64.NO_WRAP)).commit())
            throw new java.io.IOException("Session could not be saved");
    }
    static String account(Context c) { return c.getSharedPreferences("session", 0).getString("account", ""); }
    static String name(Context c) { return c.getSharedPreferences("session", 0).getString("name", ""); }
    static String role(Context c) { return c.getSharedPreferences("session", 0).getString("role", ""); }
    static String department(Context c) { return c.getSharedPreferences("session", 0).getString("department", ""); }
    /** Non-blocking control-thread check; token decryption and server authentication happen on workers. */
    static boolean current(Context c) {
        var p = c.getSharedPreferences("session", 0);
        return !p.getString("account", "").isEmpty() && p.getLong("expiresAt", 0) > System.currentTimeMillis()
            && p.contains("token") && p.contains("iv");
    }
    static boolean valid(Context c) {
        var p = c.getSharedPreferences("session", 0);
        if (p.getString("account", "").isEmpty() || p.getLong("expiresAt", 0) <= System.currentTimeMillis()) return false;
        try { return !token(c).isEmpty(); } catch (Exception e) { return false; }
    }
    static String token(Context c) throws Exception {
        var p = c.getSharedPreferences("session", 0);
        if (!p.contains("token")) throw new Api.Failure(401);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(p.getString("iv", ""), Base64.NO_WRAP)));
        return new String(cipher.doFinal(Base64.decode(p.getString("token", ""), Base64.NO_WRAP)), java.nio.charset.StandardCharsets.UTF_8);
    }
    static void clear(Context c) { c.getSharedPreferences("session", 0).edit().clear().commit(); }
    static String encrypt(String plain) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
        return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(cipher.doFinal(plain.getBytes(java.nio.charset.StandardCharsets.UTF_8)), Base64.NO_WRAP);
    }
    static String decrypt(String stored) throws Exception {
        String[] parts = stored.split(":", 2);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
        return new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), java.nio.charset.StandardCharsets.UTF_8);
    }
}
