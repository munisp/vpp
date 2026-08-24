/**
 * "Can this feeder carry what we are about to ask of it?"
 *
 * Dispatch and flexibility awards are now checked against a recorded electrical
 * model, so an operator needs to see three things here: whether a node is
 * modelled at all, what a study concluded, and — when it concluded nothing —
 * which missing survey or unreachable engine is the reason. An unmodelled node
 * reads as unmodelled: the platform will still dispatch, but everything it
 * issues is stamped network-unchecked rather than approved.
 */

import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { AlertTriangle, Activity, Network, Plug, RefreshCw, ShieldCheck } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/_core/hooks/useAuth";
import { MetricTile, PageHeader, PanelCard, ToneBadge } from "@/components/ops";
import type { StateTone } from "@/lib/tone";
import {
  FEASIBILITY_STATUS_COPY,
  type FeasibilityStatus,
  type Tone as CopyTone,
  violationKindLabel,
  wattsLabel,
} from "../../../shared/network-feasibility-copy";

/** The shared copy speaks of a bad state; the design system calls it danger. */
const COPY_TONE: Record<CopyTone, StateTone> = {
  good: "good",
  warning: "warning",
  bad: "danger",
  neutral: "neutral",
};

export default function NetworkFeasibility() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const utils = trpc.useUtils();
  const service = trpc.networkModel.serviceStatus.useQuery(undefined, { enabled: isAdmin });
  const nodes = trpc.locationalFlexibility.nodes.useQuery(
    {},
    { enabled: isAdmin, retry: false }
  );

  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);
  const nodeId = selectedNodeId ?? nodes.data?.[0]?.nodeId ?? null;
  const node = useMemo(
    () => (nodes.data ?? []).find(candidate => candidate.nodeId === nodeId) ?? null,
    [nodes.data, nodeId]
  );

  const summary = trpc.networkModel.summary.useQuery(
    { nodeId: nodeId! },
    { enabled: isAdmin && nodeId !== null, retry: false }
  );
  const studies = trpc.networkModel.studies.useQuery(
    { nodeId: nodeId!, limit: 25 },
    { enabled: isAdmin && nodeId !== null, retry: false }
  );

  const [candidateKw, setCandidateKw] = useState("");
  const [hostingCeilingKw, setHostingCeilingKw] = useState("500");

  const study = trpc.networkModel.study.useMutation({
    onSuccess: result => {
      if (result.status === "feasible") toast.success("Study solved: within limits");
      else toast.message(FEASIBILITY_STATUS_COPY[result.status].label, {
        description: result.reason ?? FEASIBILITY_STATUS_COPY[result.status].meaning,
      });
      void utils.networkModel.studies.invalidate();
    },
    onError: error => toast.error(error.message),
  });

  const result = study.data ?? null;
  const resultCopy = result ? FEASIBILITY_STATUS_COPY[result.status as FeasibilityStatus] : null;
  const refreshing = summary.isFetching || studies.isFetching;

  function runStudy() {
    if (nodeId === null || !node) return;
    const deltaKw = Number(candidateKw);
    const ceilingKw = Number(hostingCeilingKw);
    study.mutate({
      nodeId,
      reference: `enquiry:${node.code}`,
      candidate:
        Number.isFinite(deltaKw) && deltaKw !== 0 && candidateKw.trim() !== ""
          ? [{ bus: node.code, delta_p_w: deltaKw * 1000, reference: "connection enquiry" }]
          : undefined,
      hostingCapacity:
        Number.isFinite(ceilingKw) && ceilingKw > 0
          ? [{ bus: node.code, direction: "injection", limit_w: ceilingKw * 1000 }]
          : undefined,
    });
  }

  if (!isAdmin) {
    return (
      <DashboardLayout>
        <PageHeader
          title="Network feasibility"
          description="Conductor impedances, transformer ratings and which element limits a feeder are network information, so this page is for platform administrators only."
        />
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeader
          title="Network feasibility"
          description="Power flow and hosting capacity over the recorded electrical model — line impedances, transformer ratings and the measured base case behind each node."
          caveat="Only 'within limits' means the network was checked. Not modelled, no solution and engine unreachable all mean nobody has been told whether the feeder holds, and any dispatch or award issued in that state carries a network-unchecked stamp."
          actions={
            <div className="flex items-center gap-2">
              <Select
                value={nodeId !== null ? String(nodeId) : undefined}
                onValueChange={value => setSelectedNodeId(Number(value))}
              >
                <SelectTrigger className="w-64">
                  <SelectValue placeholder="Select a grid node" />
                </SelectTrigger>
                <SelectContent>
                  {(nodes.data ?? []).map(candidate => (
                    <SelectItem key={candidate.nodeId} value={String(candidate.nodeId)}>
                      {candidate.code} — {candidate.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                disabled={refreshing || nodeId === null}
                onClick={() => {
                  void summary.refetch();
                  void studies.refetch();
                }}
              >
                <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
          }
          className="mb-0"
        />

        {service.data && !service.data.configured && (
          <Card className="border-amber-300">
            <CardContent className="py-4 text-sm">
              <p className="flex items-center gap-2 font-medium">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                No feasibility engine is configured
              </p>
              <p className="text-muted-foreground mt-1">{service.data.note}</p>
            </CardContent>
          </Card>
        )}

        {nodes.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : nodes.isError ? (
          <Card className="border-red-300">
            <CardContent className="py-4 text-sm">{nodes.error.message}</CardContent>
          </Card>
        ) : (nodes.data ?? []).length === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground flex items-center gap-3 py-10">
              <Network className="h-5 w-5" />
              <p>No grid node has been registered, so there is no network to study.</p>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MetricTile
                label="Electrical model"
                value={summary.data ? (summary.data.modelled ? "Usable" : "Not usable") : null}
                tone={summary.data?.modelled ? "good" : "warning"}
                evidence={
                  <span className="text-muted-foreground">
                    {summary.data?.reason ??
                      (summary.data
                        ? `${summary.data.buses} bus(es), ${summary.data.lines} line(s), ${summary.data.transformers} transformer(s)`
                        : "no model read")}
                  </span>
                }
              />
              <MetricTile
                label="Source buses"
                value={
                  summary.data ? String(summary.data.sourceNodeCodes.length) : null
                }
                evidence={
                  <span className="text-muted-foreground">
                    {summary.data && summary.data.sourceNodeCodes.length > 0
                      ? summary.data.sourceNodeCodes.join(", ")
                      : "a network with no source cannot be solved"}
                  </span>
                }
                tone={
                  summary.data && summary.data.sourceNodeCodes.length > 0 ? "good" : "warning"
                }
              />
              <MetricTile
                label="Last study"
                value={
                  studies.data && studies.data.length > 0
                    ? FEASIBILITY_STATUS_COPY[studies.data[0].status as FeasibilityStatus].label
                    : null
                }
                tone={
                  studies.data && studies.data.length > 0
                    ? COPY_TONE[
                        FEASIBILITY_STATUS_COPY[studies.data[0].status as FeasibilityStatus].tone
                      ]
                    : "neutral"
                }
                evidence={
                  <span className="text-muted-foreground">
                    {studies.data && studies.data.length > 0
                      ? studies.data[0].limitingElement
                        ? `limited by ${studies.data[0].limitingElement}`
                        : (studies.data[0].reason ?? "no limiting element")
                      : "this node has never been studied"}
                  </span>
                }
              />
              <MetricTile
                label="Firm capacity"
                value={node?.firmCapacityW != null ? (node.firmCapacityW / 1000).toFixed(0) : null}
                unit="kW"
                tone={node?.firmCapacityW != null ? "neutral" : "warning"}
                evidence={
                  <span className="text-muted-foreground">
                    {node?.firmCapacityW != null
                      ? "declared contractual capacity, not a solved limit"
                      : "no firm capacity declared for this node"}
                  </span>
                }
              />
            </div>

            <PanelCard
              title="Connection enquiry"
              description="Solve the recorded model against the measured base case, optionally with an extra injection at this node, and search for the headroom left."
              footer="A positive change is generation-positive: it is extra export at this node. The base case is measured telemetry inside the freshness bound — a node whose assets are not reporting cannot be studied at all."
            >
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label htmlFor="candidate-kw">Extra injection (kW, optional)</Label>
                  <Input
                    id="candidate-kw"
                    inputMode="decimal"
                    placeholder="e.g. 50"
                    value={candidateKw}
                    onChange={event => setCandidateKw(event.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="hosting-kw">Hosting search ceiling (kW)</Label>
                  <Input
                    id="hosting-kw"
                    inputMode="decimal"
                    value={hostingCeilingKw}
                    onChange={event => setHostingCeilingKw(event.target.value)}
                  />
                </div>
                <div className="flex items-end">
                  <Button
                    onClick={runStudy}
                    disabled={study.isPending || nodeId === null}
                    className="w-full"
                  >
                    <Activity className="mr-2 h-4 w-4" />
                    {study.isPending ? "Solving…" : "Run study"}
                  </Button>
                </div>
              </div>

              {result && resultCopy && (
                <div className="mt-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <ToneBadge
                      label={resultCopy.label}
                      tone={COPY_TONE[resultCopy.tone]}
                      meaning={resultCopy.meaning}
                    />
                    <span className="text-muted-foreground text-sm">
                      {result.reason ?? resultCopy.meaning}
                    </span>
                  </div>

                  {result.violations.length > 0 && (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Element</TableHead>
                          <TableHead>Limit exceeded</TableHead>
                          <TableHead className="text-right">Value</TableHead>
                          <TableHead className="text-right">Limit</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {result.violations.map(violation => (
                          <TableRow key={`${violation.element}-${violation.kind}`}>
                            <TableCell className="font-medium">{violation.element}</TableCell>
                            <TableCell>{violationKindLabel(violation.kind)}</TableCell>
                            <TableCell className="text-right">
                              {violation.value.toFixed(2)}
                            </TableCell>
                            <TableCell className="text-right">
                              {violation.limit.toFixed(2)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}

                  {result.hostingCapacity.length > 0 && (
                    <div className="space-y-2">
                      {result.hostingCapacity.map(headroom => (
                        <p key={`${headroom.bus}-${headroom.direction}`} className="text-sm">
                          <Plug className="mr-2 inline h-4 w-4" />
                          {headroom.bus} can host {wattsLabel(headroom.headroom_w)} more{" "}
                          {headroom.direction}
                          {headroom.limiting_element
                            ? `, limited by ${headroom.limiting_element} (${violationKindLabel(
                                headroom.limiting_kind ?? ""
                              )})`
                            : ""}
                          {headroom.capped
                            ? ` — the search stopped at its ${wattsLabel(
                                headroom.searched_to_w
                              )} ceiling, so the real headroom may be higher`
                            : ""}
                        </p>
                      ))}
                    </div>
                  )}

                  {result.elements.length > 0 && (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Element</TableHead>
                          <TableHead>Kind</TableHead>
                          <TableHead className="text-right">Loading</TableHead>
                          <TableHead className="text-right">Limit</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {result.elements.map(element => (
                          <TableRow key={`${element.kind}-${element.code}`}>
                            <TableCell className="font-medium">{element.code}</TableCell>
                            <TableCell>{element.kind}</TableCell>
                            <TableCell className="text-right">
                              {element.loading_percent.toFixed(1)}%
                            </TableCell>
                            <TableCell className="text-right">
                              {element.limit_percent.toFixed(0)}%
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </div>
              )}
            </PanelCard>

            <PanelCard
              title="Studies behind dispatch and awards"
              description="Every feasibility study this node has been through, including the ones that concluded nothing."
              footer="A dispatch refusal cites the element from one of these rows; an award stamped anything other than 'within limits' was cleared without a network check."
            >
              {studies.isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : studies.isError ? (
                <p className="text-muted-foreground text-sm">{studies.error.message}</p>
              ) : (studies.data ?? []).length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No study has been run against this node — every dispatch and award behind it so
                  far is network-unchecked.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Subject</TableHead>
                      <TableHead>Outcome</TableHead>
                      <TableHead>Limiting element</TableHead>
                      <TableHead>Engine</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(studies.data ?? []).map(row => {
                      const copy = FEASIBILITY_STATUS_COPY[row.status as FeasibilityStatus];
                      return (
                        <TableRow key={row.id}>
                          <TableCell>{new Date(row.createdAt).toLocaleString()}</TableCell>
                          <TableCell>
                            {row.subject.replace(/_/g, " ")}
                            {row.subjectReference ? (
                              <span className="text-muted-foreground block text-xs">
                                {row.subjectReference}
                              </span>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <ToneBadge
                              label={copy.label}
                              tone={COPY_TONE[copy.tone]}
                              meaning={copy.meaning}
                            />
                          </TableCell>
                          <TableCell>
                            {row.limitingElement ?? (
                              <span className="text-muted-foreground">
                                {row.reason ?? "none"}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {row.engine ?? "not solved"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </PanelCard>

            {summary.data?.modelled === true && (
              <p className="text-muted-foreground flex items-center gap-2 text-sm">
                <ShieldCheck className="h-4 w-4 text-emerald-600" />
                This node has a solvable model, so dispatch and awards behind it are checked against
                it.
              </p>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
