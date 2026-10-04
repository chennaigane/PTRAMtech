# VPS and live integration setup — 2026-10-04

## Current state

Application source is restored. Existing deployment assets provide loopback-only Next.js, Nginx TLS termination, a systemd application service, daily workforce reconciliation and encrypted remote backups. Google Sheets sync is wired to the Admin workforce action and the scheduled job. Earlier missing-source claims in README.md are historical, not current blockers.

No VPS connection or live Google operation has been performed. The candidate IP `68.178.170.234` is unconfirmed. No local SSH configuration or production environment file was found.

## Inputs needed to finish deployment

- Confirmed SSH host, username, existing key/config path and provider host fingerprint.
- Public application hostname and DNS access.
- Fresh installation versus migration; for migration, the authorized database export and cutover window.
- Google workbook URL and service-account credential file path. Keep credential contents out of chat.
- Apps Script deployment URL and server-side secret location, if SOS is required.
- Off-host restic repository and backup credential location.

## Configuration check

On the VPS, populate `.env.production` from `.env.example`, protect its permissions and run:

```sh
cd /srv/ptraam/app
node --env-file=.env.production scripts/check-production.mjs
```

This checks the HTTPS origin, persistent database path, job token, Google service-account RSA key, workbook ID, viewer mapping and optional relay URL/secret without contacting external services or printing secret values. It does not prove permissions or live delivery. The supplied service unit expects the database under `/srv/ptraam/data`; adjust its writable paths if using another location.

Install dependencies from the frozen pnpm lockfile on Linux, run tests/typecheck/build there, and use the service, Nginx and timer files in this directory. Do not copy Windows `node_modules` or `.next` to Linux. Follow the host, migration, TLS and backup procedures in README.md; its obsolete missing-source warnings are superseded by this status file.

## Live acceptance

1. Verify SSH identity, OS, runtime, disk and existing services before changing the host.
2. Configure or import the persistent database; configure the environment; pass the offline configuration check and Linux build/test gates.
3. Install the application service; verify loopback response. Configure DNS, issue the certificate with the HTTP bootstrap config, then enable the TLS config and verify renewal.
4. Provision the intended active Admin/Manager app accounts. The viewer mapping requires active matching app identities before sync can succeed.
5. Enable Sheets and Drive APIs, share the workbook with the service account as Editor and approved reporting accounts with the required access. Match the configured workbook title and four tabs: `Attendance`, `Travel Log`, `Leave Tracker`, `Payroll`. Verify the sharing restrictions in `lib/sheets-policy.ts`.
6. Run the Admin sync action and inspect all four tabs, permissions, row counts and Admin sync status. Sync replaces report cells with database records; confirm the selected workbook is the production report destination.
7. Run the workforce job service manually and verify success before enabling its timer.
8. Initialize the encrypted off-host backup repository, run a backup and test a separate restore before enabling the backup timer.

## Remaining application gaps

The SOS sender and Apps Script receiver have mocked tests, but no authenticated persisted incident route/UI is wired to the sender. Setting relay credentials alone does not enable SOS. Password-reset approval and Android device acceptance also remain outstanding. Do not report those features as live.
