import {test} from 'node:test';
import assert from 'node:assert/strict';
import {connectNative,authorizeNative,nativeCommand,ensureNativeLocation} from '../lib/native-android.ts';
test('adapter accepts only native/same-origin handoff and exposes no native credentials',async()=>{
 const listeners=new Map(),sent=[],fetched=[];let receive,ready=false;
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{userAgent:'FieldoraAndroid/1'}});
 globalThis.location={origin:'https://fieldora.test'};
 globalThis.window={addEventListener:(key,f)=>listeners.set(key,f),removeEventListener:key=>listeners.delete(key),dispatchEvent:event=>{if(event.type==='fieldora-native-ready')ready=true;}};
 globalThis.fetch=async(url,options)=>{fetched.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({code:'b'.repeat(64),expiresIn:60})};};
 const fakePort={close(){},start(){},set onmessage(f){receive=f;},postMessage(raw){const r=JSON.parse(raw);sent.push(r);const result=r.command==='challenge'?{challenge:'a'.repeat(64)}:r.command==='authenticate'?{accountId:'u'}:{version:1};queueMicrotask(()=>receive({data:JSON.stringify({id:r.id,ok:true,result})}));}};
 const clean=connectNative(()=>{},message=>{throw Error(message);});
 const listener=listeners.get('message');
 listener({data:'fieldora-native-v1',ports:[fakePort],origin:'https://fieldora.test',source:{},isTrusted:true});
 listener({data:'fieldora-native-v1',ports:[fakePort],origin:'https://evil.test',source:{},isTrusted:true});
 listener({data:'fieldora-native-v1',ports:[fakePort],origin:'',source:{},isTrusted:true});
 listener({data:'fieldora-native-v1',ports:[fakePort],origin:'',source:null,isTrusted:false});
 assert.equal(sent.length,0);await assert.rejects(nativeCommand('status'),/unavailable/);
 // Android native postWebMessage has an empty source origin and no source Window.
 listener({data:'fieldora-native-v1',ports:[fakePort],origin:'',source:null,isTrusted:true});
 await new Promise(r=>setImmediate(r));assert.ok(ready);
 assert.deepEqual(await authorizeNative('u'),{accountId:'u'});
 assert.deepEqual(fetched,[{url:'/api/mobile/web-ticket',body:{challenge:'a'.repeat(64)}}]);
 assert.deepEqual(sent.map(r=>r.command),['hello','challenge','authenticate']);
 assert.ok(!JSON.stringify(sent).includes('accessToken'));assert.ok(!JSON.stringify(sent).includes('verifier'));
 await ensureNativeLocation();assert.equal(sent.at(-1).command,'status');
 clean();await assert.rejects(nativeCommand('status'),/unavailable/);
});

test('v3 permission handshake waits and propagates explicit Android denial',async()=>{
 const listeners=new Map(),sent=[];let receive,deny=false;
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{userAgent:'FieldoraAndroid/1'}});
 globalThis.window={addEventListener:(k,f)=>listeners.set(k,f),removeEventListener:k=>listeners.delete(k),dispatchEvent(){}};
 const port={close(){},start(){},set onmessage(f){receive=f;},postMessage(raw){const r=JSON.parse(raw);sent.push(r.command);queueMicrotask(()=>receive({data:JSON.stringify({id:r.id,ok:!(deny&&r.command==='locationPermission'),error:'Allow precise location in Android app settings, then retry.',result:r.command==='hello'?{version:1,locationPermission:true}:{}})}));}};
 const clean=connectNative(()=>{},message=>{throw Error(message);});listeners.get('message')({data:'fieldora-native-v1',ports:[port],origin:'',source:null,isTrusted:true});await new Promise(r=>setImmediate(r));
 await ensureNativeLocation();assert.deepEqual(sent,['hello','status','locationPermission']);
 deny=true;await assert.rejects(ensureNativeLocation(),/Android app settings/);clean();
});

test('handoff failures are actionable and never authenticate native with invalid tickets',async()=>{
 const listeners=new Map(),sent=[];let receive;
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{userAgent:'FieldoraAndroid/1'}});
 globalThis.window={addEventListener:(k,f)=>listeners.set(k,f),removeEventListener:k=>listeners.delete(k),dispatchEvent(){}};
 const port={close(){},start(){},set onmessage(f){receive=f;},postMessage(raw){const r=JSON.parse(raw);sent.push(r.command);queueMicrotask(()=>receive({data:JSON.stringify({id:r.id,ok:true,result:r.command==='challenge'?{challenge:'a'.repeat(64)}:{version:1}})}));}};
 const clean=connectNative(()=>{},()=>{});listeners.get('message')({data:'fieldora-native-v1',ports:[port],origin:'',source:null,isTrusted:true});await new Promise(r=>setImmediate(r));
 try{
 for(const [status,body,expected] of [[404,null,/matching web\/backend/],[405,null,/integration endpoint/],[401,null,/Sign in again/],[403,{error:'Invalid origin.'},/Invalid origin/],[200,{},/invalid native handoff ticket/],[502,null,/invalid native sign-in response/]]){
 globalThis.fetch=async()=>({status,ok:status===200,json:async()=>{if(body===null)throw Error('HTML');return body;}});await assert.rejects(authorizeNative('u'),expected);
 }
 globalThis.fetch=async()=>{throw Error('offline');};await assert.rejects(authorizeNative('u'),/Check your connection/);assert.ok(!sent.includes('authenticate'));
 }finally{clean();}
});
