/**
 * "Is anything actually in the lake, and how far behind is it?"
 *
 * The infrastructure audit found a lakehouse that was documentation and a client
 * nobody called: the analytics story described Iceberg tables while no job ran and
 * no dataset had ever been written. This page can only show what the ingestion job
 * recorded — a dataset with no runs reads `never ingested`, a failed run shows the
 * job's own error, and every successful run names the object and digest that was
 * read back out of the store.
 *
 * Backlog is counted against the source table, so "behind by N rows" is measured,
 * not inferred; when the source cannot be counted it says `unknown` rather than 0.
 */

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
import { AlertTriangle, Database, RefreshCw } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { MetricTile, PageHeader, PanelCard, ToneBadge } from "@/components/ops";
import {
  DATASET_STATE_COPY,
  backlogLabel,
  bytesLabel,
  runStateCopy,
  whenLabel,
  type DatasetState,
} from "../../../shared/lakehouse-state";

export default function Lakehouse() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const status = trpc.lakehouse.status.useQuery(undefined, { enabled: isAdmin });
  const runs = trpc.lakehouse.runs.useQuery({ limit: 25 }, { enabled: isAdmin });

  if (!isAdmin) {
    return (
      <DashboardLayout>
        <Card>
          <CardHeader>
            <CardTitle>Lakehouse</CardTitle>
            <CardDescription>
              Ingestion state is visible to platform administrators only.
            </CardDescription>
          </CardHeader>
        </Card>
      </DashboardLayout>
    );
  }

  const refreshing = status.isFetching || runs.isFetching;
  const datasets = status.data?.datasets ?? [];
  const behindKnown = datasets.filter(dataset => dataset.rowsBehind !== null);
  const totalBehind = behindKnown.reduce((sum, dataset) => sum + (dataset.rowsBehind ?? 0), 0);

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeader
          title="Lakehouse ingestion"
          description="Platform tables are ingested into the lake incrementally, and a run is only recorded as succeeded once its object has been read back and its digest matched. What is shown here is what the job recorded, not what is configured."
          actions={
            <Button
              variant="outline"
              size="sm"
              disabled={refreshing}
              onClick={() => {
                void status.refetch();
                void runs.refetch();
              }}
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          }
          className="mb-0"
        />

        {status.isError && (
          <Card className="border-red-300">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="h-4 w-4 text-red-600" />
                Ingestion state could not be read
              </CardTitle>
              <CardDescription>
                {status.error.message} — nothing is known about what is in the lake right now; this
                is not an all-clear.
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {status.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <PanelCard
            title="Datasets"
            description={status.data?.detail}
            className={status.data && !status.data.allFresh ? "border-amber-300" : undefined}
            footer={`Freshness budget: ${status.data?.freshnessSeconds ?? 0}s (LAKEHOUSE_FRESHNESS_SECONDS). A dataset is fresh only when a run finished inside it.`}
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <MetricTile
                label="Datasets ingesting"
                value={`${datasets.filter(dataset => dataset.state === "fresh").length}/${datasets.length}`}
                tone={status.data?.allFresh ? "good" : "warning"}
                evidence={<span className="text-muted-foreground">fresh within the budget</span>}
              />
              <MetricTile
                label="Rows not yet in the lake"
                value={behindKnown.length === datasets.length ? String(totalBehind) : `≥ ${totalBehind}`}
                unit="rows"
                tone={totalBehind > 0 ? "warning" : "good"}
                evidence={
                  <span className="text-muted-foreground">
                    {behindKnown.length === datasets.length
                      ? "counted against every source table"
                      : `${datasets.length - behindKnown.length} source table(s) could not be counted`}
                  </span>
                }
              />
              <MetricTile
                label="Never ingested"
                value={String(datasets.filter(dataset => dataset.state === "never_run").length)}
                unit="datasets"
                tone={datasets.some(dataset => dataset.state === "never_run") ? "danger" : "good"}
                evidence={<span className="text-muted-foreground">no run has ever written them</span>}
              />
            </div>

            <Table className="mt-4">
              <TableHeader>
                <TableRow>
                  <TableHead>Dataset</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="text-right">Rows ingested</TableHead>
                  <TableHead className="text-right">Behind</TableHead>
                  <TableHead>Last success</TableHead>
                  <TableHead>Evidence</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {datasets.map(dataset => {
                  const copy = DATASET_STATE_COPY[dataset.state as DatasetState];
                  return (
                    <TableRow key={dataset.dataset}>
                      <TableCell>
                        <div className="flex items-center gap-2 font-medium">
                          <Database className="h-4 w-4 text-muted-foreground" />
                          {dataset.dataset}
                        </div>
                        <div className="text-xs text-muted-foreground">{dataset.description}</div>
                      </TableCell>
                      <TableCell>
                        <ToneBadge label={copy.label} tone={copy.tone} meaning={copy.meaning} />
                        <div className="mt-1 max-w-md text-xs text-muted-foreground">
                          {dataset.detail}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">{dataset.rowsIngested}</TableCell>
                      <TableCell className="text-right">
                        {backlogLabel(dataset.rowsBehind)}
                      </TableCell>
                      <TableCell className="text-xs">{whenLabel(dataset.lastSuccessAt)}</TableCell>
                      <TableCell className="max-w-[16rem] truncate font-mono text-xs">
                        {dataset.lastObjectKey ?? "no object"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </PanelCard>
        )}

        <PanelCard
          title="Recent runs"
          description="Every attempt, including the ones that found nothing and the ones that failed. An empty run is not a successful load."
        >
          {runs.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (runs.data?.runs.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">
              No ingestion run has been recorded. The job (`python -m lakehouse`) has not run
              against this database.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Dataset</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead>Finished</TableHead>
                  <TableHead>Object / error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(runs.data?.runs ?? []).map(run => (
                  <TableRow key={run.id}>
                    <TableCell className="font-medium">{run.dataset}</TableCell>
                    <TableCell>
                      <ToneBadge
                        label={runStateCopy(run.state).label}
                        tone={runStateCopy(run.state).tone}
                        meaning={runStateCopy(run.state).meaning}
                      />
                    </TableCell>
                    <TableCell className="text-right">{run.rowsWritten}</TableCell>
                    <TableCell className="text-right">{bytesLabel(run.bytesWritten)}</TableCell>
                    <TableCell className="text-xs">{whenLabel(run.finishedAt)}</TableCell>
                    <TableCell className="max-w-[20rem] truncate font-mono text-xs">
                      {run.error ?? run.objectKey ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </PanelCard>
      </div>
    </DashboardLayout>
  );
}
