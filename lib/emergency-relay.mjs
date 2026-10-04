import {createHmac} from 'node:crypto';

// Call only AFTER the incident has committed to the database. This helper does
// not replace route authentication, employee scoping, audit or persisted status.
export async function sendEmergencyAlert(incident, env=process.env, request=fetch) {
  if (!env.EMERGENCY_WEBHOOK_URL || !env.EMERGENCY_WEBHOOK_SECRET) return {status:'not_configured'};
  try {
    const url = new URL(env.EMERGENCY_WEBHOOK_URL);
    if (url.protocol!=='https:' || url.hostname!=='script.google.com' || !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname) || url.search || url.username || url.password || url.port)
      throw Error('Expected the deployed Apps Script /exec URL');
    if (env.EMERGENCY_WEBHOOK_SECRET.length < 32) throw Error('Webhook secret too short');
    if (!incident || typeof incident.id!=='string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(incident.id)) throw Error('Saved incident ID required');
    const hasLocation = Number.isFinite(incident.lat) && Math.abs(incident.lat)<=90 && Number.isFinite(incident.lng) && Math.abs(incident.lng)<=180;
    const payload = JSON.stringify({id:incident.id, name:String(incident.name||'').slice(0,200), phone:String(incident.phone||'').slice(0,40),
      note:String(incident.note||'').slice(0,2000), time:incident.time,
      lat:hasLocation?incident.lat:null, lng:hasLocation?incident.lng:null});
    const timestamp = Date.now();
    const signature = createHmac('sha256',env.EMERGENCY_WEBHOOK_SECRET).update(timestamp+'\n'+payload).digest('hex');
    let response = await request(url.href,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({timestamp,payload,signature}),redirect:'manual',signal:AbortSignal.timeout(15000)});
    // ContentService redirects the RESPONSE. Do not forward the signed POST or
    // any Authorization header to a redirect target.
    if (response.status===302 || response.status===303) {
      const redirected = new URL(response.headers.get('location'));
      if (redirected.protocol!=='https:' || redirected.hostname!=='script.googleusercontent.com' || redirected.username || redirected.password || redirected.port) throw Error('Unexpected relay redirect');
      response = await request(redirected.href,{method:'GET',redirect:'error',signal:AbortSignal.timeout(15000)});
    }
    if (!response.ok) return {status:'failed'};
    const result = await response.json();
    // "sent" means MailApp accepted the message, not verified inbox delivery.
    return result.ok===true && result.id===incident.id ? {status:'sent'} : {status:'failed'};
  } catch { return {status:'failed'}; }
}
