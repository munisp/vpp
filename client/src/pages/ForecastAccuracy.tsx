/**
 * "How wrong were our forecasts, measured against what actually happened."
 *
 * The article's point about utilities distrusting VPPs is a measurement problem:
 * before this page the platform published forecasts with a model-derived
 * confidence and never compared them to reality. Everything here comes from
 * paired actuals, and a type without actuals reads as unmeasured rather than
 * inheriting a neighbour's score.
 */

import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { Info, RefreshCw, Target } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import {
  FORECAST_TYPE_LABEL,
  coverageVerdict,
  formatBias,
  formatMagnitude,
  formatPercent,
  measurementConfidence,
  unitFor,
  type AccuracySummaryRow,
  type AccuracyTone,
} from "@/lib/forecast-accuracy";

const TONE_CLASS: Record<AccuracyTone, string> = {
  good: "bg-emerald-100 text-emerald-900 border-emerald-300",
  warning: "bg-amber-100 text-amber-900 border-amber-300",
  danger: "bg-red-100 text-red-900 border-red-300",
  neutral: "bg-muted text-muted-foreground border-border",
};

function VerdictBadge({
  verdict,
}: {
  verdict: { label: string; tone: AccuracyTone; meaning: string };
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={TONE_CLASS[verdict.tone]}>
          {verdict.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{verdict.meaning}</TooltipContent>
    </Tooltip>
  );
}

export default function ForecastAccuracy() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const utils = trpc.useUtils();

  const summary = trpc.forecasting.accuracySummary.useQuery(
    { sinceDays: 30 },
    { refetchInterval: 60000 }
  );

  const scoreDue = trpc.forecasting.scoreDueRuns.useMutation({
    onSuccess: result => {
      // Both halves are reported: runs whose actuals never arrived stay visible
      // instead of being counted as a successful scoring pass.
      toast.success(
        `Scored ${result.scored} run${result.scored === 1 ? "" : "s"}; ` +
          `${result.unmeasured} had too few actuals to score`
      );
      utils.forecasting.accuracySummary.invalidate();
    },
    onError: e => toast.error(e.message || "Scoring failed"),
  });

  const rows = (summary.data?.rows ?? []) as unknown as AccuracySummaryRow[];
  const targetCoverageBp = summary.data?.targetCoverageBp ?? 8000;
  const minSamples = summary.data?.minScoringSamples ?? 4;
  const unmeasured = rows.reduce((total, row) => total + row.unmeasuredRuns, 0);
  const scored = rows.reduce((total, row) => total + row.scoredRuns, 0);

  return (
    <TooltipProvider>
      <DashboardLayout>
        <div className="space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Forecast accuracy</h1>
              <p className="text-muted-foreground max-w-3xl">
                Every figure below is a forecast compared with the actual telemetry, grid
                readings, settled prices or emissions factors that arrived afterwards. Runs
                whose actuals never arrived are counted as unmeasured, never as accurate.
              </p>
            </div>
            {isAdmin && (
              <Button
                variant="outline"
                onClick={() => scoreDue.mutate({ limit: 50 })}
                disabled={scoreDue.isPending}
              >
                <RefreshCw className={`mr-2 h-4 w-4 ${scoreDue.isPending ? "animate-spin" : ""}`} />
                Score elapsed runs
              </Button>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Scored runs (30 days)</CardDescription>
                <CardTitle className="text-2xl">
                  {summary.isLoading ? <Skeleton className="h-7 w-10" /> : scored}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card className={unmeasured > scored ? "border-amber-300 bg-amber-50" : undefined}>
              <CardHeader className="pb-2">
                <CardDescription>Unmeasured runs</CardDescription>
                <CardTitle className="text-2xl">
                  {summary.isLoading ? <Skeleton className="h-7 w-10" /> : unmeasured}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                Forecast horizons that elapsed without enough actuals ({minSamples} paired
                points minimum) to score.
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-1">
                  <Target className="h-3 w-3" /> Calibration target
                </CardDescription>
                <CardTitle className="text-2xl">{formatPercent(targetCoverageBp)}</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                Share of actuals that should land inside the published P10–P90 band.
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Measured accuracy by forecast type</CardTitle>
              <CardDescription>
                Averages are weighted by paired sample count, so a run scored on four points
                cannot outvote one scored on ninety-six.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {summary.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : summary.error ? (
                <p className="text-sm text-red-700">{summary.error.message}</p>
              ) : rows.length === 0 ? (
                <div className="flex items-start gap-2 text-sm text-muted-foreground">
                  <Info className="mt-0.5 h-4 w-4" />
                  <span>
                    No forecast run has been scored against actuals yet, so accuracy is unknown
                    — not good. Scores appear once a forecast horizon has elapsed and its
                    actuals have arrived.
                  </span>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Forecast</TableHead>
                      <TableHead>Evidence</TableHead>
                      <TableHead>MAPE</TableHead>
                      <TableHead>MAE</TableHead>
                      <TableHead>Bias</TableHead>
                      <TableHead>Calibration</TableHead>
                      <TableHead>Band width</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map(row => {
                      const unit = unitFor(row.forecastType);
                      const confidence = measurementConfidence(row, minSamples);
                      const calibration = coverageVerdict(row.coverageBp, targetCoverageBp);
                      return (
                        <TableRow key={`${row.forecastType}-${row.scopeId ?? "all"}-${row.modelVersion}`}>
                          <TableCell>
                            {FORECAST_TYPE_LABEL[row.forecastType] ?? row.forecastType}
                            <div className="text-xs text-muted-foreground">
                              model {row.modelVersion}
                            </div>
                          </TableCell>
                          <TableCell>
                            <VerdictBadge verdict={confidence} />
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {formatPercent(row.mapeBp)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {formatMagnitude(row.mae, unit)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {formatBias(row.bias, unit)}
                          </TableCell>
                          <TableCell>
                            <VerdictBadge verdict={calibration} />
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                            {formatMagnitude(row.intervalWidth, unit)}
                            <div>P10–P90 spread</div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Reading these numbers</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>
                <strong>Bias</strong> is signed on purpose: a forecast that is 200 W high half
                the time and 200 W low the other half has the same MAE as one that is always
                200 W high, but only the second one systematically over-commits capacity.
              </p>
              <p>
                <strong>Calibration and band width belong together.</strong> A forecast that
                answers "somewhere between zero and everything" scores perfect coverage and is
                worthless to bid with, so the spread it needed is always shown next to it.
              </p>
            </CardContent>
          </Card>
        </div>
      </DashboardLayout>
    </TooltipProvider>
  );
}
