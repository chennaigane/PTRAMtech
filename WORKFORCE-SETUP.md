# PTRAAM workforce reports and access

The application database is authoritative. Google Sheets is an app-written report and is never an input source. The application writes one workbook containing the four managed tabs `Attendance`, `Travel Log`, `Leave Tracker`, and `Payroll`. Do not add manual notes or edit report rows. Sync detects discrepancies, records an Admin alert and audit event, then restores the rows from the application database.

## Server configuration

Set these server-side secrets; never put them in browser code or an APK:

- `GOOGLE_CLIENT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `GOOGLE_SPREADSHEET_ID`
- Optional `GOOGLE_SPREADSHEET_TITLE` (defaults to `PTRAAM Enterprises`; set it to the exact title of the customer workbook)
- Optional `GOOGLE_REPORT_VIEWERS` JSON override

Enable Google Sheets API and Google Drive API. Share the workbook with the service account as Editor. The application service account writes the four tabs. Do not distribute its private key.

The default viewer mapping is:

- Admin app account `+919600043768` → `ptramkumaarenterprises25@gmail.com`
- Manager app account `+919940180612` → `mohanagane08@gmail.com` and `chennaigane@gmail.com`

The app account signs in with its phone number and password. A Google email is not an app login. The Admin must approve the member and assign the Manager role to the account associated with `+919940180612`. On every sync, the server verifies that mapped app accounts exist, are active, and have the Admin or Manager role. Each mapped email must already have Viewer access in Google Drive.

To override the defaults, configure a JSON object whose keys are active Admin/Manager user IDs or normalized phone numbers and whose values are one email or an array of emails, for example:

```json
{"+919600043768":"ptramkumaarenterprises25@gmail.com","+919940180612":["mohanagane08@gmail.com","chennaigane@gmail.com"]}
```

Only the app's Admin can approve accounts and change roles. Keep the Manager's app team assignment current; Manager dashboard visibility and employee-level access are enforced by the application role/team rules.

## Workbook setup

Create or use one spreadsheet, set its title to `PTRAAM Enterprises` (or set `GOOGLE_SPREADSHEET_TITLE` to the exact existing title), and create these exact tabs:

1. `Attendance`
2. `Travel Log`
3. `Leave Tracker`
4. `Payroll`

The sync replaces all cells in these tabs, including obsolete rows. It checks every tab before writing and uses one Google Sheets batch update for the workbook. The Attendance tab uses the four-column report: S.no, Date, Name, and Attendance (Present / Absent).

## Workbook permissions and payroll

- Give `GOOGLE_CLIENT_EMAIL` Editor access.
- Give `ptramkumaarenterprises25@gmail.com`, `mohanagane08@gmail.com`, and `chennaigane@gmail.com` Viewer access only, subject to the active-role check above.
- Remove employee access, public links, group shares, and other writers. Use Restricted sharing and inspect inherited folder access.
- Keep copying and downloading enabled for Viewers so Admin/Manager can export or copy reports to Excel.
- All workbook Viewers can see every tab, including Payroll. Hidden tabs and protected ranges do not make Payroll private. Do not share this workbook with anyone who should not see payroll data.
- The file owner retains owner controls and can edit cells and sharing. The application detects report drift on sync, logs it, and restores app-managed content; it cannot prevent the owner from making a temporary manual edit.

## Sync and recovery

The Admin can run `Admin > Sheets & audit > Sync / retry reports`. For regular reconciliation, schedule the authenticated `/api/workforce/job` with `WORKFORCE_JOB_TOKEN`. Reconcile attendance and calculate payroll before publishing. Inspect Admin alerts and audit details after sync. If sync fails, correct the spreadsheet ID/title, tab names, sharing, API access, or server secrets, then retry. The local automated tests use a fake Google API and do not verify live Google permissions.

Google references: [Drive roles](https://developers.google.com/workspace/drive/api/guides/ref-roles), [copy/download settings](https://developers.google.com/workspace/drive/api/reference/rest/v3/files).
