# Automatic trip locations

## Cause and behavior

The start APIs stored GPS but left `from` empty (or used the office business label).
The dashboard substituted “GPS start point”. Web stop required a manual `to` value;
Android stopped collection without requesting an endpoint. No reverse geocoder existed.

Web now requests a new device fix for each start/stop, preserves its timestamp,
requires accuracy of 100 m or better and rejects an unchanged departure as the stop.
The API preserves existing driver office-geofence and employee permission rules.
Native manual stop requests a new GPS fix, persists it with the stop boundary in the
encrypted local queue, then stops collection. Notification Stop uses the same path.
Permission/lease revocation and logout still stop tracking immediately for privacy;
these interruptions cannot promise a fresh endpoint.

Start/stop evidence commits before reverse geocoding. Both MySQL and SQLite mobile
adapters call the same resolver after committing. A bounded 3-second provider call
cannot roll back the trip. A failed resolution displays saved coordinates with
“address pending”. Successful names and structured provider addresses persist in
`records.data.startLocation.address` / `endLocation.address`, alongside original
coordinates, device/server timestamps and accuracy. Existing points, distance,
rates, claims and approval fields are retained. No schema migration is needed.

## Configuration (not applied to Cloud Run)

Set server-side runtime values only:

```
GEOCODING_PROVIDER=geoapify
GEOCODING_API_KEY=<Secret Manager reference supplied as an environment secret>
GEOCODING_REQUESTS_PER_SECOND=2
GEOCODING_REQUESTS_PER_DAY=2500
```

Never use NEXT_PUBLIC_ for the key. Never bake it into Android or the image.
No database credentials or existing deployment environment values need changing.
The provider is deliberately disabled unless explicitly configured. Coordinates
continue saving without a key. The fixed HTTPS provider endpoint has no country
filter and accepts worldwide latitude/longitude. No example place is a default.

Provider documentation: https://apidocs.geoapify.com/docs/geocoding/reverse-geocoding/
Usage/pricing: https://www.geoapify.com/pricing/
Storage guidance: https://apidocs.geoapify.com/open-api/

Confirm your Geoapify plan before setting quotas. Local defaults are conservative
application limits, not a guarantee of remaining provider credits. Other services
using the same key also consume that plan's quota. The database-backed second/day
budget (`settings.geocode_budget`) is shared by all app instances; requests over
budget are deferred rather than queued in memory. Increase limits only within the
account plan. Exact-coordinate results are cached for 24 hours (maximum 512 entries
per process); failures for 30 seconds. Persisted resolved trip addresses avoid future
lookups. Concurrent identical lookups within a process share one request.
The UI includes Geoapify/OpenStreetMap attribution; raw datasource attribution is
retained in the structured address.

## Retry and optional historical backfill

In Travel log, select a trip and click **Resolve saved location names**. This calls
`POST /api/trips/resolve` with `{ "id": "existing-trip-uuid" }`. The session/origin and
existing trip visibility rules apply. No coordinates may be supplied by the caller.
Only missing address metadata is filled, with a 30-second retry cooldown; existing
names, points, status and money are not rewritten. A legacy first sample can recover
the start. An end requires stored end-location evidence; a missing end is not invented.
This is an explicit one-trip backfill, not an automatic history rewrite or bulk job.

## Android protocol compatibility

The existing `/api/mobile/v1/trips/start`, `/trips/points`, `/trips/stop` paths remain.
Sync uploads and acknowledges queued points before sending stop. Updated clients add
`endpointSeq` to manual stops marked `employee_stopped_gps` in the local queue.
Pre-update queued stops retain the old payload, so upgrading does not block uploads.
Updated servers validate that it identifies the last
accepted point at `stoppedAt`; offline freshness is relative to capture time, not
upload time. Retries are idempotent. Old servers ignore this additional field; old
clients remain accepted by new servers, but cannot gain the new fresh-stop capture
behavior without installing an updated app. No native geocoding key is needed.

Web offline points remain locally queued and upload on reconnection. Web completion
still requires a successful server save: if offline, GPS evidence is retained and the
user must retry Stop after reconnecting to capture a fresh final endpoint. Android
can commit its endpoint offline and upload within the existing authorization/upload
windows. Neither implementation expands the existing background/lease permissions.

## Verification and release gate

Automated tests use mocked provider replies and GPS, plus an in-memory database.
They cover distinct worldwide locations, same-locality stops, persistence/reload,
provider outage and retry, budgets, stale/weak/denied GPS, native queued final points,
duplicate uploads, authorization and preservation of older records.

Before release, configure the geocoder secret and verify real provider responses,
Cloud SQL persistence, browser permission denial/recovery, cross-city and same-place
trips, loss/recovery of connectivity, and Android foreground/locked-screen stops on
physical devices. Distances remain estimates from accepted GPS points, not verified
road mileage. Real-device background reliability has not been verified.

No push or deployment is part of this change. Obtain user approval before deployment.

## Local validation results

- Full `pnpm test`: 82 passed, 0 failed, 1 live MySQL integration test skipped.
- After final native journey-response changes: 12 relevant trip/mobile tests passed.
- `pnpm build`: passed, including TypeScript and route generation.
- Android Java sources compiled with Java 17 against installed Android API 35 and
  the existing generated BuildConfig. Deprecated API notices only. This was a
  compile check, not an APK build, emulator run or physical-device test.
- No real provider key, deployed API, Cloud SQL connection or device GPS was tested.

## Exact feature file list

Modified:

- `app/dashboard/page.tsx`
- `app/api/records/route.ts`
- `lib/mobile-api.ts`
- `lib/mobile-mysql.ts`
- `android/app/src/main/java/com/ptraam/tracker/MainActivity.java`
- `android/app/src/main/java/com/ptraam/tracker/TripService.java`
- `android/app/src/main/java/com/ptraam/tracker/Queue.java`
- `android/app/src/main/java/com/ptraam/tracker/SyncJob.java`

Added:

- `app/api/trips/resolve/route.ts`
- `lib/browser-gps.ts`
- `lib/reverse-geocode.ts`
- `lib/trip-locations.ts`
- `lib/trip-labels.ts`
- `tests/trip-locations.test.mjs`
- `docs/trip-location-update.md`

Pre-existing `.env.example`, Android build/Firebase configuration and generated
`next-env.d.ts` changes were not part of this feature edit. No database migration,
credential change or deployment configuration update was performed.
