import { z } from 'zod';
import { protectedProcedure, router } from '../../_core/trpc';
import { EVChargingService } from '../../services/ev-charging';

const evChargingService = new EVChargingService();

export const evChargingRouter = router({
  registerEV: protectedProcedure
    .input(z.object({
      vin: z.string().optional(),
      make: z.string().optional(),
      model: z.string().optional(),
      year: z.number().optional(),
      batteryCapacityKwh: z.number().optional(),
      usableBatteryKwh: z.number().optional(),
      maxChargingPowerKw: z.number().optional(),
      maxDischargingPowerKw: z.number().optional(),
      v2gCapable: z.boolean().optional(),
      v2hCapable: z.boolean().optional(),
      bidirectionalProtocol: z.enum(['none', 'chademo', 'ccs_v2g', 'iso15118']).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      return evChargingService.registerEV(ctx.user.id, input);
    }),

  getEV: protectedProcedure
    .input(z.object({ evId: z.number() }))
    .query(async ({ input }) => {
      return evChargingService.getEV(input.evId);
    }),

  getUserEVs: protectedProcedure
    .query(async ({ ctx }) => {
      return evChargingService.getUserEVs(ctx.user.id);
    }),

  registerStation: protectedProcedure
    .input(z.object({
      name: z.string(),
      connectorType: z.enum(['type1', 'type2', 'chademo', 'ccs1', 'ccs2', 'tesla']),
      maxPowerKw: z.number(),
      siteId: z.number().optional(),
      v2gCapable: z.boolean().optional(),
      latitude: z.number().optional(),
      longitude: z.number().optional(),
      address: z.string().optional(),
      ocppVersion: z.enum(['1.6', '2.0', '2.0.1']).optional(),
      ocppEndpoint: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      return evChargingService.registerStation({ ...input, userId: ctx.user.id });
    }),

  getStation: protectedProcedure
    .input(z.object({ stationId: z.union([z.number(), z.string()]) }))
    .query(async ({ input }) => {
      return evChargingService.getStation(input.stationId);
    }),

  startSession: protectedProcedure
    .input(z.object({
      evId: z.number(),
      stationId: z.number(),
      sessionType: z.enum(['standard_charge', 'smart_charge', 'v2g', 'v2h']).optional(),
      targetSocPercent: z.number().optional(),
      departureTime: z.date().optional(),
      maxPowerKw: z.number().optional(),
    }))
    .mutation(async ({ input }) => {
      const { evId, stationId, ...options } = input;
      return evChargingService.startSession(evId, stationId, options);
    }),

  getSession: protectedProcedure
    .input(z.object({ sessionId: z.union([z.number(), z.string()]) }))
    .query(async ({ input }) => {
      return evChargingService.getSession(input.sessionId);
    }),

  endSession: protectedProcedure
    .input(z.object({
      sessionId: z.string(),
      endSocPercent: z.number().optional(),
      totalCost: z.number().optional(),
      totalRevenue: z.number().optional(),
    }))
    .mutation(async ({ input }) => {
      const { sessionId, ...endData } = input;
      return evChargingService.endSession(sessionId, endData);
    }),

  createSmartChargingSchedule: protectedProcedure
    .input(z.object({
      sessionId: z.string(),
      objective: z.enum(['minimize_cost', 'maximize_revenue', 'minimize_emissions', 'fastest']).optional(),
      maxPowerKw: z.number().optional(),
      minSocPercent: z.number().optional(),
      mustCompleteBy: z.date().optional(),
    }))
    .mutation(async ({ input }) => {
      const { sessionId, objective, ...constraints } = input;
      return evChargingService.createSmartChargingSchedule(sessionId, { objective, constraints });
    }),

    getV2GAvailability: protectedProcedure
      .input(z.object({ communityId: z.number().optional() }).optional())
      .query(async ({ input, ctx }) => {
        return evChargingService.getV2GAvailability({ userId: ctx.user.id, communityId: input?.communityId });
      }),

    dispatchV2G: protectedProcedure
      .input(z.object({
        evId: z.number(),
        action: z.enum(['start_discharge', 'stop_discharge', 'set_power']),
        powerKw: z.number().positive().optional(),
        /**
         * How long the discharge applies. Required for discharge commands: the
         * charge point enforces the window itself, so an unbounded V2G command
         * would keep exporting after the platform stopped asking.
         */
        durationMinutes: z.number().int().min(1).max(1440).optional(),
        minSocPercent: z.number().min(0).max(100).optional(),
      }).refine(
        input => input.action === 'stop_discharge' || input.durationMinutes !== undefined,
        { message: 'durationMinutes is required for discharge commands', path: ['durationMinutes'] }
      ))
      .mutation(async ({ input, ctx }) => {
        const { evId, ...command } = input;
        return evChargingService.dispatchV2G(evId, command, ctx.user.id);
      }),
});
