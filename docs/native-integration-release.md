# Fieldora native integration release ? 2026-10-17

## Assessment: BLOCKED for one-phone acceptance

Local release branch: fieldora-v3-staging-release. Baseline: acee4996ceea59ed0e85695e693f5e59277457a1. No push, deployment, traffic change, APK rebuild/install, cloud schema/data modification or Sheets activation was performed. The original unfinished worktree was not edited. Existing APK v3 remains the intended test client.

## Confirmed root cause

Live staging https://fieldora-staging-349065809928.asia-south1.run.app returned HTML 404 for GET /api/mobile/web-ticket, text/plain POST, and application/json POST containing malformed JSON with canonical Origin and no cookies. The matching release returns 405, 415 and 400 respectively. Staging /dashboard returned 200; none of its eight fetched script assets contained fieldora-native-v1 or /api/mobile/web-ticket. The baseline has no ticket route; the isolated source has it, and its earlier DELIVERY.md explicitly says the matching web/backend was not deployed.

This confirms a deployed web/backend versus APK integration mismatch. Authenticated Cloud Run revision/image/log inspection remains blocked, so no exact deployed commit is claimed. Without phone logs, the exact browser retry event is not confirmed. The old browser capture path and Android's refusal of geolocation before native authentication explain a plausible consequence of this mismatch.

## Flow, changes and security

Transferred the supplied v3 web/backend adapter, ticket redemption, versioned start/points/lease/stop/recovery contracts, required Android sources/resources and regression/security tests. Resources and legacy activities are included because the supplied Android sources reference them; no new UI redesign was performed. Excluded unfinished live-Sheets source/migrations, secrets, local configuration, node_modules, .next, APKs and logs. Added actionable handoff errors for missing endpoints, expired sign-in, invalid responses and network failures; added concurrent-redemption and MySQL connection/lock-lifetime tests. Source checks now require the integration files.

Android pins the approved HTTPS main-frame origin and transfers a MessagePort. The web adapter accepts the trusted native event. A native verifier generates a SHA-256 challenge; the cookie-authenticated web endpoint issues a hashed, proof-bound 60-second ticket. Redemption checks proof, expiry, active account and live web session; bearer credentials remain native. Same-account reconnect reuses the valid native session to preserve trip ownership.

Start invokes Android consent/permissions, capability checks and fresh nonmock GPS capture (accuracy <=100 m, 45-second timeout), then /trips/start/endpoint-v1 with a persistent request ID. Browser watchers are suppressed inside Android. Offline capture remains bounded by the existing authorization lease/session; physical background and recovery behavior remain unverified.

MySQL lock naming is SHA-256(database + ':fieldora:' + name), yielding 64 characters. GET_LOCK waits zero seconds and fails closed on contention. AsyncLocalStorage pins the same connection through protected queries and nested transactions. RELEASE_LOCK precedes pool release in finally. Issuance and redemption share the workforce lock; ticket consumption and native session creation share a batch transaction. This design was preserved. SQLite concurrent redemption and mocked MySQL contention/rollback tests pass; real MySQL concurrency remains unverified.

DB_SCHEMA_MODE=verify checks existing InnoDB tables, columns and full unique indexes using SELECT metadata queries only. Tests confirm no DDL, backfill or role normalization. The default remains initialize: an approved deployment MUST explicitly set DB_SCHEMA_MODE=verify. Metadata checks do not certify all column types/triggers or live database behavior.

## Tests performed

| Check | Result |
| --- | --- |
| Source completeness | PASS |
| TypeScript --noEmit --incremental false | PASS |
| Regression/security suite | 207 PASS, 0 FAIL, 1 SKIP (208 total) |
| Real MySQL integration | SKIPPED: dedicated test database unavailable |
| Production Next.js webpack build | PASS; ticket/mobile routes present |
| Built localhost HTTP endpoint | PASS: GET 405, text POST 415, malformed JSON POST 400 |
| Java origin policy | PASS: 17 assertions |
| Java endpoint/capture contracts | PASS: 73 assertions |
| Git whitespace checks | PASS |
| Staging native endpoint availability | FAIL: remains 404 |
| Phone/instrumentation | NOT RUN: adb devices -l found no devices |
| Cloud revision/schema verification | BLOCKED: gcloud unavailable in PATH and checked standard locations |

