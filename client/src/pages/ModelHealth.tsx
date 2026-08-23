/**
 * "Is there a trained model behind this prediction, and can we still prove it?"
 *
 * The registry existed long before a trainer did, so a row saying `production`
 * used to be the only evidence the platform had. This page shows what is
 * verifiable instead: where the training data came from (and, for synthetic data,
 * the generator and seed that reproduce it), what the run actually did, whether
 * the checkpoint still hashes to the bytes that were evaluated, and live accuracy
 * measured only over predictions whose actual has arrived.
 *
 * Nothing here is inferred from configuration. A model whose artifact cannot be
 * read from this process reads `not verifiable here`, never `verified`.
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
import { AlertTriangle, Boxes, RefreshCw } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { MetricTile, PageHeader, PanelCard, ToneBadge } from "@/components/ops";
import {
  ARTIFACT_STATE_COPY,
  JOB_STATUS_COPY,
  ORIGIN_COPY,
  TRAINING_RUN_STATE_COPY,
  USAGE_COPY,
  copyFor,
  metricLabel,
  provenanceLine,
  whenLabel,
  type ArtifactState,
  type DataOrigin,
  type UsageState,
} from "../../../shared/model-health-state";

export default function ModelHealth() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const overview = trpc.modelHealth.overview.useQuery({ limit: 50 }, { enabled: isAdmin });

  if (!isAdmin) {
    return (
      <DashboardLayout>
        <Card>
          <CardHeader>
            <CardTitle>Model health</CardTitle>
            <CardDescription>
              Model provenance and training state are visible to platform administrators only.
            </CardDescription>
          </CardHeader>
        </Card>
      </DashboardLayout>
    );
  }

  const models = overview.data?.models ?? [];
  const jobs = overview.data?.jobs ?? [];
  const production = models.filter(model => model.status === "production");
  const verifiedProduction = production.filter(
    model => model.artifact.state === "verified"
  ).length;
  const degraded = models.filter(model => model.accuracy.degraded).length;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeader
          title="Model health"
          description="Every registered version, the data it was trained on, and whether its weights can still be proved to be the ones that were evaluated. A row in the registry is not evidence that a model exists."
          actions={
            <Button
              variant="outline"
              size="sm"
              disabled={overview.isFetching}
              onClick={() => {
                void overview.refetch();
              }}
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${overview.isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          }
          className="mb-0"
        />

        {overview.isError && (
          <Card className="border-red-300">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="h-4 w-4 text-red-600" />
                Model state could not be read
              </CardTitle>
              <CardDescription>
                {overview.error.message} — nothing is known about what is serving right now; this is
                not an all-clear.
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {overview.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <PanelCard
            title="Registered versions"
            description={overview.data?.detail}
            className={
              overview.data && overview.data.unverifiedProduction > 0
                ? "border-amber-300"
                : undefined
            }
            footer={
              overview.data?.artifactDirConfigured
                ? "Checkpoints are re-hashed from ML_ARTIFACT_DIR as this page loads."
                : "ML_ARTIFACT_DIR is unset for this process, so artifacts can only be verified where the trainer wrote them."
            }
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <MetricTile
                label="Production weights verified"
                value={`${verifiedProduction}/${production.length}`}
                tone={
                  production.length === 0
                    ? "neutral"
                    : verifiedProduction === production.length
                      ? "good"
                      : "danger"
                }
                evidence={
                  <span className="text-muted-foreground">re-hashed against the training run</span>
                }
              />
              <MetricTile
                label="Trained on synthetic data"
                value={String(overview.data?.syntheticInProduction ?? 0)}
                unit="live versions"
                tone={(overview.data?.syntheticInProduction ?? 0) > 0 ? "warning" : "good"}
                evidence={
                  <span className="text-muted-foreground">
                    outputs are not evidence about the real fleet
                  </span>
                }
              />
              <MetricTile
                label="Measured degradation"
                value={String(degraded)}
                unit="versions"
                tone={degraded > 0 ? "danger" : "good"}
                evidence={
                  <span className="text-muted-foreground">
                    live MAE against held-out, actuals only
                  </span>
                }
              />
            </div>

            {models.length === 0 ? (
              <p className="mt-4 text-sm text-muted-foreground">
                No model version has ever been registered. Nothing on this platform is serving a
                trained model, and any figure presented as a forecast comes from somewhere else.
              </p>
            ) : (
              <Table className="mt-4">
                <TableHeader>
                  <TableRow>
                    <TableHead>Version</TableHead>
                    <TableHead>Data origin</TableHead>
                    <TableHead>Weights</TableHead>
                    <TableHead>Run</TableHead>
                    <TableHead className="text-right">Held-out MAE</TableHead>
                    <TableHead>Live accuracy</TableHead>
                    <TableHead>Use</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {models.map(model => {
                    const origin = (model.dataset?.origin ?? "unknown") as DataOrigin;
                    const originCopy = ORIGIN_COPY[origin];
                    const artifactCopy =
                      ARTIFACT_STATE_COPY[model.artifact.state as ArtifactState];
                    const usageCopy = USAGE_COPY[model.usage as UsageState];
                    const runCopy = model.run
                      ? copyFor(TRAINING_RUN_STATE_COPY, model.run.state)
                      : null;
                    return (
                      <TableRow key={model.id}>
                        <TableCell>
                          <div className="flex items-center gap-2 font-medium">
                            <Boxes className="h-4 w-4 text-muted-foreground" />
                            {model.modelName} {model.version}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {model.status}
                            {model.rolledBackFrom
                              ? ` · rolled back from ${model.rolledBackFrom.version}`
                              : ""}
                          </div>
                          <div className="mt-1 max-w-md text-xs text-muted-foreground">
                            {model.detail}
                          </div>
                        </TableCell>
                        <TableCell>
                          <ToneBadge
                            label={originCopy.label}
                            tone={originCopy.tone}
                            meaning={originCopy.meaning}
                          />
                          <div className="mt-1 text-xs text-muted-foreground">
                            {provenanceLine(origin, {
                              sourceObjects: model.dataset?.sourceObjects,
                              generator: model.dataset?.generator,
                              generatorVersion: model.dataset?.generatorVersion,
                              seed: model.dataset?.seed,
                            })}
                          </div>
                          {model.dataset && (
                            <div className="mt-1 max-w-md text-xs text-muted-foreground">
                              {model.dataset.detail}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <ToneBadge
                            label={artifactCopy.label}
                            tone={artifactCopy.tone}
                            meaning={artifactCopy.meaning}
                          />
                          <div className="mt-1 max-w-xs break-all font-mono text-xs text-muted-foreground">
                            {model.artifact.path ?? "no path recorded"}
                          </div>
                        </TableCell>
                        <TableCell>
                          {runCopy ? (
                            <>
                              <ToneBadge
                                label={runCopy.label}
                                tone={runCopy.tone}
                                meaning={runCopy.meaning}
                              />
                              <div className="mt-1 text-xs text-muted-foreground">
                                {model.run?.framework} {model.run?.frameworkVersion} ·{" "}
                                {model.run?.compute} · epoch {model.run?.bestEpoch ?? "?"}/
                                {model.run?.epochsRan}
                              </div>
                              {model.run?.refusalReason && (
                                <div className="mt-1 max-w-xs text-xs text-amber-700">
                                  {model.run.refusalReason}
                                </div>
                              )}
                              {model.run?.error && (
                                <div className="mt-1 max-w-xs text-xs text-red-700">
                                  {model.run.error}
                                </div>
                              )}
                            </>
                          ) : (
                            <span className="text-xs text-muted-foreground">no run linked</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {metricLabel(model.accuracy.heldOutMae, 1)}
                        </TableCell>
                        <TableCell>
                          <div className="max-w-xs text-xs text-muted-foreground">
                            {model.accuracy.detail}
                          </div>
                        </TableCell>
                        <TableCell>
                          <ToneBadge
                            label={usageCopy.label}
                            tone={usageCopy.tone}
                            meaning={usageCopy.meaning}
                          />
                          <div className="mt-1 text-xs text-muted-foreground">
                            {whenLabel(model.lastPredictionAt)}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </PanelCard>
        )}

        <PanelCard
          title="Retraining"
          description="Retraining is triggered by measured severe drift, measured live degradation, or an operator asking for it — never by a missing baseline. A refused job trained nothing and left the live model alone."
        >
          {overview.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No retraining job has been recorded, so no model here has been retrained by this
              platform.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>New version</TableHead>
                  <TableHead>Outcome</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map(job => {
                  const statusCopy = copyFor(JOB_STATUS_COPY, job.status);
                  return (
                    <TableRow key={job.jobId}>
                      <TableCell className="max-w-[12rem] truncate font-mono text-xs">
                        {job.jobId}
                      </TableCell>
                      <TableCell className="text-xs">{job.modelName ?? job.modelId}</TableCell>
                      <TableCell className="text-xs">
                        {job.triggerType}
                        {job.triggeredBy ? ` · ${job.triggeredBy}` : ""}
                      </TableCell>
                      <TableCell>
                        <ToneBadge
                          label={statusCopy.label}
                          tone={statusCopy.tone}
                          meaning={statusCopy.meaning}
                        />
                        <div className="mt-1 text-xs text-muted-foreground">
                          {whenLabel(job.completedAt ?? job.startedAt ?? job.createdAt)}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">{job.newModelVersion ?? "—"}</TableCell>
                      <TableCell className="max-w-[20rem] text-xs text-muted-foreground">
                        {job.errorMessage ??
                          job.promotionNote ??
                          (job.promoted === null
                            ? "—"
                            : job.promoted
                              ? "promoted on held-out evidence"
                              : "kept in staging; it did not beat the live model")}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </PanelCard>
      </div>
    </DashboardLayout>
  );
}
