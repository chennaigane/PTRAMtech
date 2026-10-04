import {DatabaseSync} from 'node:sqlite';
import {mkdirSync, lstatSync, chmodSync, existsSync} from 'node:fs';
import {dirname, isAbsolute} from 'node:path';

class Statement {
  constructor(owner, sql, values = []) { this.owner = owner; this.sql = sql; this.values = values.map(v => v instanceof Uint8Array ? Buffer.from(v) : v); }
  bind(...values) { return new Statement(this.owner, this.sql, values); }
  statement() { return this.owner.connection.prepare(this.sql); }
  async first(column) {
    const row = this.statement().get(...this.values);
    return row ? (column === undefined ? row : row[column] ?? null) : null;
  }
  async all() { return {success:true, results:this.statement().all(...this.values)}; }
  async run() { return this.execute(); }
  execute() {
    // .columns() was added after Node 22.13; .all() supports both writes and reads.
    const connection=this.owner.connection;
    const before=connection.prepare('SELECT total_changes() AS n').get().n;
    const results=this.statement().all(...this.values);
    const meta=connection.prepare('SELECT total_changes() AS total,changes() AS changes,last_insert_rowid() AS last_row_id').get();
    return {success:true,results,meta:{changes:meta.total===before?0:Number(meta.changes),last_row_id:Number(meta.last_row_id)}};
  }
}

/** Small compatibility surface for the supplied .prepare().bind() callers.
 * One Node process owns this connection. Batch executes without asynchronous gaps.
 * This is not a full implementation of the D1 API.
 */
export function openDatabase(path) {
  if (path !== ':memory:') {
    if (!isAbsolute(path)) throw Error('DATABASE_PATH must be absolute');
    mkdirSync(dirname(path), {recursive:true, mode:0o700});
    if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw Error('Database must be a regular file');
  }
  const connection = new DatabaseSync(path, {enableForeignKeyConstraints:true, allowExtension:false});
  try {
    if (path !== ':memory:') chmodSync(path, 0o600);
    connection.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;');
  } catch (error) { connection.close(); throw error; }
  const owner = {
    connection,
    prepare(sql) { return new Statement(owner, sql); },
    async batch(statements) {
      if (statements.some(s => !(s instanceof Statement) || s.owner !== owner)) throw Error('Batch statements must use this database');
      connection.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(s => s.execute());
        connection.exec('COMMIT'); return results;
      } catch (error) { connection.exec('ROLLBACK'); throw error; }
    },
    async exec(sql) { connection.exec(sql); },
    close() { connection.close(); }
  };
  return owner;
}
