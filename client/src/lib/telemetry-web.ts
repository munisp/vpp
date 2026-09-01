/**
 * Browser RUM (Real User Monitoring) via the OpenTelemetry Web SDK.
 *
 * Instrumentations: document-load (page load + resource timings) and fetch
 * (one client span per fetch, with the W3C `traceparent` header injected on
 * same-origin /api calls so browser spans join the server-side traces).
 *
 * Export: OTLP/HTTP straight to the collector set in
 * `VITE_OTEL_COLLECTOR_URL` (e.g. `http://localhost:4318/v1/traces`). The
 * app server does NOT proxy /otel/*, and the collector's browser-facing
 * endpoint is 4318 with CORS enabled — so the exporter talks to the
 * collector directly. When the variable is unset the SDK is never created:
 * zero network attempts, zero noise. Initialization is fail-quiet by design;
 * a broken collector must never break the UI.
 *
 * Deliberately NOT included: user-interaction instrumentation. It requires
 * Zone.js + ZoneContextManager, which is heavy and interacts poorly with
 * React 19's concurrent scheduling; document-load + fetch already cover
 * page loads and every API call.
 */

import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { DocumentLoadInstrumentation } from "@opentelemetry/instrumentation-document-load";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";

let initialized = false;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function initWebTelemetry(): void {
  if (initialized) return;

  const collectorUrl = import.meta.env.VITE_OTEL_COLLECTOR_URL as string | undefined;
  if (!collectorUrl) return; // telemetry opt-in per deployment
  if (typeof window === "undefined") return;

  try {
    const provider = new WebTracerProvider({
      resource: resourceFromAttributes({
        "service.name": (import.meta.env.VITE_OTEL_SERVICE_NAME as string | undefined) ?? "vpp-web",
        "service.version": (import.meta.env.VITE_OTEL_SERVICE_VERSION as string | undefined) ?? "1.0.0",
        "deployment.environment": import.meta.env.MODE ?? "development",
        "tenant.id": (import.meta.env.VITE_OTEL_TENANT_ID as string | undefined) ?? "default",
      }),
      spanProcessors: [
        new BatchSpanProcessor(new OTLPTraceExporter({ url: collectorUrl })),
      ],
    });

    provider.register({ propagator: new W3CTraceContextPropagator() });

    // Send traceparent only where it belongs: same-origin API calls (both
    // relative and absolute URL forms) — never to third-party origins.
    const sameOrigin = new RegExp(`^${escapeRegExp(window.location.origin)}/`);

    registerInstrumentations({
      instrumentations: [
        new DocumentLoadInstrumentation(),
        new FetchInstrumentation({
          propagateTraceHeaderCorsUrls: [sameOrigin, /^\//],
          clearTimingResources: true,
        }),
      ],
    });

    initialized = true;
  } catch (error) {
    // Fail-quiet: RUM is an observability concern, never a user-facing one.
    console.warn("[Telemetry] Web RUM initialization failed, continuing without it:", error);
  }
}
