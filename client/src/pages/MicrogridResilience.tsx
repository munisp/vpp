/**
 * "If the grid goes down right now, what stays on, and for how long?"
 *
 * The answer used to be manufactured: autonomy was `shared_capacity_kw * 2`
 * hours of an imaginary battery, and critical loads were reported as served
 * whenever measured generation exceeded half of measured load. Both read like
 * engineering to whoever was relying on the clinic staying lit.
 *
 * This page shows the same question answered from the register: declared
 * critical loads, registered pack energy and discharge limits, and the last
 * readings inside the freshness bound. Where an input is missing the figure is
 * `unknown` with the survey or registration task that would fill it — never a
 * default, and never a zero standing in for something nobody measured.
 */

import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { AlertTriangle, BatteryCharging, Plus, RefreshCw, ShieldCheck, Users } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { MetricTile, PageHeader, PanelCard, ToneBadge } from "@/components/ops";
import {
  CRITICAL_LOAD_CATEGORY_LABEL,
  DEMAND_SOURCE_COPY,
  RATING_SOURCE_COPY,
  autonomyCopy,
  criticalServiceCopy,
  hoursLabel,
} from "../../../shared/microgrid-resilience-copy";

const CATEGORIES = Object.keys(CRITICAL_LOAD_CATEGORY_LABEL);
const RATING_SOURCES = Object.keys(RATING_SOURCE_COPY);

