import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { Trophy } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

type StatusFilter = "all" | "open" | "closed" | "cancelled";

function fmtPct(percent100: number | null | undefined): string {
  if (percent100 === null || percent100 === undefined) return "—";
  return `${(percent100 / 100).toFixed(1)}%`;
}

function fmtWh(wh: number | null | undefined): string {
  if (wh === null || wh === undefined) return "—";
  return wh >= 1000 ? `${(wh / 1000).toFixed(2)} kWh` : `${Math.round(wh)} Wh`;
}

export default function Challenges() {
  const utils = trpc.useUtils();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const challenges = trpc.challenges.list.useQuery({
    limit: 50,
    status: statusFilter === "all" ? undefined : statusFilter,
  });

  const leaderboard = trpc.challenges.leaderboard.useQuery(
    { challengeId: selectedId! },
    { enabled: selectedId !== null }
  );
  const myProgress = trpc.challenges.myProgress.useQuery(
    { challengeId: selectedId! },
    { enabled: selectedId !== null }
  );

  const invalidateDetail = () => {
    utils.challenges.leaderboard.invalidate();
    utils.challenges.myProgress.invalidate();
  };

  const joinMutation = trpc.challenges.join.useMutation({
    onSuccess: () => {
      toast.success("Joined challenge");
      invalidateDetail();
    },
    onError: (e) => toast.error(e.message || "Failed to join challenge"),
  });

  const withdrawMutation = trpc.challenges.withdraw.useMutation({
    onSuccess: () => {
      toast.success("Withdrew from challenge");
      invalidateDetail();
    },
    onError: (e) => toast.error(e.message || "Failed to withdraw"),
  });

  const lb = leaderboard.data;
  const mine = myProgress.data; // null when not joined

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Community Challenges</h1>
          <p className="text-muted-foreground">
            Reduction goals measured against a declared baseline window. Progress is computed from
            real meter telemetry on every read — a participant without baseline data is unranked,
            never treated as zero.
          </p>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between flex-wrap gap-3">
              <CardTitle className="text-base">Challenges</CardTitle>
              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="closed">Closed</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            {challenges.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : challenges.error ? (
              <p className="text-sm text-muted-foreground">{challenges.error.message}</p>
            ) : !challenges.data || challenges.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">No challenges found.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Title</TableHead>
                    <TableHead>Goal</TableHead>
                    <TableHead>Baseline window</TableHead>
                    <TableHead>Measurement window</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {challenges.data.map((c: any) => (
                    <TableRow key={c.id} className={selectedId === c.id ? "bg-muted/50" : undefined}>
                      <TableCell className="font-medium">{c.title}</TableCell>
                      <TableCell>reduce by {fmtPct(c.goalPercent100)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(c.baselineStart).toLocaleDateString()} –{" "}
                        {new Date(c.baselineEnd).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(c.periodStart).toLocaleDateString()} –{" "}
                        {new Date(c.periodEnd).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        <Badge variant={c.status === "open" ? "default" : "secondary"}>{c.status}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="outline" onClick={() => setSelectedId(c.id)}>
                          View
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {selectedId !== null && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Trophy className="h-4 w-4" /> {lb?.challenge?.title ?? "Challenge"}
                  </CardTitle>
                  <CardDescription>
                    {lb?.challenge
                      ? `Goal: reduce consumption by ${fmtPct(lb.challenge.goalPercent100)} vs the baseline window`
                      : ""}
                  </CardDescription>
                </div>
                {lb?.challenge?.status === "open" && (
                  mine && mine.entryStatus === "active" ? (
                    <Button
                      variant="outline"
                      onClick={() => withdrawMutation.mutate({ challengeId: selectedId })}
                      disabled={withdrawMutation.isPending}
                    >
                      Withdraw
                    </Button>
                  ) : (
                    <Button
                      onClick={() => joinMutation.mutate({ challengeId: selectedId })}
                      disabled={joinMutation.isPending}
                    >
                      Join challenge
                    </Button>
                  )
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {myProgress.isLoading ? (
                <Skeleton className="h-12 w-full" />
              ) : mine === null ? (
                <p className="text-sm text-muted-foreground">You have not joined this challenge.</p>
              ) : mine ? (
                <div className="rounded-md border p-3 text-sm space-y-1">
                  <p className="font-medium">
                    Your progress{" "}
                    <Badge variant={mine.entryStatus === "active" ? "default" : "secondary"}>
                      {mine.entryStatus}
                    </Badge>
                  </p>
                  {mine.progressAvailable ? (
                    <p className="text-muted-foreground">
                      Baseline {fmtWh(mine.baselineWh)} ({fmtWh(mine.baselineDailyWh)}/day) → current{" "}
                      {fmtWh(mine.currentWh)} ({fmtWh(mine.currentDailyWh)}/day) — reduction{" "}
                      <span className="text-foreground font-medium">{fmtPct(mine.reductionPercent100)}</span>{" "}
                      {mine.goalMet === true && <Badge className="ml-1">goal met</Badge>}
                      {mine.goalMet === false && <Badge variant="outline">below goal</Badge>}
                    </p>
                  ) : (
                    <p className="text-muted-foreground">
                      baseline unavailable — {mine.unavailableReason ?? "reason not recorded"}
                    </p>
                  )}
                </div>
              ) : null}

              {leaderboard.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : leaderboard.error ? (
                <p className="text-sm text-muted-foreground">{leaderboard.error.message}</p>
              ) : !lb || lb.leaderboard.length === 0 ? (
                <p className="text-sm text-muted-foreground">No participants yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Rank</TableHead>
                      <TableHead>Participant</TableHead>
                      <TableHead>Reduction</TableHead>
                      <TableHead>Goal</TableHead>
                      <TableHead>Entry</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lb.leaderboard.map((p: any) => (
                      <TableRow key={p.userId}>
                        <TableCell>{p.rank ?? "—"}</TableCell>
                        <TableCell className="text-sm">User #{p.userId}</TableCell>
                        <TableCell>
                          {p.progressAvailable ? (
                            fmtPct(p.reductionPercent100)
                          ) : (
                            <span className="text-sm text-muted-foreground" title={p.unavailableReason ?? undefined}>
                              baseline unavailable
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          {p.goalMet === true ? (
                            <Badge>met</Badge>
                          ) : p.goalMet === false ? (
                            <Badge variant="outline">not yet</Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={p.entryStatus === "active" ? "secondary" : "outline"}>
                            {p.entryStatus}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
