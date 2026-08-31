import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { RefreshCw, Banknote } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

type SourceType = "dr_compensation" | "p2p_match" | "referral_reward";

const SOURCE_LABELS: Record<string, string> = {
  dr_compensation: "DR compensation",
  p2p_match: "P2P sale",
  referral_reward: "Referral reward",
};

/**
 * Amounts are whole minor currency units. Currencies are never summed
 * together — every figure is displayed with its own currency. CREDITS is a
 * reward balance, not money, so it is shown as a count, not as currency/100.
 */
function fmtAmount(amountCents: number | null | undefined, currency: string | null | undefined): string {
  if (amountCents === null || amountCents === undefined) return "—";
  const ccy = currency ?? "";
  if (ccy === "CREDITS") return `${amountCents} credits`;
  return ccy ? `${ccy} ${(amountCents / 100).toFixed(2)}` : (amountCents / 100).toFixed(2);
}

export default function GridRevenue() {
  const utils = trpc.useUtils();
  const [sourceFilter, setSourceFilter] = useState<SourceType | "all">("all");

  const summary = trpc.gridRevenue.summary.useQuery({});
  const revenues = trpc.gridRevenue.list.useQuery({
    limit: 50,
    sourceType: sourceFilter === "all" ? undefined : sourceFilter,
  });

  const syncMutation = trpc.gridRevenue.sync.useMutation({
    onSuccess: (r) => {
      const newly =
        r.drCompensation.newlyRecorded + r.p2pMatches.newlyRecorded + r.referralRewards.newlyRecorded;
      toast.success(
        newly > 0
          ? `Sync complete — ${newly} new earning(s) recorded`
          : "Sync complete — everything earned is already recorded"
      );
      utils.gridRevenue.summary.invalidate();
      utils.gridRevenue.list.invalidate();
    },
    onError: (e) => toast.error(e.message || "Failed to sync revenues"),
  });

  const s = summary.data;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Grid Revenue</h1>
            <p className="text-muted-foreground">
              What you actually earned from grid services — recorded only from paid compensations,
              executed P2P sales and processed referral rewards. Totals are grouped per currency and
              are never summed across currencies.
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            {syncMutation.isPending ? "Syncing…" : "Sync earnings"}
          </Button>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Banknote className="h-4 w-4" /> Earnings by source
              </CardTitle>
              <CardDescription>Per source and currency</CardDescription>
            </CardHeader>
            <CardContent>
              {summary.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : summary.error ? (
                <p className="text-sm text-muted-foreground">{summary.error.message}</p>
              ) : !s || s.bySource.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No earnings recorded yet — run a sync after you have been paid for DR, sold energy
                  P2P, or earned a referral reward.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Source</TableHead>
                      <TableHead>Total</TableHead>
                      <TableHead>Count</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {s.bySource.map((r: any) => (
                      <TableRow key={`${r.sourceType}-${r.currency}`}>
                        <TableCell className="text-sm">
                          {SOURCE_LABELS[r.sourceType] ?? r.sourceType}
                        </TableCell>
                        <TableCell className="font-medium">
                          {fmtAmount(r.totalAmountCents, r.currency)}
                        </TableCell>
                        <TableCell>{r.count}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Earnings by month</CardTitle>
              <CardDescription>UTC months, per currency</CardDescription>
            </CardHeader>
            <CardContent>
              {summary.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : summary.error ? (
                <p className="text-sm text-muted-foreground">{summary.error.message}</p>
              ) : !s || s.byMonth.length === 0 ? (
                <p className="text-sm text-muted-foreground">No monthly totals yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Month (UTC)</TableHead>
                      <TableHead>Total</TableHead>
                      <TableHead>Count</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {s.byMonth.map((r: any) => (
                      <TableRow key={`${r.month}-${r.currency}`}>
                        <TableCell className="text-sm">{r.month}</TableCell>
                        <TableCell className="font-medium">
                          {fmtAmount(r.totalAmountCents, r.currency)}
                        </TableCell>
                        <TableCell>{r.count}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <CardTitle className="text-base">Revenue ledger</CardTitle>
                <CardDescription>
                  Each row references the real source record it was recorded from
                </CardDescription>
              </div>
              <Select value={sourceFilter} onValueChange={(v) => setSourceFilter(v as SourceType | "all")}>
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All sources</SelectItem>
                  <SelectItem value="dr_compensation">DR compensation</SelectItem>
                  <SelectItem value="p2p_match">P2P sale</SelectItem>
                  <SelectItem value="referral_reward">Referral reward</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            {revenues.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : revenues.error ? (
              <p className="text-sm text-muted-foreground">{revenues.error.message}</p>
            ) : !revenues.data || revenues.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">No revenue rows match.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Occurred</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Source record</TableHead>
                    <TableHead>Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {revenues.data.map((r: any) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(r.occurredAt).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{SOURCE_LABELS[r.sourceType] ?? r.sourceType}</Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        <code className="text-xs">
                          {r.sourceType} #{r.sourceId}
                        </code>
                      </TableCell>
                      <TableCell className="font-medium">{fmtAmount(r.amountCents, r.currency)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
