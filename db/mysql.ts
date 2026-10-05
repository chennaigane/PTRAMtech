import mysql,{type PoolConnection,type PoolOptions,type RowDataPacket,type ResultSetHeader} from 'mysql2/promise';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {mysqlSchema,mysqlBackfill} from '@/db/mysql-schema';
import {mysqlSql} from '@/db/mysql-sql';
import {DatabaseUnavailableError} from '@/db/errors';
import type {Database,Result,Statement} from './types';

export function openMySQL(options:PoolOptions):Database {
  const pool=mysql.createPool(options);
  const context=new AsyncLocalStorage<{connection:PoolConnection;transaction:boolean}>();
  const lockName=(name:string)=>createHash('sha256').update(`${options.database}:fieldora:${name}`).digest('hex');
  let ready:Promise<void>|undefined;
  async function connection(){
    try{return await pool.getConnection();}
    catch(cause){throw new DatabaseUnavailableError('Unable to connect to managed MySQL. Check DB_* settings and database availability.',{cause});}
  }
  async function initialize(){
    ready??=(async()=>{
      const c=await connection();let acquired=false;
      try{
        const [rows]=await c.query<RowDataPacket[]>('SELECT GET_LOCK(?,30) AS acquired',[lockName('schema')]);
        if(Number(rows[0].acquired)!==1)throw Error('Database initialization is busy. Retry shortly.');
        acquired=true;
        // MySQL DDL commits implicitly: execute it outside application transactions.
        for(const sql of mysqlSchema)await c.query(sql);
        await c.query(mysqlBackfill);
        await c.query("UPDATE users SET role='Employee' WHERE role='Representative'");
      }finally{try{if(acquired)await c.query('SELECT RELEASE_LOCK(?)',[lockName('schema')]);}finally{c.release();}}
    })().catch(error=>{ready=undefined;throw error;});
    await ready;
  }
  async function execute(sql:string,values:unknown[]):Promise<Result> {
    await initialize();
    const existing=context.getStore()?.connection,c=existing||await connection();
    try{
      const [result]=await c.query(mysqlSql(sql),values);
      if(Array.isArray(result))return {success:true,results:result as Record<string,unknown>[]};
      const header=result as ResultSetHeader;
      return {success:true,results:[],meta:{changes:header.affectedRows,last_row_id:header.insertId}};
    }catch(error){
      if((error as {code?:string}).code==='ER_DUP_ENTRY')throw Object.assign(new Error('UNIQUE constraint failed.',{cause:error}),{code:'ER_DUP_ENTRY'});
      throw error;
    }finally{if(!existing)c.release();}
  }
  class MySQLStatement implements Statement {
    constructor(readonly sql:string,readonly values:unknown[]=[]){ }
    bind(...values:(string|number|null|Uint8Array)[]){return new MySQLStatement(this.sql,values.map(v=>v instanceof Uint8Array?Buffer.from(v):v));}
    async first<T=Record<string,unknown>>(column?:string):Promise<T|null>{const r=await execute(this.sql,this.values),row=r.results[0];return row?(column===undefined?row:row[column]??null) as T:null;}
    async all<T=Record<string,unknown>>():Promise<Result<T>>{return await execute(this.sql,this.values) as Result<T>;}
    async run(){return execute(this.sql,this.values);}
  }
  async function transaction<T>(work:()=>Promise<T>):Promise<T>{
    await initialize();const existing=context.getStore();
    if(existing?.transaction)return work();
    const c=existing?.connection||await connection();
    try{
      await c.beginTransaction();
      try{const result=await context.run({connection:c,transaction:true},work);await c.commit();return result;}
      catch(error){await c.rollback();throw error;}
    }finally{if(!existing)c.release();}
  }
  async function withLock<T>(name:string,work:()=>Promise<T>):Promise<T>{
    await initialize();const existing=context.getStore(),c=existing?.connection||await connection();let acquired=false;
    try{
      const [rows]=await c.query<RowDataPacket[]>('SELECT GET_LOCK(?,0) AS acquired',[lockName(name)]);
      if(Number(rows[0].acquired)!==1)throw Error('Another update is in progress. Please retry shortly.');
      acquired=true;
      return await context.run({connection:c,transaction:existing?.transaction||false},work);
    }finally{try{if(acquired)await c.query('SELECT RELEASE_LOCK(?)',[lockName(name)]);}finally{if(!existing)c.release();}}
  }
  return {dialect:'mysql',initialize,transaction,withLock,
    prepare:sql=>new MySQLStatement(sql),
    batch:statements=>transaction(async()=>{
      if(statements.some(s=>!(s instanceof MySQLStatement)))throw Error('Batch statements must use this database');
      const results:Result[]=[];for(const s of statements)results.push(await s.run());return results;
    }),
    exec:async sql=>{await execute(sql,[]);},
    close:()=>pool.end(),
  };
}
