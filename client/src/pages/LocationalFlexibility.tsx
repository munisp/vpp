/**
 * "What relief this part of the network needs, who can actually supply it, and
 * what was measured afterwards."
 *
 * Located flexibility pays for a change in power at a specific node, so the
 * screen keeps location provenance, awarded capacity and measured delivery
 * visibly apart: unverified links are shown as capacity that cannot be sold, a
 * short clearing is never dressed up as a cleared one, and an award only reads as
 * delivery once telemetry says so.
 */

import { useState } from "react";

import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { AlertTriangle, Info } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import {
  DELIVERY_STATUS_COPY,
  DIRECTION_COPY,
  LINK_SOURCE_COPY,
  canSettle,
  describeAwardEvidence,
  describeNodeCapacity,
  describeRequirementCoverage,
  formatKw,
  formatPrice,
  requirementStatusCopy,
  type DeliveryStatus,
  type FlexibilityDirection,
  type FlexibilityTone,
  type NodeLinkSource,
} from "@/lib/locational-flexibility";

const TONE_CLASS: Record<FlexibilityTone, string> = {
  good: "bg-emerald-100 text-emerald-900 border-emerald-300",
  warning: "bg-amber-100 text-amber-900 border-amber-300",
  danger: "bg-red-100 text-red-900 border-red-300",
  neutral: "bg-muted text-muted-foreground border-border",
};

function ToneBadge({
  label,
  tone,
  meaning,
}: {
  label: string;
  tone: FlexibilityTone;
  meaning?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={TONE_CLASS[tone]}>
          {label}
        </Badge>
      </TooltipTrigger>
      {meaning && <TooltipContent className="max-w-xs">{meaning}</TooltipContent>}
    </Tooltip>
  );
}

function ReadError({ message }: { message: string }) {
  // A failed read is an outage, never an empty market.
  return (
    <div className="flex items-start gap-2 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
      <AlertTriangle className="mt-0.5 h-4 w-4" />
      <span>{message}</span>
    </div>
  );
}

