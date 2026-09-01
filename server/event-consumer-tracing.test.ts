/**
 * Pins the consumer half of the W3C trace-context contract.
 *
 * server/integration/kafka-publisher.ts stamps `traceparent` onto every
 * published message (pinned in server/telemetry.test.ts). This file pins the
 * symmetric extraction in server/services/events/consumer.ts: a consumed
 * message carrying that header is handled inside a CONSUMER span that
 * continues the same trace, and a message without one still runs its handler
 * unchanged — which is also the disabled-telemetry path (NODE_ENV=test never
 * starts the SDK, so the same code is exercised here against an in-memory
 * provider instead).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { withConsumeSpan } from './services/events/consumer';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

// The Node SDK registers these in production; in tests nothing does, and
// without them context.with() and propagation.extract() are no-ops.
beforeAll(() => {
  provider.register({
    contextManager: new AsyncLocalStorageContextManager().enable(),
    propagator: new W3CTraceContextPropagator(),
  });
});

afterAll(async () => {
  await provider.shutdown();
});

beforeEach(() => {
  exporter.reset();
});

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const PARENT_SPAN_ID = 'b7ad6b7169203331';

function messageWith(headers: Record<string, string | Buffer>) {
  return {
    key: Buffer.from('event-1'),
    value: Buffer.from(JSON.stringify({ event_id: 'event-1' })),
    offset: '42',
    timestamp: '1700000000000',
    headers,
  };
}

describe('consumer trace extraction', () => {
  it('a message with a traceparent header is handled in a CONSUMER span continuing that trace', async () => {
    const message = messageWith({
      traceparent: `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`,
    });

    let activeTraceId: string | undefined;
    await withConsumeSpan('payments.completed', 3, message, 'vpp-event-inbox', async () => {
      activeTraceId = trace.getActiveSpan()?.spanContext().traceId;
    });

    // The handler ran inside the span's context.
    expect(activeTraceId).toBe(TRACE_ID);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span.name).toBe('messaging.kafka.consume');
    expect(span.kind).toBe(SpanKind.CONSUMER);
    expect(span.spanContext().traceId).toBe(TRACE_ID);
    // The span hangs off the producer's span as a remote parent.
    expect(span.parentSpanContext?.spanId).toBe(PARENT_SPAN_ID);
    expect(span.attributes).toMatchObject({
      'messaging.system': 'kafka',
      'messaging.destination.name': 'payments.completed',
      'messaging.destination.partition.id': '3',
      'messaging.kafka.message.offset': 42,
      'messaging.kafka.consumer.group': 'vpp-event-inbox',
    });
  });

  it('Buffer header values extract the same way (kafkajs delivers Buffers)', async () => {
    const message = messageWith({
      traceparent: Buffer.from(`00-${TRACE_ID}-${PARENT_SPAN_ID}-01`),
    });
    await withConsumeSpan('payments.completed', 0, message, 'vpp-event-inbox', async () => {});
    const [span] = exporter.getFinishedSpans();
    expect(span.spanContext().traceId).toBe(TRACE_ID);
    expect(span.parentSpanContext?.spanId).toBe(PARENT_SPAN_ID);
  });

  it('a message without trace context still runs its handler, as a new root trace', async () => {
    const message = messageWith({ 'content-type': 'application/json' });

    let handled = false;
    await withConsumeSpan('payments.completed', 1, message, 'vpp-event-inbox', async () => {
      handled = true;
    });

    expect(handled).toBe(true);
    const [span] = exporter.getFinishedSpans();
    expect(span.spanContext().traceId).not.toBe(TRACE_ID);
    expect(span.parentSpanContext).toBeUndefined();
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('a handler failure is recorded on the span and rethrown, so redelivery semantics are unchanged', async () => {
    const message = messageWith({
      traceparent: `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`,
    });

    await expect(
      withConsumeSpan('payments.completed', 0, message, 'vpp-event-inbox', async () => {
        throw new Error('database unavailable');
      })
    ).rejects.toThrow('database unavailable');

    const [span] = exporter.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe('database unavailable');
    expect(span.events.some(event => event.name === 'exception')).toBe(true);
  });
});
