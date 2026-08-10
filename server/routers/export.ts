/**
 * Export Router
 * Endpoints for generating PDF and CSV reports
 */

import { z } from 'zod';
import { protectedProcedure, router } from '../_core/trpc';
import { generateCSV, generateRevenueReport, generateEnergyReport } from '../_core/export';
import * as analyticsDb from '../analytics';

export const exportRouter = router({
  /**
   * Export revenue data as CSV
   */
  revenueCSV: protectedProcedure
    .input(z.object({
      startDate: z.string(),
      endDate: z.string(),
    }))
    .query(async ({ input, ctx }) => {
      const start = new Date(input.startDate);
      const end = new Date(input.endDate);

      const data = await analyticsDb.getRevenueData(ctx.user.id, start, end);

      const csv = generateCSV(data, ['date', 'revenue', 'transactions']);

      return {
        filename: `revenue-${input.startDate}-${input.endDate}.csv`,
        content: csv,
        mimeType: 'text/csv',
      };
    }),

  /**
   * Export energy data as CSV
   */
  energyCSV: protectedProcedure
    .input(z.object({
      startDate: z.string(),
      endDate: z.string(),
    }))
    .query(async ({ input, ctx }) => {
      const start = new Date(input.startDate);
      const end = new Date(input.endDate);

      const data = await analyticsDb.getEnergyFlowData(ctx.user.id, start, end);

      const csv = generateCSV(data, ['timestamp', 'generation', 'consumption', 'gridImport', 'gridExport']);

      return {
        filename: `energy-${input.startDate}-${input.endDate}.csv`,
        content: csv,
        mimeType: 'text/csv',
      };
    }),

  /**
   * Generate revenue report PDF
   */
  revenuePDF: protectedProcedure
    .input(z.object({
      startDate: z.string(),
      endDate: z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      const start = new Date(input.startDate);
      const end = new Date(input.endDate);

      const revenueData = await analyticsDb.getRevenueData(ctx.user.id, start, end);

      const totalRevenue = revenueData.reduce((sum, item) => sum + item.revenue, 0);
      const totalPayments = revenueData.reduce((sum, item) => sum + item.transactions, 0);
      const pendingPayments = 0; // Not available in current data structure

      const pdfBuffer = await generateRevenueReport({
        startDate: start,
        endDate: end,
        totalRevenue,
        totalPayments,
        pendingPayments,
        transactions: revenueData.map(item => ({
          date: new Date(item.date),
          amount: item.revenue,
          method: 'Trading',
          status: 'completed',
        })),
      });

      return {
        filename: `revenue-report-${input.startDate}-${input.endDate}.pdf`,
        content: pdfBuffer.toString('base64'),
        mimeType: 'application/pdf',
      };
    }),

  /**
   * Generate energy report PDF
   */
  energyPDF: protectedProcedure
    .input(z.object({
      startDate: z.string(),
      endDate: z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      const start = new Date(input.startDate);
      const end = new Date(input.endDate);

      const energyData = await analyticsDb.getEnergyFlowData(ctx.user.id, start, end);

      const totalGeneration = energyData.reduce((sum, item) => sum + item.generation, 0);
      const totalConsumption = energyData.reduce((sum, item) => sum + item.consumption, 0);
      const totalTraded = energyData.reduce((sum, item) => sum + (item.gridExport - item.gridImport), 0);

      const pdfBuffer = await generateEnergyReport({
        startDate: start,
        endDate: end,
        totalGeneration,
        totalConsumption,
        totalTraded,
        dailyData: energyData.map(item => ({
          date: new Date(item.timestamp),
          generation: item.generation,
          consumption: item.consumption,
          traded: item.gridExport - item.gridImport,
        })),
      });

      return {
        filename: `energy-report-${input.startDate}-${input.endDate}.pdf`,
        content: pdfBuffer.toString('base64'),
        mimeType: 'application/pdf',
      };
    }),
});
