import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { CalendarClock } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

const REASON_LABELS: Record<string, string> = {
  no_tariff: "no published dynamic tariff for your country",
  asset_not_flexible: "asset is not a battery (not flexible)",
  asset_constraints_unregistered: "asset has no registered charge/discharge limits",
};

function fmtPrice(centsPerKwh: number | null | undefined): string {
  if (centsPerKwh === null || centsPerKwh === undefined) return "—";
  return `${(centsPerKwh / 100).toFixed(2)}/kWh`;
}

export default function DispatchWindows() {
  const utils = trpc.useUtils();
  const [assetIdStr, setAssetIdStr] = useState<string>("");
  const [selectedRecId, setSelectedRecId] = useState<number | null>(null);

  const assetsQ = trpc.assets.list.useQuery();
  const batteries = useMemo(
    () => (assetsQ.data?.assets ?? []).filter((a: any) => a.assetType === "battery"),
    [assetsQ.data]
  );

  const filterAssetId = assetIdStr ? parseInt(assetIdStr, 10) : undefined;
  const recs = trpc.dispatchWindows.listRecommendations.useQuery({
    assetId: filterAssetId,
    limit: 20,
  });

  const computeMutation = trpc.dispatchWindows.computeWindows.useMutation({
    onSuccess: (rec) => {
      if (rec.recommendationAvailable) {
        const count = Array.isArray(rec.windows) ? rec.windows.length : 0;
        toast.success(
          count > 0
            ? `Recommendation computed — ${count} window(s)`
            : "Recommendation computed — the published tariff prices no hour cheap or dear enough to act on"
        );
      } else {
        toast.info(
          `Recommendation recorded as unavailable: ${
            REASON_LABELS[rec.reason ?? ""] ?? rec.reason ?? "unknown reason"
          }`
        );
      }
      setSelectedRecId(rec.id);
      utils.dispatchWindows.listRecommendations.invalidate();
    },
    onError: (e) => toast.error(e.message || "Failed to compute windows"),
  });

  const selected = recs.data?.recommendations?.find((r: any) => r.id === selectedRecId) ?? null;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dispatch Windows</h1>
          <p className="text-muted-foreground">
            Recommended charge/discharge windows from the published dynamic tariff for your country
            and your battery's registered limits. Prices are the real published figures — never
            invented.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <CalendarClock className="h-4 w-4" /> Compute windows
            </CardTitle>
            <CardDescription>Runs against one of your battery assets and persists the result</CardDescription>
          </CardHeader>
          <CardContent className="flex items-end gap-3 flex-wrap">
            <div className="space-y-2 min-w-56">
              <Label>Battery asset</Label>
              <Select value={assetIdStr} onValueChange={setAssetIdStr}>
                <SelectTrigger>
                  <SelectValue placeholder={assetsQ.isLoading ? "Loading assets…" : "All batteries (filter)"} />
                </SelectTrigger>
                <SelectContent>
                  {batteries.map((a: any) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!assetsQ.isLoading && batteries.length === 0 && (
                <p className="text-sm text-muted-foreground">No battery assets registered.</p>
              )}
            </div>
            <Button
              onClick={() => computeMutation.mutate({ assetId: parseInt(assetIdStr, 10) })}
              disabled={!assetIdStr || computeMutation.isPending}
            >
              {computeMutation.isPending ? "Computing…" : "Compute windows"}
            </Button>
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recommendations</CardTitle>
              <CardDescription>Newest first{filterAssetId ? " (filtered to the selected asset)" : ""}</CardDescription>
            </CardHeader>
            <CardContent>
              {recs.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : recs.error ? (
                <p className="text-sm text-muted-foreground">{recs.error.message}</p>
              ) : !recs.data || recs.data.recommendations.length === 0 ? (
                <p className="text-sm text-muted-foreground">No recommendations computed yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Computed</TableHead>
                      <TableHead>Asset</TableHead>
                      <TableHead>Tariff</TableHead>
                      <TableHead>Result</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recs.data.recommendations.map((r: any) => (
                      <TableRow key={r.id} className={selectedRecId === r.id ? "bg-muted/50" : undefined}>
                        <TableCell className="text-sm text-muted-foreground">
                          {new Date(r.computedAt).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-sm">#{r.assetId}</TableCell>
                        <TableCell className="text-sm">
                          {r.tariffId != null ? `#${r.tariffId} v${r.tariffVersion ?? "?"}` : "—"}
                        </TableCell>
                        <TableCell>
                          {r.recommendationAvailable ? (
                            <Badge variant="default">
                              {Array.isArray(r.windows) ? `${r.windows.length} window(s)` : "available"}
                            </Badge>
                          ) : (
                            <span className="text-sm text-muted-foreground">
                              <Badge variant="secondary">unavailable</Badge>{" "}
                              {REASON_LABELS[r.reason ?? ""] ?? r.reason ?? "reason not recorded"}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button size="sm" variant="outline" onClick={() => setSelectedRecId(r.id)}>
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

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Window detail</CardTitle>
              <CardDescription>
                {selected
                  ? `Recommendation #${selected.id} — computed ${new Date(selected.computedAt).toLocaleString()}`
                  : "Select a recommendation to inspect its windows"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!selected ? (
                <p className="text-sm text-muted-foreground">Nothing selected.</p>
              ) : !selected.recommendationAvailable ? (
                <p className="text-sm text-muted-foreground">
                  No windows were computed:{" "}
                  {REASON_LABELS[selected.reason ?? ""] ?? selected.reason ?? "reason not recorded"}.
                </p>
              ) : !Array.isArray(selected.windows) || selected.windows.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Available, but empty: the published tariff prices no hour cheap or dear enough to
                  recommend an action. That is a real answer — nothing to do.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Action</TableHead>
                      <TableHead>Start</TableHead>
                      <TableHead>End</TableHead>
                      <TableHead>Hours</TableHead>
                      <TableHead>Price range</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {selected.windows.map((w: any, i: number) => (
                      <TableRow key={i}>
                        <TableCell>
                          <Badge variant={w.action === "charge" ? "secondary" : "default"}>
                            {w.action}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm">{new Date(w.startIso).toLocaleString()}</TableCell>
                        <TableCell className="text-sm">{new Date(w.endIso).toLocaleString()}</TableCell>
                        <TableCell>{w.hours}</TableCell>
                        <TableCell className="text-sm">
                          {w.minPriceCentsPerKwh === null && w.maxPriceCentsPerKwh === null
                            ? "—"
                            : `${fmtPrice(w.minPriceCentsPerKwh)} – ${fmtPrice(w.maxPriceCentsPerKwh)}`}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  );
}
