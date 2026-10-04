# Debug build results — 2026-10-04

**Build succeeded.** This is an actual compiled and debug-signed Android APK, not a placeholder.

Artifact: `E:\OneDrive\OneDrive\Desktop\PTRAAM-production-update\outputs\android-debug\PTRAAM-Enterprises-debug.apk`

SHA-256: `d97059de6984bdbbcb516aa74684eb43fc8b473c24d197375c0f2e4779d01d00`

Package: `com.ptraam.tracker.debug`; version `0.2.0-debug-pilot-debug`; minimum API 26; target API 35. No VPS URL is embedded by default: enter the Admin-supplied HTTPS origin on the app's setup screen.

| Check | Result |
| --- | --- |
| Gradle 8.11.1 / AGP 8.9.2 `:app:assembleDebug` | PASS |
| `:app:lintDebug` | PASS: 0 errors, 13 warnings (UI localization / preference writes) |
| SDK `apksigner verify --verbose --print-certs` | PASS: APK Signature Scheme v2, Android Debug certificate |
| SDK `aapt dump badging` | Debug package, launch activity, API levels and location-service permissions confirmed |
| `npm.cmd test` | PASS: 53 tests, 0 failures |
| `npm.cmd run typecheck` | PASS |
| `npm.cmd run build` | PASS: production route includes `/api/mobile/v1/[...path]` |
| `npm.cmd run lint` | BLOCKED: repository has ESLint 9 but no `eslint.config.js`, `.mjs` or `.cjs`. Add a compatible flat config and align Next lint dependencies before rerunning. |
| `adb devices -l` | No attached phones/emulators; installation/device checks NOT RUN |
| VPS / real HTTPS login / locked-screen GPS / network recovery on phone | NOT RUN |

Debug certificate SHA-256: `2a375ee1151f7548f13cc170a7bd5200512624f2035c419b7d0e2b7d440df716`.

Initial toolchain setup recovered JDK 17 from Android Studio and installed official Android SDK Platform 35, Build Tools 35.0.0 and Gradle 8.11.1 under the ignored `.tools/` directory. The Gradle distribution was checksum-verified and the committed wrapper pins that checksum. The final build script verifies the APK before copying it to the output directory.

Follow [TESTING.md](TESTING.md) for build/install commands, backend setup and the physical-phone checklist. Deploy the updated Node backend before attempting mobile sign-in. Locked-screen GPS reliability is expressly unverified. This testing UI covers employee sign-in and trip tracking; the rest of the existing attendance/administration workflows remain in the web app.
