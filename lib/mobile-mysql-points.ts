import {db} from '@/db/raw';
import {normalize,PointError} from './mobile-point-ingest.mjs';

// Use one InnoDB transaction for accepted points, sequence state, and dashboard
// projection. A rolled-back batch must never be acknowledged to the phone.
export async function ingestMySQLPoints(accountId:string,tripId:string,points:unknown,now=Date.now(),project:()=>Promise<void>=async()=>{}) {
  if(!accountId)throw new PointError(401,'Authentication required');
  if(typeof tripId!=='string'||!Array.isArray(points)||points.length<1||points.length>100)throw new PointError(400,'Invalid batch');
  const normalized=points.map(normalize),store=db();
  return store.transaction!(async()=>{
    const trip=await store.prepare('SELECT * FROM mobile_trips WHERE id=? AND account=? FOR UPDATE').bind(tripId,accountId).first<any>();
    if(!trip)throw new PointError(404,'Trip not found');
    if(now>trip.upload_until)throw new PointError(410,'Upload window ended; review retained device queue');
    let seq=trip.last_seq,time=trip.last_time,elapsed=trip.last_elapsed,previous=0;
    for(const p of normalized){
      if(p.seq<=previous)throw new PointError(409,'Batch is not strictly ordered');
      previous=p.seq;const payload=JSON.stringify(p);
      if(p.seq<=seq){
        const old=await store.prepare('SELECT payload FROM mobile_points WHERE trip=? AND seq=?').bind(tripId,p.seq).first<{payload:string}>();
        if(!old||old.payload!==payload)throw new PointError(409,'Conflicting replay');
        continue;
      }
      if(p.seq!==seq+1||p.time<=time||p.elapsedMs<=elapsed)throw new PointError(409,'Out-of-order GPS point');
      if(p.time<trip.started_at||p.time>trip.capture_until||p.time>now+30000)throw new PointError(409,'Point outside authorized capture interval');
      await store.prepare('INSERT INTO mobile_points(trip,seq,payload) VALUES(?,?,?)').bind(tripId,p.seq,payload).run();
      seq=p.seq;time=p.time;elapsed=p.elapsedMs;
    }
    await store.prepare('UPDATE mobile_trips SET last_seq=?,last_time=?,last_elapsed=? WHERE id=?').bind(seq,time,elapsed,tripId).run();
    await project();return {ackSeq:normalized.at(-1)!.seq};
  });
}
