> Current setup status and next steps: [SETUP-STATUS.md](SETUP-STATUS.md). Application source has been restored; missing-source statements below are historical. VPS and live integration acceptance remain outstanding.

# GoDaddy Ubuntu VPS deployment — BLOCKED, not deployed

Production target: **Node.js on Ubuntu 22.04 with SQLite on VPS disk**, Nginx and HTTPS. Supplied candidate IP: `68.178.170.234`; ownership, OS, installed runtime, SSH access and hostname have not been verified. No remote connection, DNS change, Google write, email delivery or production data migration has been performed.

## What is available and what is missing

The repository now has Node/Next commands, a persistent `node:sqlite` adapter, a D1 export importer, consistent backup utility, systemd/Nginx examples, daily job/backup timers, a server-only environment example, and a signed Apps Script email relay. The Sheets module reads `process.env`. The supplied libraries' database query interface is preserved without a Cloudflare runtime.

This is **not a complete application migration**: the workspace lacks the `app/` routes, UI, authentication/authorization, workforce rules/store, Sheets payload/policy helpers, TypeScript configuration and full-test loader. It is missing substantially more than `components/workforce-panel.tsx`. `pnpm check:source` lists required paths and blocks build/typecheck. Restore matching source and adapt its remaining Cloudflare-specific APIs and old test fixtures (including the missing `tests/cloudflare.mjs`) to Node before deployment. Do not add stub routes or bypass tests to make the gate green.

Password-reset approval and SOS persistence/routes/UI are also absent. The relay helper is not wired to an incident route. The daily job caller requires a successful JSON `{ok:true}` response after completed reconciliation; implement/verify that contract in the restored route. The native mobile API contract is separately still outstanding. No implemented security flow is inferred from the pasted checklist alone.

## Access and secrets to supply

- Confirm candidate VPS IP, sudo-capable named SSH user, and an existing SSH key/config entry. Verify the server host-key fingerprint through the provider console; never disable host-key checking or commit keys/passwords.
- Choose the public app hostname and confirm DNS administration. Keep the service on `127.0.0.1:3000`; public ingress is Nginx on 80/443. Restrict SSH to approved admin IPs without locking out the active administrator.
- Supply the complete current source and authorized D1 export/schema. Preserve the original export securely outside the repository.
- Configure the actual workbook ID, service-account secrets, Apps Script deployment and responder consent/access. Secrets belong on the server, not in this chat or browser bundles.
- Supply an independent encrypted backup repository, recovery credentials, retention policy, monitoring receiver and restore-test owner.

## Prepare and check the host

Check `/etc/os-release`, `node --version`, `command -v node`, `corepack --version`, `nginx -v`, disk space and current listening services. Use a maintained Node release satisfying `>=22.13` (the `node:sqlite` API used here); pin the validated runtime in operations records. Install pnpm 11.25.0 using Corepack, Git, Nginx, Certbot and restic through trusted distribution/vendor instructions. Unit examples assume Node at `/usr/bin/node`; adjust to the verified absolute path. Do not run app services as root.

Create a `ptraam` system user/group and directories:

```sh
sudo useradd --system --home /srv/ptraam --shell /usr/sbin/nologin ptraam
sudo install -d -m 0755 /srv/ptraam/app
sudo install -d -m 0700 -o ptraam -g ptraam /srv/ptraam/data
sudo install -d -m 0755 /var/www/letsencrypt
```

Check first whether the user/directories already exist. Copy the complete source to `/srv/ptraam/app` under the deploy user's control; the service account needs read access and only cache/data write access. Keep SQLite outside the source directory and deployment replacements. The database adapter uses WAL, foreign keys, full synchronous writes and a five-second busy timeout. Use one app service process; cluster/multi-worker behavior has not been validated.

Before starting any service:

```sh
cd /srv/ptraam/app
corepack pnpm install --frozen-lockfile
corepack pnpm check:source
corepack pnpm test:deployment
corepack pnpm test:mobile
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
```

All are required. This snapshot cannot pass the full sequence. Review restored authentication cookie settings (HttpOnly, Secure, SameSite), CSRF/origin enforcement against `APP_ORIGIN`, trusted proxy handling, role/team scoping, rate limiting and API Node runtime. Do not assume the adapter proves these application behaviors.

## D1 migration and cutover

Keep Wrangler only in the **old authorized checkout** for a one-time export. Stop writes and reconciliation jobs on the old deployment before exporting, and leave them stopped until cutover or rollback is decided. Never run two writable masters.

```sh
node node_modules/wrangler/bin/wrangler.js d1 export D1_DATABASE_NAME --remote --output /secure/ptraam-d1-export.sql
```

Record old table counts, export time and checksum securely. Transfer the export with restricted access, make it readable by the importer account, then run as `ptraam` against a **nonexistent destination**:

