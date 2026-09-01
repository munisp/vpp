/**
 * OpenTelemetry SDK bootstrap for the VPP TypeScript processes.
 *
 * This module MUST be imported before any other application module (first
 * line of server/_core/index.ts and of every Temporal worker entry) so the
 * auto-instrumentation hooks (http, express, pg, ioredis, kafkajs) are in
 * place before those libraries load.
 *
 * Env contract (shared with the infra stack):
 *   OTEL_EXPORTER_OTLP_ENDPOINT  OTLP gRPC collector endpoint (default http://localhost:4317)
 *   OTEL_SERVICE_NAME            service.name resource attribute
 *   OTEL_SERVICE_VERSION         service.version resource attribute
 *   OTEL_ENVIRONMENT             deployment.environment resource attribute
 *   OTEL_TENANT_ID               tenant.id resource attribute (default 'default')
 *   OTEL_SDK_DISABLED=true       escape hatch: no SDK, no exporters, no listeners
 *   METRICS_PORT                 Prometheus listener port for HTTP-less workers
 *                                (wired in docker-compose.prod.yml; defaults:
 *                                payment 9091, dr 9092, trading 9093, prepaid 9094,
 *                                inferred from the entry filename)
 *   OTEL_SEMCONV_STABILITY_OPT_IN  defaults to 'http' (set here when unset) so
 *                                HTTP metrics use the STABLE semconv names
 *                                (http.server.request.duration, seconds) that
 *                                the collector's prometheus exporter turns into
 *                                http_server_request_duration_seconds_*.
 *
 * Honesty rules:
 *   - NODE_ENV === 'test' never starts the SDK or any exporter/listener.
 *   - The boot log line and getTelemetryStatus() always say whether telemetry
 *     is live, and why not when it is not. /ready exposes the same status.
 *   - A collector that is enabled-but-unreachable must not crash boot: export
 *     failures are recorded and surface as `degraded: true`, never as a throw.
 *
 * Metrics: the HTTP server serves GET /metrics on its own port via
 * createMetricsHandler() (OTel Prometheus exporter output merged with the
 * legacy prom-client registry so the existing kafka_* counters stay visible).
 * Workers have no HTTP server, so their Prometheus exporter starts its own
 * listener on OTEL_PROMETHEUS_PORT — the ports prometheus.yml already scrapes.
 */

import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes, type Resource } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { KafkaJsInstrumentation } from '@opentelemetry/instrumentation-kafkajs';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

export interface TelemetryStatus {
  /** True when the OTel SDK was actually started with live exporters. */
  enabled: boolean;
  /** Why telemetry is off (test env, OTEL_SDK_DISABLED, init failure). */
  reason?: string;
  /** True when enabled but exports are failing (e.g. collector unreachable). */
  degraded?: boolean;
  /** Last export error message, when degraded. */
  lastExportError?: string;
  /** Where traces are sent, when enabled. */
  endpoint?: string;
  /** How metrics are exposed: express route or a dedicated listener port. */
  metrics?: 'route:/metrics' | `listen:${number}` | 'disabled';
  /** Resolved resource attributes (service.name, tenant.id, ...). */
  resource?: Record<string, string>;
}

const DEFAULT_OTLP_ENDPOINT = 'http://localhost:4317';

/** Prometheus listener defaults for the HTTP-less Temporal workers. */
const WORKER_METRICS_PORTS: Record<string, number> = {
  'worker.ts': 9091, // payment-worker
  'worker.js': 9091,
  'dr-worker.ts': 9092,
  'dr-worker.js': 9092,
  'trading-worker.ts': 9093,
  'trading-worker.js': 9093,
  'prepaid-worker.ts': 9094,
  'prepaid-worker.js': 9094,
};

const WORKER_SERVICE_NAMES: Record<string, string> = {
  'worker.ts': 'vpp-payment-worker',
  'worker.js': 'vpp-payment-worker',
  'dr-worker.ts': 'vpp-dr-worker',
  'dr-worker.js': 'vpp-dr-worker',
  'trading-worker.ts': 'vpp-trading-worker',
  'trading-worker.js': 'vpp-trading-worker',
  'prepaid-worker.ts': 'vpp-prepaid-worker',
  'prepaid-worker.js': 'vpp-prepaid-worker',
};

