/**
 * Region resolution — the single honest source for mapping a user to a grid
 * emissions/forecast region.
 *
 * Platform rule: never hardcode a region (e.g. 'NG-LAGOS') as a silent
 * default. If the user's country cannot be resolved, callers must treat
 * region-dependent data as unavailable.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { users } from '../../drizzle/schema';

/** users.country -> emissions_factors.region codes (see carbon-credits.ts). */
export const COUNTRY_TO_REGION: Record<'nigeria' | 'tanzania', string> = {
  nigeria: 'NG-LAGOS',
  tanzania: 'TZ-DAR',
};

/**
 * Resolve the grid region for a user from their real profile country.
 * Returns null when the user does not exist or the country is unmapped —
 * callers MUST handle null as "region unavailable", never substitute a
 * fabricated default.
 */
export async function resolveRegionForUser(userId: number): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const [user] = await db
    .select({ country: users.country })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return null;
  return COUNTRY_TO_REGION[user.country] ?? null;
}
