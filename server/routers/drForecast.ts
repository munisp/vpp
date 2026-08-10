import { z } from 'zod';
import { router, protectedProcedure, adminProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import { drForecast } from '../services/dr-forecast';

/**
 * DR event forecasting + participant recommendation router.
 * Forecasts are computed from real demandResponseEvents history, telemetry
 * demand trend, and (when available) real weather forecasts — rows are marked
 * weatherUsed=false when weather data was unavailable.
 */
export const drForecastRouter = router({
  /**
   * 7-day (default) DR-event likelihood forecast. Persists forecast rows.
   */
  getEventForecast: protectedProcedure
    .input(z.object({
      days: z.number().int().min(1).max(14).default(7),
      lat: z.number().min(-90).max(90).optional(),
      lon: z.number().min(-180).max(180).optional(),
    }))
    .query(async ({ input }) => {
      try {
        const location = input.lat !== undefined && input.lon !== undefined
          ? { lat: input.lat, lon: input.lon }
          : undefined;
        const forecast = await drForecast.getEventForecast(input.days, location);
        return { forecast, count: forecast.length };
      } catch (error: any) {
        console.error('[DrForecast] getEventForecast error:', error);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message || 'Failed to compute event forecast' });
      }
    }),

  /**
   * Recent persisted forecast rows (audit trail).
   */
  listForecasts: protectedProcedure
    .input(z.object({ limit: z.number().int().positive().max(60).default(14) }))
    .query(async ({ input }) => {
      try {
        const forecasts = await drForecast.listForecasts(input.limit);
        return { forecasts, count: forecasts.length };
      } catch (error: any) {
        console.error('[DrForecast] listForecasts error:', error);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to list forecasts' });
      }
    }),

  /**
   * Rank and persist an optimal participant set for a forecast/planned event (admin).
   */
  recommendParticipants: adminProcedure
    .input(z.object({
      targetReductionKw: z.number().positive(),
      eventId: z.number().int().positive().optional(),
      forecastId: z.number().int().positive().optional(),
      eventDate: z.coerce.date().optional(),
      maxParticipants: z.number().int().positive().max(500).optional(),
    }))
    .mutation(async ({ input }) => {
      try {
        return await drForecast.recommendParticipants(input);
      } catch (error: any) {
        console.error('[DrForecast] recommendParticipants error:', error);
        throw new TRPCError({ code: 'BAD_REQUEST', message: error.message || 'Failed to recommend participants' });
      }
    }),

  /**
   * Record the observed outcome of a recommendation (feedback loop, admin).
   */
  recordRecommendationOutcome: adminProcedure
    .input(z.object({
      recommendationId: z.number().int().positive(),
      outcome: z.enum(['participated', 'no_show', 'declined']),
    }))
    .mutation(async ({ input }) => {
      try {
        const recommendation = await drForecast.recordRecommendationOutcome(input.recommendationId, input.outcome);
        return { success: true, recommendation };
      } catch (error: any) {
        console.error('[DrForecast] recordRecommendationOutcome error:', error);
        throw new TRPCError({ code: 'BAD_REQUEST', message: error.message || 'Failed to record outcome' });
      }
    }),

  /**
   * List persisted recommendations (admin), optionally scoped to an event or forecast.
   */
  listRecommendations: adminProcedure
    .input(z.object({
      eventId: z.number().int().positive().optional(),
      forecastId: z.number().int().positive().optional(),
      limit: z.number().int().positive().max(500).default(100),
    }))
    .query(async ({ input }) => {
      try {
        const recommendations = await drForecast.listRecommendations(
          { eventId: input.eventId, forecastId: input.forecastId },
          input.limit
        );
        return { recommendations, count: recommendations.length };
      } catch (error: any) {
        console.error('[DrForecast] listRecommendations error:', error);
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to list recommendations' });
      }
    }),
});
