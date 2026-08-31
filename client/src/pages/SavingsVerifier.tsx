import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { AlertCircle, ShieldCheck } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

function fmtWh(wh: number | null | undefined): string {
  if (wh === null || wh === undefined) return "—";
  const sign = wh < 0 ? "-" : "";
  const abs = Math.abs(wh);
  return abs >= 1000 ? `${sign}${(abs / 1000).toFixed(2)} kWh` : `${sign}${Math.round(abs)} Wh`;
}
function coverage(r: number | null | undefined): string {
  return r === null || r === undefined ? "—" : `${(r * 100).toFixed(1)}%`;
}

export default function SavingsVerifier() {
  const utils = trpc.useUtils();
  const { data: assetsData, isLoading: assetsLoading } = trpc.assets.list.useQuery();
  const assets = assetsData?.assets ?? [];
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const assetId = selectedId ?? assets[0]?.id ?? null;

  const [baselineStart, setBaselineStart] = useState("");
  const [baselineEnd, setBaselineEnd] = useState("");
  const [reportingStart, setReportingStart] = useState("");
  const [reportingEnd, setReportingEnd] = useState("");
  const [result, setResult] = useState<any>(null);

  const history = trpc.savingsVerifier.history.useQuery(
    { assetId: assetId!, limit: 20 },
    { enabled: assetId !== null }
  );

  const verifyMutation = trpc.savingsVerifier.verify.useMutation({
    onSuccess: (r) => {
      setResult(r);
      if (r.verifiable) toast.success("Savings verified from real telemetry");
      else toast.info("Verification refused — see the reason");
      utils.savingsVerifier.history.invalidate();
    },
    onError: (e) => toast.error(e.message || "Verification failed"),
  });

  const handleVerify = () => {
    if (assetId === null) return toast.error("Select an asset");
    if (!baselineStart || !baselineEnd || !reportingStart || !reportingEnd) {
      return toast.error("Fill in both periods");
    }
    verifyMutation.mutate({
      assetId,
      baselineStart: new Date(baselineStart),
      baselineEnd: new Date(baselineEnd),
      reportingStart: new Date(reportingStart),
      reportingEnd: new Date(reportingEnd),
    });
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Savings Verifier</h1>
          <p className="text-muted-foreground">
            IPMVP Option C-style baseline-vs-reporting comparison measured strictly from real
            telemetry. Periods below 80% hourly coverage are refused — with the reason persisted, not
            hidden.
          </p>
        </div>

        {assetsLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : assets.length === 0 ? (
          <Card>
            <CardContent className="flex items-center gap-3 py-10 text-muted-foreground">
              <ShieldCheck className="h-5 w-5" />
              <p>You have no assets. Register an asset to verify savings.</p>
            </CardContent>
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Verify savings</CardTitle>
                <CardDescription>
                  Baseline and reporting periods must not overlap; the reporting period must start at
                  or after the baseline ends.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2 max-w-xs">
                  <Label>Asset</Label>
                  <Select
                    value={assetId !== null ? String(assetId) : undefined}
                    onValueChange={(v) => { setSelectedId(Number(v)); setResult(null); }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select asset" />
                    </SelectTrigger>
                    <SelectContent>
                      {assets.map((a: any) => (
                        <SelectItem key={a.id} value={String(a.id)}>
                          {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Baseline start</Label>
                    <Input type="datetime-local" value={baselineStart} onChange={(e) => setBaselineStart(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label>Baseline end</Label>
                    <Input type="datetime-local" value={baselineEnd} onChange={(e) => setBaselineEnd(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label>Reporting start</Label>
                    <Input type="datetime-local" value={reportingStart} onChange={(e) => setReportingStart(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label>Reporting end</Label>
                    <Input type="datetime-local" value={reportingEnd} onChange={(e) => setReportingEnd(e.target.value)} />
                  </div>
                </div>
                <Button onClick={handleVerify} disabled={verifyMutation.isPending || assetId === null}>
                  {verifyMutation.isPending ? "Verifying…" : "Verify savings"}
                </Button>
              </CardContent>
            </Card>

            {result && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    Verification result
                    {result.verifiable ? (
                      <Badge variant="default">verifiable</Badge>
                    ) : (
                      <Badge variant="secondary">not verifiable</Badge>
                    )}
                  </CardTitle>
                  <CardDescription>
                    Method <code className="text-xs">{result.method}</code> — unadjusted Wh/day comparison
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {!result.verifiable && (
                    <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900 p-3 text-sm">
                      <AlertCircle className="h-4 w-4 mt-0.5 text-amber-600" />
                      <p>{result.reason ?? "Verification refused."}</p>
                    </div>
                  )}
                  <div className="grid gap-4 md:grid-cols-4 text-sm">
                    <div>
                      <p className="text-muted-foreground">Savings</p>
                      <p className="text-xl font-semibold">
                        {result.verifiable ? fmtWh(result.savingsWh) : "—"}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Savings per day</p>
                      <p className="text-xl font-semibold">
                        {result.verifiable && result.savingsWhPerDay != null
                          ? fmtWh(result.savingsWhPerDay)
                          : "—"}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Baseline coverage</p>
                      <p className="text-xl font-semibold">{coverage(result.baseline.coverageRatio)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Reporting coverage</p>
                      <p className="text-xl font-semibold">{coverage(result.reporting.coverageRatio)}</p>
                    </div>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2 text-sm">
                    <div className="rounded-md border p-3">
                      <p className="font-medium mb-1">Baseline period</p>
                      <p className="text-muted-foreground">
                        {new Date(result.baseline.start).toLocaleString()} –{" "}
                        {new Date(result.baseline.end).toLocaleString()}
                      </p>
                      <p>Energy: {fmtWh(result.baseline.energyWh)}</p>
                      <p>
                        Daily rate:{" "}
                        {result.baseline.whPerDay != null ? fmtWh(result.baseline.whPerDay) : "—"}
                      </p>
                      <p className="text-muted-foreground">
                        {result.baseline.sampleCount} samples · {result.baseline.coveredHours}/
                        {result.baseline.totalHours} hours covered
                      </p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="font-medium mb-1">Reporting period</p>
                      <p className="text-muted-foreground">
                        {new Date(result.reporting.start).toLocaleString()} –{" "}
                        {new Date(result.reporting.end).toLocaleString()}
                      </p>
                      <p>Energy: {fmtWh(result.reporting.energyWh)}</p>
                      <p>
                        Daily rate:{" "}
                        {result.reporting.whPerDay != null ? fmtWh(result.reporting.whPerDay) : "—"}
                      </p>
                      <p className="text-muted-foreground">
                        {result.reporting.sampleCount} samples · {result.reporting.coveredHours}/
                        {result.reporting.totalHours} hours covered
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-base">History</CardTitle>
                <CardDescription>Persisted verifications for this asset — refusals included</CardDescription>
              </CardHeader>
              <CardContent>
                {history.isLoading ? (
                  <Skeleton className="h-24 w-full" />
                ) : history.error ? (
                  <p className="text-sm text-muted-foreground">{history.error.message}</p>
                ) : !history.data || history.data.verifications.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No verifications recorded yet.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Created</TableHead>
                        <TableHead>Baseline</TableHead>
                        <TableHead>Reporting</TableHead>
                        <TableHead>Coverage (B/R)</TableHead>
                        <TableHead>Savings</TableHead>
                        <TableHead>State</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {history.data.verifications.map((v: any) => (
                        <TableRow key={v.id}>
                          <TableCell>{new Date(v.createdAt).toLocaleString()}</TableCell>
                          <TableCell>
                            {new Date(v.baselineStart).toLocaleDateString()} –{" "}
                            {new Date(v.baselineEnd).toLocaleDateString()}
                          </TableCell>
                          <TableCell>
                            {new Date(v.reportingStart).toLocaleDateString()} –{" "}
                            {new Date(v.reportingEnd).toLocaleDateString()}
                          </TableCell>
                          <TableCell>
                            {(v.baselineCoveragePct100 / 100).toFixed(0)}% /{" "}
                            {(v.reportingCoveragePct100 / 100).toFixed(0)}%
                          </TableCell>
                          <TableCell>{fmtWh(v.savingsWh)}</TableCell>
                          <TableCell>
                            {v.verifiable ? (
                              <Badge variant="outline">verifiable</Badge>
                            ) : (
                              <Badge variant="secondary" title={v.reason ?? ""}>
                                refused
                              </Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
