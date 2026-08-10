import { z } from 'zod';
import { protectedProcedure, router } from '../../_core/trpc';
import { edgeOrchestration } from '../../services/edge-orchestration';

export const edgeRouter = router({
    registerGateway: protectedProcedure
      .input(z.object({
        gatewayId: z.string(),
        name: z.string(),
        siteId: z.number().optional(),
        communityId: z.number().optional(),
        hardwareModel: z.string().optional(),
        firmwareVersion: z.string().optional(),
        primaryProtocol: z.enum(['mqtt', 'grpc', 'https']).default('mqtt'),
        connectionEndpoint: z.string().optional(),
        canOperateOffline: z.boolean().default(true),
        localStorageCapacityMb: z.number().optional(),
        maxManagedDevices: z.number().optional(),
      }))
      .mutation(async ({ input }) => {
        const { gatewayId, name, ...options } = input;
        return edgeOrchestration.registerGateway(gatewayId, name, options);
      }),

  getGateways: protectedProcedure
    .input(z.object({
      siteId: z.number().optional(),
      communityId: z.number().optional(),
    }).optional())
    .query(async ({ input }) => {
      return edgeOrchestration.getGateways(input || {});
    }),

    queueCommand: protectedProcedure
      .input(z.object({
        gatewayId: z.string(),
        commandType: z.enum(['set_power', 'set_soc_target', 'start_charging', 'stop_charging', 'enable_v2g', 'disable_v2g', 'emergency_stop', 'update_config']),
        targetDeviceId: z.number().optional(),
        targetAssetId: z.number().optional(),
        payload: z.record(z.string(), z.any()),
        priority: z.number().default(5),
        validForSeconds: z.number().default(300),
        idempotencyKey: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const { gatewayId, ...command } = input;
        return edgeOrchestration.queueCommand(gatewayId, command);
      }),

  getCommand: protectedProcedure
    .input(z.object({ commandId: z.union([z.number(), z.string()]) }))
    .query(async ({ input }) => {
      return edgeOrchestration.getCommand(input.commandId);
    }),

  getGatewayHealth: protectedProcedure
    .input(z.object({ gatewayId: z.string() }))
    .query(async ({ input }) => {
      return edgeOrchestration.getGatewayHealth(input.gatewayId);
    }),

  emergencyStop: protectedProcedure
    .input(z.object({ gatewayId: z.string(), reason: z.string() }))
    .mutation(async ({ input }) => {
      return edgeOrchestration.emergencyStop(input.gatewayId, input.reason);
    }),
});
