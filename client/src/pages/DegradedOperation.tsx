/**
 * "What is the platform refusing to do right now, and what did it do anyway?"
 *
 * The dashboard this screen is built against is the calm one: every tile green
 * because nothing has been called in an hour. So dependencies are shown by the
 * last real call made to them, an unobserved dependency is drawn as a warning
 * rather than as health, and the header leads with refusals — the refusals are
 * the operational consequence, not the dependency list.
 *
 * The open-actions table is the other half: everything the platform did without
 * its usual evidence, which stays open until an operator writes down what
 * resolved it.
 */

import { useState } from "react";

import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { AlertTriangle, Info, RefreshCw } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import {
  OBSERVATION_COPY,
  POSTURE_COPY,
  STATE_COPY,
  ageSeconds,
  capabilityLabel,
  dependencyLabel,
  formatAge,
  postureHeadline,
  stalenessRatio,
  summarisePosture,
  type CapabilityStatus,
  type DegradedAction,
  type DependencyPosture,
  type StateTone,
} from "@/lib/degraded-operation";

const TONE_CLASS: Record<StateTone, string> = {
  good: "bg-emerald-100 text-emerald-900 border-emerald-300",
  warning: "bg-amber-100 text-amber-900 border-amber-300",
  danger: "bg-red-100 text-red-900 border-red-300",
  neutral: "bg-muted text-muted-foreground border-border",
};

function ToneBadge({ label, tone, meaning }: { label: string; tone: StateTone; meaning?: string }) {
  const badge = (
    <Badge variant="outline" className={TONE_CLASS[tone]}>
      {label}
    </Badge>
  );
  if (!meaning) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-help items-center gap-1">
          {badge}
          <Info className="h-3 w-3 text-muted-foreground" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs">{meaning}</TooltipContent>
    </Tooltip>
  );
}

function DependencyRow({ posture }: { posture: DependencyPosture }) {
  const copy = STATE_COPY[posture.state];
  const observation = posture.lastObservation;
  const ratio = stalenessRatio(posture);

  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{dependencyLabel(posture.dependency)}</div>
        <div className="font-mono text-xs text-muted-foreground">{posture.dependency}</div>
      </TableCell>
      <TableCell>
        <ToneBadge label={copy.label} tone={copy.tone} meaning={copy.meaning} />
      </TableCell>
      <TableCell className="text-xs">
        {observation ? (
          <>
            <div>{OBSERVATION_COPY[observation.observation].label}</div>
            <div className="text-muted-foreground">
              {observation.operation} · {observation.observedBy}
            </div>
          </>
        ) : (
          <span className="text-muted-foreground">No call recorded</span>
        )}
      </TableCell>
      <TableCell className="text-xs">
        {formatAge(ageSeconds(observation?.observedAt ?? null))}
        <div className="text-muted-foreground">
          {/* The bound, not a guess: past it, the observation stops supporting `up`. */}
          treated as unobserved after {Math.round(posture.stalenessSeconds / 60)}m
          {ratio !== null && ratio > 1 ? " — past it" : ""}
        </div>
      </TableCell>
      <TableCell className="max-w-md text-xs text-muted-foreground">{posture.reason}</TableCell>
    </TableRow>
  );
}

