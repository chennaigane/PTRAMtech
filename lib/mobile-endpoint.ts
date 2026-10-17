import {z} from 'zod';
import {PointError} from './mobile-point-ingest.mjs';
import type {Point} from './geo';

export const MOBILE_CONTRACT = {stopContract:1,structuredStopAcknowledgement:true,endpointVersion:1,startPath:'/trips/start/endpoint-v1',stopPath:'/trips/stop/endpoint-v1'} as const;

const endpointSchema = z.discriminatedUnion('status', [
  z.object({version:z.literal(1).default(1),status:z.literal('captured'),seq:z.number().int().min(1).max(10000)}).strict(),
  z.object({version:z.literal(1).default(1),status:z.literal('unverified')}).strict(),
]);
export type Endpoint = z.infer<typeof endpointSchema>;
type RecordedPoint = Point & {seq:number};

/** Bridge the incoming locality client's explicit final sequence, never infer one. */
export function legacyStopEvidence(path:string, input:unknown, seq:unknown, reason:string, at:number, lastSeq:number, lastTime:number) {
  if (seq === undefined) return {reason,endpoint:input};
  if (path !== 'trips/stop' || input !== undefined || !['employee_stopped','employee_stopped_gps'].includes(reason))
    throw new PointError(409,'Use one supported final GPS evidence contract.');
  const finalSeq = z.number().int().positive().max(10000).parse(seq);
  if (finalSeq !== lastSeq || at < lastTime || at - lastTime > 1000)
    throw new PointError(409,'Synchronize the fresh final GPS point before stopping.');
  return {reason:'employee_stopped',endpoint:{version:1,status:'captured',seq:finalSeq}};
}

/** Evidence refers to an already committed point, never coordinates supplied with stop. */
export function stopEndpoint(input:unknown, reason:string, at:number, cutoff:number, last?:RecordedPoint):Endpoint {
  const endpoint = endpointSchema.parse(input === undefined ? {status:'unverified'} : input);
  if (endpoint.status === 'captured' && (reason !== 'employee_stopped' || !last
      || last.seq !== endpoint.seq || last.accuracy <= 0 || last.accuracy > 100
      || last.time > cutoff || last.time > at || at - last.time > 10000 || cutoff - last.time > 10000))
    throw new PointError(409,'Final GPS point must be uploaded and within the authorized stop interval.');
  return endpoint;
}

/** Re-projection/replay must not turn a timeout's last ordinary point into a verified endpoint. */
export function projectEndpoint(data:Record<string,any>, captured:RecordedPoint[], stoppedAt:number) {
  // Missing metadata is historical evidence, not a failed final capture.
  // Unversioned Phase 1A metadata means v1; preserve unknown future versions.
  const parsed = endpointSchema.safeParse(data.endpoint);
  // Only understood, valid metadata owns these fields. Malformed/unknown metadata
  // must not erase independently recorded historical verification during replay.
  if (!parsed.success) return;
  const endpoint = parsed.data;
  const last = captured.at(-1);
  data.end = stoppedAt;
  data.status = data.status === 'Travelling' ? 'Pending' : data.status;
  data.endVerified = endpoint.status === 'captured' && !!last && last.seq === endpoint.seq
    && last.time <= stoppedAt && stoppedAt - last.time <= 10000;
  const previous = data.endLocation;
  const same = previous?.lat === last?.lat && previous?.lng === last?.lng && previous?.time === last?.time;
  data.endLocation = data.endVerified ? (same ? {...previous,...last} : last) : null;
  if (!same || !data.endVerified) data.to = '';
  data.captureNote = data.endVerified
    ? 'Final native GPS coordinate captured; physical-device validation pending.'
    : 'Destination unverified. Last recorded GPS point retained; no destination was invented.';
}

export function stopAcknowledgement(id:string, data:Record<string,any>) {
  // A legacy already-stopped trip can have endVerified but no explicit final sequence.
  const parsed = endpointSchema.safeParse(data.endpoint);
  const endpoint = parsed.success ? parsed.data : undefined;
  const captured = data.endVerified === true && endpoint?.status === 'captured';
  return {tripId:id,stoppedAt:data.end,endpointStatus:captured ? 'captured' : 'unverified',
    finalSeq:captured ? endpoint.seq : 0};
}
