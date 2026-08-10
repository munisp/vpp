import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { AlertCircle, Upload, Zap } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";

type Country = "nigeria" | "tanzania";

const BAND_COLORS: Record<string, string> = {
  off_peak: "#6b9e78",
  shoulder: "#c8a24a",
  peak: "#b0614f",
};

function bandBadge(band: string) {
  const label = band.replace("_", " ");
  if (band === "peak") return <Badge variant="destructive">{label}</Badge>;
  if (band === "shoulder") return <Badge variant="secondary">{label}</Badge>;
  return <Badge variant="default">{label}</Badge>;
}

export default function Tariffs() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const utils = trpc.useUtils();
  const [country, setCountry] = useState<Country>((user?.country as Country) || "tanzania");
  const [publishOpen, setPublishOpen] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState("");

  const current = trpc.dynamicTariffs.getCurrentTariff.useQuery({ country });
  const schedule = trpc.dynamicTariffs.getTariffSchedule.useQuery({ country });
  const published = trpc.dynamicTariffs.getPublishedTariff.useQuery({ country });
  const versions = trpc.dynamicTariffs.listVersions.useQuery(
    { country, limit: 10 },
    { enabled: isAdmin }
  );

  const publishMutation = trpc.dynamicTariffs.publishTariff.useMutation({
    onSuccess: (data) => {
      toast.success(`Tariff v${data.version} published for ${data.country}`);
      setPublishOpen(false);
      utils.dynamicTariffs.getPublishedTariff.invalidate();
      utils.dynamicTariffs.listVersions.invalidate();
    },
    onError: (e) => toast.error(e.message || "Failed to publish tariff"),
  });

  const scheduleError = schedule.error;
  const insufficientHistory = scheduleError?.data?.code === "PRECONDITION_FAILED";

  const chartData = (schedule.data?.periods ?? []).map((p: any) => ({
    hour: new Date(p.hourStart).getHours().toString().padStart(2, "0"),
    price: p.finalPriceCentsPerKwh,
    band: p.band,
    interpolated: p.interpolated,
  }));

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Dynamic Tariffs</h1>
            <p className="text-muted-foreground">
              Time-of-use tariffs learned from real market price history with a live grid-stress multiplier.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={country} onValueChange={(v) => setCountry(v as Country)}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="nigeria">Nigeria</SelectItem>
                <SelectItem value="tanzania">Tanzania</SelectItem>
              </SelectContent>
            </Select>
            {isAdmin && (
              <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
                <DialogTrigger asChild>
                  <Button>
                    <Upload className="h-4 w-4 mr-2" /> Publish tariff
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Publish tariff ({country})</DialogTitle>
                    <DialogDescription>
                      Computes the current schedule and persists it as a new append-only version.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-2">
                    <Label htmlFor="effectiveFrom">Effective from (optional)</Label>
                    <Input
                      id="effectiveFrom"
                      type="datetime-local"
                      value={effectiveFrom}
                      onChange={(e) => setEffectiveFrom(e.target.value)}
                    />
                  </div>
                  <DialogFooter>
                    <Button
                      onClick={() =>
                        publishMutation.mutate({
                          country,
                          effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : undefined,
                        })
                      }
                      disabled={publishMutation.isPending}
                    >
                      {publishMutation.isPending ? "Publishing…" : "Publish"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            )}
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Zap className="h-4 w-4" /> Current hour
              </CardTitle>
              <CardDescription>Tariff applying right now</CardDescription>
            </CardHeader>
            <CardContent>
              {current.isLoading ? (
                <Skeleton className="h-16 w-full" />
              ) : current.error ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <AlertCircle className="h-4 w-4" />
                  {current.error.data?.code === "PRECONDITION_FAILED"
                    ? "Insufficient market price history to compute a tariff."
                    : current.error.message}
                </div>
              ) : current.data?.current ? (
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-3xl font-bold">
                      {current.data.current.finalPriceCentsPerKwh != null
                        ? `${current.data.current.finalPriceCentsPerKwh}¢`
                        : "—"}
                      <span className="text-sm font-normal text-muted-foreground"> /kWh</span>
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      grid stress ×{current.data.current.gridStressMultiplier?.toFixed(2)}
                      {current.data.current.interpolated ? " · interpolated" : ""}
                    </p>
                  </div>
                  {bandBadge(current.data.current.band)}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No current tariff available.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Published tariff</CardTitle>
              <CardDescription>Active published version for {country}</CardDescription>
            </CardHeader>
            <CardContent>
              {published.isLoading ? (
                <Skeleton className="h-16 w-full" />
              ) : published.error ? (
                <p className="text-sm text-muted-foreground">{published.error.message}</p>
              ) : published.data?.published ? (
                <div className="space-y-1 text-sm">
                  <p className="font-medium">Version {published.data.published.version}</p>
                  <p className="text-muted-foreground">
                    Effective {new Date(published.data.published.effectiveFrom).toLocaleString()}
                  </p>
                  <p className="text-muted-foreground">
                    Published {new Date(published.data.published.createdAt).toLocaleString()}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No tariff has ever been published for {country}.
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">24-hour schedule</CardTitle>
            <CardDescription>
              {schedule.data?.learnedFrom
                ? `Learned from ${schedule.data.learnedFrom.sampleCount} real market samples over ${schedule.data.learnedFrom.windowDays} days (${schedule.data.learnedFrom.hoursCovered}/24 hours covered)`
                : "Hourly final prices (cents/kWh) from the current hour"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {schedule.isLoading ? (
              <Skeleton className="h-64 w-full" />
            ) : insufficientHistory ? (
              <div className="flex items-center gap-3 py-10 text-muted-foreground">
                <AlertCircle className="h-5 w-5" />
                <p>
                  Insufficient market price history to build a tariff schedule for {country}. No
                  fallback prices are shown.
                </p>
              </div>
            ) : scheduleError ? (
              <p className="text-sm text-muted-foreground py-6">{scheduleError.message}</p>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="hour" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip
                      formatter={(value: any, _name, props: any) =>
                        value == null
                          ? ["unavailable", "Price"]
                          : [`${value}¢/kWh (${props.payload.band.replace("_", " ")})`, "Price"]
                      }
                    />
                    <Bar dataKey="price" radius={[4, 4, 0, 0]}>
                      {chartData.map((d: any, i: number) => (
                        <Cell key={i} fill={BAND_COLORS[d.band] ?? "#888"} fillOpacity={d.interpolated ? 0.45 : 1} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                <div className="flex gap-4 mt-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-sm" style={{ background: BAND_COLORS.off_peak }} /> off-peak</span>
                  <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-sm" style={{ background: BAND_COLORS.shoulder }} /> shoulder</span>
                  <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-sm" style={{ background: BAND_COLORS.peak }} /> peak</span>
                  <span>faded bars = interpolated hours</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {isAdmin && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Version history</CardTitle>
              <CardDescription>Append-only publication history (admin)</CardDescription>
            </CardHeader>
            <CardContent>
              {versions.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : !versions.data || versions.data.length === 0 ? (
                <p className="text-sm text-muted-foreground">No published versions yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Version</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Effective from</TableHead>
                      <TableHead>Published</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {versions.data.map((v: any) => (
                      <TableRow key={v.id}>
                        <TableCell>v{v.version}</TableCell>
                        <TableCell>
                          <Badge variant={v.status === "published" ? "default" : "secondary"}>{v.status}</Badge>
                        </TableCell>
                        <TableCell>{new Date(v.effectiveFrom).toLocaleString()}</TableCell>
                        <TableCell>{new Date(v.createdAt).toLocaleString()}</TableCell>
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