```sh
sudo -u ptraam env DATABASE_PATH=/srv/ptraam/data/ptraam.sqlite \
  /usr/bin/node scripts/import-d1-export.mjs /secure/ptraam-d1-export.sql
```

The importer stages and validates the export before publishing, checks required tables/known columns, integrity and foreign keys, reports pre-import counts, clears sessions and stale workforce locks, and refuses to overwrite even an empty destination file. It accepts ordinary table/index/insert D1 exports; triggers, virtual tables, arbitrary PRAGMAs and ATTACH are rejected for review. Compare actual production schema with the restored application; the supplied test fixture is not proof of compatibility with a live export. If rejected, inspect and extend the importer with tests rather than removing validation.

Everyone signs in again after migration. Verify the imported identities, role/team assignments, trip counts, attendance and payroll records before public cutover. Do not create a new Admin over imported users. For a genuinely new empty deployment, restore/test application schema setup and initial Admin setup at `+919600043768`; there is no preset password.

If any pre-cutover check fails, leave the new service closed and restore old operations only after confirming the new database accepted no writes. After new writes exist, preserve both databases and reconcile; never overwrite them with an older snapshot as an automatic rollback.

## Environment, service and TLS

Create `/srv/ptraam/app/.env.production` from `.env.example`, set ownership to `ptraam:ptraam`, mode 600 while editing and 400 afterward. Keep `/srv/ptraam/app` non-writable by the service user. Set the exact HTTPS `APP_ORIGIN`, absolute `DATABASE_PATH`, workbook/service account values and independently random job/webhook secrets (at least 32 characters). Keep values compatible with both systemd EnvironmentFile and dotenv; use quoted single-line values and literal `\n` PEM separators. No `NEXT_PUBLIC_` secret variables.

After a successful build, create `.next/cache` owned by `ptraam`, since the hardened service permits writes only there and in the data directory. Install `ptraam.service` under `/etc/systemd/system/`, run `systemd-analyze verify`, then `systemctl daemon-reload`. Start only when all gates pass; inspect `journalctl -u ptraam` and verify the listener is loopback-only.

Replace every `app.example.com` placeholder. Verify the DNS A record (and any AAAA record) routes to this server. Install the HTTP bootstrap Nginx config first; it serves only ACME challenges and returns 503 elsewhere. Validate with `nginx -t`, reload, then obtain the certificate:

```sh
sudo certbot certonly --webroot -w /var/www/letsencrypt -d YOUR_APP_HOSTNAME
```

Only after certificate files exist, replace the bootstrap with `ptraam.nginx.conf`, validate/reload Nginx, verify HTTPS and HTTP→HTTPS redirect, and test `certbot renew --dry-run`. Install a Certbot deploy hook to run `nginx -t` and reload Nginx after renewal. Restrict unmatched hosts using the host's default virtual host. Confirm cookies and generated links use HTTPS. DNS/TLS/firewall commands are operator steps; none have been run here.

## One Google workbook

Set only `GOOGLE_SPREADSHEET_ID`; do not restore retired attendance/detail IDs. Title defaults to `PTRAAM Enterprises`. Exact tabs: `Attendance`, `Travel Log`, `Leave Tracker`, `Payroll`.

Enable Sheets and Drive APIs. Share as Editor with the service account and as Viewer with the authorized reporting emails: `ptramkumaarenterprises25@gmail.com`, `mohanagane08@gmail.com`, `chennaigane@gmail.com`. All Viewers can see Payroll; owner edits remain possible. Restore the missing sharing/payload helpers before claiming verification or drift repair works end-to-end. Run a live sync and verify all four tabs, row counts, sharing, failure handling and drift recovery.

The two Manager email addresses are reporting/notification identities, not automatically two app accounts. Current mapping associates both with the single Manager phone `+919940180612`. Test whichever distinct app accounts the approved company access model actually provisions.

## Password-reset acceptance gate

Restore/implement the registered-phone request UI and rate-limited endpoint without account enumeration. Requests must not change passwords. Verify Admin approval scope and Manager approval limited to representatives in the same team. Approval must atomically invalidate existing sessions and create a hashed one-time temporary password, shown to the reviewer once, with expiry and forced replacement. Confirm trusted-channel handoff; no SMS/WhatsApp automation is supplied. Admin recovery remains out-of-band. These flows are requirements, not implemented features in this snapshot.

## SOS email relay setup and integration

Under the company Google account, create a standalone Apps Script project and paste `integrations/google-apps-script/EmergencyWebhook.gs`. Set Script Properties `WEBHOOK_SECRET` and `ALERT_RECIPIENTS` (comma-separated allowed responder emails). Run `authorizeMail` to authorize MailApp; deploy as a Web App executing as the company account, accessible to Anyone. Configure the `/exec` URL and matching secret in the VPS environment. New code versions require updating the deployment.

