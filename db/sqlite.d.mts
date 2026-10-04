import type {DatabaseSync} from 'node:sqlite';
export interface Result<T=Record<string,unknown>> { success:boolean; results:T[]; meta?:{changes:number;last_row_id:number}; }
export interface Statement {
  bind(...values:(string|number|null|Uint8Array)[]):Statement;
  first<T=Record<string,unknown>>(column?:string):Promise<T|null>;
  all<T=Record<string,unknown>>():Promise<Result<T>>;
  run():Promise<Result>;
}
export interface Database {
  connection:DatabaseSync;
  prepare(sql:string):Statement;
  batch(statements:Statement[]):Promise<Result[]>;
  exec(sql:string):Promise<void>;
  close():void;
}
export function openDatabase(path:string):Database;