function entryBasename(): string {
  const argv1 = process.argv[1] ?? '';
  return argv1.split('/').pop() ?? '';
}

/**
 * Pure resource-attribute builder (exported for tests). Honors the env
 * contract exactly; tenant.id defaults to 'default' for this single-tenant
 * deployment so every backend can group by it unconditionally.
 */
export function buildResourceAttributes(
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const entry = entryBasename();
  return {
    'service.name':
      env.OTEL_SERVICE_NAME || WORKER_SERVICE_NAMES[entry] || 'vpp-server',
    'service.version': env.OTEL_SERVICE_VERSION || '1.0.0',
    'deployment.environment': env.OTEL_ENVIRONMENT || env.NODE_ENV || 'development',
    'tenant.id': env.OTEL_TENANT_ID || 'default',
  };
}

function resolveWorkerMetricsPort(env: NodeJS.ProcessEnv = process.env): number | null {
  if (env.METRICS_PORT) {
    const port = parseInt(env.METRICS_PORT, 10);
    return Number.isFinite(port) ? port : null;
  }
  return WORKER_METRICS_PORTS[entryBasename()] ?? null;
}

/**
 * Wraps a SpanExporter and records the most recent export outcome, so a
 * collector that is down shows up as `degraded` in /ready instead of being
 * silently dropped by the BatchSpanProcessor's retry logging.
 */
class StatusTrackingExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.inner.export(spans, (result: ExportResult) => {
      if (result.code === ExportResultCode.SUCCESS) {
        exporterState.lastError = null;
        exporterState.lastErrorAt = 0;
      } else {
        exporterState.lastError = result.error?.message ?? 'unknown export failure';
        exporterState.lastErrorAt = Date.now();
      }
      resultCallback(result);
    });
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush?(): Promise<void> {
    return this.inner.forceFlush ? this.inner.forceFlush() : Promise.resolve();
  }
}

const exporterState = { lastError: null as string | null, lastErrorAt: 0 };

let sdk: NodeSDK | null = null;
let prometheusExporter: PrometheusExporter | null = null;
let sdkResource: Resource | null = null;
const status: TelemetryStatus = { enabled: false, reason: 'not_initialized' };

export function getTelemetryStatus(): TelemetryStatus {
  const degraded =
    status.enabled && exporterState.lastErrorAt > 0
      ? // Consider the pipeline healthy again after 5 quiet minutes.
        Date.now() - exporterState.lastErrorAt < 5 * 60 * 1000
      : false;
  return {
    ...status,
    degraded: status.enabled ? degraded : undefined,
    lastExportError: degraded ? (exporterState.lastError ?? undefined) : undefined,
  };
}

/** Shape surfaced by GET /ready — keep it small and stable. */
export function telemetryReadyPayload(): { enabled: boolean; reason?: string; degraded?: boolean } {
  const s = getTelemetryStatus();
  const payload: { enabled: boolean; reason?: string; degraded?: boolean } = {
    enabled: s.enabled,
  };
  if (!s.enabled && s.reason) payload.reason = s.reason;
  if (s.degraded) payload.degraded = true;
  return payload;
}

function bootLog(): void {
  if (status.enabled) {
    console.log(
      `[Telemetry] OTel enabled: service=${status.resource?.['service.name']} ` +
        `endpoint=${status.endpoint} metrics=${status.metrics} tenant=${status.resource?.['tenant.id']}`
    );
  } else {
    console.log(`[Telemetry] OTel disabled (${status.reason ?? 'unknown reason'})`);
  }
}

/**
 * Idempotent SDK init. Called once at module evaluation below; exported so
 * tests and future entry points can drive it explicitly with a clean env.
 */
