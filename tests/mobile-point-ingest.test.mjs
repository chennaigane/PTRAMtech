import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mobileSchema,ingestPoints} from '../lib/mobile-point-ingest.mjs';

test('dashboard projection failure rolls back uploaded points before acknowledgement', () => {
  const db = setup();
  assert.throws(() => ingestPoints(db,'employee','trip',[fix(1)],2000,() => { throw Error('projection unavailable'); }), /projection unavailable/);
  assert.equal(db.prepare('SELECT count(*) n FROM mobile_points').get().n,0);
  assert.equal(db.prepare('SELECT last_seq FROM mobile_trips').get().last_seq,0);
  db.close();
});
function setup() {
  const db = new DatabaseSync(':memory:'); mobileSchema(db);
  db.prepare('INSERT INTO mobile_trips(id,account,started_at,capture_until,upload_until) VALUES(?,?,?,?,?)').run('trip','employee',1000,10000,20000);
  return db;
}
const fix = (seq, extra={}) => ({seq,time:1000+seq*100,elapsedMs:seq*100,lat:13,lng:80,accuracy:15,...extra});
const ingest = (db, points, account='employee', now=11000) => ingestPoints(db,account,'trip',points,now);
test('lost acknowledgement and overlapping replay do not duplicate points', () => {
  const db=setup();
  assert.deepEqual(ingest(db,[fix(1),fix(2)]),{ackSeq:2});
  assert.deepEqual(ingest(db,[fix(1),fix(2)]),{ackSeq:2});
  ingest(db,[fix(2),fix(3)]);
  assert.equal(db.prepare('SELECT count(*) n FROM mobile_points').get().n,3); db.close();
});
test('conflicting replay rolls back the entire batch', () => {
  const db=setup(); ingest(db,[fix(1)]);
  assert.throws(()=>ingest(db,[fix(1,{lat:14}),fix(2)]),{status:409});
  assert.equal(db.prepare('SELECT last_seq FROM mobile_trips').get().last_seq,1); db.close();
});
test('gaps, reversed batches, clock rollback and elapsed rollback are rejected atomically', () => {
  for (const points of [[fix(1),fix(3)],[fix(2),fix(1)],[fix(1),fix(2,{time:1050})],[fix(1),fix(2,{elapsedMs:50})]]) {
    const db=setup(); assert.throws(()=>ingest(db,points),{status:409});
    assert.equal(db.prepare('SELECT count(*) n FROM mobile_points').get().n,0); db.close();
  }
});
test('ownership, authentication, limits and coordinate validation', () => {
  const db=setup();
  assert.throws(()=>ingest(db,[fix(1)],'other'),{status:404});
  assert.throws(()=>ingest(db,[fix(1)],''),{status:401});
  for (const points of [[],Array.from({length:101},(_,i)=>fix(i+1)),[fix(1,{lat:NaN})],[fix(1,{lng:181})],[fix(1,{accuracy:0})],[fix(1,{seq:1.5})]])
    assert.throws(()=>ingest(db,points),{status:400});
  db.close();
});
test('delayed offline points allowed only inside capture and upload windows', () => {
  const db=setup(); ingest(db,[fix(1)],'employee',19000);
  assert.throws(()=>ingest(db,[fix(2,{time:10001})]),{status:409});
  assert.throws(()=>ingest(db,[fix(2)],'employee',20001),{status:410}); db.close();
});
