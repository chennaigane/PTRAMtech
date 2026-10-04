/* eslint-disable @typescript-eslint/no-explicit-any -- D1 JSON records are validated at write boundaries; legacy records remain readable. */
import {db} from '@/db/raw';
import {initialPolicy,type Policy,type Department} from '@/lib/workforce-rules';
export type Profile = {department:Department;other:string;salary:number|null;divisor:number|null;otRate:number|null;otMultiplier:number|null;payrollAccess:boolean};
export type Entry = {id:string;kind:string;employee:string;date:string;data:Record<string,any>;updated:number};
export const defaultProfile:Profile={department:'Other',other:'Unassigned',salary:null,divisor:null,otRate:null,otMultiplier:null,payrollAccess:false};
export async function profile(id:string):Promise<Profile>{const r=await db().prepare('SELECT data FROM workforce_profiles WHERE employee=?').bind(id).first<{data:string}>();return r?JSON.parse(r.data):{...defaultProfile};}
export async function policy():Promise<Policy>{const r=await db().prepare("SELECT value FROM settings WHERE key='workforce_policy'").first<{value:string}>();return r?JSON.parse(r.value):structuredClone(initialPolicy);}
export function put(e:Omit<Entry,'updated'>){return db().prepare('INSERT INTO workforce_entries(id,kind,employee,date,data,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated=excluded.updated').bind(e.id,e.kind,e.employee,e.date,JSON.stringify(e.data),Date.now());}
export function audit(actor:string,action:string,target:string,details:unknown){return db().prepare('INSERT INTO workforce_audit(id,actor,action,target,details,created) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),actor,action,target,JSON.stringify(details),Date.now());}
export async function entries(kind?:string):Promise<Entry[]>{const r=await db().prepare('SELECT * FROM workforce_entries'+(kind?' WHERE kind=?':'')+' ORDER BY date DESC,id').bind(...(kind?[kind]:[])).all<any>();return r.results.map(r=>({...r,data:JSON.parse(r.data)}));}
export async function entry(id:string):Promise<Entry|null>{const r=await db().prepare('SELECT * FROM workforce_entries WHERE id=?').bind(id).first<any>();return r?{...r,data:JSON.parse(r.data)}:null;}
export function dailyStatement(employee:string,date:string,evidence:Record<string,unknown>){return db().prepare(`INSERT INTO workforce_entries(id,kind,employee,date,data,updated) VALUES(?,'daily',?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=json_patch(workforce_entries.data,excluded.data),updated=excluded.updated`).bind(`daily:${employee}:${date}`,employee,date,JSON.stringify(evidence),Date.now());}

/** Derived payroll must never survive a change to its policy or source records. */
export async function invalidatePayroll(){await db().prepare("DELETE FROM workforce_entries WHERE kind='payroll'").run();}