export function initTelemetry(env: NodeJS.ProcessEnv = process.env): TelemetryStatus {
  if (sdk || status.reason !== 'not_initialized') {
    return getTelemetryStatus();
  }

  if (env.OTEL_SDK_DISABLED === 'true') {
    Object.assign(status, { enabled: false, reason: 'disabled_by_env', metrics: 'disabled' });
    bootLog();
    return getTelemetryStatus();
  }
  if (env.NODE_ENV === 'test') {
    Object.assign(status, { enabled: false, reason: 'test_env', metrics: 'disabled' });
    return getTelemetryStatus(); // no boot log noise in tests
  }

  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT || DEFAULT_OTLP_ENDPOINT;
  const resourceAttributes = buildResourceAttributes(env);

  // Default to STABLE HTTP semconv (http.server.request.duration, seconds)
  // unless the deployment explicitly opts into something else. Must be set
  // before the instrumentations below are constructed — they read it once.
  process.env.OTEL_SEMCONV_STABILITY_OPT_IN ??= 'http';

  try {
    if (env.OTEL_LOG_LEVEL) {
      const levels: Record<string, DiagLogLevel> = {
        ERROR: DiagLogLevel.ERROR,
        WARN: DiagLogLevel.WARN,
        INFO: DiagLogLevel.INFO,
        DEBUG: DiagLogLevel.DEBUG,
      };
      const level = levels[env.OTEL_LOG_LEVEL.toUpperCase()];
      if (level !== undefined) diag.setLogger(new DiagConsoleLogger(), level);
    }

    sdkResource = resourceFromAttributes(resourceAttributes);
    const traceExporter = new StatusTrackingExporter(
      new OTLPTraceExporter({ url: endpoint })
    );

    const workerPort = resolveWorkerMetricsPort(env);
    prometheusExporter =
      workerPort !== null
        ? new PrometheusExporter({ port: workerPort }, err => {
            if (err) {
              // e.g. port already bound by a PM2 cluster sibling — degrade,
              // never crash the worker over metrics.
              exporterState.lastError = `prometheus listener :${workerPort}: ${err.message}`;
              exporterState.lastErrorAt = Date.now();
              console.error(`[Telemetry] Prometheus listener failed on :${workerPort}:`, err.message);
            }
          })
        : new PrometheusExporter({ preventServerStart: true });

    sdk = new NodeSDK({
      resource: sdkResource,
      traceExporter,
      metricReaders: [prometheusExporter],
      instrumentations: [
        new HttpInstrumentation(),
        new ExpressInstrumentation(),
        new PgInstrumentation(),
        new IORedisInstrumentation(),
        new KafkaJsInstrumentation(),
      ],
    });
    sdk.start();

    Object.assign(status, {
      enabled: true,
      reason: undefined,
      endpoint,
      metrics: workerPort !== null ? `listen:${workerPort}` : 'route:/metrics',
      resource: resourceAttributes,
    });
  } catch (error) {
    // Telemetry must never take the process down with it.
    sdk = null;
    prometheusExporter = null;
    Object.assign(status, {
      enabled: false,
      reason: `init_failed: ${error instanceof Error ? error.message : String(error)}`,
      metrics: 'disabled',
    });
  }

  bootLog();
  return getTelemetryStatus();
}

/**
 * Express handler for GET /metrics on the application's own HTTP port.
 * Merges the OTel Prometheus exporter output with the legacy prom-client
 * registry (kafka_messages_published_total, kafka_publish_duration_seconds)
 * so the single scrape target INFRA owns keeps both metric families.
 */
export function createMetricsHandler() {
  return async (
    req: import('express').Request,
    res: import('express').Response,
    next: import('express').NextFunction
  ) => {
    try {
      let promClientText = '';
      try {
        const { register } = await import('prom-client');
        promClientText = await register.metrics();
      } catch {
        // prom-client absent or empty registry: OTel output alone is fine.
      }

      if (!prometheusExporter) {
        res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
        res.end(promClientText || '# OpenTelemetry metrics are disabled\n');
        return;
      }

      const originalEnd = res.end.bind(res);
      (res as { end: unknown }).end = (chunk?: unknown, ...rest: unknown[]) => {
        const otelText = chunk == null ? '' : String(chunk);
        const body = promClientText ? `${promClientText}\n${otelText}` : otelText;
        return (originalEnd as (...args: unknown[]) => unknown)(body, ...rest);
      };
      prometheusExporter.getMetricsRequestHandler(req, res);
    } catch (error) {
      next(error);
    }
  };
}

/** Resource used by the SDK (Temporal workers reuse it for workflow spans). */
export function getTelemetryResource(): Resource | null {
  return sdkResource;
}

/**
 * Adapter between @temporalio/interceptors-opentelemetry@1.13.2 (which
 * serializes workflow spans in the OTel 1.x shape — `instrumentationLibrary`,
 * `parentSpanId`) and the OTel 2.x OTLP exporter (which reads
 * `instrumentationScope.name` and `parentSpanContext.spanId`). Without this
 * the 2.x exporter throws inside the workflow sink. Activity and API spans
 * never pass through here — only workflow-isolate spans.
 */
