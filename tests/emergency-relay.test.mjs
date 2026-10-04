import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {sendEmergencyAlert} from '../lib/emergency-relay.mjs';

const secret='test-secret-32-characters-long-minimum';
const incident=()=>({id:'incident-1',name:'Employee',phone:'+910000000000',note:'Help',time:Date.now(),lat:13,lng:80});
const env={EMERGENCY_WEBHOOK_URL:'https://script.google.com/macros/s/TEST/exec',EMERGENCY_WEBHOOK_SECRET:secret};
function relay() {
  const values={WEBHOOK_SECRET:secret,ALERT_RECIPIENTS:'ptramkumaarenterprises25@gmail.com,mohanagane08@gmail.com,chennaigane@gmail.com'},sent=[];
  const context=vm.createContext({Date,JSON,Number,String,Object,
    ContentService:{MimeType:{JSON:'json'},createTextOutput:s=>({setMimeType:()=>JSON.parse(s)})},
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>values[k],setProperty:(k,v)=>{values[k]=v;},getProperties:()=>({...values}),deleteProperty:k=>{delete values[k];}})},
    LockService:{getScriptLock:()=>({tryLock:()=>true,hasLock:()=>true,releaseLock:()=>{}})},
    Utilities:{Charset:{UTF_8:'utf8'},computeHmacSha256Signature:(data,key)=>[...createHmac('sha256',key).update(data).digest()]},
    MailApp:{getRemainingDailyQuota:()=>100,sendEmail:message=>sent.push(message)}});
  vm.runInContext(readFileSync('integrations/google-apps-script/EmergencyWebhook.gs','utf8'),context);
  return {context,values,sent,receive:body=>context.doPost({postData:{contents:body}})};
}
function envelope(payload,timestamp=Date.now()) {
  payload=JSON.stringify(payload);return JSON.stringify({timestamp,payload,signature:createHmac('sha256',secret).update(timestamp+'\n'+payload).digest('hex')});
}
test('sender and relay agree on signed payload; recipients cannot be injected',async()=>{
  const r=relay(),item={...incident(),recipients:['attacker@example.com']};
  const send=async(url,options)=>new Response(JSON.stringify(r.receive(options.body)),{status:200});
  assert.deepEqual(await sendEmergencyAlert(item,env,send),{status:'sent'});
  assert.deepEqual(await sendEmergencyAlert(item,env,send),{status:'sent'});
  assert.equal(r.sent.length,1);assert.equal(r.sent[0].to,r.values.ALERT_RECIPIENTS);
  assert.match(r.sent[0].body,/google.com\/maps/);
});
test('tampered, stale, conflicting and unauthorized-recipient requests do not send',()=>{
  const r=relay(),item=incident();
  const tampered=JSON.parse(envelope(item));tampered.payload=JSON.stringify({...item,note:'altered'});
  assert.equal(r.receive(JSON.stringify(tampered)).ok,false);
  assert.equal(r.receive(envelope(item,Date.now()-600000)).ok,false);
  assert.equal(r.receive(envelope({...item,time:Date.now()-90000000})).ok,false);
  assert.equal(r.receive(envelope(item)).ok,true);
  assert.equal(r.receive(envelope({...item,note:'conflicting replay'})).ok,false);
  r.values.ALERT_RECIPIENTS='attacker@example.com';
  assert.equal(r.receive(envelope({...item,id:'incident-2'})).ok,false);assert.equal(r.sent.length,1);
});
test('uncertain MailApp failure is not reported as sent or automatically resent',()=>{
  const r=relay(),item=incident();let attempts=0;
  r.context.MailApp.sendEmail=()=>{attempts++;throw Error('quota or network');};
  assert.equal(r.receive(envelope(item)).ok,false);assert.equal(r.receive(envelope(item)).ok,false);assert.equal(attempts,1);
});
test('Apps Script response redirect uses GET without credentials; unsafe redirects fail',async()=>{
  let calls=0;const item=incident();
  const response=await sendEmergencyAlert(item,env,async(url,options)=>{
    calls++;if(calls===1)return new Response(null,{status:302,headers:{location:'https://script.googleusercontent.com/macros/echo?user_content_key=test'}});
    assert.equal(options.method,'GET');assert.equal(options.body,undefined);assert.equal(options.headers,undefined);
    return new Response(JSON.stringify({ok:true,id:item.id}));
  });
  assert.deepEqual(response,{status:'sent'});assert.equal(calls,2);
  assert.deepEqual(await sendEmergencyAlert(item,env,async()=>new Response(null,{status:302,headers:{location:'https://attacker.example'}})),{status:'failed'});
  assert.deepEqual(await sendEmergencyAlert(item,{}),{status:'not_configured'});
});
