import { sql, type SQL } from 'drizzle-orm';

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A value to write into a JSON document; `{ json }` inserts a JSON document verbatim. */
export type JsonSetValue = string | number | boolean | null | undefined | { json: string };

/**
 * Postgres equivalent of MySQL's `JSON_SET` over a `text` column that stores a
 * JSON document: merges the given paths into the document and returns text
 * again, so the column type does not have to change. Keys may be dotted paths
 * (`"pendingTransition.status"`).
 *
 * A JS `null`/`undefined` value is written as JSON `null` (MySQL's behaviour);
 * Postgres' `jsonb_set` would otherwise collapse the whole document to NULL.
 *
 * Unlike `JSON_SET`, `jsonb_set` only creates the *last* path segment, so a
 * dotted path whose parent is absent would silently write nothing. Missing
 * ancestors are therefore materialised as empty objects first.
 */
export function jsonSetText(
  column: SQL,
  entries: Record<string, JsonSetValue>
): SQL {
  let expr = sql`COALESCE(${column}, '{}')::jsonb`;

  for (const [key, value] of Object.entries(entries)) {
    const segments = key.split('.');
    if (!segments.every(segment => KEY_PATTERN.test(segment))) {
      throw new Error(`Unsafe JSON path for jsonSetText: ${key}`);
    }
    const path = sql.raw(`'{${segments.join(',')}}'`);

    // Each ancestor guard repeats the accumulated expression, so the SQL grows
    // exponentially with path depth; two levels covers every current call site.
    if (segments.length > 2) {
      throw new Error(`JSON path too deep for jsonSetText: ${key}`);
    }
    for (let depth = 1; depth < segments.length; depth++) {
      const ancestor = sql.raw(`'{${segments.slice(0, depth).join(',')}}'`);
      expr = sql`CASE WHEN jsonb_typeof(${expr} #> ${ancestor}) = 'object'
        THEN ${expr} ELSE jsonb_set(${expr}, ${ancestor}, '{}'::jsonb, true) END`;
    }

    let valueExpr: SQL;
    if (value === null || value === undefined) {
      valueExpr = sql`'null'::jsonb`;
    } else if (typeof value === 'number') {
      valueExpr = sql`to_jsonb(${value}::numeric)`;
    } else if (typeof value === 'boolean') {
      valueExpr = sql`to_jsonb(${value}::boolean)`;
    } else if (typeof value === 'object') {
      valueExpr = sql`${value.json}::jsonb`;
    } else {
      valueExpr = sql`to_jsonb(${value}::text)`;
    }
    expr = sql`jsonb_set(${expr}, ${path}, ${valueExpr}, true)`;
  }

  return sql`(${expr})::text`;
}