class TemporalWorkflowSpanExporterAdapter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const adapted = spans.map(span => {
      const legacy = span as unknown as {
        instrumentationLibrary?: { name: string; version?: string; schemaUrl?: string };
        parentSpanId?: string;
      };
      const spanContext = span.spanContext();
      return {
        ...span,
        instrumentationScope:
          span.instrumentationScope ??
          legacy.instrumentationLibrary ?? { name: '@temporalio/interceptors-opentelemetry/workflow' },
        parentSpanContext:
          span.parentSpanContext ??
          (legacy.parentSpanId
            ? {
                traceId: spanContext.traceId,
                spanId: legacy.parentSpanId,
                traceFlags: spanContext.traceFlags,
                isRemote: true,
              }
            : undefined),
        events: span.events ?? [],
        links: span.links ?? [],
        droppedAttributesCount: span.droppedAttributesCount ?? 0,
        droppedEventsCount: span.droppedEventsCount ?? 0,
        droppedLinksCount: span.droppedLinksCount ?? 0,
      } as ReadableSpan;
    });
    this.inner.export(adapted, resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush?(): Promise<void> {
    return this.inner.forceFlush ? this.inner.forceFlush() : Promise.resolve();
  }
}

/**
 * Fresh OTLP gRPC span exporter for subsystems that export outside the SDK's
 * own pipeline — currently the Temporal workflow isolate sink
 * (makeWorkflowExporter). Returns null when telemetry is disabled.
 */
export function createOtelSpanExporter(): SpanExporter | null {
  if (!status.enabled) return null;
  return new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || DEFAULT_OTLP_ENDPOINT,
  });
}

/**
 * Temporal worker telemetry wiring (workflow + activity interceptors and the
 * workflow-span sink). Dynamically imported so the API server never loads the
 * Temporal worker bundle. Returns undefined when telemetry is disabled.
 */
export async function temporalWorkerTelemetry(): Promise<
  Pick<import('@temporalio/worker').WorkerOptions, 'sinks' | 'interceptors'> | undefined
> {
  if (!status.enabled || !sdkResource) return undefined;

  const {
    OpenTelemetryActivityInboundInterceptor,
    OpenTelemetryActivityOutboundInterceptor,
    makeWorkflowExporter,
  } = await import('@temporalio/interceptors-opentelemetry/lib/worker');

  const workflowExporter = createOtelSpanExporter();
  if (!workflowExporter) return undefined;

  type ActivityInterceptorsFactory =
    import('@temporalio/worker').ActivityInterceptorsFactory;

  const activity: ActivityInterceptorsFactory[] = [
    ctx => ({
      inbound: new OpenTelemetryActivityInboundInterceptor(ctx),
      outbound: new OpenTelemetryActivityOutboundInterceptor(ctx),
    }),
  ];

  // The interceptors package is typed against OTel 1.x (sdk-trace-base 1.30);
  // the adapter above bridges the 2.x exporter at runtime, and the casts
  // bridge the types.
  const adaptedExporter = new TemporalWorkflowSpanExporterAdapter(workflowExporter);

  return {
    sinks: {
      exporter: makeWorkflowExporter(
        adaptedExporter as never,
        sdkResource as never
      ),
    },
    interceptors: {
      activity,
      workflowModules: [
        require.resolve('@temporalio/interceptors-opentelemetry/lib/workflow'),
      ],
    },
  };
}

/**
 * Flush and shut the SDK down. Safe to call when disabled (no-op). Wired
 * into the server's graceful-shutdown path and worker signal handlers so the
 * last spans are not lost on SIGTERM.
 */
export async function withTelemetryShutdown(): Promise<void> {
  if (!sdk) return;
  const current = sdk;
  sdk = null;
  try {
    await current.shutdown();
    console.log('[Telemetry] OTel SDK shut down');
  } catch (error) {
    console.warn('[Telemetry] OTel SDK shutdown error:', error);
  }
}

// Auto-init on import. This module is imported as the very first side effect
// of every entry point; in tests this resolves to disabled without touching
// the network, the filesystem, or any port.
initTelemetry();
