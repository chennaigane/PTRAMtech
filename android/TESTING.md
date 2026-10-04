# PTRAAM Enterprises Android debug testing

This is a native Java test app for approved representatives (`Employee` in the database). It reuses the Node.js/SQLite backend, password verification, department rules, travel records, attendance evidence and Admin/Manager review permissions. It is not a Play Store release.

Verified locally on 2026-10-04: debug APK built and signature verified; Android lint 0 errors / 13 warnings; 53 backend tests passed; TypeScript and Next.js production build passed. Web lint is blocked by the existing missing ESLint flat configuration. No physical phone or live VPS was tested. Exact artifact details are recorded in [BUILD-RESULTS.md](BUILD-RESULTS.md).

## Artifact and repeatable build

Output after a successful build:

`E:\OneDrive\OneDrive\Desktop\PTRAAM-production-update\outputs\android-debug\PTRAAM-Enterprises-debug.apk`

Package: `com.ptraam.tracker.debug`. Minimum Android: 8.0 / API 26. Target/compile API: 35. The debug package is separate from a future production installation. Gradle debug-signs it; no production signing key or backend credentials are embedded.

From the project root on this Windows machine:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-android-debug.ps1
```

The script uses JDK 17 from Android Studio and the locally installed tools in `.tools/`. It runs Android lint and assembles the debug APK, verifies the APK signature, then copies it to `outputs/android-debug/` with `build-info.json` and a SHA-256 file. It stops on failure. Local tools, caches, APKs and debug signing keys are ignored by version control. Preserve the local debug key if you want to update an installed test build without uninstalling it.

To preconfigure a **public, non-secret** server address:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-android-debug.ps1 -ApiUrl https://YOUR-VPS-HOSTNAME
```

On another Windows machine install JDK 17, SDK Platform 35 and Build Tools 35.0.0, then pass `-JavaHome` and `-SdkRoot`. The generated Gradle wrapper is pinned to 8.11.1 with a distribution checksum. Equivalent manual build:

```powershell
cd android
.\gradlew.bat :app:lintDebug :app:assembleDebug -PptraamApiUrl=https://YOUR-VPS-HOSTNAME
```

