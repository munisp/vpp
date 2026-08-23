/**
 * "Something is wrong — what does the platform's own data say?"
 *
 * An operator asks a question, and a *local* model (Ollama) answers from
 * observations taken out of PostgreSQL and the lakehouse bookkeeping seconds
 * earlier. Three things are deliberately visible on this page rather than hidden
 * behind a spinner:
 *
 *  - whether a model is available at all. No model means no answer; there is no
 *    template or canned response behind this button.
 *  - the observations themselves, with `unreadable` for any source that could not
 *    be queried. An operator can read them with no model in the loop.
 *  - the citations on each finding, which are checked against the observations that
 *    were supplied. Invented citations are counted, not shown as evidence.
 */

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertTriangle, Bot, RefreshCw, Search } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { MetricTile, PageHeader, PanelCard, ToneBadge } from "@/components/ops";
import {
  CONFIDENCE_TONE,
  availabilityCopy,
  diagnosticStateCopy,
  latencyLabel,
  measureLabel,
  modelStatusCopy,
  whenLabel,
} from "../../../shared/diagnostics-state";

const EXAMPLES = [
  "Why has settlement stopped completing for some trades?",
  "Is telemetry coverage good enough to bill on right now?",
  "Are events being lost between the platform and the lake?",
];

export default function Diagnostics() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [question, setQuestion] = useState(EXAMPLES[0]);

  const health = trpc.diagnostics.health.useQuery(undefined, { enabled: isAdmin });
  const evidence = trpc.diagnostics.evidence.useQuery(undefined, { enabled: isAdmin });
  const runs = trpc.diagnostics.runs.useQuery({ limit: 10 }, { enabled: isAdmin });
  const diagnose = trpc.diagnostics.diagnose.useMutation({
    onSuccess: () => {
      void runs.refetch();
      void evidence.refetch();
    },
  });

  if (!isAdmin) {
    return (
      <DashboardLayout>
        <Card>
          <CardHeader>
            <CardTitle>Diagnostics</CardTitle>
            <CardDescription>
              Diagnostic runs read payment, ledger and control state, so they are visible to
              platform administrators only.
            </CardDescription>
          </CardHeader>
        </Card>
      </DashboardLayout>
    );
  }

  const modelStatus = health.data
    ? modelStatusCopy(health.data)
    : { label: "unknown", tone: "neutral" as const };
  const observations = evidence.data?.observations ?? [];
  const result = diagnose.data;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeader
          title="Diagnostics"
          description="A local model answers from measurements taken out of this platform's own tables. When no model is available, or when a source cannot be read, the run is refused and says so — it never fills the gap with a plausible answer."
          actions={
            <Button
              variant="outline"
              size="sm"
              disabled={health.isFetching || evidence.isFetching}
              onClick={() => {
                void health.refetch();
                void evidence.refetch();
              }}
            >
              <RefreshCw
                className={`mr-2 h-4 w-4 ${health.isFetching || evidence.isFetching ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>
          }
          className="mb-0"
        />

        <PanelCard
          title="Local model"
          description={health.data?.detail ?? "Probing the configured Ollama endpoint."}
          footer="OLLAMA_URL and OLLAMA_MODEL. Nothing is sent to a hosted model from this page."
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <MetricTile
              label="Model"
              value={health.data?.requestedModel || "unset"}
              tone={modelStatus.tone}
              evidence={<span className="text-muted-foreground">{modelStatus.label}</span>}
            />
            <MetricTile
              label="Endpoint"
              value={health.data?.baseUrl || "unset"}
              tone={health.data?.reachable ? "good" : "danger"}
              evidence={
                <span className="text-muted-foreground">
                  {health.data?.version ? `ollama ${health.data.version}` : "no version reported"}
                </span>
              }
            />
            <MetricTile
              label="Models pulled"
              value={String(health.data?.models.length ?? 0)}
              tone={(health.data?.models.length ?? 0) > 0 ? "good" : "warning"}
              evidence={
                <span className="text-muted-foreground">
                  {health.data?.models.slice(0, 3).join(", ") || "none reported"}
                </span>
              }
            />
          </div>
        </PanelCard>

        <PanelCard
          title="Ask"
          description="The question is sent with the observations below, and only those."
        >
          <Textarea
            value={question}
            rows={3}
            onChange={event => setQuestion(event.target.value)}
            placeholder="What should I look at?"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            {EXAMPLES.map(example => (
              <Button
                key={example}
                variant="ghost"
                size="sm"
                className="text-xs"
                onClick={() => setQuestion(example)}
              >
                {example}
              </Button>
            ))}
          </div>
          <Button
            className="mt-4"
            disabled={diagnose.isPending || question.trim().length < 8}
            onClick={() => diagnose.mutate({ question })}
          >
            <Search className={`mr-2 h-4 w-4 ${diagnose.isPending ? "animate-pulse" : ""}`} />
            {diagnose.isPending ? "Asking the local model…" : "Diagnose"}
          </Button>

          {diagnose.isError && (
            <p className="mt-3 text-sm text-red-600">{diagnose.error.message}</p>
          )}

          {result?.state === "refused" && (
            <Card className="mt-4 border-amber-300">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  Refused — no diagnosis was produced
                </CardTitle>
                <CardDescription>{result.reason}</CardDescription>
              </CardHeader>
            </Card>
          )}

          {result?.state === "succeeded" && (
            <div className="mt-4 space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Bot className="h-4 w-4 text-muted-foreground" />
                    {result.model} answered in {latencyLabel(result.latencyMs)}
                  </CardTitle>
                  <CardDescription>{result.answer}</CardDescription>
                </CardHeader>
              </Card>

              {result.findings.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  The model reported no finding against these observations. That is not a
                  clean bill of health for anything the observations do not cover.
                </p>
              ) : (
                result.findings.map((finding, index) => (
                  <Card key={`${finding.title}-${index}`}>
                    <CardHeader>
                      <div className="flex items-start justify-between gap-3">
                        <CardTitle className="text-base">{finding.title}</CardTitle>
                        <ToneBadge
                          label={`${finding.confidence} confidence`}
                          tone={CONFIDENCE_TONE[finding.confidence] ?? "neutral"}
                          meaning="The model's own confidence. It is not a measurement."
                        />
                      </div>
                      <CardDescription>{finding.hypothesis}</CardDescription>
                      <p className="mt-2 text-sm">
                        <span className="font-medium">Check:</span> {finding.recommendedAction}
                      </p>
                      <p className="mt-2 font-mono text-xs text-muted-foreground">
                        cites: {finding.observationIds.join(", ")}
                      </p>
                    </CardHeader>
                  </Card>
                ))
              )}

              {result.rejectedCitations > 0 && (
                <p className="text-sm text-amber-700">
                  {result.rejectedCitations} citation(s) named observations that were never
                  supplied and were dropped. Treat this model's output with more suspicion, not
                  less.
                </p>
              )}
            </div>
          )}
        </PanelCard>

        <PanelCard
          title="Observations"
          description={evidence.data?.detail ?? "Collected from PostgreSQL and lakehouse bookkeeping."}
          footer="An unreadable source is unknown. It is never counted as zero or as healthy."
        >
          {evidence.isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : evidence.isError ? (
            <p className="text-sm text-red-600">{evidence.error.message}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Observation</TableHead>
                  <TableHead>Read</TableHead>
                  <TableHead>Measures</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {observations.map(observation => {
                  const copy = availabilityCopy(observation.available);
                  return (
                    <TableRow key={observation.id}>
                      <TableCell>
                        <div className="font-medium">{observation.title}</div>
                        <div className="font-mono text-xs text-muted-foreground">
                          {observation.id}
                        </div>
                        <div className="mt-1 max-w-md text-xs text-muted-foreground">
                          {observation.detail}
                        </div>
                      </TableCell>
                      <TableCell>
                        <ToneBadge label={copy.label} tone={copy.tone} meaning={observation.detail} />
                      </TableCell>
                      <TableCell className="text-xs">
                        {Object.entries(observation.measures).map(([key, value]) => (
                          <div key={key}>
                            <span className="text-muted-foreground">{key}:</span>{" "}
                            {measureLabel(value)}
                          </div>
                        ))}
                      </TableCell>
                      <TableCell className="max-w-[14rem] truncate font-mono text-xs">
                        {observation.source}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </PanelCard>

        <PanelCard
          title="Past runs"
          description="Refusals are kept alongside answers, with the evidence digest each was based on."
        >
          {runs.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (runs.data?.runs.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">
              No diagnostic run has been recorded on this deployment.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Question</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Findings</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(runs.data?.runs ?? []).map(run => {
                  const copy = diagnosticStateCopy(run.state);
                  return (
                    <TableRow key={run.id}>
                      <TableCell className="text-xs">{whenLabel(run.startedAt)}</TableCell>
                      <TableCell>
                        <ToneBadge label={copy.label} tone={copy.tone} meaning={copy.meaning} />
                      </TableCell>
                      <TableCell className="max-w-[18rem]">
                        <div className="truncate">{run.question}</div>
                        <div className="mt-1 max-w-[18rem] text-xs text-muted-foreground">
                          {run.refusalReason ?? run.answer ?? ""}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">{run.model ?? "—"}</TableCell>
                      <TableCell className="text-right">{run.findings.length}</TableCell>
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
