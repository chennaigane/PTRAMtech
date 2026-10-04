import {existsSync} from 'node:fs';
const required=['app/layout.tsx','app/dashboard/page.tsx','components/workforce-panel.tsx','lib/auth.ts','lib/permissions.ts','lib/workforce-rules.ts','lib/workforce-store.ts','lib/workforce-lock.ts','lib/sheets-policy.ts','lib/sheets-payload.ts','lib/travel-modes.ts','app/api/auth/me/route.ts','app/api/workforce/route.ts','app/api/workforce/job/route.ts','app/api/records/route.ts','tests/loader.mjs','tsconfig.json'];
const missing=required.filter(file=>!existsSync(file));
if(missing.length) { console.error('Release blocked: restore matching application source:\n'+missing.map(file=>'  '+file).join('\n')); process.exitCode=1; }
else console.log('Required source paths exist. Run tests, typecheck, build and deployment acceptance checks.');
