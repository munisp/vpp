/**
 * The filled quantity shown against a resting order decides what a trader
 * believes is still for sale. It was computed with the outer order's id
 * interpolated as a Drizzle column reference, which renders unqualified: inside
 * the subquery `"id"` resolved to `p2p_matches.id`, so every order was credited
 * with the fills of an unrelated match row.
 *
 * The generated SQL is asserted rather than the TypeScript, because the defect
 * only existed in what Drizzle emitted.
 */

import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { filledEnergySql } from './services/p2p-matching';

describe('order-book filled quantity', () => {
  it('correlates the match subquery against the outer trade', () => {
    const { sql } = new PgDialect().sqlToQuery(filledEnergySql.getSQL());

    expect(sql).toContain('m."buyOrderId" = "trades"."id"');
    expect(sql).toContain('m."sellOrderId" = "trades"."id"');
    // An unqualified reference is what bound to p2p_matches.id.
    expect(sql).not.toMatch(/=\s*"id"/);
  });
});
