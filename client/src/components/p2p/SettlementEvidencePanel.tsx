/**
 * What the platform can prove about the signed-in trader's P2P trades.
 *
 * Every leg is drawn on its own row. A confirmed buyer payment renders as a
 * confirmed buyer payment — never as a finished trade — and a trade whose
 * seller cannot be paid says so instead of showing a green tick.
 */
import { trpc } from '@/lib/trpc';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/ops';
import {
  deliveryLeg,
  formatMoneyCents,
  formatWh,
  payoutLeg,
  reconciliationLeg,
  settlementHeadline,
  type SettlementLeg,
} from '@shared/p2p-settlement-state';

function Leg({ leg, value }: { leg: SettlementLeg; value?: string }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
      <ToneBadge tone={leg.tone} label={leg.label} />
      <span className="text-xs text-muted-foreground">{value ? `${value} — ` : ''}{leg.detail}</span>
    </div>
  );
}

export default function SettlementEvidencePanel() {
  const settlements = trpc.p2pTrading.mySettlements.useQuery(undefined, {
    refetchInterval: 60000,
  });
  const rows = settlements.isError ? undefined : settlements.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Settlement evidence</CardTitle>
        <CardDescription>
          A match is not a settlement. Each trade is shown leg by leg: the buyer’s payment, the
          measured energy, the seller’s payout and the reconciliation that re-reads all three.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {settlements.isError ? (
          <p className="text-sm text-destructive">
            The settlement evidence could not be read, so nothing is shown rather than a stale
            picture. Retry in a moment.
          </p>
        ) : settlements.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : !rows || rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No settlement record exists for your trades yet. A record is created when a payment
            provider confirms a buyer’s payment.
          </p>
        ) : (
          rows.map(row => {
            const headline = settlementHeadline(row);
            return (
              <div key={row.settlementId} className="rounded-md border p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-medium">
                    Trade #{row.buyTradeId} · {row.side === 'buyer' ? 'You bought' : 'You sold'}{' '}
                    {formatWh(row.energyWh)} for {formatMoneyCents(row.amountCents, row.currency)}
                  </div>
                  <ToneBadge tone={headline.tone} label={headline.label} />
                </div>

                <Leg
                  leg={{
                    label: row.buyerPaid ? 'Buyer payment confirmed' : 'Buyer payment unconfirmed',
                    detail: row.buyerPaid
                      ? 'The provider confirmed the payment with its own reference.'
                      : 'No provider confirmation has been recorded for this payment.',
                    tone: row.buyerPaid ? 'good' : 'neutral',
                  }}
                  value={row.buyerPaymentReference ?? undefined}
                />
                <Leg
                  leg={deliveryLeg(row.delivery)}
                  value={
                    row.deliveredEnergyWh === null
                      ? undefined
                      : `${formatWh(row.deliveredEnergyWh)} from ${row.deliverySamples ?? 0} readings`
                  }
                />
                <Leg leg={payoutLeg(row.sellerPayout)} value={row.sellerPayoutReference ?? undefined} />
                <Leg
                  leg={reconciliationLeg(row.reconciliation)}
                  value={row.reconciliationNote ?? undefined}
                />
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