export default function MicrogridResilience() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const communities = trpc.community.getUserCommunities.useQuery();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const communityId = selectedId ?? communities.data?.[0]?.id ?? null;

  const isAdmin = user?.role === "admin";

  const status = trpc.community.getMicrogridStatus.useQuery(
    { communityId: communityId! },
    { enabled: communityId !== null, retry: false }
  );
  const loads = trpc.community.listCriticalLoads.useQuery(
    { communityId: communityId!, includeInactive: true },
    { enabled: communityId !== null, retry: false }
  );

  const [label, setLabel] = useState("");
  const [category, setCategory] = useState<string>("health");
  const [ratedPowerW, setRatedPowerW] = useState("");
  const [ratingSource, setRatingSource] = useState<string>("nameplate");
  const [autonomyTargetHours, setAutonomyTargetHours] = useState("");

  const declare = trpc.community.declareCriticalLoad.useMutation({
    onSuccess: () => {
      toast.success("Critical load declared");
      setLabel("");
      setRatedPowerW("");
      setAutonomyTargetHours("");
      void utils.community.listCriticalLoads.invalidate();
      void utils.community.getMicrogridStatus.invalidate();
    },
    onError: e => toast.error(e.message),
  });

  const resilience = status.data?.resilience;
  const autonomy = resilience?.autonomy;
  const critical = resilience?.criticalService;
  const storage = resilience?.storage;

  const autonomyState = useMemo(
    () => autonomyCopy(autonomy?.hours ?? null, autonomy?.basis ?? null, autonomy?.reason ?? null),
    [autonomy]
  );
  const criticalState = useMemo(
    () => criticalServiceCopy(critical?.served ?? null, critical?.reason ?? null),
    [critical]
  );

  const refreshing = status.isFetching || loads.isFetching;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeader
          title="Microgrid resilience"
          description="Ride-through and critical-load coverage computed from the register: declared critical loads, registered pack energy and discharge limits, and readings inside the 15-minute freshness bound."
          caveat="Nothing here is estimated. A missing survey or an unregistered limit reads as unknown with the task that would resolve it, because an invented autonomy figure is a promise to whoever is relying on that load."
          actions={
            <div className="flex items-center gap-2">
              <Select
                value={communityId !== null ? String(communityId) : undefined}
                onValueChange={v => setSelectedId(Number(v))}
              >
                <SelectTrigger className="w-56">
                  <SelectValue placeholder="Select a community" />
                </SelectTrigger>
                <SelectContent>
                  {(communities.data ?? []).map(community => (
                    <SelectItem key={community.id} value={String(community.id)}>
                      {community.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                disabled={refreshing || communityId === null}
                onClick={() => {
                  void status.refetch();
                  void loads.refetch();
                }}
              >
                <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
          }
          className="mb-0"
        />

        {communities.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : (communities.data ?? []).length === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground flex items-center gap-3 py-10">
              <Users className="h-5 w-5" />
              <p>You are not a member of any energy community yet.</p>
            </CardContent>
          </Card>
        ) : communityId === null ? null : (
          <>
            {status.isError && (
              <Card className="border-red-300">
                <CardContent className="py-4 text-sm">
                  <p className="flex items-center gap-2 font-medium">
                    <AlertTriangle className="h-4 w-4 text-red-600" />
                    Resilience could not be read
                  </p>
                  <p className="text-muted-foreground mt-1">
                    {status.error.message} — the state of this microgrid is unknown right now. This
                    is not an all-clear.
                  </p>
                </CardContent>
              </Card>
            )}

            {status.isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <MetricTile
                  label="Critical-load coverage"
                  value={criticalState.label}
                  tone={criticalState.tone}
                  evidence={
                    <span className="text-muted-foreground">{criticalState.meaning}</span>
                  }
                />
                <MetricTile
                  label="Ride-through"
                  value={hoursLabel(autonomy?.hours ?? null)}
                  unit="hours"
                  tone={autonomyState.tone}
                  status={{
                    label: autonomyState.label,
                    tone: autonomyState.tone,
                    meaning: autonomyState.meaning,
                  }}
                  evidence={
                    <span className="text-muted-foreground">
                      {autonomy?.netDrainKw !== null && autonomy?.netDrainKw !== undefined
                        ? `against ${autonomy.netDrainKw} kW measured net drain`
                        : autonomyState.meaning}
                    </span>
                  }
                />
                <MetricTile
                  label="Critical demand"
                  value={critical?.demandKw !== null && critical?.demandKw !== undefined ? String(critical.demandKw) : null}
                  unit="kW"
                  tone={
                    critical?.demandSource
                      ? DEMAND_SOURCE_COPY[critical.demandSource].tone
                      : "neutral"
                  }
                  status={
                    critical?.demandSource
                      ? {
                          label: DEMAND_SOURCE_COPY[critical.demandSource].label,
                          tone: DEMAND_SOURCE_COPY[critical.demandSource].tone,
                          meaning: DEMAND_SOURCE_COPY[critical.demandSource].meaning,
                        }
                      : undefined
                  }
                  evidence={
                    <span className="text-muted-foreground">
                      {critical
                        ? `${critical.meteredLoads}/${critical.registeredLoads} declared load(s) metered`
                        : "no register read"}
                    </span>
                  }
                />
                <MetricTile
                  label="Usable stored energy"
                  value={
                    storage?.usableEnergyWh !== null && storage?.usableEnergyWh !== undefined
                      ? (storage.usableEnergyWh / 1000).toFixed(2)
                      : null
                  }
                  unit="kWh"
                  tone={storage?.complete ? "good" : "warning"}
                  evidence={
                    <span className="text-muted-foreground">
                      {storage
                        ? `${storage.assessedBatteries}/${storage.registeredBatteries} registered batter${storage.registeredBatteries === 1 ? "y" : "ies"} assessed, above the registered floor`
                        : "no storage read"}
                    </span>
                  }
                />
              </div>
            )}

            <PanelCard
              title="What this assessment could not establish"
              description="Every withheld figure, with the registration or survey that would produce it."
              footer={`Islanding is refused while critical-load coverage is anything other than covered, and a confirmed physical transition is still required afterwards. Telemetry older than 15 minutes is not treated as the present state.`}
            >
              {status.isLoading ? (
                <Skeleton className="h-16 w-full" />
              ) : (resilience?.limitations.length ?? 0) === 0 ? (
                <p className="flex items-center gap-2 text-sm">
                  <ShieldCheck className="h-4 w-4 text-emerald-600" />
                  Every figure above is computed from registered and measured inputs.
                </p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {(resilience?.limitations ?? []).map(limitation => (
                    <li key={limitation} className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                      <span>{limitation}</span>
                    </li>
                  ))}
                </ul>
              )}
            </PanelCard>

            <PanelCard
              title="Critical-load register"
              description="The loads this microgrid is required to keep energised. Coverage and ride-through are computed against these rows and nothing else."
              footer="An empty register means coverage is unknown, not satisfied."
            >
              {loads.isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : loads.isError ? (
                <p className="text-muted-foreground text-sm">{loads.error.message}</p>
              ) : (loads.data?.length ?? 0) === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No load has been declared critical for this community, so no resilience figure can
                  be judged against one.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Load</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead className="text-right">Priority</TableHead>
                      <TableHead className="text-right">Rated</TableHead>
                      <TableHead>Rating basis</TableHead>
                      <TableHead className="text-right">Autonomy target</TableHead>
                      <TableHead>Meter</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(loads.data ?? []).map(load => {
                      const rating = RATING_SOURCE_COPY[load.ratingSource];
                      return (
                        <TableRow key={load.id} className={load.active ? undefined : "opacity-60"}>
                          <TableCell className="font-medium">
                            {load.label}
                            {!load.active && (
                              <span className="text-muted-foreground ml-2 text-xs">(inactive)</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {CRITICAL_LOAD_CATEGORY_LABEL[load.category] ?? load.category}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{load.priority}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {(load.ratedPowerW / 1000).toFixed(2)} kW
                          </TableCell>
                          <TableCell>
                            {rating ? (
                              <ToneBadge
                                label={rating.label}
                                tone={rating.tone}
                                meaning={rating.meaning}
                              />
                            ) : (
                              load.ratingSource
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {load.autonomyTargetHours === null
                              ? "—"
                              : `${load.autonomyTargetHours} h`}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-xs">
                            {load.assetId === null
                              ? "not metered"
                              : `asset #${load.assetId}`}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}

              {isAdmin && (
                <div className="mt-4 grid gap-3 border-t pt-4 md:grid-cols-6">
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="cl-label">Load</Label>
                    <Input
                      id="cl-label"
                      value={label}
                      placeholder="Clinic cold chain"
                      onChange={e => setLabel(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Category</Label>
                    <Select value={category} onValueChange={setCategory}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CATEGORIES.map(value => (
                          <SelectItem key={value} value={value}>
                            {CRITICAL_LOAD_CATEGORY_LABEL[value]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="cl-power">Rated power (W)</Label>
                    <Input
                      id="cl-power"
                      inputMode="numeric"
                      value={ratedPowerW}
                      placeholder="1500"
                      onChange={e => setRatedPowerW(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Rating basis</Label>
                    <Select value={ratingSource} onValueChange={setRatingSource}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {RATING_SOURCES.map(value => (
                          <SelectItem key={value} value={value}>
                            {RATING_SOURCE_COPY[value].label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="cl-target">Autonomy target (h)</Label>
                    <div className="flex gap-2">
                      <Input
                        id="cl-target"
                        inputMode="numeric"
                        value={autonomyTargetHours}
                        placeholder="8"
                        onChange={e => setAutonomyTargetHours(e.target.value)}
                      />
                      <Button
                        disabled={declare.isPending}
                        onClick={() => {
                          const watts = Number(ratedPowerW);
                          if (!label.trim() || !Number.isFinite(watts) || watts <= 0) {
                            toast.error("A declared load needs a name and a positive rated power");
                            return;
                          }
                          const target = autonomyTargetHours.trim()
                            ? Number(autonomyTargetHours)
                            : null;
                          if (target !== null && (!Number.isFinite(target) || target <= 0)) {
                            toast.error("An autonomy target must be a positive number of hours");
                            return;
                          }
                          declare.mutate({
                            communityId,
                            label: label.trim(),
                            category: category as "health",
                            ratedPowerW: Math.round(watts),
                            ratingSource: ratingSource as "nameplate",
                            autonomyTargetHours: target,
                          });
                        }}
                      >
                        <Plus className="mr-1 h-4 w-4" />
                        Declare
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </PanelCard>

            <PanelCard
              title="Storage behind the figure"
              description="Which registered batteries could be assessed, and which are missing the registration the assessment needs."
            >
              {status.isLoading ? (
                <Skeleton className="h-16 w-full" />
              ) : !storage ? (
                <p className="text-muted-foreground text-sm">No storage assessment available.</p>
              ) : (
                <div className="space-y-2 text-sm">
                  <p className="flex items-center gap-2">
                    <BatteryCharging className="h-4 w-4 text-muted-foreground" />
                    {storage.registeredBatteries === 0
                      ? "No battery is registered against this community."
                      : `${storage.assessedBatteries} of ${storage.registeredBatteries} registered batteries contributed to the figures above.`}
                  </p>
                  {storage.batteriesMissingCapacity.length > 0 && (
                    <p className="text-muted-foreground">
                      Energy capacity unregistered: asset(s){" "}
                      {storage.batteriesMissingCapacity.join(", ")}
                    </p>
                  )}
                  {storage.batteriesMissingStateOfCharge.length > 0 && (
                    <p className="text-muted-foreground">
                      No recent state of charge: asset(s){" "}
                      {storage.batteriesMissingStateOfCharge.join(", ")}
                    </p>
                  )}
                  {storage.batteriesMissingUsableFloor.length > 0 && (
                    <p className="text-muted-foreground">
                      Minimum state of charge unregistered, so usable energy is
                      not assumed to be the whole pack: asset(s){" "}
                      {storage.batteriesMissingUsableFloor.join(", ")}
                    </p>
                  )}
                  {storage.batteriesMissingDischargeLimit.length > 0 && (
                    <p className="text-muted-foreground">
                      Discharge limit unregistered: asset(s){" "}
                      {storage.batteriesMissingDischargeLimit.join(", ")}
                    </p>
                  )}
                </div>
              )}
            </PanelCard>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
