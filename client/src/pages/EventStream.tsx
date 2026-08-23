/**
 * "Are the events we produce actually reaching the stream, and is anything
 * reading them?"
 *
 * The producer side used to answer that with a log line: an event that the broker
 * never accepted left nothing behind. Now every event is a row, so this page can
 * show the difference between *published*, *waiting*, and *the broker refused it
 * and a human is needed* — and the consumer side reports what has been read back
 * per topic, which is the only way to tell a working pipeline from a topic with a
 * producer and no reader.
 *
 * Nothing here invents a healthy state: no broker configured reads as no stream,
 * and a topic this deployment claims to consume but has never received is listed
 * as exactly that.
 */

import { useState } from "react";

import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertTriangle, Radio, RefreshCw, Send } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { MetricTile, PageHeader, PanelCard, ToneBadge } from "@/components/ops";

function ageLabel(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

export default function EventStream() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [busy, setBusy] = useState(false);
  const [lastAction, setLastAction] = useState<string | null>(null);

  const status = trpc.eventStream.status.useQuery(undefined, { enabled: isAdmin });
  const undeliverable = trpc.eventStream.undeliverable.useQuery(undefined, { enabled: isAdmin });
  const deadLetters = trpc.eventStream.deadLetters.useQuery(undefined, { enabled: isAdmin });
  const relayNow = trpc.eventStream.relayNow.useMutation();
  const requeue = trpc.eventStream.requeue.useMutation();

  if (!isAdmin) {
    return (
      <DashboardLayout>
        <Card>
          <CardHeader>
            <CardTitle>Event stream</CardTitle>
            <CardDescription>
              Stream delivery state is visible to platform administrators only.
            </CardDescription>
          </CardHeader>
        </Card>
      </DashboardLayout>
    );
  }

  const outbox = status.data?.outbox;
  const consumer = status.data?.consumer;
  const inbox = status.data?.inbox;
  const refreshing = status.isFetching || undeliverable.isFetching;

  const refreshAll = () => {
    void status.refetch();
    void undeliverable.refetch();
    void deadLetters.refetch();
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeader
          title="Event stream"
          description="Every event is recorded in the same transaction as the fact it describes, and is only marked published once the broker acknowledges it. Waiting and undeliverable events are shown here rather than logged and forgotten."
          actions={
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={refreshing}
                onClick={refreshAll}
              >
                <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
                Refresh
              </Button>
              <Button
                size="sm"
                disabled={busy || !outbox?.brokerConfigured}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const result = await relayNow.mutateAsync({ limit: 100 });
                    setLastAction(
                      result.skippedReason ??
                        `Published ${result.published}, retrying ${result.retryable}, undeliverable ${result.undeliverable}.`
                    );
                    refreshAll();
                  } catch (error) {
                    setLastAction(
                      error instanceof Error ? error.message : "The outbox could not be drained."
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Send className="mr-2 h-4 w-4" />
                Publish waiting events
              </Button>
            </div>
          }
          className="mb-0"
        />

        {lastAction && (
          <Card>
            <CardHeader>
              <CardDescription>{lastAction}</CardDescription>
            </CardHeader>
          </Card>
        )}

        {status.isError && (
          <Card className="border-red-300">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="h-4 w-4 text-red-600" />
                Stream state could not be read
              </CardTitle>
              <CardDescription>
                {status.error.message} — nothing is known about delivery right now; this is not an
                all-clear.
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {status.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <>
            <PanelCard
              title="Publishing"
              description={outbox?.detail}
              className={
                outbox && (outbox.undeliverable > 0 || !outbox.brokerConfigured)
                  ? "border-amber-300"
                  : undefined
              }
              footer={
                outbox?.relayRunningInThisProcess
                  ? "The relay is running in this process."
                  : "The relay is not running in this process (EVENT_OUTBOX_RELAY_MS unset here). Publish by hand above, or run it in a worker."
              }
            >
              <div className="grid gap-3 sm:grid-cols-4">
                <MetricTile
                  label="Waiting"
                  value={String(outbox?.pending ?? 0)}
                  unit="events"
                  tone={(outbox?.pending ?? 0) > 0 ? "warning" : "good"}
                  evidence={
                    <span className="text-muted-foreground">
                      recorded, not yet acknowledged
                    </span>
                  }
                />
                <MetricTile
                  label="Oldest waiting"
                  value={ageLabel(outbox?.oldestPendingAgeSeconds ?? null)}
                  tone={(outbox?.oldestPendingAgeSeconds ?? 0) > 300 ? "danger" : "neutral"}
                  evidence={
                    <span className="text-muted-foreground">
                      how far behind the relay is
                    </span>
                  }
                />
                <MetricTile
                  label="Undeliverable"
                  value={String(outbox?.undeliverable ?? 0)}
                  unit="events"
                  tone={(outbox?.undeliverable ?? 0) > 0 ? "danger" : "good"}
                  evidence={
                    <span className="text-muted-foreground">kept, needs an operator</span>
                  }
                />
                <MetricTile
                  label="Published"
                  value={String(outbox?.publishedLastHour ?? 0)}
                  unit="last hour"
                  tone="neutral"
                  evidence={
                    <span className="text-muted-foreground">broker acknowledged</span>
                  }
                />
              </div>
            </PanelCard>

            <PanelCard
              title="Consuming"
              description={consumer?.detail}
              className={consumer?.configured ? undefined : "border-amber-300"}
            >
              <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
                <Radio className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Group</span>
                <span className="font-mono">{consumer?.groupId ?? "—"}</span>
                <ToneBadge
                  tone={consumer?.running ? "good" : "warning"}
                  label={consumer?.running ? "running here" : "not running in this process"}
                />
              </div>

              {(inbox?.topics.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No event has been read back yet, so nothing can be said about the pipeline
                  beyond publishing.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Topic</TableHead>
                      <TableHead className="text-right">Consumed</TableHead>
                      <TableHead>Last event</TableHead>
                      <TableHead className="text-right">Median lag</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {inbox?.topics.map(topic => (
                      <TableRow key={topic.topic}>
                        <TableCell className="font-mono text-xs">{topic.topic}</TableCell>
                        <TableCell className="text-right">{topic.consumed}</TableCell>
                        <TableCell>
                          {topic.lastConsumedAt
                            ? new Date(topic.lastConsumedAt).toLocaleString()
                            : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          {topic.medianLagSeconds === null
                            ? "unknown"
                            : `${topic.medianLagSeconds}s`}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}

              {(inbox?.configuredWithNoEvents.length ?? 0) > 0 && (
                <p className="mt-4 text-sm text-amber-700">
                  Subscribed with nothing received:{" "}
                  <span className="font-mono">{inbox?.configuredWithNoEvents.join(", ")}</span> — a
                  producer with no reader looks identical to a working topic from the producer's
                  side, so it is named here.
                </p>
              )}
            </PanelCard>

            <PanelCard
              title="Undeliverable events"
              description="The broker refused these until the retries ran out. They are held with their payload, never dropped; fix the cause, then requeue."
              actions={
                (undeliverable.data?.events.length ?? 0) > 0 ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const result = await requeue.mutateAsync({});
                        setLastAction(`${result.requeued} event(s) requeued for publishing.`);
                        refreshAll();
                      } catch (error) {
                        setLastAction(
                          error instanceof Error ? error.message : "Requeue failed."
                        );
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Requeue all
                  </Button>
                ) : undefined
              }
            >
              {(undeliverable.data?.events.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No event has exhausted its retries.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Topic</TableHead>
                      <TableHead>Event</TableHead>
                      <TableHead className="text-right">Attempts</TableHead>
                      <TableHead>Broker said</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {undeliverable.data?.events.map(event => (
                      <TableRow key={event.id}>
                        <TableCell className="font-mono text-xs">{event.topic}</TableCell>
                        <TableCell className="font-mono text-xs">{event.eventKey}</TableCell>
                        <TableCell className="text-right">{event.attempts}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {event.lastError ?? "unknown"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </PanelCard>

            <PanelCard
              title="Dead letters"
              description="Events that need a decision: refused by the broker, or received in a form this platform could not read. Acknowledging one records who looked at it and changes nothing else."
            >
              {(deadLetters.data?.deadLetters.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing is waiting on a human.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Side</TableHead>
                      <TableHead>Topic</TableHead>
                      <TableHead>Event</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {deadLetters.data?.deadLetters.map(letter => (
                      <TableRow key={letter.id}>
                        <TableCell>
                          <ToneBadge
                            tone={letter.side === "produce" ? "danger" : "warning"}
                            label={letter.side === "produce" ? "not published" : "not readable"}
                          />
                        </TableCell>
                        <TableCell className="font-mono text-xs">{letter.topic}</TableCell>
                        <TableCell className="font-mono text-xs">{letter.eventKey}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {letter.reason}
                        </TableCell>
                        <TableCell className="text-right">
                          <AcknowledgeButton id={letter.id} onDone={refreshAll} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </PanelCard>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

function AcknowledgeButton({ id, onDone }: { id: number; onDone: () => void }) {
  const acknowledge = trpc.eventStream.acknowledgeDeadLetter.useMutation();
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={acknowledge.isPending}
      onClick={async () => {
        await acknowledge.mutateAsync({ id });
        onDone();
      }}
    >
      Acknowledge
    </Button>
  );
}
