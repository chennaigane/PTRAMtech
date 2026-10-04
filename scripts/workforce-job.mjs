// Keep the token out of argv, URLs, client bundles, cron text and logs.
if (!process.env.WORKFORCE_JOB_TOKEN || process.env.WORKFORCE_JOB_TOKEN.length<32) throw Error('WORKFORCE_JOB_TOKEN must be configured');
const origin = new URL(process.env.APP_ORIGIN || '');
if (origin.protocol!=='https:' || origin.username || origin.password || origin.pathname!=='/' || origin.search || origin.hash) throw Error('APP_ORIGIN must be an HTTPS origin');
const response = await fetch(new URL('/api/workforce/job',origin),{method:'POST',headers:{Authorization:'Bearer '+process.env.WORKFORCE_JOB_TOKEN},redirect:'error',signal:AbortSignal.timeout(120000)});
if (!response.ok) throw Error('Workforce job HTTP '+response.status);
const result=await response.json();
if(result.ok!==true) throw Error('Workforce job did not confirm completion with ok:true');
console.log('Workforce reconciliation completed');
