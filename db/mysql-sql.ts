/** Translate only the SQLite expressions used by the shared application queries.
 * Values remain placeholders; never interpolate data or alter quoted literals.
 * Schema DDL and mobile rate limiting use dedicated MySQL statements instead.
 */
export function mysqlSql(sql:string):string {
  if(/\bON CONFLICT\([^)]*\) DO UPDATE SET[\s\S]*\bWHERE\b/i.test(sql))
    throw Error('Conditional SQLite upsert requires an explicit MySQL implementation.');
  return sql
    .replace(/json_extract\((\w+(?:\.\w+)?),\s*('(?:[^']|'')*')\)/gi,'JSON_UNQUOTE(JSON_EXTRACT($1,$2))')
    .split(/('(?:[^']|'')*'|`[^`]*`)/g)
    .map((part,index)=>index%2?part:part
      .replace(/\bON CONFLICT\([^)]*\) DO UPDATE SET\b/gi,'ON DUPLICATE KEY UPDATE')
      .replace(/\bexcluded\.(\w+)/gi,'VALUES($1)')
      .replace(/\bjson_patch\b/gi,'JSON_MERGE_PATCH')
      .replace(/(?<!DUPLICATE )\b(key|window)\b/gi,'`$1`'))
    .join('');
}
