import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { trace } from "@opentelemetry/api";
import type { User } from "../../drizzle/schema";
import { sdk } from "./sdk";
import { getUserById } from "../db";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
};

// Demo mode for UI testing - bypasses OAuth authentication.
// This bypass is strictly forbidden in production: enabling it would make
// every request run as user id 1. Hard-fail at module load if both are set.
if (process.env.NODE_ENV === "production" && process.env.VITE_DEMO_MODE === "true") {
  throw new Error(
    "FATAL: VITE_DEMO_MODE=true is not allowed when NODE_ENV=production. " +
      "The demo-mode auth bypass would grant every request user id 1. " +
      "Unset VITE_DEMO_MODE to start the server."
  );
}
const isDemoMode = process.env.VITE_DEMO_MODE === "true" && process.env.NODE_ENV !== "production";

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: User | null = null;

  // In demo mode, use the demo user from the database
  if (isDemoMode) {
    try {
      const demoUser = await getUserById(1);
      if (demoUser) {
        user = demoUser;
      }
    } catch (error) {
      console.log('[Demo Mode] Error fetching demo user:', error);
    }
  } else {
    try {
      user = await sdk.authenticateRequest(opts.req);
    } catch (error) {
      // Authentication is optional for public procedures.
      user = null;
    }
  }

  // Tag the in-flight HTTP span with the resolved identity so traces can be
  // sliced by user without joining against logs. No-op when there is no
  // active span (telemetry disabled or non-traced caller).
  if (user) {
    const span = trace.getActiveSpan();
    span?.setAttribute("enduser.id", String(user.id));
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
  };
}
