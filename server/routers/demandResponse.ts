import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import * as drDb from '../dr-db';
import * as notifications from '../_core/notifications';
import { kafkaPublisher } from '../integration/kafka-publisher';
import { temporalClient } from '../integration/temporal-client';

// Admin-only procedure
const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== 'admin') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin access required' });
  }
  return next({ ctx });
});

export const demandResponseRouter = router({
  // Consumer procedures
  enroll: protectedProcedure
    .input(z.object({
      autoOptIn: z.boolean().default(true),
      minCompensation: z.number().int().positive().optional(),
      maxReduction: z.number().int().positive().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Check if already enrolled
      const existing = await drDb.getDRParticipant(ctx.user.id);
      if (existing) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Already enrolled in demand response program',
        });
      }
      
      await drDb.enrollUserInDR({
        userId: ctx.user.id,
        autoOptIn: input.autoOptIn,
        minCompensation: input.minCompensation,
        maxReduction: input.maxReduction,
        status: 'active',
      });
      
      return { success: true };
    }),
  
  getEnrollment: protectedProcedure
    .query(async ({ ctx }) => {
      const participant = await drDb.getDRParticipant(ctx.user.id);
      return participant || null;
    }),
  
  updateEnrollment: protectedProcedure
    .input(z.object({
      autoOptIn: z.boolean().optional(),
      minCompensation: z.number().int().positive().optional(),
      maxReduction: z.number().int().positive().optional(),
      status: z.enum(['active', 'paused', 'cancelled']).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await drDb.updateDRParticipant(ctx.user.id, input);
      return { success: true };
    }),
  
  getUpcomingEvents: protectedProcedure
    .query(async () => {
      const events = await drDb.getDREvents({
        status: 'scheduled',
        startAfter: new Date(),
      });
      return events;
    }),
  
  respondToEvent: protectedProcedure
    .input(z.object({
      eventId: z.number().int().positive(),
      participate: z.boolean(),
      targetReduction: z.number().int().positive().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const event = await drDb.getDREventById(input.eventId);
      if (!event) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found' });
      }
      
      await drDb.createDRResponse({
        eventId: input.eventId,
        userId: ctx.user.id,
        participationStatus: input.participate ? 'opted_in' : 'opted_out',
        targetReduction: input.targetReduction,
      });
      
      return { success: true };
    }),
  
  getMyResponses: protectedProcedure
    .query(async ({ ctx }) => {
      const responses = await drDb.getUserDRResponses(ctx.user.id);
      return responses;
    }),
  
  getMyCompensation: protectedProcedure
    .query(async ({ ctx }) => {
      const compensation = await drDb.getUserDRCompensation(ctx.user.id);
      return compensation;
    }),
  
  getMyAnalytics: protectedProcedure
    .query(async ({ ctx }) => {
      const analytics = await drDb.getDRAnalytics(ctx.user.id);
      return analytics;
    }),
  
  // Admin/Grid Operator procedures
  createEvent: adminProcedure
    .input(z.object({
      eventName: z.string(),
      eventType: z.enum(['peak_shaving', 'load_shifting', 'emergency', 'economic']),
      targetReduction: z.number().int().positive(),
      startTime: z.date(),
      endTime: z.date(),
      compensationRate: z.number().int().positive(),
    }))
    .mutation(async ({ ctx, input }) => {
      const eventId = await drDb.createDREvent({
        operatorId: ctx.user.id,
        ...input,
        status: 'scheduled',
      });

      // Publish Kafka event for DR event creation
      await kafkaPublisher.publishDREventCreated({
        eventId: eventId.toString(),
        type: input.eventType,
        targetReduction: input.targetReduction,
        startTime: input.startTime,
        endTime: input.endTime,
        compensationRate: input.compensationRate,
      }).catch(err => console.error('[Kafka] Failed to publish DR event created:', err));

      // Start Temporal workflow for DR event orchestration
      try {
        await temporalClient.startDREventWorkflow({
          eventId: eventId.toString(),
          type: input.eventType,
          targetReduction: input.targetReduction,
          startTime: input.startTime,
          endTime: input.endTime,
          compensationRate: input.compensationRate,
          participants: [], // Will be populated by workflow from enrolled participants
        });
        console.log(`[DR] Started Temporal workflow for event ${eventId}`);
      } catch (err) {
        console.error('[DR] Failed to start Temporal workflow:', err);
        // Don't fail the event creation if workflow fails to start
      }
      
      // Notify enrolled participants
      const participants = await drDb.getAllDRParticipants('active');
      for (const participant of participants) {
        if (participant.autoOptIn) {
          // Auto-enroll
          await drDb.createDRResponse({
            eventId: 0, // Will be set after event creation
            userId: participant.userId,
            participationStatus: 'auto_enrolled',
          });
        }
        
        // Send notification
        await notifications.sendPushNotification({
          userId: participant.userId,
          title: 'New Demand Response Event',
          body: `${input.eventName}: Reduce ${input.targetReduction}kW from ${input.startTime.toLocaleString()} to ${input.endTime.toLocaleString()}. Earn ${input.compensationRate}¢/kWh.`,
        });
      }
      
      return { success: true };
    }),
  
  getAllEvents: adminProcedure
    .input(z.object({
      status: z.enum(['scheduled', 'active', 'completed', 'cancelled']).optional(),
    }))
    .query(async ({ input }) => {
      const events = await drDb.getDREvents({ status: input.status });
      return events;
    }),
  
  getEventResponses: adminProcedure
    .input(z.object({
      eventId: z.number().int().positive(),
    }))
    .query(async ({ input }) => {
      const responses = await drDb.getDRResponses(input.eventId);
      return responses;
    }),
  
  updateEventStatus: adminProcedure
    .input(z.object({
      eventId: z.number().int().positive(),
      status: z.enum(['scheduled', 'active', 'completed', 'cancelled']),
      actualReduction: z.number().int().positive().optional(),
    }))
    .mutation(async ({ input }) => {
      await drDb.updateDREventStatus(input.eventId, input.status, input.actualReduction);
      
      // If completed, calculate and create compensation
      if (input.status === 'completed') {
        const event = await drDb.getDREventById(input.eventId);
        const responses = await drDb.getDRResponses(input.eventId);
        
        for (const response of responses) {
          if (response.actualReduction && response.actualReduction > 0) {
            const compensation = response.actualReduction * (event?.compensationRate || 0);
            await drDb.createDRCompensation({
              userId: response.userId,
              eventId: input.eventId,
              responseId: response.id,
              amount: compensation,
              currency: 'USD',
              status: 'pending',
            });
          }
        }
      }
      
      return { success: true };
    }),
  
  getAllParticipants: adminProcedure
    .query(async () => {
      const participants = await drDb.getAllDRParticipants();
      return participants;
    }),
  
  getSystemAnalytics: adminProcedure
    .query(async () => {
      const analytics = await drDb.getDRAnalytics();
      return analytics;
    }),
});