AGP 8.9.2 uses the [documented Gradle/JDK compatibility requirements](https://developer.android.com/build/releases/agp-8-9-0-release-notes). SDK and Gradle downloads require network access.

## Backend setup

No verified VPS URL was provided for this build. Open the app, enter the exact HTTPS origin supplied by Admin, and tap **Save server** before entering credentials. HTTP, URL credentials, paths, queries and fragments are rejected. Changing the server requires logout and no unsynchronized trips, so another server cannot receive the previous queue.

Deploy the updated project to the intended GoDaddy VPS using the existing Node/SQLite deployment instructions. Set server-only `DATABASE_PATH` to the persistent SQLite file and `APP_ORIGIN` to the exact public HTTPS origin; build and restart the service. Use a certificate trusted by the Android phone. The APK does not accept self-signed TLS or bypass certificate checks. Database initialization creates the mobile tables without dropping existing data; back up the existing database before deployment. No VPS deployment was performed in this task.

Admin **+91 9600043768** performs setup in the web app. Employees register in the existing web registration flow or are created by Admin. Admin must approve them and assign Marketing/Sales (or Driver with an office geofence). Admin and Manager use the web dashboard; the mobile session endpoint rejects those roles. An employee cannot grant themselves approval, change roles, submit points for another employee or use a mobile token as a web session.

The implemented native endpoints are under `/api/mobile/v1/`: `session`, `session/logout`, `trips/start`, `trips/lease`, `trips/points`, `trips/stop`. Passwords are checked against existing accounts. Only hashed, one-hour mobile tokens are stored server-side; status and role are checked on every authenticated request. Native trip starts write existing dashboard travel and daily attendance records. The backend enforces Driver office geofencing and rejects trip tracking for office-only departments.

## Install on an Android phone

Either copy the APK to the phone, open it and allow installation from that file manager for this test, or enable Developer options / USB debugging and use:

```powershell
.\.tools\android-sdk\platform-tools\adb.exe devices -l
# Unlock the phone and approve its USB debugging prompt, then use its serial:
.\.tools\android-sdk\platform-tools\adb.exe -s DEVICE_SERIAL install -r .\outputs\android-debug\PTRAAM-Enterprises-debug.apk
```

Open **PTRAAM Enterprises (test)**. Set the server, sign in, go outdoors, and tap **Start trip**. GPS permission is requested at that point, not at sign-in. Grant precise location and notifications; after the permission dialog, tap Start trip again. The app waits up to 45 seconds for a real, fresh GPS fix before requesting the trip start. Mock-provider locations are rejected. If no fix is available, no trip is started.

## Physical-phone checklist — all NOT RUN

Record phone model/Android version, APK SHA-256, trip IDs and timestamps. Use test accounts; do not publish passwords, bearer tokens or employee location traces.

| Test | Expected result |
| --- | --- |
| Sign-in | Approved representative succeeds; wrong password, pending/removed account fail. Password is cleared from the input. |
| Role access | Admin/Manager mobile sign-in rejected with web-dashboard message. Employee cannot manage users or access another employee's trip through direct API calls. Admin sees native trips; Manager sees only their team's trips. |
| Start | No permission prompt at launch/sign-in. Start prompts for consent/permissions and waits for GPS; successful authorized start marks Present and shows the ongoing location notification. Driver must be inside the configured office fence. |
| Stop | In-app Stop and notification Stop both stop new GPS collection. Queued points and stop record sync; trip becomes Pending on dashboard. Confirm the point count stops increasing. |
| Permission | Deny GPS, choose approximate-only, disable notifications, revoke permission during a trip, and disable system GPS. App must explain refusal or stop; no silent tracking restart. |
| Screen locked | Walk a real route with screen locked for 10–15 minutes, then check timestamped server points and notification. Repeat under battery saver and the fleet's OEM battery settings. Record gaps; do not infer success from an unlocked test. |
| Network loss | Start online, disable network for 1–2 minutes, move outdoors, restore network. Encrypted queue should drain without duplicate points/distance. Start while offline must fail. |
| Extended outage | Stay offline beyond five minutes. GPS must stop after its current lease expires; reopening must not restart it. Restore connectivity and confirm retained points/stop upload. |
| Logout | Online/offline logout stops GPS immediately and clears local credentials. Online logout revokes the server token. Re-login to the same account to drain remaining points; another account cannot upload them. |
| Interruption | Force-stop, reopen, rotate, and restart the phone. No automatic GPS restart. Reopen/sign in to sync retained data. Check a lost start/stop reply can be retried without duplicate trips. |
| Expiry | After one-hour token expiry, collection stops at the authorization deadline. Re-login and sync; start a new trip explicitly. |

## Limits of this debug app

- No physical phone was connected during preparation. Compilation, lint, signature verification and backend tests **do not verify locked-screen GPS, battery behavior or live VPS connectivity**. The service follows Android's [location foreground-service model](https://developer.android.com/develop/background-work/services/fgs/service-types), but device testing remains mandatory.
- Offline capture lasts only through the issued lease, at most five minutes. The service requests renewal every 15 seconds while Android schedules it. Android sleep/OEM policies can delay callbacks and notification removal; no fixes are accepted locally after the elapsed-time deadline. No simulated GPS fills gaps.
- GPS payloads and tokens use Android Keystore-backed AES-GCM; app data is private and backups/device transfer are excluded. This is a debuggable testing build, not protection against someone with authorized debugging/root access.
- Tokens expire after one hour; trips are capped at 12 hours and 10,000 queued points. Server uploads are accepted for seven days from trip start. Conflicts/expired uploads retain the device queue for review rather than silently deleting it. A production retention and queue-reconciliation workflow still needs to be agreed.
- Only real captured points reach the server. Stops without a recent endpoint remain explicitly unverified for endpoint/overtime evidence. GPS is not cryptographic proof of presence.
- Native UI covers approved-account sign-in, trip start/stop and synchronization. Account registration, branch visits, leave, office-only attendance, reimbursements and management remain in the existing web app. Google Sheets/email integrations have not been live-tested by this APK build.
- The repository's web `npm.cmd run lint` currently fails because there is no ESLint 9 flat configuration. Backend tests, TypeScript and production build are separate checks; see the task's build report for their actual outcomes.
