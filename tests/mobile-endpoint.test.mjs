import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stopEndpoint,projectEndpoint,stopAcknowledgement,legacyStopEvidence} from '../lib/mobile-endpoint.ts';

const point = {seq:4,time:100000,elapsedMs:50000,lat:13,lng:80,accuracy:5};
test('legacy locality stop evidence bridges only explicit fresh sequences on the legacy route',()=>{
  for(const reason of ['employee_stopped','employee_stopped_gps']) {
    const evidence=legacyStopEvidence('trips/stop',undefined,4,reason,101000,4,100000);
    assert.equal(stopEndpoint(evidence.endpoint,evidence.reason,101000,101000,point).status,'captured');
  }
  for(const args of [
    ['trips/stop/endpoint-v1',undefined,4,'employee_stopped',101000,4,100000],
    ['trips/stop',{status:'unverified'},4,'employee_stopped',101000,4,100000],
    ['trips/stop',undefined,4,'permission_revoked',101000,4,100000],
    ['trips/stop',undefined,3,'employee_stopped',101000,4,100000],
    ['trips/stop',undefined,4,'employee_stopped',101001,4,100000],
    ['trips/stop',undefined,4,'employee_stopped',99999,4,100000],
  ]) assert.throws(()=>legacyStopEvidence(...args));
});
test('endpoint reprojection retains locality metadata only for identical verified evidence',()=>{
  const address={locality:'Recorded locality'},data={status:'Pending',endpoint:{version:1,status:'captured',seq:4},endLocation:{...point,address},to:'Recorded locality'};
  projectEndpoint(data,[point],101000);assert.deepEqual(data.endLocation.address,address);assert.equal(data.to,'Recorded locality');
  projectEndpoint(data,[{...point,lat:14}],101000);assert.equal(data.endLocation.address,undefined);assert.equal(data.to,'');
  data.endpoint={version:1,status:'unverified'};projectEndpoint(data,[point],101000);assert.equal(data.endLocation,null);
});
test('endpoint evidence requires the final committed sequence and authorized timestamp',()=>{
  assert.deepEqual(stopEndpoint({status:'captured',seq:4},'employee_stopped',101000,101000,point),{version:1,status:'captured',seq:4});
  for(const last of [undefined,{...point,seq:3},{...point,accuracy:101},{...point,time:80000},{...point,time:102000}])
    assert.throws(()=>stopEndpoint({status:'captured',seq:4},'employee_stopped',101000,101000,last));
  assert.throws(()=>stopEndpoint({status:'captured',seq:4},'authorization_ended',101000,101000,point));
  assert.throws(()=>stopEndpoint({status:'captured',seq:4},'employee_stopped',101000,99000,point));
});
test('timeout, immediate stop and legacy requests remain explicitly unverified',()=>{
  for(const reason of ['endpoint_timeout','immediate_stop','permission_revoked','authorization_ended','employee_stopped']) {
    const data={status:'Travelling',endpoint:stopEndpoint(undefined,reason,101000,101000,point)};
    projectEndpoint(data,[point],101000);
    assert.equal(data.endVerified,false);assert.equal(data.endLocation,null);assert.equal(data.status,'Pending');
    projectEndpoint(data,[point],101000);assert.equal(data.endVerified,false,'retry cannot infer verification from recency');
  }
});
test('retry of a legacy already-stopped trip acknowledges conservatively without rewriting history',()=>{
  const legacy={end:101000,endVerified:true,endLocation:point};
  assert.deepEqual(stopAcknowledgement('trip',legacy),{tripId:'trip',stoppedAt:101000,endpointStatus:'unverified',finalSeq:0});
  assert.equal(legacy.endVerified,true,'acknowledgement does not rewrite historical evidence');
});


test('versioned endpoint semantics preserve legacy and unknown evidence',()=>{
  for(const endpoint of [undefined,null,{},'captured',{status:'unknown'},
    {status:'captured',seq:'4'},{version:1,status:'captured',seq:10001},{version:99,status:'captured',seq:4}]) {
    const data={status:'Paid',end:101000,endVerified:true,endLocation:point,captureNote:'historical',...(endpoint===undefined?{}:{endpoint})};
    const before=structuredClone(data);projectEndpoint(data,[],102000);assert.deepEqual(data,before);
    assert.equal(stopAcknowledgement('trip',data).endpointStatus,'unverified');
  }
  assert.equal(stopEndpoint({status:'unverified'},'endpoint_timeout',101000,101000).version,1);
  assert.throws(()=>stopEndpoint({version:2,status:'unverified'},'endpoint_timeout',101000,101000));
  assert.equal(stopEndpoint({version:1,status:'captured',seq:4},'employee_stopped',110000,110000,point).status,'captured');
  assert.throws(()=>stopEndpoint({status:'captured',seq:4},'employee_stopped',110001,110001,point));
});
