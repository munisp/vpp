/**
 * Tests for server/_core/telemetry.ts.
 *
 * Hard requirements pinned here:
 *  1. NODE_ENV=test must never start exporters or listeners — the module
 *     resolves to disabled with reason 'test_env' and no network/port use.
 *  2. The env contract: tenant.id defaults to 'default' and honors
 *     OTEL_TENANT_ID; OTEL_SDK_DISABLED=true is an escape hatch that works
 *     even in production.
 *  3. The /ready telemetry payload shape is stable: {enabled, reason?}.
 *  4. /metrics stays servable with telemetry disabled (legacy prom-client
 *     registry only), so the INFRA scrape target never 500s.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { ROOT_CONTEXT, context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  buildResourceAttributes,
  createMetricsHandler,
  getTelemetryStatus,
  initTelemetry,
  telemetryReadyPayload,
} from './_core/telemetry';

describe('telemetry module (test env)', () => {
  it('is disabled under NODE_ENV=test with an honest reason', () => {
    const status = getTelemetryStatus();
    expect(status.enabled).toBe(false);
    expect(status.reason).toBe('test_env');
    expect(status.metrics).toBe('disabled');
  });

  it('initTelemetry is idempotent and never starts exporters in tests', () => {
    const status = initTelemetry({ ...process.env, NODE_ENV: 'test' });
    expect(status.enabled).toBe(false);
    expect(status.reason).toBe('test_env');
  });

  it('exposes the /ready telemetry status shape', () => {
    const payload = telemetryReadyPayload();
    expect(payload).toHaveProperty('enabled');
    expect(typeof payload.enabled).toBe('boolean');
    // Disabled in tests: the reason must be reported, not hidden.
    expect(payload.enabled).toBe(false);
    expect(payload.reason).toBe('test_env');
  });

  it('serves /metrics even when telemetry is disabled', async () => {
    const handler = createMetricsHandler();
    const res = {
      statusCode: 0,
      headers: {} as Record<string, string>,
      body: undefined as unknown,
      setHeader(k: string, v: string) {
        this.headers[k] = v;
      },
      end(chunk?: unknown) {
        this.body = chunk;
      },
    };
    const next = (err?: unknown) => {
      if (err) throw err;
    };
    await handler({} as never, res as never, next);
    expect(typeof res.body).toBe('string');
    expect(res.headers['content-type']).toContain('text/plain');
  });
});

describe('resource attributes (env contract)', () => {
  it("defaults tenant.id to 'default'", () => {
    const attrs = buildResourceAttributes({});
    expect(attrs['tenant.id']).toBe('default');
  });

  it('honors OTEL_TENANT_ID', () => {
    const attrs = buildResourceAttributes({ OTEL_TENANT_ID: 'acme-energy' });
    expect(attrs['tenant.id']).toBe('acme-energy');
  });

  it('maps the documented env vars to resource attributes', () => {
    const attrs = buildResourceAttributes({
      OTEL_SERVICE_NAME: 'vpp-server',
      OTEL_SERVICE_VERSION: '2.3.4',
      OTEL_ENVIRONMENT: 'production',
      OTEL_TENANT_ID: 'tenant-7',
    });
    expect(attrs).toEqual({
      'service.name': 'vpp-server',
      'service.version': '2.3.4',
      'deployment.environment': 'production',
      'tenant.id': 'tenant-7',
    });
  });
});

describe('OTEL_SDK_DISABLED escape hatch', () => {
  it('disables the SDK even in production, with a reason', async () => {
    vi.resetModules();
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.OTEL_SDK_DISABLED = 'true';
    try {
      const mod = await import('./_core/telemetry');
      const status = mod.getTelemetryStatus();
      expect(status.enabled).toBe(false);
      expect(status.reason).toBe('disabled_by_env');
      expect(status.metrics).toBe('disabled');
      // And /ready would say so honestly.
      expect(mod.telemetryReadyPayload()).toEqual({
        enabled: false,
        reason: 'disabled_by_env',
      });
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      delete process.env.OTEL_SDK_DISABLED;
      vi.resetModules();
    }
  });
});

describe('kafka trace-context propagation', () => {
  // The SDK is disabled in tests, so no context manager is registered by
  // default — register the same AsyncLocalStorage manager the Node SDK uses
  // in production, otherwise context.with() is a no-op.
  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    // The Node SDK registers the W3C propagator in production; without an
    // SDK (tests) the global propagator is a no-op.
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  });

  it('injects W3C traceparent headers from the active context', async () => {
    const { currentTraceHeaders } = await import('./integration/kafka-publisher');

    const spanContext = {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: 1,
    };
    const ctx = trace.setSpanContext(ROOT_CONTEXT, spanContext);

    const headers = context.with(ctx, () => currentTraceHeaders());
    expect(headers.traceparent).toBe(
      '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
    );
  });

  it('produces no traceparent without an active span', async () => {
    const { currentTraceHeaders } = await import('./integration/kafka-publisher');
    const headers = context.with(ROOT_CONTEXT, () => currentTraceHeaders());
    expect(headers.traceparent).toBeUndefined();
  });
});
