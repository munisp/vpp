/**
 * Stakeholder journeys over tRPC.
 *
 * Starting a journey dispatches a real Temporal workflow. If Temporal is not
 * reachable the procedure fails loudly: a journey suite that reported "started"
 * without a workflow behind it would be exactly the mockware these journeys
 * exist to catch. Reading runs needs no Temporal, because the run record lives
 * in PostgreSQL — so a report is readable long after the workflow has aged out
 * of the cluster's retention.
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { adminProcedure, protectedProcedure, router } from '../_core/trpc';
import { NAV_GROUPS } from '../../client/src/lib/nav';
import { MOBILE_NAV_GROUPS } from '../../shared/mobile-nav';
import {
  JOURNEYS,
  catalogDependencies,
  journeyById,
  mobileScreenCoverage,
  navCoverage,
  suiteSummary,
} from '../../shared/journeys';
import { getTemporalClient, TASK_QUEUES } from '../integration/temporal-config';
import { missingImplementations } from '../journeys/registry';
import {
  getRunByKey,
  latestRunPerJourney,
  listRuns,
} from '../services/journey-runs';

const webPaths = NAV_GROUPS.flatMap(group => group.items.map(item => item.path));
const mobileScreens = MOBILE_NAV_GROUPS.flatMap(group => group.items.map(item => item.screen));

const journeyIdSchema = z.enum(
  JOURNEYS.map(journey => journey.id) as [string, ...string[]]
);

function runKeyFor(journeyId: string, label: string): string {
  return `${journeyId}:${label}`;
}

async function startWorkflow(
  workflowType: string,
  workflowId: string,
  args: unknown[]
): Promise<{ workflowId: string; runId: string }> {
  let client;
  try {
    client = await getTemporalClient();
  } catch (error) {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message:
        'No Temporal server is reachable, so no journey was started. Journeys run as durable workflows; nothing is executed locally in its place.',
      cause: error,
    });
  }
  try {
    const handle = await client.workflow.start(workflowType, {
      taskQueue: TASK_QUEUES.JOURNEYS,
      workflowId,
      args,
    });
    return { workflowId: handle.workflowId, runId: handle.firstExecutionRunId };
  } catch (error) {
    // A duplicate workflow id means this exact run is already in flight, which
    // is the idempotency the journeys are supposed to have.
    throw new TRPCError({
      code: 'CONFLICT',
      message: `Journey workflow '${workflowId}' could not be started: ${
        error instanceof Error ? error.message : String(error)
      }`,
      cause: error,
    });
  }
}

export const journeysRouter = router({
  /** The catalog itself, so both apps render the same journeys. */
  catalog: protectedProcedure.query(() => ({
    journeys: JOURNEYS,
    dependencies: catalogDependencies(),
    unimplementedSteps: missingImplementations(),
  })),

  /** Route and screen coverage, computed from each app's own navigation. */
  coverage: protectedProcedure.query(() => ({
    web: navCoverage(webPaths),
    mobile: mobileScreenCoverage(mobileScreens),
  })),

  start: adminProcedure
    .input(
      z.object({
        journeyId: journeyIdSchema,
        label: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
        memberUserId: z.number().int().positive(),
        counterpartyUserId: z.number().int().positive().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const journey = journeyById(input.journeyId);
      if (!journey) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `No journey "${input.journeyId}".` });
      }
      const runKey = runKeyFor(input.journeyId, input.label);
      const started = await startWorkflow('runJourneyWorkflow', `journey-${runKey}`, [
        {
          journeyId: input.journeyId,
          runKey,
          memberUserId: input.memberUserId,
          adminUserId: ctx.user.id,
          counterpartyUserId: input.counterpartyUserId,
        },
      ]);
      return { runKey, ...started };
    }),

  startSuite: adminProcedure
    .input(
      z.object({
        label: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
        memberUserId: z.number().int().positive(),
        counterpartyUserId: z.number().int().positive().optional(),
        journeyIds: z.array(journeyIdSchema).min(1).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const started = await startWorkflow('runJourneySuiteWorkflow', `journey-suite-${input.label}`, [
        {
          suiteRunKey: input.label,
          memberUserId: input.memberUserId,
          adminUserId: ctx.user.id,
          counterpartyUserId: input.counterpartyUserId,
          journeyIds: input.journeyIds,
        },
      ]);
      return { suiteRunKey: input.label, ...started };
    }),

  /**
   * Run records carry another member's asset, offer and payment identifiers, so
   * reading them is an operator act even though a journey is run on a member's
   * behalf. The catalog and coverage above are metadata and stay readable.
   */
  run: adminProcedure
    .input(z.object({ runKey: z.string().min(1).max(160) }))
    .query(async ({ input }) => {
      const run = await getRunByKey(input.runKey);
      if (!run) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `No run "${input.runKey}".` });
      }
      return run;
    }),

  runs: adminProcedure
    .input(
      z
        .object({
          journeyId: journeyIdSchema.optional(),
          limit: z.number().int().positive().max(200).default(50),
        })
        .optional()
    )
    .query(async ({ input }) => ({
      runs: await listRuns(input?.limit ?? 50, input?.journeyId),
    })),

  /**
   * The report: the latest run of each journey and the score derived from it.
   * The score counts only steps that could be exercised; steps blocked on a
   * provider nobody has credentials for are reported separately rather than
   * being counted as passes.
   */
  report: adminProcedure
    .input(z.object({ suiteRunKey: z.string().min(1).max(160).optional() }).optional())
    .query(async ({ input }) => {
      const runs = await latestRunPerJourney(input?.suiteRunKey);
      return {
        suiteRunKey: input?.suiteRunKey ?? null,
        runs,
        summary: suiteSummary(runs.map(run => ({ journeyId: run.journeyId, steps: run.steps }))),
        unimplementedSteps: missingImplementations(),
      };
    }),
});
