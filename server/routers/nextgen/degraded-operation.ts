import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { adminProcedure, protectedProcedure, router } from '../../_core/trpc';
import {
  DEPENDENCIES,
  DegradedOperationError,
  capabilityStatuses,
  dependencyPostures,
  guardMode,
  listObservations,
  listOpenDegradedActions,
  reconcileDegradedAction,
} from '../../services/degraded-operation';

/**
 * Operator and member view of what the platform can currently prove.
 *
 * Two audiences, two surfaces:
 *  - operators (admin) see every dependency, every guarded capability and the
 *    backlog of actions taken without full evidence, so they can see *why* a
 *    payout or bid is being refused rather than reading it as a bug;
 *  - members see only whether their own energy and money figures are currently
 *    being measured, which is the part that affects them.
 *
 * Nothing here infers health. Every field comes from a recorded observation of a
 * real call, and "no recent observation" is reported as `unknown`.
 */
function toTRPCError(error: unknown): never {
  if (error instanceof DegradedOperationError) {
    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: error.message });
  }
  throw error;
}

export const degradedOperationRouter = router({
  /** Full operator posture: dependencies, capabilities and the guard mode. */
  posture: adminProcedure.query(async () => {
    try {
      const [dependencies, capabilities] = await Promise.all([
        dependencyPostures(),
        capabilityStatuses(),
      ]);
      return {
        guardMode: guardMode(),
        dependencies,
        capabilities,
        /** Every state above came from a recorded call, not a health endpoint. */
        evidence: 'observed_calls' as const,
      };
    } catch (error) {
      toTRPCError(error);
    }
  }),

  /** Actions taken while degraded that no evidence has yet accounted for. */
  openActions: adminProcedure
    .input(z.object({ limit: z.number().int().min(1).max(500).default(100) }).optional())
    .query(async ({ input }) => {
      try {
        return { actions: await listOpenDegradedActions(input?.limit ?? 100) };
      } catch (error) {
        toTRPCError(error);
      }
    }),

  /**
   * Closes one degraded action. The note is mandatory and stored: an action is
   * reconciled by evidence an operator can point to, not by clicking a button.
   */
  reconcile: adminProcedure
    .input(z.object({ id: z.number().int().positive(), note: z.string().trim().min(10).max(2000) }))
    .mutation(async ({ input }) => {
      try {
        return await reconcileDegradedAction({ id: input.id, note: input.note });
      } catch (error) {
        toTRPCError(error);
      }
    }),

  /** Raw observation history for one dependency, for diagnosing an outage. */
  observations: adminProcedure
    .input(
      z.object({
        dependency: z.enum(DEPENDENCIES as [string, ...string[]]),
        sinceMinutes: z.number().int().min(1).max(10080).default(180),
        limit: z.number().int().min(1).max(500).default(200),
      })
    )
    .query(async ({ input }) => {
      try {
        const since = new Date(Date.now() - input.sinceMinutes * 60_000);
        return {
          observations: await listObservations(
            input.dependency as (typeof DEPENDENCIES)[number],
            since,
            input.limit
          ),
        };
      } catch (error) {
        toTRPCError(error);
      }
    }),

  /**
   * Member-facing summary. Deliberately narrow: a member does not need the
   * dependency inventory of the platform, only whether the numbers they are
   * looking at are currently being measured and settled.
   */
  memberStatus: protectedProcedure.query(async () => {
    try {
      const capabilities = await capabilityStatuses();
      const byName = new Map(capabilities.map(status => [status.capability, status]));
      const settlement = byName.get('flexibility_settlement');
      const control = byName.get('control_dispatch');
      return {
        /** Whether measured delivery can currently be turned into money. */
        settlement: {
          posture: settlement?.posture ?? 'refused',
          limitation: settlement?.evidenceLimit ?? null,
        },
        /** Whether a control sent to your asset can currently be confirmed. */
        control: {
          posture: control?.posture ?? 'refused',
          limitation: control?.evidenceLimit ?? null,
        },
      };
    } catch (error) {
      toTRPCError(error);
    }
  }),
});
