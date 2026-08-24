/**
 * "Which stakeholder scenarios has this deployment actually executed?"
 *
 * The catalog of journeys is a contract, not a report: it lists the twenty
 * stakeholder scenarios, the services each step calls and the routes each step
 * puts data behind. This page shows the contract next to the evidence — the
 * latest run of each journey, step by step, with the facts the step recorded.
 *
 * Nothing here is inferred from the catalog. A journey the platform has never
 * run reads `not run`, and a step blocked on an absent provider is excluded
 * from the score rather than counted as a pass.
 */

import { Fragment, useState } from "react";

import DashboardLayout from "@/components/DashboardLayout";
import { MetricTile, PageHeader, PanelCard, ToneBadge } from "@/components/ops";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, PlayCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import {
  JOURNEY_STATUS_COPY,
  OUTCOME_COPY,
  scoreCaveat,
} from "../../../../shared/journey-state";
import {
  EXTERNAL_DEPENDENCY_LABELS,
  JOURNEYS,
  journeyStatus,
  type ExternalDependency,
} from "../../../../shared/journeys";

function factLine(facts: Record<string, string | number | boolean | null>): string {
  const entries = Object.entries(facts);
  if (entries.length === 0) return "no facts recorded";
  return entries.map(([key, value]) => `${key}=${value === null ? "none" : value}`).join(" · ");
}

