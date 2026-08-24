/**
 * "How much energy have I got left, and where is my token?"
 *
 * The two questions prepaid customers actually ask, answered without either of
 * the comfortable lies available here: a remaining figure invented from the
 * purchase when nothing measures consumption, and a token code shown for a
 * payment this deployment could not vend against. Both appear as named unknowns
 * with the reason, alongside what *is* established — energy bought, energy the
 * meter register reported as taken, and the ledger posting behind the purchase.
 *
 * Operators get the same account from the other side: every vend on the fleet,
 * the redemption evidence, and the supply decisions with whether a meter
 * enforced them.
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
import { AlertTriangle, BatteryCharging, KeyRound, RefreshCw, Search, Zap } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { MetricTile, PageHeader, PanelCard, ToneBadge } from "@/components/ops";
import {
  ACCOUNT_STATUS_COPY,
  BALANCE_BASIS_COPY,
  BALANCE_UNAVAILABLE_COPY,
  CONSUMPTION_SOURCE_COPY,
  SUPPLY_ACTION_COPY,
  SUPPLY_REASON_LABEL,
  TOKEN_CHECK_COPY,
  TOKEN_STATUS_COPY,
  copyFor,
  kwhLabel,
  vendingCopy,
} from "../../../shared/prepaid-state";

function when(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export default function PrepaidEnergy() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const utils = trpc.useUtils();

  const vending = trpc.prepaid.vendingStatus.useQuery();
  const mine = trpc.prepaid.myAccounts.useQuery();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const accountId = selectedId ?? mine.data?.accounts?.[0]?.id ?? null;

  const view = trpc.prepaid.account.useQuery(
    { accountId: accountId! },
    { enabled: accountId !== null, retry: false }
  );
  const tokens = trpc.prepaid.tokens.useQuery(
    { accountId: accountId!, limit: 25 },
    { enabled: accountId !== null, retry: false }
  );
  const consumption = trpc.prepaid.consumption.useQuery(
    { accountId: accountId!, limit: 25 },
    { enabled: accountId !== null, retry: false }
  );
  const supply = trpc.prepaid.supplyEvents.useQuery(
    { accountId: accountId!, limit: 25 },
    { enabled: accountId !== null, retry: false }
  );

  const refresh = trpc.prepaid.refreshConsumption.useMutation({
    onSuccess: result => {
      toast.success(
        result.segmentsRecorded === 0
          ? "The meter reported no new readings, so nothing was charged."
          : `${result.segmentsRecorded} metered period(s) recorded, ${kwhLabel(result.energyWh)} kWh taken.`
      );
      void utils.prepaid.account.invalidate();
      void utils.prepaid.consumption.invalidate();
    },
    onError: e => toast.error(e.message),
  });

  const [codeToCheck, setCodeToCheck] = useState("");
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<{
    reason: string;
    energyWh: number | null;
  } | null>(null);

  const detail = view.data;
  const balance = detail?.balance;
  const account = detail?.account;

  const balanceState = useMemo(() => {
    if (!balance) return null;
    return balance.unavailableReason
      ? copyFor(BALANCE_UNAVAILABLE_COPY, balance.unavailableReason)
      : copyFor(BALANCE_BASIS_COPY, balance.basis);
  }, [balance]);

  const vendingState = vendingCopy(vending.data?.configured ?? false);

  async function checkCode() {
    if (accountId === null || codeToCheck.trim().length < 4) return;
    setChecking(true);
    setCheckResult(null);
    try {
      const result = await utils.prepaid.checkToken.fetch({
        accountId,
        tokenCode: codeToCheck.trim(),
      });
      setCheckResult({ reason: result.reason, energyWh: result.energyWh });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The code could not be checked.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <PageHeader
          title="Prepaid energy"
          description="Pay-as-you-go credit, the tokens vended against it, and the energy the meter register reported as taken."
          caveat="A remaining figure is shown only where a meter measures consumption; otherwise it reads unknown with the reason. A token is only ever the digits the OpenPAYGO encoder produced — no code is shown for a payment this deployment could not vend against."
          actions={
            <div className="flex items-center gap-2">
              <ToneBadge label={vendingState.label} tone={vendingState.tone} meaning={vendingState.meaning} />
              {(mine.data?.accounts ?? []).length > 1 && (
                <Select
                  value={accountId !== null ? String(accountId) : undefined}
                  onValueChange={v => setSelectedId(Number(v))}
                >
                  <SelectTrigger className="w-56">
                    <SelectValue placeholder="Select a meter" />
                  </SelectTrigger>
                  <SelectContent>
                    {(mine.data?.accounts ?? []).map(row => (
                      <SelectItem key={row.id} value={String(row.id)}>
                        {row.meterSerial}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={accountId === null || refresh.isPending}
                onClick={() => accountId !== null && refresh.mutate({ accountId })}
              >
                <RefreshCw className={`mr-2 h-4 w-4 ${refresh.isPending ? "animate-spin" : ""}`} />
                Read meter
              </Button>
            </div>
          }
          className="mb-0"
        />

        {mine.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : (mine.data?.accounts ?? []).length === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground flex items-center gap-3 py-10">
              <BatteryCharging className="h-5 w-5" />
              <p>
                You have no prepaid meter on this platform yet. An operator opens one against your
                meter's serial and device profile — the token digits depend on both, so neither is
                guessed.
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {view.isError && (
              <Card className="border-red-300">
                <CardContent className="py-4 text-sm">
                  <p className="flex items-center gap-2 font-medium">
                    <AlertTriangle className="h-4 w-4 text-red-600" />
                    This account could not be read
                  </p>
                  <p className="text-muted-foreground mt-1">
                    {view.error.message} — your balance is unknown right now. This is not a
                    statement that you have no credit.
                  </p>
                </CardContent>
              </Card>
            )}

            {!detail || !balance ? (
              <Skeleton className="h-32 w-full" />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <MetricTile
                  label="Energy remaining"
                  value={kwhLabel(balance.remainingWh)}
                  unit="kWh"
                  tone={balanceState?.tone ?? "neutral"}
                  status={
                    balanceState
                      ? { label: balanceState.label, tone: balanceState.tone, meaning: balanceState.meaning }
                      : undefined
                  }
                  evidence={<span className="text-muted-foreground">{balanceState?.meaning}</span>}
                />
                <MetricTile
                  label="Energy bought"
                  value={kwhLabel(balance.creditedWh)}
                  unit="kWh"
                  tone="good"
                  evidence={
                    <span className="text-muted-foreground">
                      {detail.tokensIssued} token(s) awaiting the keypad, {detail.tokensRedeemed} loaded
                    </span>
                  }
                />
                <MetricTile
                  label="Energy taken"
                  value={kwhLabel(balance.consumedWh)}
                  unit="kWh"
                  tone="neutral"
                  evidence={
                    <span className="text-muted-foreground">
                      {detail.latestConsumption
                        ? `meter read to ${when(detail.latestConsumption.toAt)}`
                        : "no meter reading recorded on this account"}
                    </span>
                  }
                />
                <MetricTile
                  label="Supply"
                  value={account ? copyFor(ACCOUNT_STATUS_COPY, account.status).label : null}
                  tone={account ? copyFor(ACCOUNT_STATUS_COPY, account.status).tone : "neutral"}
                  evidence={
                    <span className="text-muted-foreground">
                      {detail.latestSupplyEvent
                        ? `${copyFor(SUPPLY_ACTION_COPY, detail.latestSupplyEvent.action).label} — ${
                            SUPPLY_REASON_LABEL[detail.latestSupplyEvent.reason] ??
                            detail.latestSupplyEvent.reason
                          }${
                            detail.latestSupplyEvent.enforcedAtMeter
                              ? ", enforced at the meter"
                              : ", not enforced at the meter"
                          }`
                        : "no supply decision recorded"}
                    </span>
                  }
                />
              </div>
            )}

            <PanelCard
              title="Your latest token"
              description="The digits to enter on the meter keypad."
              footer="A token loads a meter once. Once the meter has taken it, it reads as loaded here and will be refused if entered again."
            >
              {detail?.latestToken ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <code className="bg-muted rounded-lg px-4 py-3 font-mono text-2xl tracking-widest">
                      {detail.latestToken.tokenCode}
                    </code>
                    <ToneBadge
                      label={copyFor(TOKEN_STATUS_COPY, detail.latestToken.status).label}
                      tone={copyFor(TOKEN_STATUS_COPY, detail.latestToken.status).tone}
                      meaning={copyFor(TOKEN_STATUS_COPY, detail.latestToken.status).meaning}
                    />
                    <span className="text-muted-foreground text-sm">
                      {kwhLabel(detail.latestToken.energyWh)} kWh · vended {when(detail.latestToken.issuedAt)}
                    </span>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    Provider reference {detail.latestToken.providerReference} · ledger posting{" "}
                    {detail.latestToken.ledgerPostingId ?? "not recorded"}
                  </p>
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No token has been vended on this account yet. Buying credit vends one against the
                  confirmed payment — and only against a confirmed one.
                </p>
              )}
            </PanelCard>

            <PanelCard
              title="Check a code"
              description="Ask what the meter would do with a code, without crediting anything."
              footer="This is the standard's own decoder answering for this device and the counts it has already accepted. It is not a report from your physical meter."
            >
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <Label htmlFor="prepaid-code">Token code</Label>
                  <Input
                    id="prepaid-code"
                    value={codeToCheck}
                    inputMode="numeric"
                    placeholder="123456789"
                    onChange={e => setCodeToCheck(e.target.value)}
                    className="w-56 font-mono"
                  />
                </div>
                <Button
                  variant="outline"
                  disabled={checking || accountId === null || codeToCheck.trim().length < 4}
                  onClick={() => void checkCode()}
                >
                  <Search className="mr-2 h-4 w-4" />
                  Check
                </Button>
                {checkResult && (
                  <div className="flex items-center gap-2">
                    <ToneBadge
                      label={copyFor(TOKEN_CHECK_COPY, checkResult.reason).label}
                      tone={copyFor(TOKEN_CHECK_COPY, checkResult.reason).tone}
                      meaning={copyFor(TOKEN_CHECK_COPY, checkResult.reason).meaning}
                    />
                    <span className="text-muted-foreground text-sm">
                      {checkResult.energyWh === null
                        ? copyFor(TOKEN_CHECK_COPY, checkResult.reason).meaning
                        : `${kwhLabel(checkResult.energyWh)} kWh`}
                    </span>
                  </div>
                )}
              </div>
            </PanelCard>

            <PanelCard
              title="Tokens"
              description="Every vend on this account, with what proved the meter took it."
              footer="A redemption is only recorded with the evidence that the meter accepted the code; a token with no evidence stays issued rather than being assumed loaded."
            >
              {tokens.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : (tokens.data?.tokens ?? []).length === 0 ? (
                <p className="text-muted-foreground text-sm">No token has been vended yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Code</TableHead>
                      <TableHead>Energy</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead>Vended</TableHead>
                      <TableHead>Evidence</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(tokens.data?.tokens ?? []).map(token => {
                      const state = copyFor(TOKEN_STATUS_COPY, token.status);
                      return (
                        <TableRow key={token.id}>
                          <TableCell className="font-mono">{token.tokenCode}</TableCell>
                          <TableCell>{kwhLabel(token.energyWh)} kWh</TableCell>
                          <TableCell>
                            <ToneBadge label={state.label} tone={state.tone} meaning={state.meaning} />
                          </TableCell>
                          <TableCell>{when(token.issuedAt)}</TableCell>
                          <TableCell className="text-muted-foreground text-xs">
                            {token.status === "redeemed"
                              ? `${token.redemptionEvidenceRef ?? "no reference"} · ${when(token.redeemedAt)}`
                              : `payment ${token.paymentId} · ${token.providerReference}`}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </PanelCard>

            <PanelCard
              title="Metered consumption"
              description="Energy taken, measured as movement of the meter's cumulative register."
              footer="A period with no reading produces no row: it stays unaccounted rather than being charged as an estimate or given away as zero."
            >
              {consumption.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : (consumption.data?.periods ?? []).length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No metered period is recorded on this account yet.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>From</TableHead>
                      <TableHead>To</TableHead>
                      <TableHead>Register</TableHead>
                      <TableHead>Energy</TableHead>
                      <TableHead>Source</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(consumption.data?.periods ?? []).map(period => {
                      const source = copyFor(CONSUMPTION_SOURCE_COPY, period.source);
                      return (
                        <TableRow key={period.id}>
                          <TableCell>{when(period.fromAt)}</TableCell>
                          <TableCell>{when(period.toAt)}</TableCell>
                          <TableCell className="text-muted-foreground text-xs">
                            {period.registerStartWh} → {period.registerEndWh} Wh
                          </TableCell>
                          <TableCell>{kwhLabel(period.energyWh)} kWh</TableCell>
                          <TableCell>
                            <ToneBadge label={source.label} tone={source.tone} meaning={source.meaning} />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </PanelCard>

            <PanelCard
              title="Supply decisions"
              description="Disconnections and reconnections on this account, and whether a meter enforced them."
              footer="A decision recorded here is the platform's decision. It only claims the meter acted on it where the meter's own report is referenced."
            >
              {(supply.data?.events ?? []).length === 0 ? (
                <p className="text-muted-foreground text-sm">No supply decision has been recorded.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Decision</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Enforced at meter</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(supply.data?.events ?? []).map(event => {
                      const action = copyFor(SUPPLY_ACTION_COPY, event.action);
                      return (
                        <TableRow key={event.id}>
                          <TableCell>{when(event.createdAt)}</TableCell>
                          <TableCell>
                            <ToneBadge label={action.label} tone={action.tone} meaning={action.meaning} />
                          </TableCell>
                          <TableCell>{SUPPLY_REASON_LABEL[event.reason] ?? event.reason}</TableCell>
                          <TableCell className="text-muted-foreground text-xs">
                            {event.enforcedAtMeter ? (event.evidenceRef ?? "yes") : "no meter report"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </PanelCard>

            {isAdmin && <OperatorPanel />}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

/**
 * The operator's side: every account on the fleet, and the two actions that
 * change what a customer is owed — vending against a payment, and recording that
 * a meter took a token.
 */
