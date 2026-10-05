# Fieldora on GoDaddy managed Node.js

GoDaddy's managed MySQL connection variables are documented in its
[official hosting recipe](https://github.com/godaddy/nodejs-hosting-agent-skill/blob/main/skills/godaddy-nodejs-hosting/examples.md#managed-mysql).

Enable the managed MySQL database for the app. GoDaddy supplies the real values:

```dotenv
DB_HOST=<provided by GoDaddy>
DB_PORT=<provided by GoDaddy>
DB_NAME=<provided by GoDaddy>
DB_USER=<provided by GoDaddy>
DB_PASSWORD=<provided by GoDaddy>
```

Do not paste the angle-bracket placeholders into the hosting configuration. Never
commit credentials or share passwords in chat. MySQL is selected automatically
when these variables are present; optional `DATABASE_DRIVER=mysql` selects it
explicitly and reports incomplete credentials. Remove an old
`DATABASE_DRIVER=sqlite` override. No `DATABASE_PATH` is needed for MySQL.

Use MySQL 8.0+ (verified locally with MySQL 8.4). Connections are pooled and all
values are parameterized. For a database requiring TLS, set `DB_SSL=true`; certificate
validation remains enabled. Supply `DB_SSL_CA` only if the provider requires its
CA PEM (literal `\n` separators are accepted). Never disable certificate validation.

The database account needs CREATE/INDEX and SELECT/INSERT/UPDATE/DELETE privileges
within this application's database. Missing tables are created automatically under
a database-scoped initialization lock. Existing records are not dropped. Shared
mutations use database-scoped locks; GPS points and their dashboard projection
commit together before the phone receives an acknowledgement.

## Deploy and complete setup

1. Update the app in GoDaddy using the existing Git sync or zip-upload workflow.
   Both dependency lockfiles include `mysql2`. Do not upload `node_modules`, build
   caches, `.tools`, local databases, or environment files containing credentials.
2. Confirm the correct preview/published environment has the database settings.
3. Set `APP_ORIGIN` to that site's HTTPS origin (no path or share token). The
   approved preview also remains in `app/config/origins.ts`.
4. Restart/redeploy and open `/api/auth/me`. A fresh database reports
   `adminSetupNeeded: true`; it must no longer report missing SQLite storage.
5. At `/login`, choose **Set up Admin password**, use **9600043768**, and create a
   private password. Successful setup signs in the Admin. Existing Admin accounts
   continue using their existing password.
6. Verify signup/approval, department-specific attendance and travel, leave,
   reimbursements, and any configured Sheets integration. Check the runtime logs
   if database initialization fails. Connection errors report a safe message to
   users without exposing credentials.

## Existing data

Switching drivers does **not** move SQLite records into MySQL. Keep the original
SQLite database and backups. If existing records must be carried over, perform a
separately reviewed data migration and reconcile counts before changing the live
database. Do not create a second production database as an account-recovery method.
SQLite remains supported using `DATABASE_DRIVER=sqlite` and an absolute
`DATABASE_PATH` on persistent storage.

## Local verification

`npm test` runs SQLite regressions and MySQL configuration checks. The real-server
test is opt-in because it clears its dedicated test schema. Set `MYSQL_INTEGRATION=1`
and test-only `DB_*` variables, with `DB_NAME=fieldora_integration` or a name starting
with `fieldora_test_`, then run:

```sh
node --experimental-sqlite --loader ./tests/loader.mjs --test tests/mysql.test.mjs
```

Never run that test against production. It checks Admin setup/login, approvals,
department rules, office attendance, native/web GPS, replay protection, atomic
rollback, connection-to-connection visibility and database lock contention.
