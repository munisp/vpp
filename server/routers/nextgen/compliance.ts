import { z } from 'zod';
import { protectedProcedure, router } from '../../_core/trpc';
import { complianceAutomation } from '../../services/compliance-automation';

export const complianceRouter = router({
  getActiveRules: protectedProcedure
    .input(z.object({ jurisdiction: z.string().default('NG') }).optional())
    .query(async ({ input }) => {
      return complianceAutomation.getActiveRules(input?.jurisdiction || 'NG');
    }),

  runComplianceCheck: protectedProcedure
    .input(z.object({
      ruleId: z.number(),
      scopeType: z.enum(['user', 'asset', 'community', 'platform']),
      scopeId: z.number().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      return complianceAutomation.runComplianceCheck(
        input.ruleId,
        { type: input.scopeType, id: input.scopeId || ctx.user.id }
      );
    }),

    getComplianceSummary: protectedProcedure
      .input(z.object({
        scopeType: z.enum(['user', 'asset', 'community', 'platform']).default('user'),
        scopeId: z.number().optional(),
        jurisdiction: z.string().default('NG'),
      }).optional())
      .query(async ({ input, ctx }) => {
        return complianceAutomation.getComplianceSummary(
          { type: input?.scopeType || 'user', id: input?.scopeId || ctx.user.id },
          input?.jurisdiction || 'NG'
        );
      }),

  generateComplianceReport: protectedProcedure
    .input(z.object({
      jurisdiction: z.string(),
      periodStart: z.date(),
      periodEnd: z.date(),
      reportType: z.enum(['periodic', 'incident', 'audit', 'regulatory_filing']).default('periodic'),
    }))
    .mutation(async ({ input }) => {
      return complianceAutomation.generateComplianceReport(
        input.jurisdiction,
        input.periodStart,
        input.periodEnd,
        input.reportType
      );
    }),

  initializeJurisdictionRules: protectedProcedure
    .input(z.object({ jurisdiction: z.string() }))
    .mutation(async ({ input }) => {
      return complianceAutomation.initializeJurisdictionRules(input.jurisdiction);
    }),
});
