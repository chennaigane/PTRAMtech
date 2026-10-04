import {createPrivateKey} from 'node:crypto';
import {resolve, posix} from 'node:path';
import {pathToFileURL} from 'node:url';

// Offline validation only: never prints credentials or contacts external services.
export function checkProduction(env) {
  const errors = [];
  const requireValue = key => {
    if (!env[key]?.trim()) errors.push(`${key} is required`);
    return env[key] || '';
  };
  if (env.NODE_ENV !== 'production') errors.push('NODE_ENV must be production');
  try {
    const url = new URL(requireValue('APP_ORIGIN'));
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.hostname === 'localhost' || url.hostname.endsWith('.example.com')) throw Error();
  } catch { errors.push('APP_ORIGIN must be the public HTTPS origin without a path'); }
  const database = requireValue('DATABASE_PATH');
  if (!posix.isAbsolute(database) || database.startsWith('/srv/ptraam/app/')) errors.push('DATABASE_PATH must be an absolute VPS path outside the application directory');
  if (requireValue('WORKFORCE_JOB_TOKEN').length < 32) errors.push('WORKFORCE_JOB_TOKEN must contain at least 32 characters');
  if (!/^[A-Za-z0-9_-]+$/.test(requireValue('GOOGLE_SPREADSHEET_ID'))) errors.push('GOOGLE_SPREADSHEET_ID must be an ID, not a URL');
  if (!/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(requireValue('GOOGLE_CLIENT_EMAIL'))) errors.push('GOOGLE_CLIENT_EMAIL must be a service-account email');
  try {
    const key = createPrivateKey(requireValue('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n'));
    if (key.asymmetricKeyType !== 'rsa') throw Error();
  } catch { errors.push('GOOGLE_PRIVATE_KEY must be a valid RSA private key'); }
  try {
    const mapping = JSON.parse(requireValue('GOOGLE_REPORT_VIEWERS'));
    if (!mapping || Array.isArray(mapping) || typeof mapping !== 'object' || !Object.keys(mapping).length) throw Error();
    for (const value of Object.values(mapping)) {
      const emails = Array.isArray(value) ? value : [value];
      if (!emails.length || emails.some(email => typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw Error();
    }
  } catch { errors.push('GOOGLE_REPORT_VIEWERS must map app identities to email addresses'); }
  const relay = ['EMERGENCY_WEBHOOK_URL', 'EMERGENCY_WEBHOOK_SECRET'];
  if (relay.some(key => env[key])) {
    try {
      const url = new URL(requireValue(relay[0]));
      if (url.origin !== 'https://script.google.com' || url.username || url.password || url.search || url.hash || !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname)) throw Error();
    } catch { errors.push('EMERGENCY_WEBHOOK_URL must be a deployed Google Apps Script /exec URL'); }
    if (requireValue(relay[1]).length < 32) errors.push('EMERGENCY_WEBHOOK_SECRET must contain at least 32 characters');
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = checkProduction(process.env);
  for (const error of errors) console.error(`FAIL: ${error}`);
  if (errors.length) process.exitCode = 1;
  else console.log('Production configuration syntax passes. Live access, workbook permissions, delivery and backups still require verification.');
}