Local logs and review patch: outputs/native-integration (ignored). Local dependencies use an ignored junction to existing node_modules. Dependency manifests were unchanged; no fresh install or container build was run. Java host tests do not replace Android instrumentation or physical GPS acceptance. Never run the destructive MySQL integration fixtures against staging.

## GitHub release readiness

Ready for review as a dedicated local commit; user approval is required before pushing. No merge or push was performed. Exact application/test files are listed below; this report is also part of the commit.

## GCP readiness and intended deployment

BLOCKED pending authenticated verification of active project, serving revision and traffic, immutable image digest, service account, environment names and secret references (never values), scaling/network settings, Cloud SQL attachment, metadata-only schema compatibility and scheduler/Sheets behavior.

Use explicit project fieldora-testing, region asia-south1, service fieldora-staging. Record status.traffic and latestReadyRevisionName; inspect the image digest, Cloud SQL annotation and environment/secret references without printing literal values. Verify attachment to fieldora-mysql-staging and database fieldora_staging. Query only metadata; inspect existing triggers and indexes, and do not run migrations/backfills. Do not invent a rollback revision.

Legacy app/api/workforce/job can call Sheets when its existing credentials are configured. That code was not changed or invoked. No live-Sheets worker/route/migration was transferred. Existing scheduler activation cannot be certified without cloud access; inspect before rollout.

After these gates pass, obtain explicit approval to deploy an immutable candidate with this web/backend integration, preserving existing configuration/secrets/Cloud SQL attachment and explicitly setting DB_SCHEMA_MODE=verify. A no-traffic candidate is still a deployment and requires approval. Traffic changes also need approval. A tagged URL differs from the APK's pinned canonical origin and is not a native acceptance substitute.

After approved rollout, verify expected POST 415/400/403/401 responses and authorized handoff. On one physical phone, test bridge, permissions, start, persisted trip and points/ACKs, stop, distance/timestamps/status, screen lock, temporary network loss within the authorization lease, recovery and duplicate prevention. Reconcile the first phone before expanding to four. HTTP 200 alone is not acceptance.

## Rollback instructions

Record and retain the previously serving revision/image and exact traffic distribution before any rollout. Stop new starts and reconcile active trips and pending GPS/stop ACKs on the compatible backend before restoring previous traffic. For a previously single-revision service, the eventual approved command is:

    gcloud run services update-traffic fieldora-staging --project=fieldora-testing --region=asia-south1 --to-revisions=RECORDED_PREVIOUS_REVISION=100

Do not execute this placeholder. For split traffic restore the recorded distribution. Old-backend rollback restores the missing-integration behavior. If urgent rollback prevents ACKs, preserve encrypted phone queues and keep the compatible image available for an approved recovery window. Do not restore an old database snapshot, uninstall/clear the app or downgrade queue storage. No database rollback should be needed because no schema/data migration is authorized.

## Exact application/test files changed

