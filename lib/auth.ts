import {db} from '@/db/raw';
import {accessSetup} from '@/app/config/access';
import {deploymentOrigins} from '@/app/config/origins';

export type Role = 'Admin' | 'Manager' | 'Employee';
export type Status = 'pending' | 'active' | 'rejected' | 'removed';
export type User = {id:string,phone:string,name:string,role:Role,team:string|null,status:Status,created:number};

const COOKIE = 'ptraam_session';
const SESSION_DAYS = 7;
const PBKDF2_ITERATIONS = 100000;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

let schemaReady: Promise<unknown> | null = null;
export function ensureSchema() {
  const database=db();
  if(database.dialect==='mysql')return database.initialize!();
  schemaReady ??= db().batch([
    db().prepare(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY NOT NULL, phone TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL, team TEXT, password_hash TEXT NOT NULL, status TEXT NOT NULL, failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER, created INTEGER NOT NULL, reviewed_by TEXT, reviewed_at INTEGER)`),
    db().prepare(`CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, expires INTEGER NOT NULL)`),
    db().prepare(`CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id)`),
    db().prepare(`CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires)`),
    db().prepare(`CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL)`),
    db().prepare(`CREATE INDEX IF NOT EXISTS records_owner_kind ON records (owner, kind)`),
    db().prepare(`CREATE INDEX IF NOT EXISTS records_owner_created ON records (owner, created DESC)`),
    db().prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`),
    db().prepare(`CREATE TABLE IF NOT EXISTS workforce_profiles (employee TEXT PRIMARY KEY NOT NULL,data TEXT NOT NULL)`),
    db().prepare(`CREATE TABLE IF NOT EXISTS workforce_entries (id TEXT PRIMARY KEY NOT NULL,kind TEXT NOT NULL,employee TEXT NOT NULL,date TEXT NOT NULL,data TEXT NOT NULL,updated INTEGER NOT NULL)`),
    db().prepare(`CREATE INDEX IF NOT EXISTS workforce_employee_date ON workforce_entries(employee,date,kind)`),
    db().prepare(`CREATE TABLE IF NOT EXISTS workforce_audit (id TEXT PRIMARY KEY NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,details TEXT NOT NULL,created INTEGER NOT NULL)`),
    db().prepare(`CREATE INDEX IF NOT EXISTS workforce_audit_created ON workforce_audit (created DESC)`),
    db().prepare(`CREATE TABLE IF NOT EXISTS workforce_locks (name TEXT PRIMARY KEY NOT NULL,token TEXT NOT NULL,expires INTEGER NOT NULL)`),
    db().prepare(`INSERT OR IGNORE INTO workforce_profiles(employee,data) SELECT id,json_object('department',CASE WHEN team IN ('Marketing','Sales','Driver','Office Admin','Finance','HR') THEN team ELSE 'Other' END,'other',CASE WHEN team IN ('Marketing','Sales','Driver','Office Admin','Finance','HR') THEN '' ELSE 'Unassigned' END,'salary',NULL,'divisor',NULL,'otRate',NULL,'otMultiplier',NULL,'payrollAccess',json('false')) FROM users`),
    db().prepare(`UPDATE users SET role='Employee' WHERE role='Representative'`),
  ]).catch(e => { schemaReady = null; throw e; });
  return schemaReady;
}

/** Accepts "9876543210", "+91 98765 43210" etc. Returns "+919876543210" or null. */
export function normalizePhone(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let digits = input.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  return /^[6-9]\d{9}$/.test(digits) ? '+91' + digits : null;
}
export const ADMIN_PHONE = normalizePhone(accessSetup.designatedAdminPhone)!;

export function passwordProblem(p: unknown): string | null {
  if (typeof p !== 'string' || p.length < 8) return 'Password must be at least 8 characters.';
  if (p.length > 128) return 'Password must be at most 128 characters.';
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return 'Password must contain at least one letter and one number.';
  return null;
}

const enc = new TextEncoder();
const toHex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map(x => parseInt(x, 16)));

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({name: 'PBKDF2', hash: 'SHA-256', salt, iterations}, key, 256));
}
export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(await pbkdf2(password, salt, PBKDF2_ITERATIONS))}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [scheme, iter, salt, hash] = stored.split('$');
  if (scheme !== 'pbkdf2') return false;
  const actual = await pbkdf2(password, fromHex(salt), Number(iter));
  const expected = fromHex(hash);
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}
// Used when the phone is unknown so response time does not reveal registered numbers.
const DUMMY_HASH = `pbkdf2$${PBKDF2_ITERATIONS}$${'00'.repeat(16)}$${'00'.repeat(32)}`;

const sha256 = async (s: string) => toHex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

