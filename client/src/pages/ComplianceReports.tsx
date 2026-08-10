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
import { FileCheck, Download, ShieldCheck, CheckCircle2, XCircle } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

export default function ComplianceReports() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [verifyId, setVerifyId] = useState("");
  const [verifyLookupId, setVerifyLookupId] = useState<number | null>(null);

  const isAdmin = user?.role === "admin";

  const reports = trpc.complianceReports.listReports.useQuery(
    { limit: 50 },
    { enabled: isAdmin }
  );
  const checksum = trpc.complianceReports.getReportChecksum.useQuery(
    { reportId: verifyLookupId! },
    { enabled: verifyLookupId !== null, retry: false }
  );

  const generateMutation = trpc.complianceReports.generateReport.useMutation({
    onSuccess: (r) => {
      toast.success(`Report #${r.reportId} generated`);
      // Download the PDF (base64 payload from the server).
      try {
        const bytes = Uint8Array.from(atob(r.pdfBase64), (c) => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `compliance-report-${r.reportId}.pdf`;
        a.click();
        URL.revokeObjectURL(url);
      } catch {
        toast.error("Report generated but PDF download failed");
      }
      utils.complianceReports.listReports.invalidate();
    },
    onError: (e) => toast.error(e.message || "Failed to generate report"),
  });

  if (!isAdmin) {
    return (
      <DashboardLayout>
        <div className="container py-8">
          <Card>
            <CardContent className="flex items-center justify-center py-12">
              <p className="text-muted-foreground">Admin access required</p>
            </CardContent>
          </Card>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Compliance Reports</h1>
          <p className="text-muted-foreground">
            Regulator-ready PDF reports with SHA-256 integrity checksums over their canonical source data.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <FileCheck className="h-4 w-4" /> Generate a report
            </CardTitle>
            <CardDescription>
              Compiles compliance checks, DR events and settlement ledger for the period into a PDF
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3 max-w-xl">
              <div className="space-y-2">
                <Label htmlFor="rStart">Period start</Label>
                <Input id="rStart" type="datetime-local" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="rEnd">Period end</Label>
                <Input id="rEnd" type="datetime-local" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
              </div>
            </div>
            <Button
              onClick={() => {
                if (!periodStart || !periodEnd) return toast.error("Set both period bounds");
                generateMutation.mutate({
                  periodStart: new Date(periodStart),
                  periodEnd: new Date(periodEnd),
                });
              }}
              disabled={generateMutation.isPending}
            >
              <Download className="h-4 w-4 mr-2" />
              {generateMutation.isPending ? "Generating…" : "Generate & download PDF"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Generated reports</CardTitle>
            <CardDescription>Metadata and checksums, newest first</CardDescription>
          </CardHeader>
          <CardContent>
            {reports.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : reports.error ? (
              <p className="text-sm text-muted-foreground">{reports.error.message}</p>
            ) : !reports.data || reports.data.reports.length === 0 ? (
              <p className="text-sm text-muted-foreground">No reports generated yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead>Generated</TableHead>
                    <TableHead>By</TableHead>
                    <TableHead>Checksum</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reports.data.reports.map((r: any) => (
                    <TableRow key={r.id}>
                      <TableCell>#{r.id}</TableCell>
                      <TableCell className="text-sm">
                        {new Date(r.periodStart).toLocaleDateString()} – {new Date(r.periodEnd).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(r.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-sm">user #{r.generatedBy}</TableCell>
                      <TableCell>
                        <code className="text-xs">{r.checksum.slice(0, 16)}…</code>
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setVerifyId(String(r.id));
                            setVerifyLookupId(r.id);
                          }}
                        >
                          Verify
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
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" /> Verify report integrity
            </CardTitle>
            <CardDescription>
              Recomputes the SHA-256 of the stored canonical source JSON and compares it to the recorded checksum
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-end gap-2">
              <div className="space-y-2">
                <Label htmlFor="verifyId">Report ID</Label>
                <Input
                  id="verifyId"
                  type="number"
                  min="1"
                  value={verifyId}
                  onChange={(e) => setVerifyId(e.target.value)}
                  className="w-40"
                />
              </div>
              <Button
                variant="outline"
                onClick={() => {
                  const id = parseInt(verifyId, 10);
                  if (!id) return toast.error("Enter a valid report ID");
                  setVerifyLookupId(id);
                }}
              >
                Verify
              </Button>
            </div>
            {verifyLookupId !== null && checksum.isLoading && <Skeleton className="h-16 w-full" />}
            {verifyLookupId !== null && checksum.error && (
              <p className="text-sm text-muted-foreground">{checksum.error.message}</p>
            )}
            {verifyLookupId !== null && checksum.data && (
              <div
                className={`rounded-md border p-4 text-sm space-y-1 ${
                  checksum.data.valid
                    ? "border-green-200 bg-green-50 dark:bg-green-950/20 dark:border-green-900"
                    : "border-red-200 bg-red-50 dark:bg-red-950/20 dark:border-red-900"
                }`}
              >
                {checksum.data.valid ? (
                  <p className="flex items-center gap-2 font-medium text-green-700 dark:text-green-400">
                    <CheckCircle2 className="h-4 w-4" /> Integrity verified — checksums match
                  </p>
                ) : (
                  <p className="flex items-center gap-2 font-medium text-red-700 dark:text-red-400">
                    <XCircle className="h-4 w-4" /> Integrity check failed — checksums do not match
                  </p>
                )}
                <p className="text-muted-foreground break-all">
                  Stored: <code className="text-xs">{checksum.data.storedChecksum}</code>
                </p>
                <p className="text-muted-foreground break-all">
                  Recomputed: <code className="text-xs">{checksum.data.recomputedChecksum}</code>
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
