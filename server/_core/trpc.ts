import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import type { TrpcContext } from "./context";

const isProduction = process.env.NODE_ENV === "production";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  /**
   * Error hygiene: never serialize stack traces or internal error metadata
   * into API responses in production. The full error (with stack) is logged
   * server-side by the onError hook in server/_core/index.ts; the client
   * only needs the code and a message it can show a user.
   */
  errorFormatter({ shape }) {
    if (!isProduction) return shape;
    const { stack, ...data } = shape.data as Record<string, unknown> & { stack?: unknown };
    void stack;
    return { ...shape, data };
  },
});

export const router = t.router;

/**
 * One server span per tRPC procedure, named `trpc.<router>.<procedure>`,
 * parented under the express/http span created by auto-instrumentation.
 * Context propagation across the async middleware chain rides on OTel's
 * AsyncLocalStorage context manager, so downstream pg/redis/kafka spans
 * created by the procedure are children of this span automatically.
 */
const tracer = trace.getTracer("vpp-trpc");

const traceProcedure = t.middleware(async opts => {
  const span = tracer.startSpan(`trpc.${opts.path}`, {
    attributes: {
      "rpc.system": "trpc",
      "rpc.method": opts.path,
      "trpc.type": opts.type,
      ...(opts.ctx.user ? { "user.id": String(opts.ctx.user.id) } : {}),
    },
  });

  // Run the rest of the chain inside this span's context so nested spans
  // (db, cache, publish) parent correctly.
  return otelContext.with(trace.setSpan(otelContext.active(), span), async () => {
    try {
      const result = await opts.next();
      if (!result.ok) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: result.error.message,
        });
        span.setAttribute("error", true);
        span.setAttribute("trpc.error.code", result.error.code);
      }
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.setAttribute("error", true);
      if (error instanceof Error) span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
});

export const publicProcedure = t.procedure.use(traceProcedure);

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = t.procedure.use(requireUser);

export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== 'admin') {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);
