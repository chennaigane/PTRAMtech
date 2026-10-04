> Local recovery update (2026-10-04): application routes, components, supporting modules, migrations and test loader were restored from the adjacent PTRAAM source. All 46 tests and the Next.js production build now pass. Earlier missing-source statements below describe the previous snapshot. VPS, live integration and Android acceptance remain outstanding. See START-HERE-WINDOWS.txt for local startup.

# PTRAAM Travel Log

Single-company workforce attendance and travel application for PTRAAM Enterprises. Representatives use the mobile-responsive employee experience for attendance and trips. Admin and Manager can also use the management dashboard in a browser.

## Access model

- Admin: `+91 96000 43768`, set up once through Admin password setup.
- Manager app account: sign up with the designated Manager's phone number (`+91 99401 80612`), choose Manager and the assigned team, then wait for Admin approval. The Admin can also add or update the role through Access & roles.
- Manager Google Sheets viewers: `mohanagane08@gmail.com` and `chennaigane@gmail.com`. Google email is for workbook sharing; app sign-in uses the approved phone number and password.
- Representatives: phone and password, with Admin approval. They can access only their own employee records and cannot open the company dashboard.

Passwords are stored as PBKDF2 hashes and sessions use an HttpOnly cookie. There is no OTP. The source currently does not include the previously requested forgot-password approval flow; add and test that before production employee onboarding.

## Application and hosting status

The production target is Node.js on the GoDaddy Ubuntu VPS with persistent SQLite at `/srv/ptraam/data/ptraam.sqlite`. Runtime commands now use Next.js; the supplied Sheets module reads server environment variables, and `db/raw.ts` uses Node SQLite. Cloudflare Workers, Wrangler and D1 are not the new runtime. The complete application routes/UI/authentication are still missing, so this is not yet a buildable or deployed application.

See the [VPS deployment runbook](deploy/README.md) for D1 import, Nginx/TLS, systemd, encrypted backups, workbook and signed emergency-relay setup. Server access, hostname, live secrets, complete source and acceptance tests remain required. No live email or deployment has occurred. Native Android source remains uncompiled and unverified; browser GPS is not proof of locked-screen reliability.

## Google Sheets

The supplied sync module targets one app-managed workbook with these tabs: `Attendance`, `Travel Log`, `Leave Tracker`, and `Payroll`. Its missing helper modules must be restored before integration testing. Configure `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`, and `GOOGLE_SPREADSHEET_ID` on the server. `GOOGLE_SPREADSHEET_TITLE` defaults to `PTRAAM Enterprises`. See [WORKFORCE-SETUP.md](WORKFORCE-SETUP.md) for Drive sharing and sync setup.

The database is authoritative. The server writes the four tabs; employees do not receive workbook access. Admin and Manager viewers can see all tabs, including Payroll. The spreadsheet owner retains the ability to edit the workbook directly.

## Local development

Use a maintained Node.js release meeting the package minimum and pnpm 11.25.0. On Windows, follow [START-HERE-WINDOWS.txt](START-HERE-WINDOWS.txt). Install from `pnpm-lock.yaml`; do not mix npm and pnpm installs. `pnpm test:deployment` and `pnpm test:mobile` run the independent utility tests; full application checks remain blocked.

The source packages needed to finish this snapshot are not all present in the uploaded set. The current workspace lacks the `app/` routes, authentication/workforce helper modules, and `tests/loader.mjs` referenced by the supplied libraries and tests. The Node database adapter has been added. Run `pnpm check:source` and restore a complete matching source snapshot before treating the web app as a buildable deliverable.

## Android and release

No APK is included. The native pilot implements explicit trip start, foreground location notification and stop controls, a durable SQLite upload queue, and permission/privacy handling. It is a dedicated tracking client; it does not include the workforce dashboard. The required mobile authentication and VPS routes are not present in this source snapshot. See the [mobile API contract](android/API-CONTRACT.md) and [blocked Android release gate](android/RELEASE-GATE.md) for integration, signed debug build/install steps, privacy requirements, and the actual-device evidence matrix. GPS is not production-ready until backend integration, Android compilation, and those device checks pass. Play approval is a separate gate.
