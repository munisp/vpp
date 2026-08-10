import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import * as credDb from "../payment-credentials-db";
import { MpesaGateway } from "../payment-gateways/mpesa";
import { AirtelMoneyGateway } from "../payment-gateways/airtel";
import { TigoPesaGateway } from "../payment-gateways/tigo";

// Admin-only procedure
const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
  }
  return next({ ctx });
});

// Validation schemas for different gateways
const mpesaCredentialsSchema = z.object({
  consumerKey: z.string().min(1, "Consumer Key is required"),
  consumerSecret: z.string().min(1, "Consumer Secret is required"),
  shortcode: z.string().min(1, "Shortcode is required"),
  passkey: z.string().min(1, "Passkey is required"),
  callbackUrl: z.string().url("Invalid callback URL"),
});

const airtelCredentialsSchema = z.object({
  clientId: z.string().min(1, "Client ID is required"),
  clientSecret: z.string().min(1, "Client Secret is required"),
  merchantCode: z.string().min(1, "Merchant Code is required"),
  callbackUrl: z.string().url("Invalid callback URL"),
});

const tigoCredentialsSchema = z.object({
  apiKey: z.string().min(1, "API Key is required"),
  apiSecret: z.string().min(1, "API Secret is required"),
  merchantNumber: z.string().min(1, "Merchant Number is required"),
  callbackUrl: z.string().url("Invalid callback URL"),
});

export const paymentCredentialsRouter = router({
  // List all payment credentials (without sensitive data)
  list: adminProcedure.query(async () => {
    const credentials = await credDb.getAllPaymentCredentials();
    return credentials;
  }),

  // Get specific credential (with decrypted data for editing)
  get: adminProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
      })
    )
    .query(async ({ input }) => {
      // This would need a specific function to get by ID
      const allCreds = await credDb.getAllPaymentCredentials();
      return allCreds.find((c) => c.id === input.id) || null;
    }),

  // Save M-Pesa credentials
  saveMpesa: adminProcedure
    .input(
      z.object({
        environment: z.enum(["sandbox", "production"]),
        credentials: mpesaCredentialsSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const id = await credDb.savePaymentCredentials({
        gateway: "mpesa",
        environment: input.environment,
        credentials: input.credentials,
        createdBy: ctx.user.id,
      });

      return { success: true, id };
    }),

  // Save Airtel Money credentials
  saveAirtel: adminProcedure
    .input(
      z.object({
        environment: z.enum(["sandbox", "production"]),
        credentials: airtelCredentialsSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const id = await credDb.savePaymentCredentials({
        gateway: "airtel_money",
        environment: input.environment,
        credentials: input.credentials,
        createdBy: ctx.user.id,
      });

      return { success: true, id };
    }),

  // Save Tigo Pesa credentials
  saveTigo: adminProcedure
    .input(
      z.object({
        environment: z.enum(["sandbox", "production"]),
        credentials: tigoCredentialsSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const id = await credDb.savePaymentCredentials({
        gateway: "tigo_pesa",
        environment: input.environment,
        credentials: input.credentials,
        createdBy: ctx.user.id,
      });

      return { success: true, id };
    }),

  // Validate credentials (test API connection)
  validate: adminProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
      })
    )
    .mutation(async ({ input }) => {
      try {
        // Get credentials with decrypted data
        const credential = await credDb.getPaymentCredentialsById(input.id);
        
        if (!credential) {
          throw new Error("Credentials not found");
        }

        // Validate based on gateway type
        let validationResult = false;
        
        switch (credential.gateway) {
          case 'mpesa':
            const mpesa = new MpesaGateway();
            await mpesa.initialize(credential.credentials, credential.environment);
            const mpesaResult = await mpesa.validateCredentials();
            validationResult = mpesaResult.valid;
            break;
          case 'airtel_money':
            const airtel = new AirtelMoneyGateway();
            await airtel.initialize(credential.credentials, credential.environment);
            const airtelResult = await airtel.validateCredentials();
            validationResult = airtelResult.valid;
            break;
          case 'tigo_pesa':
            const tigo = new TigoPesaGateway();
            await tigo.initialize(credential.credentials, credential.environment);
            const tigoResult = await tigo.validateCredentials();
            validationResult = tigoResult.valid;
            break;
          default:
            throw new Error(`Unsupported gateway: ${credential.gateway}`);
        }

        if (validationResult) {
          await credDb.updateCredentialStatus(input.id, {
            isValidated: "true",
            validationError: null,
          });
          return { success: true, message: "Credentials validated successfully" };
        } else {
          throw new Error("Validation failed - invalid credentials");
        }
      } catch (error: any) {
        await credDb.updateCredentialStatus(input.id, {
          isValidated: "false",
          validationError: error.message,
        });

        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Validation failed: ${error.message}`,
        });
      }
    }),

  // Activate/deactivate credentials
  toggleActive: adminProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        isActive: z.boolean(),
      })
    )
    .mutation(async ({ input }) => {
      await credDb.updateCredentialStatus(input.id, {
        isActive: input.isActive ? "true" : "false",
      });

      return { success: true };
    }),

  // Delete credentials
  delete: adminProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
      })
    )
    .mutation(async ({ input }) => {
      await credDb.deletePaymentCredentials(input.id);
      return { success: true };
    }),

  // Get payment gateway logs
  getLogs: adminProcedure
    .input(
      z.object({
        paymentId: z.number().int().positive().optional(),
        gateway: z.enum(["mpesa", "airtel_money", "tigo_pesa"]).optional(),
        status: z.enum(["pending", "success", "failed", "timeout"]).optional(),
        limit: z.number().int().positive().max(500).optional(),
      })
    )
    .query(async ({ input }) => {
      const logs = await credDb.getPaymentGatewayLogs(input);
      return logs;
    }),
});
