# Sign-in and first Admin setup

The application requires Node.js 22.13+ and a writable, persistent SQLite file.
An origin fix does not configure account storage. Without `DATABASE_PATH`, production
sign-in, registration and Admin setup cannot work.

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