function ActionRow({ action, onReconciled }: { action: DegradedAction; onReconciled: () => void }) {
  const [note, setNote] = useState("");
  const reconcile = trpc.degradedOperation.reconcile.useMutation({
    onSuccess: () => {
      setNote("");
      onReconciled();
    },
  });

  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{capabilityLabel(action.capability)}</div>
        <div className="font-mono text-xs text-muted-foreground">{action.subject}</div>
      </TableCell>
      <TableCell className="text-xs">
        <div className="flex flex-wrap gap-1">
          {action.missingDependencies.map(dependency => (
            <Badge key={dependency} variant="secondary" className="font-normal">
              {dependencyLabel(dependency)}
            </Badge>
          ))}
        </div>
      </TableCell>
      <TableCell className="max-w-sm text-xs text-muted-foreground">
        {action.evidenceLimit}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {new Date(action.actedAt).toLocaleString()}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Input
            value={note}
            placeholder="Evidence that resolved it"
            className="h-8 w-56 text-xs"
            onChange={event => setNote(event.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={note.trim().length < 10 || reconcile.isPending}
            onClick={() => reconcile.mutate({ id: action.id, note: note.trim() })}
          >
            Reconcile
          </Button>
        </div>
        {reconcile.isError && (
          <p className="mt-1 text-xs text-red-600">{reconcile.error.message}</p>
        )}
      </TableCell>
    </TableRow>
  );
}

export default function DegradedOperation() {
  const { user } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const isAdmin = user?.role === "admin";
  const posture = trpc.degradedOperation.posture.useQuery(undefined, { enabled: isAdmin });
  const actions = trpc.degradedOperation.openActions.useQuery(undefined, { enabled: isAdmin });

  if (!isAdmin) {
    return (
      <DashboardLayout>
        <Card>
          <CardHeader>
            <CardTitle>Platform dependencies</CardTitle>
            <CardDescription>
              Dependency posture and degraded actions are visible to platform administrators only.
            </CardDescription>
          </CardHeader>
        </Card>
      </DashboardLayout>
    );
  }

  const dependencies = (posture.data?.dependencies ?? []) as DependencyPosture[];
  const capabilities = (posture.data?.capabilities ?? []) as CapabilityStatus[];
  const openActions = (actions.data?.actions ?? []) as DegradedAction[];
  const summary = summarisePosture(dependencies, capabilities);
  const headline = postureHeadline(summary);

  return (
    <TooltipProvider>
      <DashboardLayout>
        <div className="space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold">Degraded operation</h1>
              <p className="max-w-3xl text-sm text-muted-foreground">
                Every state here comes from a real call the platform made while doing work, not from
                a health probe a dependency can answer while every request to it fails.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={refreshing || posture.isFetching}
              onClick={async () => {
                setRefreshing(true);
                try {
                  await Promise.all([posture.refetch(), actions.refetch()]);
                } finally {
                  setRefreshing(false);
                }
              }}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>

          {posture.isError && (
            <Card className="border-red-300">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <AlertTriangle className="h-4 w-4 text-red-600" />
                  Posture could not be read
                </CardTitle>
                <CardDescription>
                  {posture.error.message} — this is not an all-clear; nothing is known about the
                  dependencies right now.
                </CardDescription>
              </CardHeader>
            </Card>
          )}

          {posture.isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <>
              <Card className={headline.tone === "good" ? undefined : "border-amber-300"}>
                <CardHeader className="pb-2">
                  <CardDescription>Right now</CardDescription>
                  <CardTitle className="text-xl">{headline.text}</CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">
                  {summary.up} answering · {summary.unknown} unobserved · {summary.down} in outage.
                  Guard mode <span className="font-mono">{posture.data?.guardMode}</span>
                  {posture.data?.guardMode === "observe"
                    ? " — non-binding capabilities may run degraded; money and market paths are refused regardless."
                    : " — every refused capability throws."}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">What the platform will and will not do</CardTitle>
                  <CardDescription>
                    A refused capability is not a failure to display; it is the platform declining to
                    produce a result that would look like the real thing.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 sm:grid-cols-2">
                  {capabilities.map(capability => {
                    const copy = POSTURE_COPY[capability.posture];
                    return (
                      <div key={capability.capability} className="rounded-md border p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">{capabilityLabel(capability.capability)}</span>
                          <ToneBadge label={copy.label} tone={copy.tone} meaning={copy.meaning} />
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{capability.reason}</p>
                        {capability.evidenceLimit && (
                          <p className="mt-1 text-xs text-amber-700">{capability.evidenceLimit}</p>
                        )}
                      </div>
                    );
                  })}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Dependencies</CardTitle>
                  <CardDescription>
                    An unobserved dependency blocks the same paths an outage does. An outage opens
                    after consecutive failures and closes only when a call succeeds.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Dependency</TableHead>
                        <TableHead>State</TableHead>
                        <TableHead>Last call</TableHead>
                        <TableHead>Observed</TableHead>
                        <TableHead>Why</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {dependencies.map(dependency => (
                        <DependencyRow key={dependency.dependency} posture={dependency} />
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card className={openActions.length > 0 ? "border-amber-300" : undefined}>
                <CardHeader>
                  <CardTitle className="text-base">
                    Actions taken without evidence ({openActions.length})
                  </CardTitle>
                  <CardDescription>
                    Each row is something the platform did while it could not confirm the outcome.
                    Reconciling one requires writing down what resolved it.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {openActions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Nothing open. This means no degraded action is outstanding — not that
                      dependencies are healthy; that is the table above.
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Capability</TableHead>
                          <TableHead>Unavailable</TableHead>
                          <TableHead>What is not known</TableHead>
                          <TableHead>Acted</TableHead>
                          <TableHead>Reconcile</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {openActions.map(action => (
                          <ActionRow
                            key={action.id}
                            action={action}
                            onReconciled={() => {
                              void actions.refetch();
                            }}
                          />
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </DashboardLayout>
    </TooltipProvider>
  );
}