The restored authenticated SOS route must commit the incident first, then call `sendEmergencyAlert` from `lib/emergency-relay.mjs` with the stored ID and authoritative employee identity, and persist its delivery status/audit. Do not trust client-supplied employee names, roles or recipients. Show sent/failed/not configured; on failure offer the specified emergency calling and direct-manager fallback. This does not detect accidents or confirm emergency-service dispatch.

Correction to the pasted checklist: Apps Script's event exposes the request body but not arbitrary Authorization headers. The included client signs a timestamp and payload using HMAC-SHA256; the receiver authenticates that envelope, checks age and configured recipient allowlist, and deduplicates incident IDs. `EMERGENCY_ALERT_RECIPIENTS` records the expected server configuration, but the receiver's Script Properties are authoritative. Do not place secrets in URLs. Response redirects are followed only to Google's ContentService host using GET without the signed POST.

The receiver keeps a 24-hour non-PII deduplication ledger. It rejects old incidents; a crash/send exception with a pending record requires human reconciliation rather than automatic duplicate email. `sent` means MailApp accepted the email, not that every inbox received it. Test actual delivery to each responder, spam handling, quota exhaustion, wrong secret, network failure, retries and fallback before launch. No live email was sent here.

## Daily jobs, backups and restore

Install `ptraam-workforce.service` and `.timer`. After the restored job route passes bearer-token and reconciliation tests, run the service manually, check its journal, then enable the timer. It runs at 23:15 Asia/Kolkata, independent of the server timezone. Never embed the token in command arguments or browser code.

Initialize an off-VPS restic repository and preserve its encryption password in an independent company secret store. Install `backup.env.example` as `/etc/ptraam/backup.env` with actual credentials, root-owned mode 600. Confirm the service account can access any repository-specific SSH key through an explicitly configured path outside `/home` (ProtectHome is enabled). Install the backup service/timer, run a manual backup and inspect the repository before enabling the daily 02:00 Asia/Kolkata timer.

The backup script creates a consistent SQLite snapshot (including WAL data), verifies it, uploads it encrypted through restic and checks repository structure. It does not copy a live `.sqlite` file alone, and it does not prune old backups automatically. Add the approved retention policy, failure notifications, disk-space monitoring, OS security updates and log rotation.

Restore a selected snapshot tagged `ptraam-db` into a separate restricted directory, never onto the live database:

```sh
restic snapshots --tag ptraam-db
restic check --read-data
restic restore SNAPSHOT_ID --target /srv/ptraam/restore-test
```

Use an isolated Node process to run `PRAGMA integrity_check` and `PRAGMA foreign_key_check` on the restored `ptraam.sqlite`; compare record counts and application login/report behavior with outgoing integrations disabled. Record snapshot ID, restore time and evidence. Successful local backup tests do not prove off-host recoverability. Establish and test an operational restore procedure that stops writers, preserves current data and handles session invalidation before using any backup in production.

## Acceptance record (2026-10-04)

| Gate | Evidence |
| --- | --- |
| Deployment unit tests | 9 passing: SQLite adapter/import/backup and mocked signed relay |
| Mobile ingestion unit tests | 5 passing in the combined 14-test run; no device evidence |
| Dependency lockfile | Regenerated; frozen lockfile-only check and pnpm supply-chain checks pass. Full package installation not verified |
| Utility syntax | Node syntax checks pass; systemd/Nginx/bash configuration not executed on Ubuntu |
| Complete source, full tests, typecheck, build | BLOCKED — missing source and test loader |
| VPS identity/access, runtime, service hardening | NOT VERIFIED |
| DNS, TLS, renewal, public loopback isolation | NOT VERIFIED |
| Live D1 migration/schema and record counts | NOT RUN |
| Admin/Manager/employee approval, removal, scoping/reset | NOT RUN |
| Attendance/trip evidence and map routes | NOT RUN |
| Live workbook and three-recipient relay delivery | NOT RUN |
| Daily job, encrypted remote backup and restore | NOT RUN |
| Signed Android APK and real-device GPS | BLOCKED — see [Android gate](../android/RELEASE-GATE.md) |

Production release remains blocked until every applicable gate has evidence. Play approval remains separate.

References: [Node SQLite](https://nodejs.org/download/release/v22.14.0/docs/api/sqlite.html), [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting), [Apps Script request events](https://developers.google.com/apps-script/guides/web), [ContentService redirects](https://developers.google.com/apps-script/guides/content), [restic backup](https://restic.readthedocs.io/en/stable/040_backup.html), [restic restore](https://restic.readthedocs.io/en/stable/050_restore.html).
