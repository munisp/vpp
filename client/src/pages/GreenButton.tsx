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
import { Download, FileDown } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

type Format = "csv" | "espi_xml";
type Scope = "usage" | "billing" | "both";

export default function GreenButton() {
  const utils = trpc.useUtils();

  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [format, setFormat] = useState<Format>("csv");
  const [scope, setScope] = useState<Scope>("both");
  const [downloadingId, setDownloadingId] = useState<number | null>(null);

  const jobs = trpc.greenButton.listExports.useQuery({ limit: 20 });

  const requestMutation = trpc.greenButton.requestExport.useMutation({
    onSuccess: (job) => {
      if (job.status === "ready") {
        toast.success(
          job.empty
            ? "Export ready — the period contains no rows (headers only)"
            : `Export #${job.id} ready`
        );
      } else {
        toast.error(job.failureReason || "Export failed");
      }
      utils.greenButton.listExports.invalidate();
    },
    onError: (e) => toast.error(e.message || "Export request failed"),
  });

  const handleRequest = () => {
    if (!periodStart || !periodEnd) return toast.error("Choose a start and end date");
    const start = new Date(periodStart);
    const end = new Date(periodEnd);
    if (!(end > start)) return toast.error("End must be after start");
    requestMutation.mutate({ periodStart: start, periodEnd: end, format, scope });
  };

  const handleDownload = async (jobId: number) => {
    setDownloadingId(jobId);
    try {
      const r = await utils.greenButton.downloadExport.fetch({ jobId });
      // Base64 payload from the server — decode and save (same pattern as ComplianceReports).
      const bytes = Uint8Array.from(atob(r.contentBase64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], {
        type: r.format === "csv" ? "text/csv" : "application/xml",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = r.filename;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Downloaded ${r.filename} — SHA-256 ${r.checksum.slice(0, 12)}…`);
    } catch (e: any) {
      toast.error(e?.message || "Download failed");
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Green Button Export</h1>
          <p className="text-muted-foreground">
            Export your own usage and billing data as CSV or an ESPI-flavored XML envelope. Every
            row is a real telemetry or billing record — nothing is interpolated or synthesized.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <FileDown className="h-4 w-4" /> Request an export
            </CardTitle>
            <CardDescription>The job is assembled immediately and recorded with its outcome</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-4">
              <div className="space-y-2">
                <Label htmlFor="gbStart">Period start</Label>
                <Input
                  id="gbStart"
                  type="date"
                  value={periodStart}
                  onChange={(e) => setPeriodStart(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="gbEnd">Period end</Label>
                <Input
                  id="gbEnd"
                  type="date"
                  value={periodEnd}
                  onChange={(e) => setPeriodEnd(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Format</Label>
                <Select value={format} onValueChange={(v) => setFormat(v as Format)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="csv">CSV</SelectItem>
                    <SelectItem value="espi_xml">ESPI XML</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Scope</Label>
                <Select value={scope} onValueChange={(v) => setScope(v as Scope)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="both">Usage + billing</SelectItem>
                    <SelectItem value="usage">Usage only</SelectItem>
                    <SelectItem value="billing">Billing only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button onClick={handleRequest} disabled={requestMutation.isPending}>
              {requestMutation.isPending ? "Assembling…" : "Request export"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Export jobs</CardTitle>
            <CardDescription>
              Newest first. A ready job with zero rows is an honest empty answer, not an error.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {jobs.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : jobs.error ? (
              <p className="text-sm text-muted-foreground">{jobs.error.message}</p>
            ) : !jobs.data || jobs.data.jobs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No export jobs yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Job</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead>Format / scope</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Rows</TableHead>
                    <TableHead>Checksum (SHA-256)</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.data.jobs.map((j: any) => (
                    <TableRow key={j.id}>
                      <TableCell className="text-sm text-muted-foreground">#{j.id}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(j.periodStart).toLocaleDateString()} –{" "}
                        {new Date(j.periodEnd).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-sm">
                        {j.format} / {j.scope}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            j.status === "ready"
                              ? "default"
                              : j.status === "failed"
                                ? "destructive"
                                : "secondary"
                          }
                        >
                          {j.status}
                        </Badge>
                        {j.empty === true && (
                          <Badge variant="outline" className="ml-1">
                            empty
                          </Badge>
                        )}
                        {j.status === "failed" && j.failureReason && (
                          <p className="text-xs text-muted-foreground mt-1 max-w-48">{j.failureReason}</p>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {j.status === "ready" ? (
                          <>
                            {j.telemetryRowCount ?? "—"} telemetry / {j.billingRowCount ?? "—"} billing
                          </>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>
                        {j.checksum ? (
                          <code className="text-xs" title={j.checksum}>
                            {j.checksum.slice(0, 16)}…
                          </code>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {j.status === "ready" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleDownload(j.id)}
                            disabled={downloadingId === j.id}
                          >
                            <Download className="h-4 w-4 mr-1" />
                            {downloadingId === j.id ? "Downloading…" : "Download"}
                          </Button>
                        )}
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