export default function JourneyAssurance() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [label, setLabel] = useState(`suite-${new Date().toISOString().slice(0, 10)}`);
  const [memberUserId, setMemberUserId] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const report = trpc.journeys.report.useQuery(undefined, { enabled: isAdmin });
  const coverage = trpc.journeys.coverage.useQuery(undefined, { enabled: isAdmin });
  const utils = trpc.useUtils();

  const startSuite = trpc.journeys.startSuite.useMutation({
    onSuccess: started => {
      toast.success(`Suite ${started.suiteRunKey} dispatched to Temporal`);
      void utils.journeys.report.invalidate();
    },
    onError: error => {
      toast.error(error.message);
    },
  });

  if (!isAdmin) {
    return (
      <DashboardLayout>
        <Card>
          <CardHeader>
            <CardTitle>Journey assurance</CardTitle>
            <CardDescription>
              Journey runs carry other members' asset, offer and payment identifiers, so they are
              visible to platform administrators only.
            </CardDescription>
          </CardHeader>
        </Card>
      </DashboardLayout>
    );
  }

  const runs = report.data?.runs ?? [];
  const summary = report.data?.summary;
  const unimplemented = report.data?.unimplementedSteps ?? [];
  const runByJourney = new Map(runs.map(run => [run.journeyId, run]));

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeader
          title="Journey assurance"
          description="Twenty stakeholder journeys, each a durable Temporal workflow over the platform's own services. The status of each is its latest run — an old pass does not survive a later failure."
          caveat={
            summary
              ? scoreCaveat(summary.stepsBlocked, summary.notRun)
              : "No journey has been run on this deployment yet."
          }
          actions={
            <Button
              variant="outline"
              size="sm"
              disabled={report.isFetching}
              onClick={() => {
                void report.refetch();
              }}
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${report.isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          }
          className="mb-0"
        />

        {report.isError && (
          <Card className="border-red-300">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="h-4 w-4 text-red-600" />
                Journey history could not be read
              </CardTitle>
              <CardDescription>
                {report.error.message} — nothing is known about what has been exercised; this is not
                an all-clear.
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        <PanelCard
          title="Score"
          description="Steps that were exercisable and behaved, over all exercisable steps."
          footer="A refusal counts as a pass: declining to act without evidence is the behaviour under test. Blocked steps are excluded entirely."
        >
          <div className="grid gap-3 sm:grid-cols-4">
            <MetricTile
              label="Exercisable score"
              value={
                summary?.exercisableScorePct === null || summary === undefined
                  ? null
                  : `${summary.exercisableScorePct}%`
              }
              tone={
                summary === undefined || summary.exercisableScorePct === null
                  ? "neutral"
                  : summary.stepsFailed > 0
                    ? "danger"
                    : "good"
              }
              evidence={
                <span className="text-muted-foreground">
                  {summary
                    ? `${summary.stepsPassed} passed · ${summary.stepsRefused} refused · ${summary.stepsFailed} failed`
                    : "no run recorded"}
                </span>
              }
            />
            <MetricTile
              label="Journeys passed"
              value={summary ? `${summary.passed}/${summary.journeys}` : null}
              tone={summary && summary.failed > 0 ? "danger" : "good"}
              evidence={
                <span className="text-muted-foreground">latest run of each journey</span>
              }
            />
            <MetricTile
              label="Blocked on external"
              value={summary ? String(summary.stepsBlocked) : null}
              unit="steps"
              tone={summary && summary.stepsBlocked > 0 ? "warning" : "good"}
              evidence={
                <span className="text-muted-foreground">no provider, broker or cluster</span>
              }
            />
            <MetricTile
              label="Never run here"
              value={summary ? String(summary.notRun) : null}
              unit="journeys"
              tone={summary && summary.notRun > 0 ? "warning" : "good"}
              evidence={<span className="text-muted-foreground">nothing is known about these</span>}
            />
          </div>

          {unimplemented.length > 0 && (
            <p className="mt-4 text-sm text-red-600">
              {unimplemented.length} catalog step
              {unimplemented.length === 1 ? " has" : "s have"} no implementation behind them, so the
              score above is over an incomplete suite.
            </p>
          )}
        </PanelCard>

        <PanelCard
          title="Run the suite"
          description="Dispatches one Temporal workflow per journey, on behalf of the member you name. Re-running the same label resumes that run rather than duplicating it."
          footer="If no Temporal server is reachable this refuses — a suite reporting 'started' with no workflow behind it is the mockware these journeys exist to catch."
        >
          <div className="flex flex-wrap items-end gap-3">
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground block text-xs uppercase">Run label</span>
              <Input value={label} onChange={event => setLabel(event.target.value)} className="w-56" />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground block text-xs uppercase">Member user id</span>
              <Input
                value={memberUserId}
                inputMode="numeric"
                onChange={event => setMemberUserId(event.target.value)}
                className="w-40"
              />
            </label>
            <Button
              disabled={startSuite.isPending || !label.trim() || !/^\d+$/.test(memberUserId)}
              onClick={() => {
                startSuite.mutate({ label: label.trim(), memberUserId: Number(memberUserId) });
              }}
            >
              <PlayCircle className="mr-2 h-4 w-4" />
              {startSuite.isPending ? "Dispatching…" : "Run all journeys"}
            </Button>
          </div>
          {startSuite.isError && (
            <p className="mt-3 text-sm text-red-600">{startSuite.error.message}</p>
          )}
        </PanelCard>

        {report.isLoading ? (
          <Skeleton className="h-96 w-full" />
        ) : (
          <PanelCard
            title="Journeys"
            description="Each journey, its stakeholder, and the state of its latest run."
            footer="Expand a journey to see every step, the service it called and the facts it recorded."
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Journey</TableHead>
                  <TableHead>Stakeholder</TableHead>
                  <TableHead>Steps</TableHead>
                  <TableHead>External needs</TableHead>
                  <TableHead>Latest run</TableHead>
                  <TableHead>State</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {JOURNEYS.map(journey => {
                  const run = runByJourney.get(journey.id);
                  const status = journeyStatus(
                    run?.steps ?? [],
                    journey.steps.map(step => step.id)
                  );
                  const statusCopy = JOURNEY_STATUS_COPY[status];
                  const needs = [
                    ...new Set(journey.steps.flatMap(step => step.requires ?? [])),
                  ] as ExternalDependency[];
                  const isOpen = expanded === journey.id;
                  return (
                    <Fragment key={journey.id}>
                      <TableRow
                        className="cursor-pointer"
                        onClick={() => setExpanded(isOpen ? null : journey.id)}
                      >
                        <TableCell>
                          <div className="font-medium">{journey.title}</div>
                          <div className="text-muted-foreground text-xs">{journey.id}</div>
                        </TableCell>
                        <TableCell className="text-sm">{journey.stakeholder}</TableCell>
                        <TableCell className="text-sm">
                          {run ? `${run.steps.length}/${journey.steps.length}` : `0/${journey.steps.length}`}
                        </TableCell>
                        <TableCell className="text-muted-foreground max-w-xs text-xs">
                          {needs.length === 0
                            ? "none"
                            : needs.map(need => EXTERNAL_DEPENDENCY_LABELS[need]).join(", ")}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs">
                          {run ? new Date(run.startedAt).toLocaleString() : "never"}
                        </TableCell>
                        <TableCell>
                          <ToneBadge
                            label={statusCopy.label}
                            tone={statusCopy.tone}
                            meaning={statusCopy.meaning}
                          />
                        </TableCell>
                      </TableRow>
                      {isOpen && (
                        <TableRow>
                          <TableCell colSpan={6} className="bg-muted/40">
                            <ul className="space-y-2">
                              {journey.steps.map(step => {
                                const result = run?.steps.find(
                                  candidate => candidate.stepId === step.id
                                );
                                const outcomeCopy = result ? OUTCOME_COPY[result.outcome] : null;
                                return (
                                  <li key={step.id} className="text-sm">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="font-medium">{step.title}</span>
                                      {outcomeCopy ? (
                                        <ToneBadge
                                          label={outcomeCopy.label}
                                          tone={outcomeCopy.tone}
                                          meaning={outcomeCopy.meaning}
                                        />
                                      ) : (
                                        <ToneBadge
                                          label="not run"
                                          tone="neutral"
                                          meaning="This step has not been executed in the latest run."
                                        />
                                      )}
                                    </div>
                                    <div className="text-muted-foreground text-xs">
                                      {step.services.join(", ")}
                                    </div>
                                    {result && (
                                      <div className="text-xs">
                                        {result.detail}
                                        <span className="text-muted-foreground">
                                          {" "}
                                          — {factLine(result.facts)}
                                        </span>
                                      </div>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </PanelCard>
        )}

        <PanelCard
          title="Route and screen coverage"
          description="Computed from each app's own navigation, so a page added to either app appears here as uncovered."
          footer="Coverage means a journey puts data behind the route, not that the rendered page was inspected in a browser."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-sm font-medium">
                Web routes: {coverage.data?.web.covered.length ?? 0} covered,{" "}
                {coverage.data?.web.uncovered.length ?? 0} uncovered
              </p>
              <p className="text-muted-foreground mt-1 text-xs">
                {coverage.data?.web.uncovered.length
                  ? coverage.data.web.uncovered.join(", ")
                  : "Every navigation route is exercised by a journey."}
              </p>
            </div>
            <div>
              <p className="text-sm font-medium">
                Mobile screens: {coverage.data?.mobile.covered.length ?? 0} covered,{" "}
                {coverage.data?.mobile.uncovered.length ?? 0} uncovered
              </p>
              <p className="text-muted-foreground mt-1 text-xs">
                {coverage.data?.mobile.uncovered.length
                  ? coverage.data.mobile.uncovered.join(", ")
                  : "Every mobile screen is exercised by a journey."}
              </p>
            </div>
          </div>
        </PanelCard>
      </div>
    </DashboardLayout>
  );
}
