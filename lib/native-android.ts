// Web UI adapter. Native bearer tokens and GPS queue payloads never cross this channel.
type State={accountId:string;active:boolean;ending:boolean;tripId?:string;message?:string;sync?:string;pending?:boolean};
let port:MessagePort|null=null,sequence=0,supportsLocationPermission=false;
const waiting=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
export const inAndroid=()=>typeof navigator!=='undefined'&&navigator.userAgent?.includes('FieldoraAndroid/1')===true;
export function nativeCommand(command:string,args:Record<string,unknown>={}):Promise<any>{
 if(!port)return Promise.reject(Error('Native integration is unavailable. This staging server needs the approved Android integration update.'));
 const id=String(++sequence);
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{waiting.delete(id);reject(Error('Native request timed out. Check trip status before retrying.'));},30000);waiting.set(id,{resolve,reject,timer});port!.postMessage(JSON.stringify({id,command,...args}));});
}
export function connectNative(onState:(s:State)=>void,onError:(s:string)=>void){
 if(!inAndroid())return()=>{};
 const receive=(event:MessageEvent)=>{
  if(event.data!=='fieldora-native-v1'||!event.ports[0]||!(event.origin===''&&event.source===null&&event.isTrusted))return;
  for(const p of waiting.values()){clearTimeout(p.timer);p.reject(Error('Native connection changed. Retry after reconnecting.'));}waiting.clear();supportsLocationPermission=false;port?.close();port=event.ports[0];port.onmessage=message=>{try{const reply=JSON.parse(message.data);if(reply.event==='state'){onState(reply.state);return;}if(reply.event==='back'){history.back();return;}const pending=waiting.get(reply.id);if(!pending)return;clearTimeout(pending.timer);waiting.delete(reply.id);reply.ok?pending.resolve(reply.result):pending.reject(Error(reply.error||'Native operation failed.'));}catch{onError('Native response was invalid.');}};
  port.start();nativeCommand('hello',{version:1}).then(result=>{supportsLocationPermission=result.locationPermission===true;window.dispatchEvent(new Event('fieldora-native-ready'));}).catch(e=>onError(e.message));
 };
 window.addEventListener('message',receive);
 return()=>{window.removeEventListener('message',receive);port?.close();port=null;for(const p of waiting.values()){clearTimeout(p.timer);p.reject(Error('Page closed.'));}waiting.clear();};
}
export async function authorizeNative(accountId:string){
 const challenge=await nativeCommand('challenge');
 let response:Response;
 try{response=await fetch('/api/mobile/web-ticket',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({challenge:challenge.challenge}),signal:AbortSignal.timeout(15000)});}
 catch{throw Error('Cannot reach Fieldora to connect native GPS. Check your connection, then tap Reconnect GPS.');}
 if(response.status===404||response.status===405)throw Error('This server is missing the Android integration endpoint. Ask your administrator to deploy the matching web/backend release, then tap Reconnect GPS.');
 if(response.status===401)throw Error('Your web sign-in expired. Sign in again to connect native GPS.');
 let ticket:any;
 try{ticket=await response.json();}catch{throw Error('The server returned an invalid native sign-in response. Ask your administrator to check the deployed integration.');}
 if(!response.ok)throw Error(typeof ticket?.error==='string'?ticket.error:'Native sign-in unavailable. Tap Reconnect GPS to retry.');
 if(typeof ticket?.code!=='string'||!/^[a-f0-9]{64}$/.test(ticket.code))throw Error('The server returned an invalid native handoff ticket. Reconnect GPS to retry.');
 const result=await nativeCommand('authenticate',{code:ticket.code});
 if(result.accountId!==accountId)throw Error('Web and native accounts do not match. Sign out and reconnect.');
 return result;
}

// Authenticate before asking for location so a missing bridge is never reported as an OS denial.
// v2 already prompts through WebChromeClient; v3 can await the explicit permission result first.
export async function ensureNativeLocation(){
 if(!inAndroid())return;
 await nativeCommand('status');
 if(supportsLocationPermission)await nativeCommand('locationPermission');
}
export const locationDeniedMessage=()=>inAndroid()
 ? 'Precise location was not allowed. Open Android Settings > Apps > Fieldora > Permissions > Location, allow while using the app and enable precise location, then retry.'
 : 'Location permission denied. Allow precise location in browser settings and retry.';
