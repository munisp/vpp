/**
 * Row shape for raw SQL queries run through Drizzle's `execute` helper.
 *
 * node-postgres decodes column values at runtime from the wire format, so a raw
 * query's columns cannot be inferred statically the way a Drizzle select can.
 * Call sites that need compile-time safety should pass their own row type as the
 * type argument instead of using this alias.
 */
export type SqlRow = Record<string, any>;
