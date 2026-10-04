// One source of truth for how each department records attendance and travel.
// The API enforces these rules; the dashboard uses the same functions to decide what to show.
import {distance} from '@/lib/geo';
import type {Fence, Fix} from '@/lib/workforce-rules';

/**
 * field  – Marketing / Sales: Start Trip anywhere; the phone's GPS fix is the start point.
 * driver – Drivers: Start Trip only inside the configured office geofence.
 * office – Every other department: office check-in / check-out only, no trip tracking.
 */
export type TravelMode = 'field' | 'driver' | 'office';
export function travelMode(department: string | null | undefined): TravelMode {
  if (department === 'Marketing' || department === 'Sales') return 'field';
  if (department === 'Driver') return 'driver';
  return 'office';
}
export const tracksTrips = (department: string | null | undefined) => travelMode(department) !== 'office';

/** Worst GPS accuracy (metres) accepted for a trip start or stop. */
export const TRIP_MAX_ACCURACY_M = 100;
/** A fix older than this (ms) is not "current". */
export const FRESH_FIX_MS = 120000;

export const tripUi = (department: string | null | undefined) => {
  const mode = travelMode(department);
  return {
    mode,
    startTrip: mode !== 'office',
    stopTrip: mode !== 'office',
    routeMap: mode !== 'office',
    // Marketing / Sales start wherever they are; nobody picks an origin branch any more.
    originBranchSelector: false,
    branchArrivalCheckIn: mode === 'field',
    officeCheckInOut: mode === 'office',
    startRule: mode === 'field' ? 'Your phone’s current GPS location, time and accuracy are saved as the trip start and you are marked Present.'
      : mode === 'driver' ? 'Start Trip works only when GPS confirms you are inside the office geofence. A valid start marks you Present.'
      : 'Your department uses office attendance only.',
  };
};

type Who = {role: string};
/**
 * Dashboard tabs. Admin and Manager keep company oversight tabs regardless of their own department;
 * an Employee sees travel tabs only when their department tracks trips.
 */
export function visibleTabs(me: Who, department: string | null | undefined) {
  const company = me.role === 'Admin' || me.role === 'Manager';
  const mode = travelMode(department);
  const all = ['Overview', 'Travel log', 'Attendance', 'Attendance & leave', 'Employees', 'Access & roles', 'Branches', 'Reimbursements', 'Safety centre'];
  return all.filter(tab => {
    if (['Overview', 'Employees', 'Access & roles', 'Branches'].includes(tab)) return company;
    if (tab === 'Travel log' || tab === 'Reimbursements') return company || mode !== 'office';
    if (tab === 'Attendance') return company || mode === 'field'; // branch arrival check-ins
    return true;
  });
}

/** Validates a phone fix used as a trip start or stop. Messages are shown to the employee as-is. */
export function checkTripFix(p: Fix, now = Date.now()) {
  if (![p?.lat, p?.lng, p?.accuracy, p?.time].every(Number.isFinite) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180 || p.accuracy < 0)
    throw Error('No usable GPS location was received. Turn on Location (GPS) and allow precise location for this site, then try again.');
  if (Math.abs(now - p.time) > FRESH_FIX_MS) throw Error('This GPS location is out of date. Tap again to capture a fresh location.');
  if (p.accuracy > TRIP_MAX_ACCURACY_M)
    throw Error(`GPS is only accurate to about ${Math.round(p.accuracy)} m; ${TRIP_MAX_ACCURACY_M} m or better is needed. Move to an open area, turn on precise location and try again.`);
}

/** Driver start: the fix's whole accuracy circle must fit inside the office geofence. Returns metres from the office. */
export function checkOfficeStart(p: Fix, office: Fence | null, now = Date.now()) {
  if (!office) throw Error('The Admin has not configured the office location yet, so Drivers cannot start trips. Ask the Admin to set the office geofence.');
  checkTripFix(p, now);
  if (p.accuracy > office.maxAccuracy)
    throw Error(`GPS is only accurate to about ${Math.round(p.accuracy)} m; the office requires ${office.maxAccuracy} m or better. Wait for a clearer signal and try again.`);
  const metres = distance(p, office);
  if (metres + p.accuracy > office.radius)
    throw Error(`You are about ${Math.round(metres)} m from the office (GPS ±${Math.round(p.accuracy)} m). Drivers can start a trip only inside the ${office.radius} m office geofence. Move to the office and try again.`);
  return Math.round(metres);
}
