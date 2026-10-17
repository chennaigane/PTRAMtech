package com.ptraam.tracker;

import android.app.*;
import android.content.*;
import android.net.*;
import android.os.Bundle;
import android.widget.*;

/** Native gateway for workflows that are currently authenticated only by the web portal. */
public final class WorkRequestActivity extends Activity {
    static final String FEATURE = "feature";
    static final String LEAVE = "leave";
    static final String EXPENSES = "expenses";

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        if (!Session.valid(this)) { startActivity(new Intent(this, LoginActivity.class)); finish(); return; }
        setContentView(R.layout.activity_work_request);
        boolean leave = LEAVE.equals(getIntent().getStringExtra(FEATURE));
        ((TextView)findViewById(R.id.work_title)).setText(leave ? R.string.leave_request : R.string.expense_entry);
        ((TextView)findViewById(R.id.work_message)).setText(leave ? R.string.leave_mobile_unavailable : R.string.expense_mobile_unavailable);
        findViewById(R.id.work_back).setOnClickListener(v -> finish());
        findViewById(R.id.open_portal).setOnClickListener(v -> openPortal());
    }
    private void openPortal() {
        ConnectivityManager manager = getSystemService(ConnectivityManager.class);
        Network network = manager.getActiveNetwork(); NetworkCapabilities capabilities = network == null ? null : manager.getNetworkCapabilities(network);
        if (capabilities == null || !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
            new AlertDialog.Builder(this).setMessage(R.string.internet_required).setPositiveButton(R.string.ok, null).show(); return;
        }
        String origin = Backend.origin(this);
        if (origin.isEmpty()) { new AlertDialog.Builder(this).setMessage(R.string.server_missing).setPositiveButton(R.string.ok, null).show(); return; }
        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(origin + "/login")));
    }
}
