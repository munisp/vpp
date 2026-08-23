/**
 * The same settlement legs the PWA shows, on the phone: buyer payment, measured
 * delivery, seller payout and reconciliation, each with its own evidence. The
 * labels come from the shared module so a trader cannot read "complete" here and
 * "buyer paid, seller unpaid" on the web.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { trpc } from '../services/trpc';
import {
  deliveryLeg,
  formatMoneyCents,
  formatWh,
  payoutLeg,
  reconciliationLeg,
  settlementHeadline,
  type SettlementLeg,
  type SettlementLegTone,
} from '../../../shared/p2p-settlement-state';

const TONE_COLOR: Record<SettlementLegTone, string> = {
  good: '#10b981',
  warning: '#f59e0b',
  danger: '#ef4444',
  neutral: '#9ca3af',
};

function Leg({ leg, value }: { leg: SettlementLeg; value?: string | null }) {
  return (
    <View style={styles.leg}>
      <View style={[styles.dot, { backgroundColor: TONE_COLOR[leg.tone] }]} />
      <View style={styles.legBody}>
        <Text style={[styles.legLabel, { color: TONE_COLOR[leg.tone] }]}>{leg.label}</Text>
        {value ? <Text style={styles.legValue}>{value}</Text> : null}
        <Text style={styles.legDetail}>{leg.detail}</Text>
      </View>
    </View>
  );
}

export default function SettlementEvidenceList() {
  const { data, isLoading, isError } = trpc.p2pTrading.mySettlements.useQuery();
  const rows = isError ? undefined : data;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Settlement evidence</Text>
      <Text style={styles.subtitle}>
        A match is not a settlement. Each leg below is what the platform can prove.
      </Text>

      {isError && (
        <Text style={styles.error}>
          The settlement evidence could not be read, so nothing is shown rather than a stale
          picture. Pull down to try again.
        </Text>
      )}

      {isLoading && <Text style={styles.muted}>Loading…</Text>}

      {!isLoading && !isError && !rows?.length && (
        <Text style={styles.muted}>
          No settlement record exists for your trades yet. One is created when a payment provider
          confirms a buyer's payment.
        </Text>
      )}

      {rows?.map(row => {
        const headline = settlementHeadline(row);
        return (
          <View key={row.settlementId} style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>
                Trade #{row.buyTradeId} · {row.side === 'buyer' ? 'bought' : 'sold'}{' '}
                {formatWh(row.energyWh)}
              </Text>
              <Text style={[styles.headline, { color: TONE_COLOR[headline.tone] }]}>
                {headline.label}
              </Text>
            </View>
            <Text style={styles.amount}>{formatMoneyCents(row.amountCents, row.currency)}</Text>

            <Leg
              leg={{
                label: row.buyerPaid ? 'Buyer payment confirmed' : 'Buyer payment unconfirmed',
                detail: row.buyerPaid
                  ? "The provider confirmed the payment with its own reference."
                  : 'No provider confirmation has been recorded for this payment.',
                tone: row.buyerPaid ? 'good' : 'neutral',
              }}
              value={row.buyerPaymentReference}
            />
            <Leg
              leg={deliveryLeg(row.delivery)}
              value={
                row.deliveredEnergyWh === null
                  ? null
                  : `${formatWh(row.deliveredEnergyWh)} from ${row.deliverySamples ?? 0} readings`
              }
            />
            <Leg leg={payoutLeg(row.sellerPayout)} value={row.sellerPayoutReference} />
            <Leg leg={reconciliationLeg(row.reconciliation)} value={row.reconciliationNote} />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingVertical: 8 },
  title: { fontSize: 18, fontWeight: '700', color: '#111827' },
  subtitle: { fontSize: 13, color: '#6b7280', marginTop: 2, marginBottom: 12 },
  error: { fontSize: 13, color: '#ef4444', marginBottom: 8 },
  muted: { fontSize: 13, color: '#6b7280' },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardTitle: { fontSize: 14, fontWeight: '600', color: '#111827', flexShrink: 1 },
  headline: { fontSize: 12, fontWeight: '700', marginLeft: 8 },
  amount: { fontSize: 13, color: '#374151', marginTop: 2, marginBottom: 10 },
  leg: { flexDirection: 'row', marginBottom: 10 },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 5, marginRight: 8 },
  legBody: { flex: 1 },
  legLabel: { fontSize: 13, fontWeight: '600' },
  legValue: { fontSize: 12, color: '#374151', marginTop: 1 },
  legDetail: { fontSize: 12, color: '#6b7280', marginTop: 1, lineHeight: 16 },
});
