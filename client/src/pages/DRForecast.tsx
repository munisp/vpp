import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { CloudOff, Users } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";

export default function DRForecast() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const utils = trpc.useUtils();

  const forecast = trpc.drForecast.getEventForecast.useQuery({ days: 7 });
  const history = trpc.drForecast.listForecasts.useQuery({ limit: 14 });
  const recommendations = trpc.drForecast.listRecommendations.useQuery(
    { limit: 100 },
    { enabled: isAdmin }
  );

  const [targetKw, setTargetKw] = useState("");
  const [maxParticipants, setMaxParticipants] = useState("");

  const recommendMutation = trpc.drForecast.recommendParticipants.useMutation({
    onSuccess: (r) => {
      toast.success(
        `${r.recommendations.length} participant(s) recommended — coverage ${r.coverageKw.toFixed(1)} kW of ${r.targetReductionKw} kW target${r.targetMet ? " (met)" : " (not met)"}`
      );
      utils.drForecast.listRecommendations.invalidate();
    },
    onError: (e) => toast.error(e.message || "Failed to recommend participants"),
  });

  const days = (forecast.data?.forecast ?? []).map((d: any) => ({
    date: new Date(d.date).toLocaleDateString(undefined, { weekday: "short", month: "numeric", day: "numeric" }),
    likelihood: d.likelihoodPercent,
    weatherUsed: d.weatherUsed,
  }));
  const anyWeatherUsed = (forecast.data?.forecast ?? []).some((d: any) => d.weatherUsed);

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">DR Event Forecast</h1>
          <p className="text-muted-foreground">
            7-day demand-response event likelihood from real event history, demand trends and (when available) weather.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Event likelihood — next 7 days</CardTitle>
            <CardDescription className="flex items-center gap-2">
              {forecast.data && !anyWeatherUsed && (
                <span className="flex items-center gap-1 text-amber-600">
                  <CloudOff className="h-3 w-3" /> Weather forecast unavailable — computed without the heat signal
                </span>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {forecast.isLoading ? (
              <Skeleton className="h-56 w-full" />
            ) : forecast.error ? (
              <p className="text-sm text-muted-foreground py-6">{forecast.error.message}</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={days}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v: any) => [`${v}%`, "Likelihood"]} />
                  <Bar dataKey="likelihood" radius={[4, 4, 0, 0]}>
                    {days.map((d: any, i: number) => (
                      <Cell
                        key={i}
                        fill={d.likelihood >= 60 ? "#b0614f" : d.likelihood >= 30 ? "#c8a24a" : "#6b9e78"}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {forecast.data && forecast.data.forecast.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Forecast detail</CardTitle>
              <CardDescription>Component signals (null = signal unavailable)</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Likelihood</TableHead>
                    <TableHead>History frequency</TableHead>
                    <TableHead>Demand trend</TableHead>
                    <TableHead>Heat factor</TableHead>
                    <TableHead>History sample</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {forecast.data.forecast.map((d: any) => (
                    <TableRow key={d.forecastId}>
                      <TableCell>{new Date(d.date).toLocaleDateString()}</TableCell>
                      <TableCell>
                        <Badge variant={d.likelihoodPercent >= 60 ? "destructive" : d.likelihoodPercent >= 30 ? "secondary" : "outline"}>
                          {d.likelihoodPercent}%
                        </Badge>
                      </TableCell>
                      <TableCell>{d.historyFrequencyPercent}%</TableCell>
                      <TableCell>{d.demandTrendPercent != null ? `${d.demandTrendPercent}%` : "—"}</TableCell>
                      <TableCell>{d.heatFactorPercent != null ? `${d.heatFactorPercent}%` : "—"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{d.historyEventCount} events</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Persisted forecast history</CardTitle>
            <CardDescription>Audit trail of previously computed forecasts</CardDescription>
          </CardHeader>
          <CardContent>
            {history.isLoading ? (
              <Skeleton className="h-20 w-full" />
            ) : !history.data || history.data.forecasts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No persisted forecasts yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Forecast date</TableHead>
                    <TableHead>Likelihood</TableHead>
                    <TableHead>Weather used</TableHead>
                    <TableHead>Computed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.data.forecasts.map((f: any) => (
                    <TableRow key={f.id}>
                      <TableCell>{new Date(f.forecastDate).toLocaleDateString()}</TableCell>
                      <TableCell>{f.likelihoodPercent}%</TableCell>
                      <TableCell>{f.weatherUsed ? "yes" : "no"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(f.createdAt).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {isAdmin && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Users className="h-4 w-4" /> Participant recommendations (admin)
              </CardTitle>
              <CardDescription>Ranked optimal participants for a planned reduction</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-end gap-3 flex-wrap">
                <div className="space-y-2">
                  <Label htmlFor="targetKw">Target reduction (kW)</Label>
                  <Input id="targetKw" type="number" min="0" step="0.1" value={targetKw} onChange={(e) => setTargetKw(e.target.value)} className="w-48" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="maxP">Max participants (optional)</Label>
                  <Input id="maxP" type="number" min="1" value={maxParticipants} onChange={(e) => setMaxParticipants(e.target.value)} className="w-48" />
                </div>
                <Button
                  onClick={() => {
                    const t = parseFloat(targetKw);
                    if (!t || t <= 0) return toast.error("Enter a positive target reduction");
                    recommendMutation.mutate({
                      targetReductionKw: t,
                      maxParticipants: maxParticipants ? parseInt(maxParticipants, 10) : undefined,
                    });
                  }}
                  disabled={recommendMutation.isPending}
                >
                  {recommendMutation.isPending ? "Ranking…" : "Recommend participants"}
                </Button>
              </div>

              {recommendations.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : !recommendations.data || recommendations.data.recommendations.length === 0 ? (
                <p className="text-sm text-muted-foreground">No recommendations persisted yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Rank</TableHead>
                      <TableHead>User</TableHead>
                      <TableHead>Score</TableHead>
                      <TableHead>Compliance</TableHead>
                      <TableHead>Flexibility</TableHead>
                      <TableHead>No-shows</TableHead>
                      <TableHead>Outcome</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recommendations.data.recommendations.map((r: any) => (
                      <TableRow key={r.id}>
                        <TableCell>#{r.rankPosition}</TableCell>
                        <TableCell>User {r.userId}</TableCell>
                        <TableCell>{(r.scoreMilli / 1000).toFixed(3)}</TableCell>
                        <TableCell>
                          {r.compliancePercent != null ? `${r.compliancePercent}%` : "— (no history)"}
                        </TableCell>
                        <TableCell>{(r.flexibilityKw10 / 10).toFixed(1)} kW</TableCell>
                        <TableCell>{r.noShowCount}</TableCell>
                        <TableCell>
                          <Badge variant={r.outcome === "participated" ? "default" : r.outcome === "pending" ? "outline" : "secondary"}>
                            {String(r.outcome).replace(/_/g, " ")}
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
