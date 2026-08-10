import { z } from 'zod';
import { protectedProcedure, router } from '../../_core/trpc';
import { blockchainAudit } from '../../services/blockchain-audit';

export const blockchainRouter = router({
  anchorSettlementPeriod: protectedProcedure
        .input(z.object({ periodId: z.number() }))
        .mutation(async ({ input }) => {
          return blockchainAudit.anchorSettlementPeriod(input.periodId);
    }),

  anchorCarbonCredit: protectedProcedure
        .input(z.object({ creditId: z.number() }))
        .mutation(async ({ input }) => {
          return blockchainAudit.anchorCarbonCredit(input.creditId);
    }),

  anchorComplianceReport: protectedProcedure
    .input(z.object({ reportId: z.string() }))
    .mutation(async ({ input }) => {
      return blockchainAudit.anchorComplianceReport(input.reportId);
    }),

  verifyAnchor: protectedProcedure
    .input(z.object({ anchorId: z.number() }))
    .query(async ({ input }) => {
      return blockchainAudit.verifyAnchor(input.anchorId);
    }),

  getAnchor: protectedProcedure
    .input(z.object({ anchorId: z.number() }))
    .query(async ({ input }) => {
      return blockchainAudit.getAnchor(input.anchorId);
    }),

  getAnchorsForSource: protectedProcedure
    .input(z.object({
      anchorType: z.enum(['settlement_period', 'settlement_event', 'carbon_credit', 'compliance_report']),
          sourceId: z.number(),
        }))
        .query(async ({ input }) => {
          return blockchainAudit.getAnchorsForSource(input.anchorType, input.sourceId);
    }),

  isEnabled: protectedProcedure
    .query(async () => {
      const enabled = blockchainAudit.isEnabled();
      const providerInfo = blockchainAudit.getProviderInfo();
      return { enabled, provider: providerInfo };
    }),

  processPendingAnchors: protectedProcedure
    .mutation(async () => {
      await blockchainAudit.processPendingAnchors();
      return { success: true };
    }),
});
