# Sign-in and first Admin setup

The application requires Node.js 22.13+ and configured account storage. GoDaddy
managed Node.js uses MySQL; existing VPS installations can continue using SQLite.
An origin fix does not configure account storage.

## GoDaddy managed Node.js (MySQL)

1. Enable/attach the managed MySQL database to this app in GoDaddy. Its runtime
   settings supply `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD`.
   Fieldora detects these automatically; `DATABASE_PATH` is not required.
2. Update the deployed app using your existing Git sync or zip-upload workflow.
   Ensure the database settings are available in the environment you are using
   (preview or published). Restart/redeploy after changes.
3. Fieldora initializes missing tables without dropping existing records. The
   database account needs table/index creation and read/write permissions.
4. Open `/api/auth/me`. A new database returns `adminSetupNeeded: true`. Then
   open `/login`, click **Set up Admin password**, enter **9600043768**, and create
   and confirm your own password. There is no preset password.
5. If the Admin already exists, log in with the existing password. Changing
   database settings does not reset passwords or migrate old SQLite records.

Full configuration and verification: [GoDaddy MySQL](GODADDY-MYSQL.md).

## Existing SQLite/VPS installations

1. In the hosting service, attach a persistent disk and record its actual mount path.
   Set the runtime variable `DATABASE_PATH` to an absolute filename on that disk,
   for example `/data/ptraam.sqlite` **only if the disk is mounted at `/data`**.
   The application user must be able to write the directory and SQLite sidecar files.
   Do not use temporary storage or an in-memory database for employee accounts.
   For existing accounts, point to the existing database; do not replace it with an empty file.
2. Set `APP_ORIGIN` to the public HTTPS origin, with no path or share token. The
   approved Airo preview is also listed in `app/config/origins.ts`.
3. Deploy the updated code and restart with those runtime settings. If the host does
   not support persistent writable files, use the documented Node VPS deployment
   or implement a supported external database adapter; setting an arbitrary path
   does not make a preview filesystem persistent.
4. Open `/login`. For a fresh database, click **Set up Admin password**.
5. Enter **9600043768** (the UI supplies +91), choose a password of at least eight
   characters containing a letter and a number, and confirm it. Keep the password private.
6. Click **Create Admin password**. Successful setup signs the Admin in immediately.
   Later, use **Log in** with the same number and password. There is no default password.
7. Approve pending employees in member management and configure the office geofence
   in Attendance & leave before office attendance or Driver trip starts.

If setup is already complete, use the existing Admin password. This flow does not
reset or replace an existing Admin account.

For a 503 response, inspect the server log for the failing request. Updated responses
identify `DATABASE_NOT_CONFIGURED` and `DATABASE_UNAVAILABLE` without revealing
internal paths. Other database/schema/runtime errors require the server exception;
the browser's generic message alone does not identify their cause.