function NodeHeadroom({ region }: { region: string }) {
  const nodes = trpc.locationalFlexibility.nodes.useQuery(region ? { region } : {});

  if (nodes.isLoading) return <Skeleton className="h-32 w-full" />;
  if (nodes.error) return <ReadError message={nodes.error.message} />;

  const rows = nodes.data ?? [];
  if (rows.length === 0) {
    return (
      <div className="flex items-start gap-2 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4" />
        <span>No grid nodes are registered for this scope.</span>
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Node</TableHead>
          <TableHead>Kind</TableHead>
          <TableHead>Region</TableHead>
          <TableHead>Awardable rated capacity</TableHead>
          <TableHead>Unverified location</TableHead>
          <TableHead>Open requirements</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(node => {
          const capacity = describeNodeCapacity(node);
          return (
            <TableRow key={node.nodeId}>
              <TableCell className="whitespace-nowrap font-medium">
                {node.code}
                <span className="block text-xs text-muted-foreground">{node.name}</span>
              </TableCell>
              <TableCell className="capitalize">{node.kind}</TableCell>
              <TableCell>{node.region ?? "—"}</TableCell>
              <TableCell>
                <ToneBadge {...capacity} />
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {node.unverifiedAssets === 0 ? (
                  <span className="text-muted-foreground">none</span>
                ) : (
                  <ToneBadge
                    label={`${node.unverifiedAssets} asset${node.unverifiedAssets === 1 ? "" : "s"}`}
                    tone="danger"
                    meaning={LINK_SOURCE_COPY.unverified.meaning}
                  />
                )}
              </TableCell>
              <TableCell>{node.openRequirements}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function OperatorRequirements({ region }: { region: string }) {
  const utils = trpc.useUtils();
  const requirements = trpc.locationalFlexibility.requirements.useQuery(
    region ? { region, limit: 50 } : { limit: 50 }
  );

  const clear = trpc.locationalFlexibility.clear.useMutation({
    onSuccess: result => {
      const ineligible = result.ineligible.length;
      toast[result.status === "short" ? "warning" : "success"](
        result.status === "short"
          ? `Short: only ${formatKw(result.clearedPowerW)} of ${formatKw(result.requiredPowerW)} covered` +
              (ineligible > 0 ? `; ${ineligible} offer(s) ineligible` : "")
          : `Cleared ${formatKw(result.clearedPowerW)} across ${result.awards.length} award(s)`
      );
      for (const entry of result.ineligible) {
        toast.warning(`Offer ${entry.offerId}: ${entry.reason}`);
      }
      utils.locationalFlexibility.requirements.invalidate();
    },
    onError: error => toast.error(error.message || "Clearing failed"),
  });

  const measure = trpc.locationalFlexibility.measure.useMutation({
    onSuccess: result => {
      const unverified = result.results.filter(entry => entry.deliveryStatus === "unverified");
      toast.success(
        `Measured ${result.results.length} award(s)` +
          (unverified.length > 0 ? `; ${unverified.length} unverified for want of telemetry` : "")
      );
      for (const entry of unverified) {
        toast.warning(`Award ${entry.awardId}: ${entry.unverifiedReason ?? "unverified"}`);
      }
      utils.locationalFlexibility.requirements.invalidate();
    },
    onError: error => toast.error(error.message || "Measurement failed"),
  });

  if (requirements.isLoading) return <Skeleton className="h-40 w-full" />;
  if (requirements.error) return <ReadError message={requirements.error.message} />;

  const rows = requirements.data ?? [];
  if (rows.length === 0) {
    return (
      <div className="flex items-start gap-2 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4" />
        <span>No flexibility requirements have been published for this scope.</span>
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Window</TableHead>
          <TableHead>Node</TableHead>
          <TableHead>Direction</TableHead>
          <TableHead>Needed</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Coverage</TableHead>
          <TableHead>Clearing price</TableHead>
          <TableHead className="text-right">Operator</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(requirement => {
          const status = requirementStatusCopy(requirement.status);
          const coverage = describeRequirementCoverage(requirement);
          const direction = DIRECTION_COPY[requirement.direction as FlexibilityDirection];
          const elapsed = new Date(requirement.endsAt).getTime() <= Date.now();
          return (
            <TableRow key={requirement.id}>
              <TableCell className="whitespace-nowrap text-xs">
                {new Date(requirement.startsAt).toLocaleString()}
                <span className="block text-muted-foreground">
                  to {new Date(requirement.endsAt).toLocaleTimeString()}
                </span>
              </TableCell>
              <TableCell className="whitespace-nowrap font-medium">
                {requirement.nodeCode}
                <span className="block text-xs text-muted-foreground">
                  {requirement.region ?? "—"}
                </span>
              </TableCell>
              <TableCell>
                <ToneBadge label={direction.label} tone="neutral" meaning={direction.meaning} />
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {formatKw(requirement.requiredPowerW)}
                <span className="block text-xs text-muted-foreground">
                  cap {formatPrice(requirement.priceCapCentsPerKwh, requirement.currency)}
                </span>
              </TableCell>
              <TableCell>
                <ToneBadge {...status} />
              </TableCell>
              <TableCell>
                <ToneBadge {...coverage} />
                <span className="ml-2 text-xs text-muted-foreground">
                  {requirement.offers} offer{requirement.offers === 1 ? "" : "s"}
                </span>
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {requirement.clearingPriceCentsPerKwh === null
                  ? "—"
                  : formatPrice(requirement.clearingPriceCentsPerKwh, requirement.currency)}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-2">
                  {requirement.status === "open" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={clear.isPending}
                      onClick={() => clear.mutate({ requirementId: requirement.id })}
                    >
                      Clear
                    </Button>
                  )}
                  {requirement.awards > 0 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={measure.isPending || !elapsed}
                          onClick={() => measure.mutate({ requirementId: requirement.id })}
                        >
                          Measure
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        {elapsed
                          ? "Compares each asset's telemetry against its own baseline for this window."
                          : "The delivery window has not elapsed, so there is nothing to measure yet."}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function MyOpportunities() {
  const utils = trpc.useUtils();
  const opportunities = trpc.locationalFlexibility.myOpportunities.useQuery();
  const [powerByKey, setPowerByKey] = useState<Record<string, string>>({});
  const [priceByKey, setPriceByKey] = useState<Record<string, string>>({});

  const offer = trpc.locationalFlexibility.offer.useMutation({
    onSuccess: () => {
      toast.success("Offer submitted. It is awarded only if clearing reaches your price.");
      utils.locationalFlexibility.myOpportunities.invalidate();
      utils.locationalFlexibility.myAwards.invalidate();
    },
    onError: error => toast.error(error.message || "Offer refused"),
  });

  if (opportunities.isLoading) return <Skeleton className="h-32 w-full" />;
  if (opportunities.error) return <ReadError message={opportunities.error.message} />;

  const rows = opportunities.data ?? [];
  if (rows.length === 0) {
    return (
      <div className="flex items-start gap-2 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4" />
        <span>
          No open requirement matches a node your assets are recorded behind. Location is recorded
          by the network operator, so an asset with no confirmed node cannot offer here.
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rows.map(row => {
        const key = `${row.requirementId}:${row.assetId}`;
        const link = LINK_SOURCE_COPY[row.linkSource as NodeLinkSource];
        const direction = DIRECTION_COPY[row.direction as FlexibilityDirection];
        return (
          <div key={key} className="rounded border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{row.assetName}</span>
              <span className="text-muted-foreground">at {row.nodeCode}</span>
              <ToneBadge label={link.label} tone={link.tone} meaning={link.meaning} />
              <ToneBadge label={direction.label} tone="neutral" meaning={direction.meaning} />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {new Date(row.startsAt).toLocaleString()} to{" "}
              {new Date(row.endsAt).toLocaleTimeString()} · node needs{" "}
              {formatKw(row.requiredPowerW)} · pays up to{" "}
              {formatPrice(row.priceCapCentsPerKwh, row.currency)} · your asset is rated{" "}
              {formatKw(row.assetCapacityW)}
            </p>
            {row.alreadyOffered ? (
              <p className="mt-2 text-xs text-muted-foreground">
                You have already offered this asset into this window.
              </p>
            ) : (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Offered power (W)</p>
                  <Input
                    value={powerByKey[key] ?? ""}
                    onChange={event =>
                      setPowerByKey(previous => ({ ...previous, [key]: event.target.value }))
                    }
                    placeholder={String(row.assetCapacityW)}
                    className="w-32"
                  />
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Price (cents/kWh ×100)</p>
                  <Input
                    value={priceByKey[key] ?? ""}
                    onChange={event =>
                      setPriceByKey(previous => ({ ...previous, [key]: event.target.value }))
                    }
                    placeholder={String(row.priceCapCentsPerKwh)}
                    className="w-40"
                  />
                </div>
                <Button
                  size="sm"
                  disabled={offer.isPending}
                  onClick={() =>
                    offer.mutate({
                      requirementId: row.requirementId,
                      assetId: row.assetId,
                      offeredPowerW: Number(powerByKey[key] ?? 0),
                      priceCentsPerKwh: Number(priceByKey[key] ?? 0),
                    })
                  }
                >
                  Offer
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function MyAwards({ isAdmin }: { isAdmin: boolean }) {
  const utils = trpc.useUtils();
  const awards = trpc.locationalFlexibility.myAwards.useQuery({ limit: 25 });
  const settle = trpc.locationalFlexibility.settle.useMutation({
    onSuccess: result =>
      toast.success(`Settled award ${result.awardId} as ledger event ${result.settlementEventId}`),
    onError: error => toast.error(error.message || "Settlement refused"),
  });

  if (awards.isLoading) return <Skeleton className="h-32 w-full" />;
  if (awards.error) return <ReadError message={awards.error.message} />;

  const rows = awards.data ?? [];
  if (rows.length === 0) {
    return (
      <div className="flex items-start gap-2 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4" />
        <span>No award yet. Offers become awards only when a requirement clears.</span>
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Window</TableHead>
          <TableHead>Node</TableHead>
          <TableHead>Awarded</TableHead>
          <TableHead>Delivery</TableHead>
          <TableHead>Measured energy</TableHead>
          <TableHead>Earned</TableHead>
          {isAdmin && <TableHead className="text-right">Settle</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(award => {
          const evidence = describeAwardEvidence(award);
          return (
            <TableRow key={award.awardId}>
              <TableCell className="whitespace-nowrap text-xs">
                {new Date(award.startsAt).toLocaleString()}
              </TableCell>
              <TableCell className="whitespace-nowrap">{award.nodeCode}</TableCell>
              <TableCell className="whitespace-nowrap">
                {formatKw(award.awardedPowerW)}
                <span className="block text-xs text-muted-foreground">
                  {formatPrice(award.priceCentsPerKwh, award.currency)}
                </span>
              </TableCell>
              <TableCell>
                <ToneBadge {...evidence} />
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {award.deliveredEnergyWh === null
                  ? "—"
                  : `${(award.deliveredEnergyWh / 1000).toFixed(2)} kWh`}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {award.earnedAmount === null
                  ? "—"
                  : `${award.earnedAmount} ${award.currency}`}
                {award.settled && (
                  <span className="block text-xs text-emerald-700">paid into ledger</span>
                )}
              </TableCell>
              {isAdmin && (
                <TableCell className="text-right">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={settle.isPending || !canSettle(award)}
                        onClick={() => settle.mutate({ awardId: award.awardId })}
                      >
                        Settle
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      {canSettle(award)
                        ? "Pays the measured energy, not the awarded capacity."
                        : DELIVERY_STATUS_COPY[award.deliveryStatus as DeliveryStatus].meaning}
                    </TooltipContent>
                  </Tooltip>
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export default function LocationalFlexibility() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [region, setRegion] = useState("");
  const [appliedRegion, setAppliedRegion] = useState("");

  return (
    <DashboardLayout>
      <TooltipProvider>
        <div className="space-y-6">
          <div>
            <h1 className="text-2xl font-semibold">Locational flexibility</h1>
            <p className="text-sm text-muted-foreground">
              Relief bought at a named substation, feeder or transformer. Capacity is only sellable
              here if the network operator has recorded which node the asset sits behind, and an
              award is paid on measured delivery against that asset's own baseline — never on the
              award itself.
            </p>
          </div>

          {isAdmin && (
            <>
              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Region (blank = all nodes)</p>
                  <Input
                    value={region}
                    onChange={event => setRegion(event.target.value)}
                    placeholder="e.g. TZ-DAR"
                    className="w-48"
                  />
                </div>
                <Button size="sm" variant="outline" onClick={() => setAppliedRegion(region.trim())}>
                  Apply scope
                </Button>
              </div>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Network nodes</CardTitle>
                  <CardDescription>
                    Rated capacity behind each node, with the capacity that cannot be awarded
                    because nobody has confirmed the asset's location.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <NodeHeadroom region={appliedRegion} />
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Requirements and clearing</CardTitle>
                  <CardDescription>
                    Clearing takes the cheapest eligible offers in merit order. A requirement that
                    runs out of eligible capacity is recorded as short, not cleared.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <OperatorRequirements region={appliedRegion} />
                </CardContent>
              </Card>
            </>
          )}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Requirements your assets can offer into</CardTitle>
              <CardDescription>
                Only assets recorded behind the requirement's node appear here. An offer is a price
                and a quantity; nothing is committed until clearing.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <MyOpportunities />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Your awards and what was measured</CardTitle>
              <CardDescription>
                Delivery comes from this asset's telemetry against its own baseline for the same
                clock window on earlier days. Too little telemetry is reported as unverified —
                neither delivery nor breach — and cannot be paid.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <MyAwards isAdmin={isAdmin} />
            </CardContent>
          </Card>
        </div>
      </TooltipProvider>
    </DashboardLayout>
  );
}
