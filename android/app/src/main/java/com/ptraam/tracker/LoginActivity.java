package com.ptraam.tracker;

import android.app.*;
import android.content.*;
import android.net.*;
import android.os.Bundle;
import android.text.InputType;
import android.text.method.PasswordTransformationMethod;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.*;
import org.json.JSONObject;
import java.net.*;
import java.util.Locale;
import java.util.concurrent.*;

/** Native Fieldora login backed by the existing mobile session endpoint. */
public final class LoginActivity extends Activity {
    private final ExecutorService networkWorker = Executors.newSingleThreadExecutor();
    private EditText phone, password, server;
    private TextView phoneError, passwordError, message;
    private Button login;
    private ProgressBar progress;
    private LinearLayout serverGroup;
    private boolean busy;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        if (Session.valid(this)) { openHome(); return; }
        if (!Session.account(this).isEmpty()) Session.clear(this);
        setContentView(R.layout.activity_login);
        phone = findViewById(R.id.login_phone); password = findViewById(R.id.login_password);
        server = findViewById(R.id.server_origin); phoneError = findViewById(R.id.phone_error);
        passwordError = findViewById(R.id.password_error); message = findViewById(R.id.login_message);
        login = findViewById(R.id.login_button); progress = findViewById(R.id.login_progress);
        serverGroup = findViewById(R.id.server_group);

        CheckBox toggle = findViewById(R.id.password_toggle);
        toggle.setContentDescription(getString(R.string.show_password));
        toggle.setOnCheckedChangeListener((button, checked) -> {
            int position = password.getSelectionStart();
            password.setInputType(InputType.TYPE_CLASS_TEXT | (checked ? InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD : InputType.TYPE_TEXT_VARIATION_PASSWORD));
            password.setTransformationMethod(checked ? null : PasswordTransformationMethod.getInstance());
            password.setSelection(Math.max(0, position));
            button.setText(checked ? R.string.hide_password : R.string.show_password);
            button.setContentDescription(getString(checked ? R.string.hide_password : R.string.show_password));
        });
        password.setOnEditorActionListener((view, action, event) -> {
            if (action == EditorInfo.IME_ACTION_DONE) { submit(); return true; }
            return false;
        });

