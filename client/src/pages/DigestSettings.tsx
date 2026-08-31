import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { Mail, MessageSquare, ScrollText } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

type Channel = "email" | "sms";

function fmtWh(wh: number | null | undefined): string {
  if (wh === null || wh === undefined) return "no data";
  return `${(wh / 1000).toFixed(2)} kWh`;
}

export default function DigestSettings() {
  const utils = trpc.useUtils();

  const subs = trpc.digest.mySubscriptions.useQuery();
  const runs = trpc.digest.myRuns.useQuery({ limit: 12 });
  const preview = trpc.digest.preview.useQuery();

  const subscribeMutation = trpc.digest.subscribe.useMutation({
    onSuccess: (_r, vars) => {
      toast.success(`Subscribed to the ${vars.channel} digest`);
      utils.digest.mySubscriptions.invalidate();
    },
    onError: (e) => toast.error(e.message || "Failed to subscribe"),
  });

  const unsubscribeMutation = trpc.digest.unsubscribe.useMutation({
    onSuccess: (_r, vars) => {
      toast.success(`Unsubscribed from the ${vars.channel} digest`);
      utils.digest.mySubscriptions.invalidate();
    },
    onError: (e) => toast.error(e.message || "Failed to unsubscribe"),
  });

  const isEnabled = (channel: Channel): boolean =>
    !!subs.data?.some((s: any) => s.channel === channel && s.enabled);

  const toggle = (channel: Channel, enabled: boolean) => {
    if (enabled) subscribeMutation.mutate({ channel });
    else unsubscribeMutation.mutate({ channel });
  };

  const busy = subscribeMutation.isPending || unsubscribeMutation.isPending;
  const p = preview.data;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Weekly Digest</h1>
          <p className="text-muted-foreground">
            A weekly summary of your real consumption, generation and payments, dispatched by the
            scheduler. Opt in per channel below.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Subscriptions</CardTitle>
            <CardDescription>
              Subscribing requires the matching contact on your account (email address / phone
              number)
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {subs.isLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : subs.error ? (
              <p className="text-sm text-muted-foreground">{subs.error.message}</p>
            ) : (
              <>
                <div className="flex items-center justify-between max-w-md">
                  <Label className="flex items-center gap-2">
                    <Mail className="h-4 w-4" /> Email digest
                  </Label>
                  <Switch
                    checked={isEnabled("email")}
                    onCheckedChange={(v) => toggle("email", v)}
                    disabled={busy}
                  />
                </div>
                <div className="flex items-center justify-between max-w-md">
                  <Label className="flex items-center gap-2">
                    <MessageSquare className="h-4 w-4" /> SMS digest
                  </Label>
                  <Switch
                    checked={isEnabled("sms")}
                    onCheckedChange={(v) => toggle("sms", v)}
                    disabled={busy}
                  />
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">This week so far (preview)</CardTitle>
            <CardDescription>
              Your current week-to-date stats — nothing is sent when you preview
            </CardDescription>
          </CardHeader>
          <CardContent>
            {preview.isLoading ? (
              <Skeleton className="h-20 w-full" />
            ) : preview.error ? (
              <p className="text-sm text-muted-foreground">{preview.error.message}</p>
            ) : p ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 text-sm">
                <div>
                  <p className="text-muted-foreground">Consumption</p>
                  <p className="font-medium">{fmtWh(p.consumptionWh)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Solar generation</p>
                  <p className="font-medium">{fmtWh(p.generationWh)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Payments completed</p>
                  {p.payments.length === 0 ? (
                    <p className="font-medium">none</p>
                  ) : (
                    p.payments.map((pay: any) => (
                      <p key={pay.currency} className="font-medium">
                        {pay.currency} {(pay.totalCents / 100).toFixed(2)} ({pay.count})
                      </p>
                    ))
                  )}
                </div>
                <div>
                  <p className="text-muted-foreground">Prepaid tokens vended</p>
                  <p className="font-medium">
                    {p.tokens.count === 0
                      ? "none"
                      : `${p.tokens.count} (${p.tokens.totalEnergyKwh} kWh)`}
                  </p>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <ScrollText className="h-4 w-4" /> Digest run history
            </CardTitle>
            <CardDescription>
              Every recorded dispatch attempt — a failed run is never rewritten to sent
            </CardDescription>
          </CardHeader>
          <CardContent>
            {runs.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : runs.error ? (
              <p className="text-sm text-muted-foreground">{runs.error.message}</p>
            ) : !runs.data || runs.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No digest runs yet. Runs are recorded when the weekly scheduler dispatches to an
                enabled subscription.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Week</TableHead>
                    <TableHead>Channel</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Error</TableHead>
                    <TableHead>Sent at</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.data.map((r: any) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(r.periodStart).toLocaleDateString()} –{" "}
                        {new Date(r.periodEnd).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{r.channel}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            r.status === "sent"
                              ? "default"
                              : r.status === "failed"
                                ? "destructive"
                                : "secondary"
                          }
                        >
                          {r.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-64 truncate">
                        {r.error ?? "—"}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {r.sentAt ? new Date(r.sentAt).toLocaleString() : "—"}
                      </TableCell>
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
