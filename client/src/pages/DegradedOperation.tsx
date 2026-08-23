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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { AlertTriangle, Info, RefreshCw } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { MetricTile, PageHeader, PanelCard, ToneBadge } from "@/components/ops";
import {
  OBSERVATION_COPY,
  capabilityCopy,
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
} from "@/lib/degraded-operation";

function DependencyRow({ posture }: { posture: DependencyPosture }) {
  const copy = STATE_COPY[posture.state];
  const observation = posture.lastObservation;
  const ratio = stalenessRatio(posture);

  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{dependencyLabel(posture.dependency)}</div>
        <div className="font-mono text-xs text-muted-foreground">
          {posture.dependency}
        </div>
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
          treated as unobserved after{" "}
          {Math.round(posture.stalenessSeconds / 60)}m
          {ratio !== null && ratio > 1 ? " — past it" : ""}
        </div>
      </TableCell>
      <TableCell className="max-w-md text-xs text-muted-foreground">
        {posture.reason}
      </TableCell>
    </TableRow>
  );
}

function ActionRow({
  action,
  onReconciled,
}: {
  action: DegradedAction;
  onReconciled: () => void;
}) {
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
        <div className="font-mono text-xs text-muted-foreground">
          {action.subject}
        </div>
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
            onClick={() =>
              reconcile.mutate({ id: action.id, note: note.trim() })
            }
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
  const posture = trpc.degradedOperation.posture.useQuery(undefined, {
    enabled: isAdmin,
  });
  const actions = trpc.degradedOperation.openActions.useQuery(undefined, {
    enabled: isAdmin,
  });

  if (!isAdmin) {
    return (
      <DashboardLayout>
        <Card>
          <CardHeader>
            <CardTitle>Platform dependencies</CardTitle>
            <CardDescription>
              Dependency posture and degraded actions are visible to platform
              administrators only.
            </CardDescription>
          </CardHeader>
        </Card>
      </DashboardLayout>
    );
  }

  const dependencies = (posture.data?.dependencies ??
    []) as DependencyPosture[];
  const capabilities = (posture.data?.capabilities ?? []) as CapabilityStatus[];
  const openActions = (actions.data?.actions ?? []) as DegradedAction[];
  const summary = summarisePosture(dependencies, capabilities);
  const headline = postureHeadline(summary);

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeader
          title="Degraded operation"
          description="Every state here comes from a real call the platform made while doing work, not from a health probe a dependency can answer while every request to it fails."
          actions={
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
              <RefreshCw
                className={`mr-2 h-4 w-4 ${refreshing || posture.isFetching ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>
          }
          className="mb-0"
        />

        {posture.isError && (
          <Card className="border-red-300">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="h-4 w-4 text-red-600" />
                Posture could not be read
              </CardTitle>
              <CardDescription>
                {posture.error.message} — this is not an all-clear; nothing is
                known about the dependencies right now.
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {posture.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <>
            <PanelCard
              title={headline.text}
              description="Right now"
              className={
                headline.tone === "good" ? undefined : "border-amber-300"
              }
              footer={
                <>
                  Guard mode{" "}
                  <span className="font-mono">{posture.data?.guardMode}</span>
                  {posture.data?.guardMode === "observe"
                    ? " — non-binding capabilities may run degraded; money and market paths are refused regardless."
                    : " — every refused capability throws."}
                </>
              }
            >
              <div className="grid gap-3 sm:grid-cols-3">
                <MetricTile
                  label="Answering"
                  value={String(summary.up)}
                  unit="dependencies"
                  tone={summary.up > 0 ? "good" : "neutral"}
                  evidence={
                    <span className="text-muted-foreground">
                      a recent call to each succeeded
                    </span>
                  }
                />
                <MetricTile
                  label="Unobserved"
                  value={String(summary.unknown)}
                  unit="dependencies"
                  tone={summary.unknown > 0 ? "warning" : "good"}
                  evidence={
                    <span className="text-muted-foreground">
                      blocks the same paths an outage does
                    </span>
                  }
                />
                <MetricTile
                  label="In outage"
                  value={String(summary.down)}
                  unit="dependencies"
                  tone={summary.down > 0 ? "danger" : "good"}
                  evidence={
                    <span className="text-muted-foreground">
                      consecutive failures recorded
                    </span>
                  }
                />
              </div>
            </PanelCard>

            <PanelCard
              title="What the platform will and will not do"
              description="A refused capability is not a failure to display; it is the platform declining to produce a result that would look like the real thing."
              bodyClassName="grid gap-3 sm:grid-cols-2"
            >
              {capabilities.map(capability => {
                const copy = capabilityCopy(capability);
                return (
                  <div
                    key={capability.capability}
                    className="bg-muted/30 rounded-lg border p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">
                        {capabilityLabel(capability.capability)}
                      </span>
                      <ToneBadge
                        label={copy.label}
                        tone={copy.tone}
                        meaning={copy.meaning}
                      />
                    </div>
                    <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">
                      {capability.reason}
                    </p>
                    {capability.evidenceLimit && (
                      <p className="mt-1 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
                        {capability.evidenceLimit}
                      </p>
                    )}
                  </div>
                );
              })}
            </PanelCard>

            <PanelCard
              title="Dependencies"
              description="An unobserved dependency blocks the same paths an outage does. An outage opens after consecutive failures and closes only when a call succeeds."
              bodyClassName="px-0 py-0 overflow-x-auto"
            >
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
                    <DependencyRow
                      key={dependency.dependency}
                      posture={dependency}
                    />
                  ))}
                </TableBody>
              </Table>
            </PanelCard>

            <PanelCard
              title={`Actions taken without evidence (${openActions.length})`}
              description="Each row is something the platform did while it could not confirm the outcome. Reconciling one requires writing down what resolved it."
              className={
                openActions.length > 0 ? "border-amber-300" : undefined
              }
              bodyClassName="overflow-x-auto"
            >
              {openActions.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nothing open. This means no degraded action is outstanding —
                  not that dependencies are healthy; that is the table above.
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
            </PanelCard>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
