package com.ptraam.tracker;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/** Native launch router. The branded window appears immediately; no delay is added. */
public final class SplashActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_splash);
        getWindow().getDecorView().post(() -> {
            // Retain account identity and pending records until explicit sign-out.
            startActivity(new Intent(this, MainActivity.class));
            finish();
        });
    }
}
