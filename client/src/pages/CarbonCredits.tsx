import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, CheckCircle2, Leaf, ShieldCheck, XCircle } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

function fmtWh(wh: number): string {
  return wh >= 1000 ? `${(wh / 1000).toFixed(1)} kWh` : `${wh} Wh`;
}
function fmtGrams(g: number | null | undefined): string {
  if (g === null || g === undefined) return "unavailable";
  return g >= 1000 ? `${(g / 1000).toFixed(1)} kg CO₂` : `${g} g CO₂`;
}

export default function CarbonCredits() {
  const [hashInput, setHashInput] = useState("");
  const [hashToVerify, setHashToVerify] = useState<string | null>(null);

  const summary = trpc.carbonCredits.getMyCarbonSummary.useQuery();
  const certs = trpc.carbonCredits.listMyCertificates.useQuery({ limit: 50 });
  const verification = trpc.carbonCredits.verifyCertificate.useQuery(
    { certificateHash: hashToVerify! },
    { enabled: hashToVerify !== null, retry: false }
  );

  const s = summary.data;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Carbon Credits</h1>
          <p className="text-muted-foreground">
            CO₂ avoided from your verified solar generation. One certificate per 100 kWh.
          </p>
        </div>

        {summary.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : summary.error ? (
          <Card>
            <CardContent className="flex items-center gap-3 py-8 text-muted-foreground">
              <AlertCircle className="h-5 w-5" />
              <p>{summary.error.message}</p>
            </CardContent>
          </Card>
        ) : s ? (
          <div className="grid gap-4 md:grid-cols-4">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-1">
                  <Leaf className="h-3 w-3" /> CO₂ avoided
                </CardDescription>
                <CardTitle className="text-2xl">{fmtGrams(s.co2AvoidedGrams)}</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                {s.emissionFactorGramsPerKwh != null
                  ? `${s.emissionFactorGramsPerKwh} g/kWh (${s.region})`
                  : "No live emission factor for your region — CO₂ savings are reported as unavailable."}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Solar generation (all time)</CardDescription>
                <CardTitle className="text-2xl">{fmtWh(s.solarGenerationWh)}</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                measured via {String(s.energyMethod).replace(/_/g, " ")}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Certificates minted</CardDescription>
                <CardTitle className="text-2xl">{s.certificatesMintedTotal}</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                {s.newCertificatesMinted > 0 ? `${s.newCertificatesMinted} newly minted` : "no new certificates"}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Uncertified remainder</CardDescription>
                <CardTitle className="text-2xl">{fmtWh(s.uncertifiedEnergyWh)}</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                {s.mintSkippedReason ? s.mintSkippedReason : `${(100000 - (s.uncertifiedEnergyWh % 100000)) / 1000} kWh until next certificate`}
              </CardContent>
            </Card>
          </div>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">My certificates</CardTitle>
            <CardDescription>Deterministically hashed, publicly verifiable</CardDescription>
          </CardHeader>
          <CardContent>
            {certs.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : !certs.data || certs.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No certificates yet — they are minted automatically per 100 kWh of verified solar generation.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Energy</TableHead>
                    <TableHead>CO₂ avoided</TableHead>
                    <TableHead>Region</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Minted</TableHead>
                    <TableHead>Hash</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {certs.data.map((c: any) => (
                    <TableRow key={c.id}>
                      <TableCell>{c.sequence}</TableCell>
                      <TableCell>{fmtWh(c.energyWh)}</TableCell>
                      <TableCell>{fmtGrams(c.co2AvoidedGrams)}</TableCell>
                      <TableCell>{c.region}</TableCell>
                      <TableCell>
                        <Badge variant={c.status === "minted" ? "default" : "secondary"}>{c.status}</Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(c.mintedAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        <code className="text-xs">{c.certificateHash.slice(0, 12)}…</code>
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
              <ShieldCheck className="h-4 w-4" /> Verify a certificate
            </CardTitle>
            <CardDescription>
              Anyone can verify a certificate by its 64-character SHA-256 hash.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2 items-end">
              <div className="flex-1 space-y-2">
                <Label htmlFor="hash">Certificate hash</Label>
                <Input
                  id="hash"
                  value={hashInput}
                  onChange={(e) => setHashInput(e.target.value.trim())}
                  placeholder="64 hex characters"
                  className="font-mono text-xs"
                />
              </div>
              <Button
                variant="outline"
                onClick={() => setHashToVerify(/^[0-9a-fA-F]{64}$/.test(hashInput) ? hashInput : null)}
                disabled={!/^[0-9a-fA-F]{64}$/.test(hashInput)}
              >
                Verify
              </Button>
            </div>
            {hashToVerify !== null && !/^[0-9a-fA-F]{64}$/.test(hashInput) && (
              <p className="text-sm text-muted-foreground">Enter a valid 64-character hex hash.</p>
            )}
            {hashToVerify && verification.isLoading && <Skeleton className="h-16 w-full" />}
            {hashToVerify && verification.error && (
              <p className="text-sm text-muted-foreground">{verification.error.message}</p>
            )}
            {hashToVerify && verification.data && (
              <div
                className={`rounded-md border p-4 text-sm ${
                  verification.data.valid
                    ? "border-green-200 bg-green-50 dark:bg-green-950/20 dark:border-green-900"
                    : "border-red-200 bg-red-50 dark:bg-red-950/20 dark:border-red-900"
                }`}
              >
                {verification.data.found ? (
                  verification.data.valid ? (
                    <div className="space-y-1">
                      <p className="flex items-center gap-2 font-medium text-green-700 dark:text-green-400">
                        <CheckCircle2 className="h-4 w-4" /> Certificate valid
                      </p>
                      {verification.data.certificate && (
                        <div className="text-muted-foreground space-y-0.5">
                          <p>Region: {verification.data.certificate.region}</p>
                          <p>Energy: {fmtWh(verification.data.certificate.energyWh)}</p>
                          <p>CO₂ avoided: {fmtGrams(verification.data.certificate.co2AvoidedGrams)}</p>
                          <p>
                            Emission factor: {verification.data.certificate.emissionFactorGramsPerKwh} g/kWh (
                            {verification.data.certificate.emissionFactorSource})
                          </p>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="flex items-center gap-2 font-medium text-red-700 dark:text-red-400">
                      <XCircle className="h-4 w-4" /> Certificate found but hash does not match — integrity check failed.
                    </p>
                  )
                ) : (
                  <p className="flex items-center gap-2 text-muted-foreground">
                    <XCircle className="h-4 w-4" /> No certificate found with this hash.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