        String origin = Backend.origin(this);
        server.setText(origin);
        if (origin.isEmpty()) { serverGroup.setVisibility(View.VISIBLE); showMessage(R.string.server_missing, true); }
        findViewById(R.id.server_settings).setOnClickListener(v ->
            serverGroup.setVisibility(serverGroup.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE));
        findViewById(R.id.save_server).setOnClickListener(v -> saveServer());
        findViewById(R.id.forgot_password).setOnClickListener(v -> new AlertDialog.Builder(this)
            .setTitle(R.string.contact_administrator).setMessage(R.string.forgot_password_help).setPositiveButton(R.string.ok, null).show());
        findViewById(R.id.signup_button).setOnClickListener(v -> signup());
        login.setOnClickListener(v -> submit());
    }

    private void saveServer() {
        if (busy) return;
        try {
            Backend.save(this, server.getText().toString());
            server.setText(Backend.origin(this)); serverGroup.setVisibility(View.GONE);
            showMessage(R.string.server_saved, false);
        } catch (Exception e) { showMessage(e.getMessage(), true); }
    }

    private void signup() {
        String origin = Backend.origin(this);
        if (origin.isEmpty()) { serverGroup.setVisibility(View.VISIBLE); showMessage(R.string.server_missing, true); return; }
        new AlertDialog.Builder(this).setTitle(R.string.signup).setMessage(R.string.signup_help)
            .setNegativeButton(R.string.cancel, null).setPositiveButton(R.string.open_signup, (dialog, which) ->
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(origin + "/login")))).show();
    }

    private void submit() {
        if (busy) return;
        clearErrors();
        String origin = Backend.origin(this), mobile = phone.getText().toString().replaceAll("\\D", "");
        String secret = password.getText().toString();
        if (origin.isEmpty()) { serverGroup.setVisibility(View.VISIBLE); showMessage(R.string.server_missing, true); return; }
        boolean valid = true;
        if (!mobile.matches("[6-9][0-9]{9}")) { phoneError.setText(R.string.phone_invalid); phoneError.setVisibility(View.VISIBLE); valid = false; }
        if (secret.isEmpty()) { passwordError.setText(R.string.password_required); passwordError.setVisibility(View.VISIBLE); valid = false; }
        if (!valid) return;
        if (!online()) { showMessage(R.string.login_offline, true); return; }
        setBusy(true);
        networkWorker.execute(() -> {
            try {
                JSONObject response = Api.postToOrigin(origin, "/session", new JSONObject().put("phone", mobile).put("password", secret), null);
                String account = response.getString("accountId"), token = response.getString("accessToken");
                long expiresAt = response.getLong("expiresAt");
                String name = response.optString("name", ""), role = response.optString("role", ""), department = response.optString("department", "");
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()) return;
                    try {
                        Session.save(this, account, token, expiresAt, name, role, department); password.setText("");
                        SyncJob.schedule(this); openHome();
                    } catch (Exception e) { setBusy(false); showMessage(R.string.login_session_error, true); }
                });
            } catch (Exception e) {
                runOnUiThread(() -> { if (!isFinishing() && !isDestroyed()) { setBusy(false); showMessage(loginError(e), true); } });
            }
        });
    }

    private boolean online() {
        ConnectivityManager manager = getSystemService(ConnectivityManager.class);
        Network active = manager.getActiveNetwork();
        NetworkCapabilities capabilities = active == null ? null : manager.getNetworkCapabilities(active);
        return capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    private String loginError(Exception error) {
        if (error instanceof SocketTimeoutException) return getString(R.string.login_timeout);
        if (error instanceof UnknownHostException || error instanceof ConnectException) return getString(R.string.login_unreachable);
        if (error instanceof Api.Failure) {
            Api.Failure failure = (Api.Failure) error;
            String detail = failure.getMessage() == null ? "" : failure.getMessage();
            String lower = detail.toLowerCase(Locale.ROOT);
            if (failure.status == 401) return getString(R.string.login_incorrect);
            if (failure.status == 403 && (lower.contains("waiting") || lower.contains("pending") || lower.contains("approval"))) return getString(R.string.login_pending);
            if (failure.status == 403 && (lower.contains("removed") || lower.contains("rejected") || lower.contains("disabled"))) return getString(R.string.login_disabled);
            if (failure.status == 429) return detail;
            if (lower.contains("unexpected response")) return getString(R.string.login_invalid_response);
            if (failure.status >= 500) return getString(R.string.login_server_error);
            return detail.isEmpty() ? getString(R.string.login_server_error) : detail;
        }
        if (error instanceof java.io.IOException) return getString(R.string.login_unreachable);
        return getString(R.string.login_invalid_response);
    }

    private void clearErrors() {
        phoneError.setVisibility(View.GONE); passwordError.setVisibility(View.GONE); message.setVisibility(View.GONE);
    }
    private void setBusy(boolean value) {
        busy = value; login.setEnabled(!value); phone.setEnabled(!value); password.setEnabled(!value);
        findViewById(R.id.save_server).setEnabled(!value); progress.setVisibility(value ? View.VISIBLE : View.GONE);
        login.setText(value ? R.string.login_in_progress : R.string.login);
    }
    private void showMessage(int text, boolean error) { showMessage(getString(text), error); }
    private void showMessage(String text, boolean error) {
        message.setText(text == null ? getString(R.string.login_server_error) : text);
        message.setBackgroundResource(error ? R.drawable.bg_message_error : R.drawable.bg_message_info);
        message.setTextColor(getColor(error ? R.color.fieldora_error : R.color.fieldora_info)); message.setVisibility(View.VISIBLE);
        message.announceForAccessibility(message.getText());
    }
    private void openHome() {
        startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK | Intent.FLAG_ACTIVITY_NEW_TASK)); finish();
    }
    @Override public void onDestroy() { networkWorker.shutdownNow(); super.onDestroy(); }
}
