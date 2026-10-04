> Local recovery update (2026-10-04): application routes, components, supporting modules, migrations and test loader were restored from the adjacent PTRAAM source. All 46 tests and the Next.js production build now pass. Earlier missing-source statements below describe the previous snapshot. VPS, live integration and Android acceptance remain outstanding. See START-HERE-WINDOWS.txt for local startup.

> Android update (2026-10-04): native mobile API integration and debug build tooling are now implemented locally. See [android/TESTING.md](android/TESTING.md) for the current build/install guide and physical-phone checklist. Older missing-endpoint/toolchain statements below describe the previous snapshot; live VPS and device acceptance remain outstanding.

# PTRAAM production and APK status

The uploaded source is not yet a complete, production-ready release. The current full test command cannot run because `tests/loader.mjs` and application dependencies are missing. Nine deployment utility/relay tests and five mobile point-ingestion tests pass; the regenerated frozen lockfile check passes. Android compilation and device tests have not run. The following items remain before employee rollout:

## Source completeness and build

- This workspace lacks the entire `app/` route/UI tree, authentication and workforce helper modules, `components/workforce-panel.tsx`, TypeScript configuration, and the full test loader. `pnpm check:source` lists missing files; typecheck/build stop at this gate.
- The old Worker/Sites build notes do not validate the new Node target. The Node app cannot be built until matching source is restored and remaining Cloudflare runtime/test dependencies are ported.
- The Windows guide and some uploaded package/config files are from different source snapshots. Use one complete current project snapshot before releasing.

## Manager account

- The workbook maps the app Admin phone `+919600043768` to `ptramkumaarenterprises25@gmail.com`.
- It maps the Manager app phone `+919940180612` to both `mohanagane08@gmail.com` and `chennaigane@gmail.com` as workbook Viewers.
- A Google email is not an app login. The Manager must use the mapped phone number and password; Admin must approve the account and set its team. Managers now have payroll access in the app, scoped to their assigned team. Workbook Viewers can see every tab, including Payroll.

## Google Sheets live setup

- Create one workbook with exact tabs: `Attendance`, `Travel Log`, `Leave Tracker`, `Payroll`.
- Configure server-only `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`, and `GOOGLE_SPREADSHEET_ID`. The default expected workbook title is `PTRAAM Enterprises`; override `GOOGLE_SPREADSHEET_TITLE` if the existing workbook has a different title.
- Give the service account Editor access and both Manager emails Viewer access. The owner account remains able to edit the workbook; the sync can detect and restore changes but cannot prevent the owner from editing.
- Real Google API permissions and spreadsheet writes have not been tested from this environment.

## Hosting and mobile app

- The selected production target is now Node.js on the GoDaddy Ubuntu VPS with persistent SQLite. Node runtime commands, database adapter/importer, systemd/Nginx configs and backup/relay utilities are added. Restore missing application source and follow [deploy/README.md](deploy/README.md); no live deployment or D1 data migration has occurred. Cloudflare is only the old export source.
- Native Android Gradle source and a user-started location foreground service now exist under `android/`. No Gradle wrapper binary or APK is included, and no Android build/device validation has passed. The browser geolocation and web wake lock are not proof of locked-screen reliability. Follow the [blocked Android release gate](android/RELEASE-GATE.md).
- A mobile package must load the app and API from a secured, reachable HTTPS deployment. Cross-origin mobile requests must be designed securely; the current API checks request origin.
- Forgot-password approval and SOS incident routes/UI are missing. A signed Apps Script email relay and Node sender helper are now included, but must be integrated after incident persistence and tested with actual recipients. No live emergency delivery is configured or verified.
- Implement the [mobile API contract](android/API-CONTRACT.md), build and verify the signed debug APK, install it on real phones, and complete every release-gate scenario. Play declarations/review and production signing remain separate requirements.

## Release gate

Do not treat a wrapper APK or this code update as a production release. Release only after a complete project build, independent backend deployment, live Google Sheets test, native GPS device tests, and Admin/Manager/representative access tests pass.
