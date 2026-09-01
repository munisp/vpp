import { z } from 'zod';
import { adminProcedure, protectedProcedure, router } from '../../_core/trpc';
import { complianceAutomation } from '../../services/compliance-automation';

/**
 * Compliance automation router.
 *
 * Running checks, reading summaries, generating reports and seeding
 * jurisdiction rules are regulatory operations over the whole platform's
 * evidence, so they are admin-only (same guard as the other admin routers).
 * Reading the active rule set for a jurisdiction stays authenticated-only:
 * the rules themselves are public regulatory texts.
 */
export const complianceRouter = router({
  getActiveRules: protectedProcedure
    .input(z.object({ jurisdiction: z.string().default('NG') }).optional())
    .query(async ({ input }) => {
      return complianceAutomation.getActiveRules(input?.jurisdiction || 'NG');
    }),

  runComplianceCheck: adminProcedure
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

  getComplianceSummary: adminProcedure
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

  generateComplianceReport: adminProcedure
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

  initializeJurisdictionRules: adminProcedure
    .input(z.object({ jurisdiction: z.string() }))
    .mutation(async ({ input }) => {
      return complianceAutomation.initializeJurisdictionRules(input.jurisdiction);
    }),
});