- android/app/build.gradle
- android/app/src/androidTest/java/com/ptraam/tracker/LifecycleInstrumentationCases.java
- android/app/src/androidTest/java/com/ptraam/tracker/QueueInstrumentation.java
- android/app/src/main/AndroidManifest.xml
- android/app/src/main/java/com/ptraam/tracker/Api.java
- android/app/src/main/java/com/ptraam/tracker/AttendanceActivity.java
- android/app/src/main/java/com/ptraam/tracker/Backend.java
- android/app/src/main/java/com/ptraam/tracker/EndTripCapture.java
- android/app/src/main/java/com/ptraam/tracker/ExpensesActivity.java
- android/app/src/main/java/com/ptraam/tracker/LeaveActivity.java
- android/app/src/main/java/com/ptraam/tracker/LoginActivity.java
- android/app/src/main/java/com/ptraam/tracker/MainActivity.java
- android/app/src/main/java/com/ptraam/tracker/MobileContract.java
- android/app/src/main/java/com/ptraam/tracker/ProfileActivity.java
- android/app/src/main/java/com/ptraam/tracker/Queue.java
- android/app/src/main/java/com/ptraam/tracker/QueueIO.java
- android/app/src/main/java/com/ptraam/tracker/Session.java
- android/app/src/main/java/com/ptraam/tracker/SplashActivity.java
- android/app/src/main/java/com/ptraam/tracker/StartProtocol.java
- android/app/src/main/java/com/ptraam/tracker/SyncJob.java
- android/app/src/main/java/com/ptraam/tracker/TripActivity.java
- android/app/src/main/java/com/ptraam/tracker/TripService.java
- android/app/src/main/java/com/ptraam/tracker/WebOrigin.java
- android/app/src/main/java/com/ptraam/tracker/WebShell.java
- android/app/src/main/java/com/ptraam/tracker/WorkRequestActivity.java
- android/app/src/main/res/color/button_primary_text.xml
- android/app/src/main/res/color/button_secondary_text.xml
- android/app/src/main/res/drawable-nodpi/ptraam_logo.png
- android/app/src/main/res/drawable/badge_error.xml
- android/app/src/main/res/drawable/badge_info.xml
- android/app/src/main/res/drawable/badge_success.xml
- android/app/src/main/res/drawable/badge_warning.xml
- android/app/src/main/res/drawable/bg_badge_neutral.xml
- android/app/src/main/res/drawable/bg_button_danger.xml
- android/app/src/main/res/drawable/bg_button_disabled.xml
- android/app/src/main/res/drawable/bg_button_primary.xml
- android/app/src/main/res/drawable/bg_button_secondary.xml
- android/app/src/main/res/drawable/bg_card.xml
- android/app/src/main/res/drawable/bg_card_warning.xml
- android/app/src/main/res/drawable/bg_input_default.xml
- android/app/src/main/res/drawable/bg_input_disabled.xml
- android/app/src/main/res/drawable/bg_input_error.xml
- android/app/src/main/res/drawable/bg_input_field.xml
- android/app/src/main/res/drawable/bg_input_focused.xml
- android/app/src/main/res/drawable/bg_message_error.xml
- android/app/src/main/res/drawable/bg_message_info.xml
- android/app/src/main/res/layout/activity_attendance.xml
- android/app/src/main/res/layout/activity_dashboard.xml
- android/app/src/main/res/layout/activity_expenses.xml
- android/app/src/main/res/layout/activity_leave.xml
- android/app/src/main/res/layout/activity_login.xml
- android/app/src/main/res/layout/activity_profile.xml
- android/app/src/main/res/layout/activity_splash.xml
- android/app/src/main/res/layout/activity_trip.xml
- android/app/src/main/res/layout/activity_work_request.xml
- android/app/src/main/res/values/colors.xml
- android/app/src/main/res/values/dimens.xml
- android/app/src/main/res/values/strings.xml
- android/app/src/main/res/values/styles.xml
- android/app/src/main/res/values/themes.xml
- android/host-tests/com/ptraam/tracker/EndTripCaptureTest.java
- android/host-tests/com/ptraam/tracker/WebOriginTest.java
- app/api/mobile/web-ticket/route.ts
- app/dashboard/page.tsx
- components/workforce-panel.tsx
- db/mysql-schema-verify.ts
- db/mysql.ts
- lib/browser-gps.ts
- lib/mobile-api.ts
- lib/mobile-endpoint.ts
- lib/mobile-mysql-points.ts
- lib/mobile-mysql.ts
- lib/mobile-point-ingest.mjs
- lib/mobile-workforce.ts
- lib/native-android.ts
- lib/permissions.ts
- lib/trip-locations.ts
- lib/web-native-session.ts
- lib/workforce-service.ts
- scripts/check-source.mjs
- tests/mobile-api.test.mjs
- tests/mobile-endpoint.test.mjs
- tests/mobile-review-security.test.mjs
- tests/mysql-schema-verify.test.mjs
- tests/mysql.test.mjs
- tests/native-adapter.test.mjs
- tests/trip-locations.test.mjs
- tests/web-native-session.test.mjs
- tests/web-review-security.test.mjs
