import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { adminProcedure, protectedProcedure, router } from '../../_core/trpc';
import { DigitalTwinError, getDigitalTwin } from '../../services/digital-twin';

/**
 * A twin that cannot be built is an outage (the database is down or the
 * registry is corrupt), so it maps to SERVICE_UNAVAILABLE — never to an empty
 * or partially fabricated graph.
 */
export function toTRPCError(error: unknown): never {
  if (error instanceof DigitalTwinError) {
    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: error.message });
  }
  throw error;
}

export const digitalTwinRouter = router({
  /**
   * The caller's own equipment.
   *
   * Scoped to `ctx.user.id` rather than an input: a twin is a detailed picture of
   * a household's equipment and consumption, so no participant may ask for
   * another's by passing an id.
   */
  mine: protectedProcedure.query(async ({ ctx }) => {
    try {
      return await getDigitalTwin({ userId: ctx.user.id }, 'My site');
    } catch (error) {
      toTRPCError(error);
    }
  }),

  /** Any participant's equipment, or the whole fleet. Operator view. */
  scoped: adminProcedure
    .input(z.object({ userId: z.number().int().positive().optional() }))
    .query(async ({ input }) => {
      try {
        return await getDigitalTwin(
          { userId: input.userId },
          input.userId === undefined ? 'Fleet' : `Participant ${input.userId}`
        );
      } catch (error) {
        toTRPCError(error);
      }
    }),
});
