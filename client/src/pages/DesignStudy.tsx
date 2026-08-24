/**
 * "What should we build here, and what will it cost?"
 *
 * A design study is the document a community, developer or agency takes to a
 * lender, so this page is built around three things a reader must be able to
 * check: where the load came from, what was assumed about money and fuel, and
 * whether anything was concluded at all. A study that concluded nothing is shown
 * as such — the alternative, an empty panel, reads as a system fault when it is
 * usually a missing survey.
 *
 * Nothing here is computed in the browser. Every number comes from the stored
 * version it is displayed beside, so what is on screen is what is on the record.
 */

import { useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { AlertTriangle, Calculator, FileText, RefreshCw } from 'lucide-react';
import DashboardLayout from '@/components/DashboardLayout';
import { useAuth } from '@/_core/hooks/useAuth';
import { MetricTile, PageHeader, PanelCard, ToneBadge } from '@/components/ops';
import type { StateTone } from '@/lib/tone';
import {
  DESIGN_STATUS_COPY,
  PROFILE_SOURCE_COPY,
  centsPerKwhLabel,
  moneyLabel,
  paybackLabel,
  unmetLabel,
  wattHoursLabel,
  wattsLabel,
  type DesignStudyStatus,
  type ProfileSource,
  type Tone as CopyTone,
} from '../../../shared/design-study-copy';
import {
  FEASIBILITY_STATUS_COPY,
  type FeasibilityStatus,
} from '../../../shared/network-feasibility-copy';

const COPY_TONE: Record<CopyTone, StateTone> = {
  good: 'good',
  warning: 'warning',
  bad: 'danger',
  neutral: 'neutral',
};

/** A day-ahead shape a planner can start from, then replace with real data. */
function defaultProfileText(): string {
  const hours = Array.from({ length: 24 }, (_, hour) =>
    hour >= 7 && hour <= 19 ? 8000 : 3000
  );
  return hours.join(', ');
}

function defaultSolarText(): string {
  return Array.from({ length: 24 }, (_, hour) => {
    if (hour < 6 || hour > 18) return '0';
    return Math.sin(((hour - 6) / 12) * Math.PI).toFixed(2);
  }).join(', ');
}

function parseSeries(text: string): number[] {
  return text
    .split(/[,\s]+/)
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .map(Number);
}

export default function DesignStudy() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const utils = trpc.useUtils();

  const service = trpc.designStudy.serviceStatus.useQuery(undefined, { enabled: isAdmin });
  const studies = trpc.designStudy.studies.useQuery({ limit: 100 }, { enabled: isAdmin });
  const nodes = trpc.locationalFlexibility.nodes.useQuery(
    {},
    { enabled: isAdmin, retry: false }
  );

  const [selectedStudyId, setSelectedStudyId] = useState<number | null>(null);
  const studyId = selectedStudyId ?? studies.data?.[0]?.id ?? null;
  const versions = trpc.designStudy.versions.useQuery(
    { studyId: studyId!, limit: 50 },
    { enabled: isAdmin && studyId !== null }
  );
  const latest = versions.data?.[0] ?? null;

  const [reference, setReference] = useState('');
  const [siteName, setSiteName] = useState('');
  const [nodeId, setNodeId] = useState<number | null>(null);
  const [loadSource, setLoadSource] = useState<ProfileSource>('declared');
  const [loadText, setLoadText] = useState(defaultProfileText());
  const [loadReference, setLoadReference] = useState('');
  const [meterDays, setMeterDays] = useState('');
  const [solarText, setSolarText] = useState(defaultSolarText());
  const [dieselCents, setDieselCents] = useState('80');
  const [tariffCents, setTariffCents] = useState('60');
  const [pvSweep, setPvSweep] = useState('0, 10, 20, 30');
  const [batterySweep, setBatterySweep] = useState('0, 20, 40, 60');
  const [maxUnmetPercent, setMaxUnmetPercent] = useState('5');
  const [checkNetwork, setCheckNetwork] = useState(false);

  const run = trpc.designStudy.run.useMutation({
    onSuccess: result => {
      const copy = DESIGN_STATUS_COPY[result.status];
      if (result.status === 'optimal') {
        toast.success(`Version ${result.version ?? '?'}: ${copy.label}`);
      } else {
        toast.message(copy.label, { description: result.reason ?? copy.meaning });
      }
      setSelectedStudyId(result.studyId);
      void utils.designStudy.studies.invalidate();
      void utils.designStudy.versions.invalidate();
    },
    onError: error => toast.error(error.message),
  });

  const meteredPreview = trpc.designStudy.meteredProfile.useQuery(
    {
      nodeId: nodeId!,
      days: Number(meterDays) || 1,
      intervalMinutes: 60,
    },
    { enabled: isAdmin && loadSource === 'metered' && nodeId !== null && meterDays !== '' }
  );

  const result = run.data ?? null;
  const digestMatches = trpc.designStudy.sameInputs.useQuery(
    { digest: result?.inputDigest ?? '', limit: 20 },
    { enabled: isAdmin && result !== null }
  );

  const candidates = useMemo(() => result?.candidates ?? [], [result]);

  /**
   * The genset is the diesel baseline this design is costed against, so it has
   * to cover the peak of the load the *server* will read. For a metered study
   * that peak lives in the meter, not in the (hidden) textarea, so the study is
   * refused here rather than sized against a backup unrelated to the site.
   */
  function backupPeakW(declared: number[]): number | null {
    if (loadSource !== 'metered') {
      return declared.length > 0 ? Math.max(...declared) : null;
    }
    const preview = meteredPreview.data;
    if (!preview || !preview.available) return null;
    return preview.peakW;
  }

  function submit() {
    const load = parseSeries(loadText);
    const solar = parseSeries(solarText);
    if (loadSource !== 'metered' && (load.length < 24 || load.some(Number.isNaN))) {
      toast.error('The load profile needs at least 24 comma-separated numbers in watts');
      return;
    }
    const peakW = backupPeakW(load);
    if (peakW === null || !(peakW > 0)) {
      toast.error(
        loadSource === 'metered'
          ? 'The metered peak for this node and window is not available, so the diesel baseline cannot be sized to the site. Read the meter above first.'
          : 'The load profile has no positive demand, so there is nothing to size a backup against.'
      );
      return;
    }
    run.mutate({
      reference: reference.trim(),
      siteName: siteName.trim(),
      nodeId: nodeId ?? undefined,
      intervalMinutes: 60,
      load:
        loadSource === 'metered'
          ? undefined
          : {
              source: loadSource,
              loadW: load,
              reference: loadReference.trim() === '' ? undefined : loadReference.trim(),
            },
      meterDays: loadSource === 'metered' ? Number(meterDays) || 1 : undefined,
      resources: [
        {
          kind: 'solar_pv',
          source: 'sourced',
          capacityFactor: solar,
          reference: 'operator-entered capacity factors',
        },
      ],
      backup: {
        kind: 'genset',
        maxW: peakW * 1.2,
        energyCostCentsPerKwh: Number(dieselCents),
        fuelLitresPerKwh: 0.33,
        emissionsGPerKwh: 800,
      },
      economics: {
        discountRatePercent: 12,
        projectYears: 20,
        pvCapexCentsPerKw: 90_000,
        batteryCapexCentsPerKwh: 40_000,
        inverterCapexCentsPerKw: 30_000,
        fixedOpexPercentOfCapexPerYear: 2,
      },
      sweep: { pvKw: parseSeries(pvSweep), batteryKwh: parseSeries(batterySweep) },
      maxUnmetFraction: Number(maxUnmetPercent) / 100,
      tariffCentsPerKwh: tariffCents.trim() === '' ? undefined : Number(tariffCents),
      checkNetwork: checkNetwork && nodeId !== null,
    });
  }

  if (!isAdmin) {
    return (
      <DashboardLayout>
        <PageHeader
          title="Design studies"
          description="Sizing and costing a site fixes capital assumptions on behalf of a community or an agency, so this page is for platform administrators only."
        />
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeader
          title="Design studies"
          description="Size a site that has not been built: load, resource, storage, tariff and the diesel baseline it replaces — costed by the same optimizer that dispatches the fleet."
          caveat="Every number follows from the inputs frozen on the version beside it, and nothing else. A site with neither metered nor declared load is refused rather than sized on an assumed profile, and 'Sized' never means the wires were checked unless a feasibility study is shown against it."
          actions={
            <Button
              variant="outline"
              size="sm"
              disabled={studies.isFetching}
              onClick={() => {
                void studies.refetch();
                void versions.refetch();
              }}
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${studies.isFetching ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          }
          className="mb-0"
        />

        {service.data && !service.data.optimizerConfigured && (
          <Card className="border-amber-300">
            <CardContent className="py-4 text-sm">
              <p className="flex items-center gap-2 font-medium">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                No sizing engine is configured
              </p>
              <p className="text-muted-foreground mt-1">{service.data.note}</p>
            </CardContent>
          </Card>
        )}

        <PanelCard
          title="Run a study"
          description="Inputs are frozen with the answer, so a study can be produced later exactly as it was run."
          footer="Watts for load, cents per kWh for prices, kW and kWh for the sizes to search. The genset is sized to cover peak load so the baseline is the diesel case this design would replace."
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="ds-reference">Study reference</Label>
              <Input
                id="ds-reference"
                placeholder="e.g. WURO-MINIGRID-2026"
                value={reference}
                onChange={event => setReference(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ds-site">Site name</Label>
              <Input
                id="ds-site"
                placeholder="e.g. Wuro Kesu community"
                value={siteName}
                onChange={event => setSiteName(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Grid node (optional)</Label>
              <Select
                value={nodeId !== null ? String(nodeId) : undefined}
                onValueChange={value => setNodeId(Number(value))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Not connected to a modelled node" />
                </SelectTrigger>
                <SelectContent>
                  {(nodes.data ?? []).map(node => (
                    <SelectItem key={node.nodeId} value={String(node.nodeId)}>
                      {node.code} — {node.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label>Load profile source</Label>
              <Select
                value={loadSource}
                onValueChange={value => setLoadSource(value as ProfileSource)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PROFILE_SOURCE_COPY) as ProfileSource[]).map(source => (
                    <SelectItem key={source} value={source}>
                      {PROFILE_SOURCE_COPY[source].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                {PROFILE_SOURCE_COPY[loadSource].meaning}
              </p>
            </div>

            {loadSource === 'metered' ? (
              <div className="space-y-1">
                <Label htmlFor="ds-meter-days">Days of metering to read</Label>
                <Input
                  id="ds-meter-days"
                  inputMode="numeric"
                  placeholder="e.g. 7"
                  value={meterDays}
                  onChange={event => setMeterDays(event.target.value)}
                />
                <p className="text-muted-foreground text-xs">
                  {nodeId === null
                    ? 'Select the node whose meters should be read.'
                    : meteredPreview.data === undefined
                      ? 'Enter a number of days to check the metering first.'
                      : meteredPreview.data.available
                        ? `${meteredPreview.data.intervals} interval(s) from ${meteredPreview.data.assets} asset(s); peak ${wattsLabel(meteredPreview.data.peakW)}.`
                        : meteredPreview.data.reason}
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                <Label htmlFor="ds-load-ref">Where this profile came from</Label>
                <Input
                  id="ds-load-ref"
                  placeholder="e.g. household survey, March 2026"
                  value={loadReference}
                  onChange={event => setLoadReference(event.target.value)}
                />
              </div>
            )}

            <div className="space-y-1">
              <Label htmlFor="ds-diesel">Backup energy cost (cents/kWh)</Label>
              <Input
                id="ds-diesel"
                inputMode="decimal"
                value={dieselCents}
                onChange={event => setDieselCents(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ds-tariff">Tariff (cents/kWh, optional)</Label>
              <Input
                id="ds-tariff"
                inputMode="decimal"
                value={tariffCents}
                onChange={event => setTariffCents(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ds-pv">PV sizes to search (kW)</Label>
              <Input
                id="ds-pv"
                value={pvSweep}
                onChange={event => setPvSweep(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ds-batt">Battery sizes to search (kWh)</Label>
              <Input
                id="ds-batt"
                value={batterySweep}
                onChange={event => setBatterySweep(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ds-unmet">Unserved energy allowed (%)</Label>
              <Input
                id="ds-unmet"
                inputMode="decimal"
                value={maxUnmetPercent}
                onChange={event => setMaxUnmetPercent(event.target.value)}
              />
            </div>
            <div className="flex items-end gap-2">
              <input
                id="ds-network"
                type="checkbox"
                className="h-4 w-4"
                checked={checkNetwork}
                disabled={nodeId === null}
                onChange={event => setCheckNetwork(event.target.checked)}
              />
              <Label htmlFor="ds-network" className="text-sm">
                Check the recommendation against the feeder
              </Label>
            </div>
          </div>

          {loadSource !== 'metered' && (
            <div className="mt-3 space-y-1">
              <Label htmlFor="ds-load">Load per hour (watts, comma separated)</Label>
              <Textarea
                id="ds-load"
                rows={3}
                value={loadText}
                onChange={event => setLoadText(event.target.value)}
              />
            </div>
          )}
          <div className="mt-3 space-y-1">
            <Label htmlFor="ds-solar">Solar capacity factor per hour (0–1)</Label>
            <Textarea
              id="ds-solar"
              rows={3}
              value={solarText}
              onChange={event => setSolarText(event.target.value)}
            />
          </div>

          <div className="mt-4">
            <Button
              onClick={submit}
              disabled={
                run.isPending || reference.trim() === '' || siteName.trim() === ''
              }
            >
              <Calculator className="mr-2 h-4 w-4" />
              {run.isPending ? 'Sizing…' : 'Run study'}
            </Button>
          </div>

          {result && (
            <div className="mt-4 space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <ToneBadge
                  label={DESIGN_STATUS_COPY[result.status].label}
                  tone={COPY_TONE[DESIGN_STATUS_COPY[result.status].tone]}
                  meaning={DESIGN_STATUS_COPY[result.status].meaning}
                />
                <span className="text-muted-foreground text-sm">
                  {result.reason ?? DESIGN_STATUS_COPY[result.status].meaning}
                </span>
                {result.version !== null && (
                  <span className="text-muted-foreground text-xs">
                    stored as version {result.version}
                  </span>
                )}
              </div>

              {result.recommended && (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <MetricTile
                    label="Recommended PV"
                    value={result.recommended.pv_kw.toFixed(0)}
                    unit="kW"
                    tone="good"
                  />
                  <MetricTile
                    label="Recommended storage"
                    value={result.recommended.battery_kwh.toFixed(0)}
                    unit="kWh"
                    tone="good"
                    evidence={
                      <span className="text-muted-foreground">
                        {result.recommended.battery_kw.toFixed(0)} kW inverter
                      </span>
                    }
                  />
                  <MetricTile
                    label="Levelised cost"
                    value={
                      result.recommended.lcoe_cents_per_kwh === null
                        ? null
                        : (result.recommended.lcoe_cents_per_kwh / 100).toFixed(2)
                    }
                    unit="per kWh"
                    tone={result.recommended.lcoe_cents_per_kwh === null ? 'warning' : 'good'}
                    evidence={
                      <span className="text-muted-foreground">
                        baseline{' '}
                        {result.baseline?.lcoe_cents_per_kwh === null ||
                        result.baseline === null
                          ? 'not costed'
                          : `${(result.baseline.lcoe_cents_per_kwh / 100).toFixed(2)} per kWh`}
                      </span>
                    }
                  />
                  <MetricTile
                    label="Payback"
                    value={
                      result.recommended.payback_years === null
                        ? null
                        : result.recommended.payback_years.toFixed(1)
                    }
                    unit="years"
                    tone={result.recommended.payback_years === null ? 'warning' : 'good'}
                    evidence={
                      <span className="text-muted-foreground">
                        {result.recommended.payback_years === null
                          ? 'no case saves money at these prices'
                          : `${moneyLabel(result.recommended.capex_cents)} capex`}
                      </span>
                    }
                  />
                </div>
              )}

              {result.provenance && (
                <div className="text-sm">
                  <p className="flex flex-wrap items-center gap-2">
                    <ToneBadge
                      label={PROFILE_SOURCE_COPY[result.provenance.load_source].label}
                      tone={COPY_TONE[PROFILE_SOURCE_COPY[result.provenance.load_source].tone]}
                      meaning={PROFILE_SOURCE_COPY[result.provenance.load_source].meaning}
                    />
                    <span className="text-muted-foreground">
                      {result.provenance.load_reference ?? 'no source stated'} ·{' '}
                      {result.provenance.days_simulated} day(s) simulated ·{' '}
                      {result.provenance.backup_availability === 'declared_per_interval'
                        ? 'backup availability declared per interval'
                        : 'backup assumed available throughout'}
                    </span>
                  </p>
                  {result.provenance.notes.length > 0 && (
                    <ul className="text-muted-foreground mt-2 list-disc pl-5 text-xs">
                      {result.provenance.notes.map(note => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {result.network.status !== null ? (
                <p className="text-sm">
                  Feeder check:{' '}
                  <ToneBadge
                    label={
                      FEASIBILITY_STATUS_COPY[result.network.status as FeasibilityStatus].label
                    }
                    tone={
                      COPY_TONE[
                        FEASIBILITY_STATUS_COPY[result.network.status as FeasibilityStatus].tone
                      ]
                    }
                    meaning={
                      FEASIBILITY_STATUS_COPY[result.network.status as FeasibilityStatus].meaning
                    }
                  />{' '}
                  <span className="text-muted-foreground">
                    {result.network.limitingElement
                      ? `limited by ${result.network.limitingElement}`
                      : (result.network.reason ?? '')}
                  </span>
                </p>
              ) : (
                <p className="text-muted-foreground text-sm">
                  The feeder was not checked{result.network.reason ? `: ${result.network.reason}` : ''}
                  . A sizing on its own says nothing about whether the network can carry it.
                </p>
              )}

              {candidates.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>PV (kW)</TableHead>
                      <TableHead>Storage (kWh)</TableHead>
                      <TableHead className="text-right">Unserved</TableHead>
                      <TableHead className="text-right">Renewable share</TableHead>
                      <TableHead className="text-right">LCOE</TableHead>
                      <TableHead className="text-right">Payback</TableHead>
                      <TableHead className="text-right">Fuel/year</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {candidates.map(candidate => (
                      <TableRow
                        key={`${candidate.pv_kw}-${candidate.wind_kw}-${candidate.battery_kwh}`}
                        className={candidate.meets_unmet_limit ? '' : 'opacity-60'}
                      >
                        <TableCell>{candidate.pv_kw.toFixed(0)}</TableCell>
                        <TableCell>{candidate.battery_kwh.toFixed(0)}</TableCell>
                        <TableCell className="text-right">
                          {(candidate.unmet_fraction * 100).toFixed(2)}%
                        </TableCell>
                        <TableCell className="text-right">
                          {(candidate.renewable_fraction_of_served * 100).toFixed(0)}%
                        </TableCell>
                        <TableCell className="text-right">
                          {candidate.lcoe_cents_per_kwh === null
                            ? 'not costed'
                            : `${(candidate.lcoe_cents_per_kwh / 100).toFixed(2)}`}
                        </TableCell>
                        <TableCell className="text-right">
                          {candidate.payback_years === null
                            ? 'none'
                            : `${candidate.payback_years.toFixed(1)} y`}
                        </TableCell>
                        <TableCell className="text-right">
                          {candidate.fuel_litres_per_year === null
                            ? 'unknown'
                            : `${candidate.fuel_litres_per_year.toFixed(0)} L`}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}

              {digestMatches.data && digestMatches.data.length > 1 && (
                <p className="text-muted-foreground text-xs">
                  {digestMatches.data.length} versions were run on exactly these inputs; a
                  difference between them would be an engine defect, not a business change.
                </p>
              )}
            </div>
          )}
        </PanelCard>

        <PanelCard
          title="Studies on record"
          description="Every study and every version of it, including the ones that concluded nothing."
          footer="Versions are immutable: changing a diesel price or a capex assumption adds a version rather than editing the last one, so the study a lender was shown can always be produced again."
        >
          {studies.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : (studies.data ?? []).length === 0 ? (
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <FileText className="h-4 w-4" />
              No site has been studied yet.
            </p>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {(studies.data ?? []).map(study => (
                  <Button
                    key={study.id}
                    variant={study.id === studyId ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setSelectedStudyId(study.id)}
                  >
                    {study.reference}
                    <span className="ml-2 text-xs opacity-70">
                      v{study.latestVersion ?? '?'}
                    </span>
                  </Button>
                ))}
              </div>

              {latest && (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <MetricTile
                    label="Latest outcome"
                    value={DESIGN_STATUS_COPY[latest.status as DesignStudyStatus].label}
                    tone={COPY_TONE[DESIGN_STATUS_COPY[latest.status as DesignStudyStatus].tone]}
                    evidence={
                      <span className="text-muted-foreground">
                        {latest.reason ??
                          DESIGN_STATUS_COPY[latest.status as DesignStudyStatus].meaning}
                      </span>
                    }
                  />
                  <MetricTile
                    label="Sizing"
                    value={
                      latest.recommendedPvW === null
                        ? null
                        : `${wattsLabel(latest.recommendedPvW)} PV`
                    }
                    tone={latest.recommendedPvW === null ? 'warning' : 'good'}
                    evidence={
                      <span className="text-muted-foreground">
                        {latest.recommendedBatteryWh === null
                          ? 'no storage recommended on this version'
                          : `${wattHoursLabel(latest.recommendedBatteryWh)} storage`}
                      </span>
                    }
                  />
                  <MetricTile
                    label="Levelised cost"
                    value={centsPerKwhLabel(latest.lcoeCentsPerKwhX100)}
                    tone={latest.lcoeCentsPerKwhX100 === null ? 'warning' : 'good'}
                    evidence={
                      <span className="text-muted-foreground">
                        {unmetLabel(latest.unmetPpm)}
                      </span>
                    }
                  />
                  <MetricTile
                    label="Payback"
                    value={paybackLabel(latest.paybackMonths)}
                    tone={latest.paybackMonths === null ? 'warning' : 'good'}
                    evidence={
                      <span className="text-muted-foreground">
                        {latest.fuelLitresSavedPerYear === null
                          ? 'fuel displacement not assessed'
                          : `${latest.fuelLitresSavedPerYear.toFixed(0)} L/year displaced`}
                      </span>
                    }
                  />
                </div>
              )}

              {versions.isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Version</TableHead>
                      <TableHead>When</TableHead>
                      <TableHead>Outcome</TableHead>
                      <TableHead>Load</TableHead>
                      <TableHead className="text-right">LCOE</TableHead>
                      <TableHead className="text-right">Payback</TableHead>
                      <TableHead>Feeder</TableHead>
                      <TableHead>Inputs</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(versions.data ?? []).map(version => {
                      const copy = DESIGN_STATUS_COPY[version.status as DesignStudyStatus];
                      const source = PROFILE_SOURCE_COPY[version.loadSource as ProfileSource];
                      return (
                        <TableRow key={version.id}>
                          <TableCell className="font-medium">v{version.version}</TableCell>
                          <TableCell>{new Date(version.createdAt).toLocaleString()}</TableCell>
                          <TableCell>
                            <ToneBadge
                              label={copy.label}
                              tone={COPY_TONE[copy.tone]}
                              meaning={version.reason ?? copy.meaning}
                            />
                          </TableCell>
                          <TableCell>
                            {source.label}
                            {version.loadReference ? (
                              <span className="text-muted-foreground block text-xs">
                                {version.loadReference}
                              </span>
                            ) : null}
                          </TableCell>
                          <TableCell className="text-right">
                            {centsPerKwhLabel(version.lcoeCentsPerKwhX100)}
                          </TableCell>
                          <TableCell className="text-right">
                            {paybackLabel(version.paybackMonths)}
                          </TableCell>
                          <TableCell>
                            {version.networkStatus === null ? (
                              <span className="text-muted-foreground text-xs">not checked</span>
                            ) : (
                              FEASIBILITY_STATUS_COPY[version.networkStatus as FeasibilityStatus]
                                .label
                            )}
                          </TableCell>
                          <TableCell
                            className="text-muted-foreground font-mono text-xs"
                            title={version.inputDigest}
                          >
                            {version.inputDigest.slice(0, 10)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </div>
          )}
        </PanelCard>
      </div>
    </DashboardLayout>
  );
}
