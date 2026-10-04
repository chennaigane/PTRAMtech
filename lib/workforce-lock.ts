import {db} from '@/db/raw';
export async function locked<T>(name:string,work:()=>Promise<T>):Promise<T>{
 const token=crypto.randomUUID(),now=Date.now();
 const r=await db().prepare('INSERT INTO workforce_locks(name,token,expires) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,expires=excluded.expires WHERE workforce_locks.expires<?').bind(name,token,now+300000,now).run();
 if(!r.meta?.changes)throw Error('Another update is in progress. Please retry shortly.');
 try{return await work();}finally{await db().prepare('DELETE FROM workforce_locks WHERE name=? AND token=?').bind(name,token).run();}
}
