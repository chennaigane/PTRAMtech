// Deploy under the company Google account. See deploy/README.md.
// Never trust recipients from the request; only Script Properties can select them.
var PTRAAM_RECIPIENTS = ['ptramkumaarenterprises25@gmail.com','mohanagane08@gmail.com','chennaigane@gmail.com'];
function jsonReply(value) { return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON); }
function hmacHex(value, secret) { return Utilities.computeHmacSha256Signature(value, secret, Utilities.Charset.UTF_8).map(function(b) { return ('0'+((b+256)%256).toString(16)).slice(-2); }).join(''); }
function equalSignature(a,b) {
  if (typeof a!=='string' || !/^[0-9a-f]{64}$/.test(a)) return false;
  var difference=0; for(var i=0;i<64;i++) difference |= a.charCodeAt(i)^b.charCodeAt(i);
  return difference===0;
}
function doPost(e) {
  var lock;
  try {
    if (!e || !e.postData || e.postData.contents.length>16000) return jsonReply({ok:false});
    var envelope=JSON.parse(e.postData.contents), properties=PropertiesService.getScriptProperties();
    var secret=properties.getProperty('WEBHOOK_SECRET');
    if (!secret || secret.length<32 || !Number.isSafeInteger(envelope.timestamp) || Math.abs(Date.now()-envelope.timestamp)>300000 || typeof envelope.payload!=='string') return jsonReply({ok:false});
    if (!equalSignature(envelope.signature,hmacHex(envelope.timestamp+'\n'+envelope.payload,secret))) return jsonReply({ok:false});
    var incident=JSON.parse(envelope.payload);
    if (!incident || typeof incident.id!=='string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(incident.id) || !Number.isSafeInteger(incident.time) || incident.time<Date.now()-86400000 || incident.time>Date.now()+30000) return jsonReply({ok:false});
    var recipients=(properties.getProperty('ALERT_RECIPIENTS')||'').split(',').map(function(s){return s.trim().toLowerCase();}).filter(Boolean);
    if (!recipients.length || recipients.some(function(s){return PTRAAM_RECIPIENTS.indexOf(s)<0;})) return jsonReply({ok:false});
    recipients=recipients.filter(function(s,i){return recipients.indexOf(s)===i;});
    lock=LockService.getScriptLock(); if(!lock.tryLock(5000)) return jsonReply({ok:false});
    var key='incident:'+incident.id, digest=hmacHex(envelope.payload,secret), previous=properties.getProperty(key);
    if(previous) {
      var prior=JSON.parse(previous);
      return jsonReply({ok:prior.state==='sent' && prior.digest===digest,id:incident.id});
    }
    // Keep a 24-hour deduplication ledger without employee data. App must not
    // automatically retry incidents older than 24h; reconcile those manually.
    var values=properties.getProperties();
    Object.keys(values).forEach(function(k){if(k.indexOf('incident:')===0 && JSON.parse(values[k]).time<Date.now()-86400000) properties.deleteProperty(k);});
    if(MailApp.getRemainingDailyQuota()<recipients.length) return jsonReply({ok:false});
    properties.setProperty(key,JSON.stringify({state:'pending',digest:digest,time:Date.now()}));
    var location='Location unavailable';
    if(Number.isFinite(incident.lat) && Math.abs(incident.lat)<=90 && Number.isFinite(incident.lng) && Math.abs(incident.lng)<=180)
      location=incident.lat+', '+incident.lng+'\nhttps://www.google.com/maps?q='+encodeURIComponent(incident.lat+','+incident.lng);
    var body='PTRAAM SOS incident\nID: '+incident.id+'\nEmployee: '+String(incident.name||'').slice(0,200)+'\nPhone: '+String(incident.phone||'').slice(0,40)+
      '\nTime (UTC): '+new Date(incident.time).toISOString()+'\nNote: '+String(incident.note||'').slice(0,2000)+'\n'+location+
      '\n\nContact the employee promptly. This message does not establish that emergency services have been contacted.';
    MailApp.sendEmail({to:recipients.join(','),subject:'PTRAAM SOS — '+incident.id,body:body});
    properties.setProperty(key,JSON.stringify({state:'sent',digest:digest,time:Date.now()}));
    return jsonReply({ok:true,id:incident.id});
  } catch(error) {
    // Pending after a crash/send failure is intentionally ambiguous; do not send
    // automatically again. Reconcile with responders before clearing the ledger.
    return jsonReply({ok:false});
  } finally { if(lock && lock.hasLock()) lock.releaseLock(); }
}
function authorizeMail() { MailApp.getRemainingDailyQuota(); }