function OperatorPanel() {
  const utils = trpc.useUtils();
  const accounts = trpc.prepaid.allAccounts.useQuery({});
  const allTokens = trpc.prepaid.allTokens.useQuery({ limit: 50 });

  const [paymentId, setPaymentId] = useState("");
  const [issueAccountId, setIssueAccountId] = useState("");
  const [outcome, setOutcome] = useState<string | null>(null);

  const issue = trpc.prepaid.issueForPayment.useMutation({
    onSuccess: result => {
      if (result.state === "issued") {
        setOutcome(
          `${result.replay ? "Already vended" : "Vended"}: ${result.token.tokenCode} for ${kwhLabel(
            result.token.energyWh
          )} kWh.`
        );
      } else {
        setOutcome(`Withheld (${result.reason}): ${result.detail}`);
      }
      void utils.prepaid.allTokens.invalidate();
      void utils.prepaid.account.invalidate();
    },
    onError: e => toast.error(e.message),
  });

  return (
    <>
      <PanelCard
        title="Vend against a payment"
        description="Turn a confirmed, evidenced payment into the token it bought."
        footer="Idempotent: run twice for one payment and the second run returns the first token rather than vending a second. A payment with no provider reference, or one the ledger has not posted, is withheld with that reason."
        actions={<KeyRound className="text-muted-foreground h-4 w-4" />}
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="prepaid-payment">Payment id</Label>
            <Input
              id="prepaid-payment"
              value={paymentId}
              inputMode="numeric"
              onChange={e => setPaymentId(e.target.value)}
              className="w-40"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="prepaid-account">Account id (optional)</Label>
            <Input
              id="prepaid-account"
              value={issueAccountId}
              inputMode="numeric"
              placeholder="from the payment"
              onChange={e => setIssueAccountId(e.target.value)}
              className="w-48"
            />
          </div>
          <Button
            disabled={issue.isPending || Number(paymentId) <= 0}
            onClick={() =>
              issue.mutate({
                paymentId: Number(paymentId),
                accountId: Number(issueAccountId) > 0 ? Number(issueAccountId) : undefined,
              })
            }
          >
            <Zap className="mr-2 h-4 w-4" />
            Vend
          </Button>
          {outcome && <p className="text-muted-foreground text-sm">{outcome}</p>}
        </div>
      </PanelCard>

      <PanelCard
        title="Fleet accounts"
        description="Every prepaid meter on the deployment."
        footer="A remaining figure is absent for any account with no meter linked, on the fleet view exactly as on the customer's."
      >
        {accounts.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Meter</TableHead>
                <TableHead>Bought</TableHead>
                <TableHead>Taken</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Meter linked</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(accounts.data?.accounts ?? []).map(row => {
                const status = copyFor(ACCOUNT_STATUS_COPY, row.status);
                return (
                  <TableRow key={row.id}>
                    <TableCell>#{row.id}</TableCell>
                    <TableCell className="font-mono text-xs">{row.meterSerial}</TableCell>
                    <TableCell>{kwhLabel(row.creditedWh)} kWh</TableCell>
                    <TableCell>{kwhLabel(row.consumedWh)} kWh</TableCell>
                    <TableCell>
                      <ToneBadge label={status.label} tone={status.tone} meaning={status.meaning} />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {row.meterAssetId === null ? "no — consumption unmeasured" : `asset ${row.meterAssetId}`}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </PanelCard>

      <PanelCard
        title="Fleet vends"
        description="Recent tokens across every account, for investigating an issuance or a dispute."
        footer="Each row names the payment and the provider reference it was vended against, and the ledger posting that moved the money."
      >
        {(allTokens.data?.tokens ?? []).length === 0 ? (
          <p className="text-muted-foreground text-sm">No token has been vended on this deployment.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Energy</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Payment</TableHead>
                <TableHead>Posting</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(allTokens.data?.tokens ?? []).map(token => {
                const state = copyFor(TOKEN_STATUS_COPY, token.status);
                return (
                  <TableRow key={token.id}>
                    <TableCell>#{token.accountId}</TableCell>
                    <TableCell className="font-mono text-xs">{token.tokenCode}</TableCell>
                    <TableCell>{kwhLabel(token.energyWh)} kWh</TableCell>
                    <TableCell>
                      <ToneBadge label={state.label} tone={state.tone} meaning={state.meaning} />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {token.paymentId} · {token.providerReference}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {token.ledgerPostingId ?? "not recorded"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </PanelCard>
    </>
  );
}
