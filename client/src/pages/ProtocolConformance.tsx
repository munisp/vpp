/**
 * "Has this platform ever proven it speaks that protocol?"
 *
 * `der_capabilities.protocols` holds strings a human typed, and until now a
 * capability surface repeated them as if they were facts. This page shows the
 * evidence instead: which adapters have a passing vector-set run behind them,
 * what peer that run spoke to (a simulator is not a device, and is labelled as
 * one), which cases failed or were skipped, and which controls the platform has
 * already issued over a wire nobody tested.
 *
 * Nothing here can mark a protocol proven. Evidence arrives from the protocol
 * services over the signed ingest route, because a claim an operator can type is
 * not proof.
 */

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Cpu, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/_core/hooks/useAuth";
import { MetricTile, PageHeader, PanelCard, ToneBadge } from "@/components/ops";
import type { StateTone } from "@/lib/tone";
import {
  CONFORMANCE_ADAPTER_LABELS,
  CONFORMANCE_OUTCOME_COPY,
  PROTOCOL_PROOF_COPY,
  type ConformanceAdapter,
  type ConformanceRunOutcome,
  type ProtocolProofState,
  type Tone as CopyTone,
} from "../../../shared/protocol-conformance-copy";

const COPY_TONE: Record<CopyTone, StateTone> = {
  good: "good",
  warning: "warning",
  bad: "danger",
  neutral: "neutral",
};

const CASE_TONE: Record<string, StateTone> = {
  pass: "good",
  fail: "danger",
  skipped: "warning",
};

