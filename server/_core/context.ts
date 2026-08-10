import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { sdk } from "./sdk";
import { getUserById } from "../db";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
};

// Demo mode for UI testing - bypasses OAuth authentication
const isDemoMode = process.env.VITE_DEMO_MODE === 'true';

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

  return {
    req: opts.req,
    res: opts.res,
    user,
  };
}