function readCookie(req: Request, name: string) {
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
function cookieHeader(req: Request, value: string, maxAge: number) {
  const secure = new URL(applicationOrigin(req)).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export async function createSession(req: Request, userId: string) {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await db().batch([
    db().prepare('DELETE FROM sessions WHERE expires < ?').bind(now),
    db().prepare('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)').bind(await sha256(token), userId, now + SESSION_DAYS * 86400000),
  ]);
  return cookieHeader(req, token, SESSION_DAYS * 86400);
}
export async function destroySession(req: Request) {
  const token = readCookie(req, COOKIE);
  if (token) { await ensureSchema(); await db().prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run(); }
  return cookieHeader(req, '', 0);
}

const USER_COLUMNS = 'u.id, u.phone, u.name, u.role, u.team, u.status, u.created';
/** The signed-in, active user for this request, or null. */
export async function getSessionUser(req: Request): Promise<User | null> {
  const token = readCookie(req, COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  await ensureSchema();
  return await db().prepare(`SELECT ${USER_COLUMNS} FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ? AND u.status = 'active'`)
    .bind(await sha256(token), Date.now()).first<User>();
}

export async function adminExists() {
  await ensureSchema();
  return !!(await db().prepare(`SELECT id FROM users WHERE role = 'Admin' LIMIT 1`).first());
}

export async function findUserByPhone(phone: string) {
  await ensureSchema();
  return await db().prepare('SELECT * FROM users WHERE phone = ?').bind(phone).first<User & {password_hash: string, failed_attempts: number, locked_until: number | null}>();
}

/** Checks phone + password. Returns the user or a message safe to show. */
export async function checkLogin(phone: string, password: string): Promise<{user: User} | {error: string, status: number}> {
  const row = await findUserByPhone(phone);
  const invalid = {error: 'Incorrect mobile number or password.', status: 401};
  if (!row) { await verifyPassword(password, DUMMY_HASH); return invalid; }
  const now = Date.now();
  if (row.locked_until && row.locked_until > now) {
    return {error: `Too many failed attempts. Try again in ${Math.ceil((row.locked_until - now) / 60000)} minute(s).`, status: 429};
  }
  if (!await verifyPassword(password, row.password_hash)) {
    const failed = row.failed_attempts + 1;
    const lock = failed >= MAX_FAILED ? now + LOCK_MINUTES * 60000 : null;
    await db().prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?').bind(lock ? 0 : failed, lock, row.id).run();
    return lock ? {error: `Too many failed attempts. Try again in ${LOCK_MINUTES} minutes.`, status: 429} : invalid;
  }
  await db().prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').bind(row.id).run();
  if (row.status === 'pending') return {error: 'Your account is waiting for Admin approval.', status: 403};
  if (row.status === 'rejected') return {error: 'Your registration was not approved. Please contact the PTRAAM Admin.', status: 403};
  if (row.status === 'removed') return {error: 'Your access has been removed. Please contact the PTRAAM Admin.', status: 403};
  const {password_hash, failed_attempts, locked_until, ...user} = row as any;
  return {user};
}

function applicationOrigin(req: Request): string {
  // Managed previews reach Next through an internal HTTP address. Accept only
  // explicitly approved public origins, never arbitrary forwarded host headers.
  const additional = process.env.APP_ADDITIONAL_ORIGINS;
  const approved = (additional === undefined ? [...deploymentOrigins] : additional.split(',').map(s => s.trim()).filter(Boolean)).map(value => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname.includes('*') || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      throw new Error('APP_ADDITIONAL_ORIGINS must contain exact HTTPS origins without paths, credentials, queries or fragments.');
    return url.origin;
  });
  const browserOrigin = req.headers.get('origin');
  if (browserOrigin && approved.includes(browserOrigin)) return browserOrigin;
  // Behind Nginx, req.url can contain the internal listening address. Use the
  // configured public origin, never client-supplied forwarded headers.
  const configured = process.env.APP_ORIGIN?.trim();
  const url = new URL(configured || req.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (configured && (url.pathname !== '/' || url.search || url.hash))) {
    throw new Error('APP_ORIGIN must be an HTTP(S) origin without a path, credentials, query or fragment.');
  }
  // NextURL rewrites loopback IPs to localhost. Recover the actual local
  // browser host, but never infer a public/proxy origin from request headers.
  if (!configured && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    const host = req.headers.get('host');
    if (host) {
      const local = new URL(`${url.protocol}//${host}`);
      if (['localhost', '127.0.0.1', '[::1]'].includes(local.hostname) &&
          local.port === url.port && local.host === host) return local.origin;
    }
  }
  return url.origin;
}

export function sameOrigin(req: Request) {
  try {
    const expected = applicationOrigin(req);
    const origin = req.headers.get('origin');
    return origin === null || origin === expected;
  } catch {
    return false;
  }
}
export const publicUser = (u: User) => ({id: u.id, phone: u.phone, name: u.name, role: u.role, team: u.team, status: u.status, created: u.created});
