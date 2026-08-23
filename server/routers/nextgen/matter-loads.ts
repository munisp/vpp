import { TRPCError } from '@trpc/server';

import { adminProcedure, router } from '../../_core/trpc';
import { GridProtocolError } from '../../services/grid-protocol-ingest';
import { listMatterNodes } from '../../services/matter-ingest';

/**
 * Matter fabric read surface.
 *
 * Admin-only: the node inventory is a list of the appliances inside people's
 * homes, and the attribute values are what those appliances are doing.
 *
 * This returns platform state — what the controller last reported — and says so.
 * Live controller state (which windows are currently held, whether the controller
 * is even connected) lives in the Go service and is not inferred here: a stale
 * inventory rendered as current is how an operator ends up believing a load is
 * under control when the controller has been down for a day.
 */
export const matterLoadsRouter = router({
  nodes: adminProcedure.query(async () => {
    try {
      const nodes = await listMatterNodes();
      return {
        nodes,
        /** Every field above is the controller's last report, not a live read. */
        evidence: 'controller_reported' as const,
        lastReportedAt:
          nodes.length > 0
            ? nodes.reduce<Date>(
                (latest, node) =>
                  node.lastReportedAt > latest ? node.lastReportedAt : latest,
                nodes[0].lastReportedAt
              )
            : null,
      };
    } catch (error) {
      if (error instanceof GridProtocolError) {
        throw new TRPCError({
          code: error.status === 503 ? 'SERVICE_UNAVAILABLE' : 'BAD_REQUEST',
          message: error.message,
        });
      }
      throw error;
    }
  }),
});