function when(value: Date | string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

export default function ProtocolConformance() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const coverage = trpc.protocolConformance.coverage.useQuery(undefined, {
    enabled: isAdmin,
    retry: false,
  });
  const runs = trpc.protocolConformance.runs.useQuery(
    { limit: 50 },
    { enabled: isAdmin, retry: false }
  );
  const unproven = trpc.protocolConformance.unprovenDispatches.useQuery(
    { limit: 50 },
    { enabled: isAdmin, retry: false }
  );

  const [assetIdText, setAssetIdText] = useState("");
  const assetId = Number.parseInt(assetIdText, 10);
  const assetEvidence = trpc.derCapabilities.protocolEvidence.useQuery(
    { assetId },
    { enabled: isAdmin && Number.isInteger(assetId) && assetId > 0, retry: false }
  );

  const [openRunId, setOpenRunId] = useState<number | null>(null);
  const run = trpc.protocolConformance.run.useQuery(
    { runId: openRunId! },
    { enabled: isAdmin && openRunId !== null, retry: false }
  );

  if (!isAdmin) {
    return (
      <DashboardLayout>
        <Card>
          <CardContent className="text-muted-foreground py-10 text-sm">
            Conformance evidence is operator information. Your own asset's protocol
            evidence is shown on its capability page.
          </CardContent>
        </Card>
      </DashboardLayout>
    );
  }

  const provenCount = (coverage.data ?? []).filter(one => one.state === "proven").length;
  const claimingUnproven = (coverage.data ?? [])
    .filter(one => one.state !== "proven")
    .reduce((total, one) => total + one.claimingAssets, 0);
  const deviceProven = (coverage.data ?? []).filter(
    one => one.state === "proven" && one.run?.target === "device"
  ).length;

  return (
    <DashboardLayout>
      <div className="space-y-4">
        <PageHeader
          title="Protocol conformance"
          description="What the platform has proven on the wire, and what it has only been told."
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void coverage.refetch();
                void runs.refetch();
                void unproven.refetch();
              }}
            >
              <RefreshCw
                className={`mr-2 h-4 w-4 ${coverage.isFetching ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>
          }
          className="mb-0"
        />

        {coverage.isError ? (
          <Card className="border-red-300">
            <CardContent className="py-4 text-sm">{coverage.error.message}</CardContent>
          </Card>
        ) : coverage.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MetricTile
                label="Adapters proven"
                value={`${provenCount} of ${(coverage.data ?? []).length}`}
                tone={provenCount > 0 ? "good" : "warning"}
                evidence={
                  <span className="text-muted-foreground">
                    a passing run inside the evidence window, every case executed
                  </span>
                }
              />
              <MetricTile
                label="Proven against a device"
                value={String(deviceProven)}
                tone={deviceProven > 0 ? "good" : "warning"}
                evidence={
                  <span className="text-muted-foreground">
                    {deviceProven > 0
                      ? "run against real hardware"
                      : "every passing run so far spoke to a simulator, which proves the adapter and not the device"}
                  </span>
                }
              />
              <MetricTile
                label="Assets leaning on unproven protocols"
                value={String(claimingUnproven)}
                tone={claimingUnproven > 0 ? "warning" : "good"}
                evidence={
                  <span className="text-muted-foreground">
                    capability rows claiming a protocol with no live passing run
                  </span>
                }
              />
              <MetricTile
                label="Controls issued unproven"
                value={unproven.data ? String(unproven.data.length) : null}
                tone={unproven.data && unproven.data.length > 0 ? "warning" : "good"}
                evidence={
                  <span className="text-muted-foreground">
                    dispatches stamped with a protocol that had no proof at the time
                  </span>
                }
              />
            </div>

            <PanelCard
              title="Evidence per adapter"
              description="One row per protocol family this platform has a vector set for."
              footer="A run proves the adapter and the peer as they were on the day it ran, so evidence expires. `No vector set` is an absence, not a failure."
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Protocol</TableHead>
                    <TableHead>Evidence</TableHead>
                    <TableHead>Peer</TableHead>
                    <TableHead className="text-right">Cases</TableHead>
                    <TableHead>Last run</TableHead>
                    <TableHead className="text-right">Assets claiming</TableHead>
                    <TableHead className="text-right">Certified</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(coverage.data ?? []).map(row => {
                    const copy = PROTOCOL_PROOF_COPY[row.state as ProtocolProofState];
                    return (
                      <TableRow key={row.adapter}>
                        <TableCell className="font-medium">
                          {CONFORMANCE_ADAPTER_LABELS[row.adapter as ConformanceAdapter]}
                        </TableCell>
                        <TableCell>
                          <ToneBadge
                            label={copy.label}
                            tone={COPY_TONE[copy.tone]}
                            meaning={copy.meaning}
                          />
                        </TableCell>
                        <TableCell>
                          {row.run ? (
                            <span>
                              {row.run.target === "device" ? (
                                <span className="inline-flex items-center gap-1">
                                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                                  device
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1">
                                  <Cpu className="h-3.5 w-3.5 text-amber-600" />
                                  simulator
                                </span>
                              )}
                              <span className="text-muted-foreground ml-2">
                                {row.run.deviceModel}
                              </span>
                            </span>
                          ) : (
                            <span className="text-muted-foreground">never run</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {row.run ? `${row.run.passedCases}/${row.run.totalCases}` : "—"}
                        </TableCell>
                        <TableCell>{when(row.run?.completedAt)}</TableCell>
                        <TableCell className="text-right">{row.claimingAssets}</TableCell>
                        <TableCell className="text-right">{row.certifiedAssets}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </PanelCard>

            <PanelCard
              title="What one asset's capability row is worth"
              description="A capability row lists protocols somebody typed. This resolves each one against the evidence behind it."
              footer="An asset reads fully proven only when every protocol it claims has a live passing run. A certification whose run has aged out reads as no longer current rather than disappearing."
            >
              <div className="max-w-xs space-y-1">
                <Label htmlFor="asset-id">Asset id</Label>
                <Input
                  id="asset-id"
                  inputMode="numeric"
                  placeholder="e.g. 12"
                  value={assetIdText}
                  onChange={event => setAssetIdText(event.target.value)}
                />
              </div>

              {assetEvidence.isError ? (
                <p className="mt-3 text-sm text-red-600">{assetEvidence.error.message}</p>
              ) : assetEvidence.data ? (
                <div className="mt-4 space-y-3">
                  <p className="text-sm">
                    {assetEvidence.data.protocols.length === 0
                      ? "This asset claims no protocol at all."
                      : assetEvidence.data.allClaimsProven
                        ? "Every protocol this asset claims has a live passing run behind it."
                        : "At least one protocol this asset claims has no live passing run behind it."}
                  </p>
                  {assetEvidence.data.protocols.length > 0 && (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Claimed</TableHead>
                          <TableHead>Resolves to</TableHead>
                          <TableHead>Evidence</TableHead>
                          <TableHead>Run</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {assetEvidence.data.protocols.map(claim => {
                          const copy = PROTOCOL_PROOF_COPY[claim.state as ProtocolProofState];
                          return (
                            <TableRow key={claim.claimed}>
                              <TableCell className="font-medium">{claim.claimed}</TableCell>
                              <TableCell>
                                {claim.adapter
                                  ? CONFORMANCE_ADAPTER_LABELS[claim.adapter]
                                  : "no vector set for this label"}
                              </TableCell>
                              <TableCell>
                                <ToneBadge
                                  label={copy.label}
                                  tone={COPY_TONE[copy.tone]}
                                  meaning={copy.meaning}
                                />
                              </TableCell>
                              <TableCell>
                                {claim.proof?.run
                                  ? `run ${claim.proof.run.id} · ${claim.proof.run.target} · ${claim.proof.run.passedCases}/${claim.proof.run.totalCases}`
                                  : "no run"}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  )}
                  {assetEvidence.data.certifications.length > 0 && (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Certified protocol</TableHead>
                          <TableHead>Rests on</TableHead>
                          <TableHead>Peer</TableHead>
                          <TableHead>Still current</TableHead>
                          <TableHead>Certified by</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {assetEvidence.data.certifications.map(cert => (
                          <TableRow key={cert.id}>
                            <TableCell className="font-medium">
                              {CONFORMANCE_ADAPTER_LABELS[cert.adapter]}
                            </TableCell>
                            <TableCell>
                              run {cert.conformanceRunId} ({cert.runOutcome})
                            </TableCell>
                            <TableCell>
                              {cert.runTarget === "device" ? "device" : "simulator"}
                              <span className="text-muted-foreground ml-2">
                                {cert.runDeviceModel}
                              </span>
                            </TableCell>
                            <TableCell>
                              <ToneBadge
                                label={cert.currentlyValid ? "current" : "no longer current"}
                                tone={cert.currentlyValid ? "good" : "warning"}
                              />
                            </TableCell>
                            <TableCell>
                              {cert.certifiedBy}
                              <span className="text-muted-foreground ml-2">
                                {when(cert.certifiedAt)}
                              </span>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </div>
              ) : null}
            </PanelCard>

            <PanelCard
              title="Conformance runs"
              description="Every recorded attempt, including the ones the runner refused to stand behind."
              footer="A run with a skipped case is recorded as failed: half a vector set proves half of nothing."
            >
              {runs.isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : (runs.data ?? []).length === 0 ? (
                <p className="text-muted-foreground py-6 text-sm">
                  No conformance run has been recorded on this deployment, so no protocol
                  here is proven.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Protocol</TableHead>
                      <TableHead>Outcome</TableHead>
                      <TableHead>Vector set</TableHead>
                      <TableHead>Peer</TableHead>
                      <TableHead className="text-right">Pass / fail / skip</TableHead>
                      <TableHead>Operator</TableHead>
                      <TableHead>Completed</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(runs.data ?? []).map(row => {
                      const copy =
                        CONFORMANCE_OUTCOME_COPY[row.outcome as ConformanceRunOutcome];
                      return (
                        <TableRow key={row.id}>
                          <TableCell className="font-medium">
                            {CONFORMANCE_ADAPTER_LABELS[row.adapter as ConformanceAdapter]}
                            <span className="text-muted-foreground ml-2">
                              {row.protocolVersion}
                            </span>
                          </TableCell>
                          <TableCell>
                            <ToneBadge
                              label={copy.label}
                              tone={COPY_TONE[copy.tone]}
                              meaning={copy.meaning}
                            />
                          </TableCell>
                          <TableCell>
                            {row.vectorSetId}
                            <span className="text-muted-foreground ml-1">
                              v{row.vectorSetVersion}
                            </span>
                          </TableCell>
                          <TableCell>
                            {row.target === "device" ? "device" : "simulator"}
                            <span className="text-muted-foreground ml-2">
                              {row.deviceIdentifier ?? row.deviceModel}
                            </span>
                          </TableCell>
                          <TableCell className="text-right">
                            {row.passedCases} / {row.failedCases} / {row.skippedCases}
                          </TableCell>
                          <TableCell>{row.operator}</TableCell>
                          <TableCell>{when(row.completedAt)}</TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                setOpenRunId(openRunId === row.id ? null : row.id)
                              }
                            >
                              {openRunId === row.id ? "Hide cases" : "Cases"}
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}

              {openRunId !== null && (
                <div className="mt-4">
                  {run.isLoading ? (
                    <Skeleton className="h-24 w-full" />
                  ) : run.isError ? (
                    <p className="text-sm text-red-600">{run.error.message}</p>
                  ) : run.data ? (
                    <>
                      <p className="text-muted-foreground mb-2 text-xs">
                        artifact sha256 {run.data.artifactChecksum}
                        {run.data.artifactUri ? ` · ${run.data.artifactUri}` : ""}
                        {run.data.detail ? ` · ${run.data.detail}` : ""}
                      </p>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Case</TableHead>
                            <TableHead>Requirement</TableHead>
                            <TableHead>Outcome</TableHead>
                            <TableHead>Detail</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {run.data.cases.map(one => (
                            <TableRow key={one.caseId}>
                              <TableCell className="font-mono text-xs">
                                {one.caseId}
                                <span className="text-muted-foreground ml-2 font-sans">
                                  {one.name}
                                </span>
                              </TableCell>
                              <TableCell className="text-xs">{one.requirement}</TableCell>
                              <TableCell>
                                <ToneBadge
                                  label={one.outcome}
                                  tone={CASE_TONE[one.outcome] ?? "neutral"}
                                />
                              </TableCell>
                              <TableCell className="text-muted-foreground text-xs">
                                {one.detail ?? "—"}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </>
                  ) : null}
                </div>
              )}
            </PanelCard>

            <PanelCard
              title="Controls issued over unproven protocols"
              description="Dispatches the platform sent anyway, labelled at the moment they were issued."
              footer="The platform does not block these — refusing to dispatch would be its own kind of dishonesty about what the operator asked for — but every one is recorded so the audit question after an incident has an answer."
            >
              {unproven.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : (unproven.data ?? []).length === 0 ? (
                <p className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
                  <ShieldCheck className="h-4 w-4 text-emerald-600" />
                  No control has been issued over an unproven protocol since labelling
                  began.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Control</TableHead>
                      <TableHead>Target</TableHead>
                      <TableHead>Protocol</TableHead>
                      <TableHead>Label</TableHead>
                      <TableHead>Issued</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(unproven.data ?? []).map(row => {
                      const copy = PROTOCOL_PROOF_COPY[row.protocolProof as ProtocolProofState];
                      return (
                        <TableRow key={row.id}>
                          <TableCell className="font-medium">
                            <ShieldAlert className="mr-1 inline h-3.5 w-3.5 text-amber-600" />
                            {row.id}
                          </TableCell>
                          <TableCell>
                            {row.targetRef}
                            {row.assetId !== null && (
                              <span className="text-muted-foreground ml-2">asset {row.assetId}</span>
                            )}
                          </TableCell>
                          <TableCell>{row.protocol}</TableCell>
                          <TableCell>
                            <ToneBadge
                              label={copy.label}
                              tone={COPY_TONE[copy.tone]}
                              meaning={copy.meaning}
                            />
                          </TableCell>
                          <TableCell>{when(row.createdAt)}</TableCell>
                        </TableRow>
                      );
                    })}
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
