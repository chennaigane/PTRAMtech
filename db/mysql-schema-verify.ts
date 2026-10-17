import type {PoolConnection,RowDataPacket} from 'mysql2/promise';
// Metadata-only prerequisite checks. Never create tables, alter columns or backfill data.
export const requiredColumns:Record<string,string[]>={
 users:['id','phone','name','role','team','password_hash','status','failed_attempts','locked_until','created','reviewed_by','reviewed_at'],
 sessions:['token_hash','user_id','expires'],records:['id','owner','kind','data','created'],settings:['key','value'],
 workforce_profiles:['employee','data'],workforce_entries:['id','kind','employee','date','data','updated'],
 workforce_audit:['id','actor','action','target','details','created'],workforce_locks:['name','token','expires'],
 mobile_trips:['id','account','started_at','capture_until','upload_until','last_seq','last_time','last_elapsed','request_id','session_hash','stopped_at'],
 mobile_points:['trip','seq','payload'],mobile_sessions:['token_hash','account','expires'],mobile_limits:['key','window','count']
};
export const requiredUnique:Record<string,string[][]>={users:[['id'],['phone']],sessions:[['token_hash']],records:[['id']],settings:[['key']],workforce_profiles:[['employee']],workforce_entries:[['id']],workforce_audit:[['id']],workforce_locks:[['name']],mobile_trips:[['id'],['account','request_id']],mobile_points:[['trip','seq']],mobile_sessions:[['token_hash']],mobile_limits:[['key']]};
export async function verifyMySQLSchema(c:Pick<PoolConnection,'query'>){
 const [tables]=await c.query<RowDataPacket[]>('SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
 const [columns]=await c.query<RowDataPacket[]>('SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()');
 const [indexes]=await c.query<RowDataPacket[]>('SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,SUB_PART FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()');
 const problems:string[]=[];
 for(const [table,names] of Object.entries(requiredColumns)){
  if(!tables.some(t=>t.TABLE_NAME===table&&String(t.ENGINE).toLowerCase()==='innodb'))problems.push(table+': requires existing InnoDB table');
  for(const name of names)if(!columns.some(c=>c.TABLE_NAME===table&&c.COLUMN_NAME===name))problems.push(table+'.'+name+': missing column');
  const unique=new Map<string,RowDataPacket[]>();
  for(const i of indexes.filter(i=>i.TABLE_NAME===table&&Number(i.NON_UNIQUE)===0&&i.SUB_PART==null)){const group=unique.get(i.INDEX_NAME)||[];group.push(i);unique.set(i.INDEX_NAME,group);}
  const keys=[...unique.values()].map(group=>group.sort((a,b)=>Number(a.SEQ_IN_INDEX)-Number(b.SEQ_IN_INDEX)).map(i=>i.COLUMN_NAME).join(','));
  for(const key of requiredUnique[table])if(!keys.includes(key.join(',')))problems.push(table+': missing full unique key ('+key.join(',')+')');
 }
 if(problems.length)throw Error('Schema verification failed; no migration was attempted. '+problems.join('; '));
}
