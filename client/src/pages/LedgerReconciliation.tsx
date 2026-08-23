/**
 * "Does the money we say we hold add up?"
 *
 * Three records of the same money are compared here — the ledger's balances, the
 * platform's own postings, and the settlements members were shown — and the page
 * leads with disagreement rather than with a total. Nothing on this screen repairs
 * anything: a mismatch is a finding for a human, and a retry only re-presents an
 * entry the ledger never answered.
 *
 * A deployment with no ledger reads as having no balance, not a balance of zero.
 */

import { useState } from "react";

import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertTriangle, RefreshCw, Scale } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { MetricTile, PageHeader, PanelCard, ToneBadge } from "@/components/ops";
import {
  POSTING_STATE_COPY,
  VERDICT_COPY,
  formatMinor,
  postingKindLabel,
  reconciliationHeadline,
  summariseReconciliation,
  type LedgerPosting,
  type MemberReconciliation,
} from "@shared/ledger-state";

export default function LedgerReconciliation() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [sweeping, setSweeping] = useState(false);

  const status = trpc.ledger.status.useQuery(undefined, { enabled: isAdmin });
  const reconciliation = trpc.ledger.reconciliation.useQuery(undefined, {
    enabled: isAdmin,
  });
  const unposted = trpc.ledger.unposted.useQuery(undefined, {
    enabled: isAdmin,
  });
  const sweep = trpc.ledger.sweepUnconfirmed.useMutation();

  if (!isAdmin) {
    return (
      <DashboardLayout>
        <Card>
          <CardHeader>
            <CardTitle>Ledger reconciliation</CardTitle>
            <CardDescription>
              Ledger balances and reconciliation findings are visible to platform
              administrators only.
            </CardDescription>
          </CardHeader>
        </Card>
      </DashboardLayout>
    );
  }

  const members = (reconciliation.data?.members ?? []) as MemberReconciliation[];
  const postings = (unposted.data?.postings ?? []) as unknown as LedgerPosting[];
  const configured = status.data?.configured ?? false;
  const summary = summariseReconciliation(members);
  const headline = reconciliationHeadline(summary, configured);
  const refreshing = reconciliation.isFetching || unposted.isFetching;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeader
          title="Ledger reconciliation"
          description="Balances come from the double-entry ledger and are compared against the platform's own postings and the settlements members were shown. Differences are reported, never corrected."
          actions={
            <Button
              variant="outline"
              size="sm"
              disabled={refreshing}
              onClick={() => {
                void reconciliation.refetch();
                void unposted.refetch();
              }}
            >
              <RefreshCw
                className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>
          }
          className="mb-0"
        />

        {!configured && status.data && (
          <Card className="border-red-300">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="h-4 w-4 text-red-600" />
                No double-entry ledger
              </CardTitle>
              <CardDescription>{status.data.detail}</CardDescription>
            </CardHeader>
          </Card>
        )}

        {reconciliation.isError && (
          <Card className="border-red-300">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="h-4 w-4 text-red-600" />
                Balances could not be reconciled
              </CardTitle>
              <CardDescription>
                {reconciliation.error.message} — nothing is known about these
                balances right now; this is not an all-clear.
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {reconciliation.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <>
            <PanelCard
              title={headline.text}
              description={
                reconciliation.data?.checkedAt
                  ? `Checked ${new Date(reconciliation.data.checkedAt).toLocaleString()}`
                  : "Not yet checked"
              }
              className={headline.tone === "good" ? undefined : "border-amber-300"}
              footer={reconciliation.data?.note}
            >
              <div className="grid gap-3 sm:grid-cols-4">
                <MetricTile
                  label="Agree"
                  value={String(summary.matched)}
                  unit="members"
                  tone={summary.matched > 0 ? "good" : "neutral"}
                  evidence={
                    <span className="text-muted-foreground">
                      ledger, postings and settlements match
                    </span>
                  }
                />
                <MetricTile
                  label="Disagree"
                  value={String(summary.mismatches)}
                  unit="members"
                  tone={summary.mismatches > 0 ? "danger" : "good"}
                  evidence={
                    <span className="text-muted-foreground">
                      one of the records is wrong
                    </span>
                  }
                />
                <MetricTile
                  label="Unreadable"
                  value={String(summary.unknowns)}
                  unit="members"
                  tone={summary.unknowns > 0 ? "warning" : "good"}
                  evidence={
                    <span className="text-muted-foreground">
                      unknown, not zero
                    </span>
                  }
                />
                <MetricTile
                  label="Unconfirmed"
                  value={String(summary.unconfirmedMinor)}
                  unit="minor units"
                  tone={summary.unconfirmedMinor > 0 ? "warning" : "good"}
                  evidence={
                    <span className="text-muted-foreground">
                      recorded, not on any balance
                    </span>
                  }
                />
              </div>
            </PanelCard>

            <PanelCard
              title="Member balances"
              description="The amount the platform owes each member. A member with no ledger account is absent here rather than shown as owed nothing."
              bodyClassName="px-0 py-0 overflow-x-auto"
            >
              {members.length === 0 ? (
                <p className="text-muted-foreground p-4 text-sm">
                  No member holds a ledger account yet. That is an empty ledger,
                  not a reconciled one.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Member</TableHead>
                      <TableHead>Verdict</TableHead>
                      <TableHead>Ledger</TableHead>
                      <TableHead>Our postings</TableHead>
                      <TableHead>Shown to member</TableHead>
                      <TableHead>Why</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {members.map(member => {
                      const copy = VERDICT_COPY[member.verdict];
                      return (
                        <TableRow key={`${member.userId}:${member.currency}`}>
                          <TableCell className="font-mono text-xs">
                            #{member.userId}
                          </TableCell>
                          <TableCell>
                            <ToneBadge
                              label={copy.label}
                              tone={copy.tone}
                              meaning={copy.meaning}
                            />
                          </TableCell>
                          <TableCell className="text-xs">
                            {formatMinor(
                              member.ledgerBalanceMinor,
                              member.currency,
                            )}
                          </TableCell>
                          <TableCell className="text-xs">
                            {formatMinor(
                              member.postedBalanceMinor,
                              member.currency,
                            )}
                          </TableCell>
                          <TableCell className="text-xs">
                            {formatMinor(
                              member.businessBalanceMinor,
                              member.currency,
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground max-w-md text-xs">
                            {member.note}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </PanelCard>

            <PanelCard
              title={`Entries not on the ledger (${postings.length})`}
              description="Each row is money the platform recorded that the ledger has not applied. Retrying is safe: an entry the ledger already applied comes back as a duplicate rather than moving money twice."
              className={postings.length > 0 ? "border-amber-300" : undefined}
              bodyClassName="overflow-x-auto"
              footer={
                configured ? (
                  <div className="flex items-center gap-3">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={sweeping || postings.length === 0}
                      onClick={async () => {
                        setSweeping(true);
                        try {
                          await sweep.mutateAsync({});
                          await Promise.all([
                            unposted.refetch(),
                            reconciliation.refetch(),
                          ]);
                        } finally {
                          setSweeping(false);
                        }
                      }}
                    >
                      <Scale className="mr-2 h-4 w-4" />
                      Retry unconfirmed entries
                    </Button>
                    {sweep.data && (
                      <span className="text-muted-foreground text-xs">
                        {sweep.data.attempted} attempted · {sweep.data.posted}{" "}
                        posted · {sweep.data.stillPending} still unconfirmed ·{" "}
                        {sweep.data.refused} refused
                      </span>
                    )}
                    {sweep.isError && (
                      <span className="text-xs text-red-600">
                        {sweep.error.message}
                      </span>
                    )}
                  </div>
                ) : (
                  "There is no ledger to post these entries to."
                )
              }
            >
              {postings.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  Every recorded movement is on the ledger.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Movement</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Provider reference</TableHead>
                      <TableHead>Recorded</TableHead>
                      <TableHead>Detail</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {postings.map(posting => {
                      const copy = POSTING_STATE_COPY[posting.state];
                      return (
                        <TableRow key={posting.id}>
                          <TableCell className="text-xs font-medium">
                            {postingKindLabel(posting.postingKind)}
                          </TableCell>
                          <TableCell>
                            <ToneBadge
                              label={copy.label}
                              tone={copy.tone}
                              meaning={copy.meaning}
                            />
                          </TableCell>
                          <TableCell className="text-xs">
                            {formatMinor(posting.amountMinor, posting.currency)}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {posting.sourceType} #{posting.sourceId}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {posting.providerReference ?? "—"}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-xs">
                            {new Date(posting.createdAt).toLocaleString()}
                          </TableCell>
                          <TableCell className="text-muted-foreground max-w-md text-xs">
                            {posting.detail ?? "—"}
                          </TableCell>
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
