import {db} from '@/db/raw';
import {ensureSchema} from '@/lib/auth';

export const DEFAULT_RATE = 3;

/** Company reimbursement rate in ₹ per km, set by the Admin. */
export async function getRate() {
  await ensureSchema();
  const r = await db().prepare("SELECT value FROM settings WHERE key = 'rate_per_km'").first<{value: string}>();
  return r ? Number(r.value) : DEFAULT_RATE;
}

export async function setRate(rate: number) {
  await ensureSchema();
  await db().prepare("INSERT INTO settings (key, value) VALUES ('rate_per_km', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(rate)).run();
}
