/**
 * "What your energy was worth, and what your meter did about it."
 *
 * The owner-facing half of price-signal dispatch: the platform offers a price
 * per interval instead of commanding your equipment, and following it is
 * voluntary. The plan is what your site intended under that price; only the
 * metered row is evidence, and it is the one you are settled against.
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { trpc } from '../services/trpc';
import { HapticService } from '../services/hapticService';

type Tone = 'good' | 'warning' | 'danger' | 'neutral';

const TONE_COLOR: Record<Tone, { bg: string; fg: string }> = {
  good: { bg: '#d1fae5', fg: '#065f46' },
  warning: { bg: '#fef3c7', fg: '#92400e' },
  danger: { bg: '#fee2e2', fg: '#991b1b' },
  neutral: { bg: '#f3f4f6', fg: '#374151' },
};

const STATUS_COPY: Record<string, { label: string; tone: Tone; meaning: string }> = {
  draft: {
    label: 'Not sent',
    tone: 'neutral',
    meaning: 'A price exists for this window but has not been offered yet.',
  },
  published: {
    label: 'Offered',
    tone: 'warning',
    meaning: 'You were offered this price. Nothing has been measured yet.',
  },
  scored: {
    label: 'Measured',
    tone: 'good',
    meaning: 'The window has closed and your meter has been compared with your plan.',
  },
  not_converged: {
    label: 'Withdrawn',
    tone: 'danger',
    meaning: 'No workable price was found for this window, so it was never offered.',
  },
};

const DELIVERY_COPY: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Not sent', tone: 'neutral' },
  broker_queued: { label: 'Sent, receipt unknown', tone: 'warning' },
  failed: { label: 'Send failed', tone: 'danger' },
};

const RESPONSE_COPY: Record<string, { label: string; tone: Tone; meaning: string }> = {
  unmeasured: {
    label: 'Not measured yet',
    tone: 'neutral',
    meaning: 'The window has not closed, so there is nothing to compare.',
  },
  followed: {
    label: 'Followed',
    tone: 'good',
    meaning: 'Your meter came in within tolerance of the plan for this window.',
  },
  deviated: {
    label: 'Deviated',
    tone: 'warning',
    meaning: 'Your meter came in outside tolerance of the plan. Following a price is voluntary.',
  },
  no_telemetry: {
    label: 'No meter data',
    tone: 'danger',
    meaning: 'The window closed with no readings, so nothing can be settled from it.',
  },
};

function netKwh(wattHours: number | null | undefined): string {
  if (wattHours === null || wattHours === undefined) return 'not measured';
  if (wattHours === 0) return '0.00 kWh';
  const kwh = Math.abs(wattHours) / 1000;
  return `${kwh.toFixed(2)} kWh ${wattHours > 0 ? 'imported' : 'exported'}`;
}

function nudge(centsPerKwh: number): { label: string; tone: Tone } {
  if (Math.abs(centsPerKwh) < 0.005) return { label: 'No nudge', tone: 'neutral' };
  if (centsPerKwh > 0) return { label: `+${centsPerKwh.toFixed(2)}¢ use less`, tone: 'warning' };
  return { label: `${centsPerKwh.toFixed(2)}¢ use more`, tone: 'good' };
}

function Chip({ label, tone }: { label: string; tone: Tone }) {
  const color = TONE_COLOR[tone];
  return (
    <View style={[styles.chip, { backgroundColor: color.bg }]}>
      <Text style={[styles.chipText, { color: color.fg }]}>{label}</Text>
    </View>
  );
}

export default function PriceSignalsScreen({ navigation }: any) {
  const [refreshing, setRefreshing] = useState(false);

  const signalsQuery = trpc.priceSignal.mySignals.useQuery(
    { limit: 10 },
    { refetchInterval: 60000 }
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await signalsQuery.refetch();
    setRefreshing(false);
  };

  const signals = signalsQuery.data?.signals ?? [];

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <Text style={styles.title}>Price Signals</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.introCard}>
        <Ionicons name="information-circle" size={20} color="#1e40af" />
        <Text style={styles.introText}>
          Instead of taking control of your equipment, the platform tells you what each part of
          the day is worth. Acting on it is your choice, and you are settled on what your meter
          recorded — never on the plan.
        </Text>
      </View>

      {signalsQuery.isLoading ? (
        <Text style={styles.emptyText}>Loading your price signals…</Text>
      ) : signalsQuery.isError ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            {signalsQuery.error?.message || 'Could not load your price signals'}
          </Text>
        </View>
      ) : signals.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            Your site has not been offered a price signal yet. Sites need about a month of meter
            history before they can take part.
          </Text>
        </View>
      ) : (
        signals.map((signal: any) => {
          const status = STATUS_COPY[signal.status] ?? STATUS_COPY.draft;
          const site = signal.site;
          const delivery = site ? DELIVERY_COPY[site.delivery] ?? DELIVERY_COPY.pending : null;
          const response = site ? RESPONSE_COPY[site.response] ?? RESPONSE_COPY.unmeasured : null;

          return (
            <View key={signal.signalId} style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.target}>
                  {new Date(signal.startsAt).toLocaleString([], {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </Text>
                <Chip label={status.label} tone={status.tone} />
              </View>
              <Text style={styles.protocol}>
                until {new Date(signal.endsAt).toLocaleTimeString()} · {signal.intervalMinutes}-min
                intervals
              </Text>

              {site && (
                <>
                  <View style={styles.metricsRow}>
                    <View style={styles.metric}>
                      <Text style={styles.metricLabel}>Your plan</Text>
                      <Text style={styles.metricValue}>{netKwh(site.plannedNetWh)}</Text>
                    </View>
                    <View style={styles.metric}>
                      <Text style={styles.metricLabel}>Your meter</Text>
                      <Text style={styles.metricValue}>{netKwh(site.actualNetWh)}</Text>
                    </View>
                  </View>

                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Delivery</Text>
                    {delivery && <Chip label={delivery.label} tone={delivery.tone} />}
                  </View>
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Outcome</Text>
                    {response && <Chip label={response.label} tone={response.tone} />}
                  </View>
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Readings used</Text>
                    <Text style={styles.detailValue}>{site.telemetrySamples}</Text>
                  </View>
                  {response && <Text style={styles.meaning}>{response.meaning}</Text>}
                </>
              )}

              <Text style={styles.sectionLabel}>Price through the window</Text>
              {signal.intervals.slice(0, 8).map((interval: any) => {
                const badge = nudge(interval.signalAdjustmentCentsPerKwh);
                return (
                  <View key={interval.intervalIndex} style={styles.detailRow}>
                    <Text style={styles.detailLabel}>
                      {new Date(interval.startsAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </Text>
                    <View style={styles.intervalRight}>
                      <Text style={styles.detailValue}>
                        {(
                          interval.baseImportPriceCentsPerKwh +
                          interval.signalAdjustmentCentsPerKwh
                        ).toFixed(2)}
                        ¢/kWh
                      </Text>
                      <Chip label={badge.label} tone={badge.tone} />
                    </View>
                  </View>
                );
              })}
            </View>
          );
        })
      )}

      <View style={styles.card}>
        <Text style={styles.target}>Why this is not a command</Text>
        <Text style={styles.meaning}>
          A price signal carries no expiry and no fallback, so it can never be used for anything
          that has to happen. Those go out as bounded controls with a stated end time and appear
          under Controls.
        </Text>
      </View>

      <View style={{ height: 32 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 48,
    paddingBottom: 12,
    backgroundColor: '#ffffff',
  },
  backButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 18, fontWeight: '700', color: '#111827' },
  introCard: {
    flexDirection: 'row',
    gap: 8,
    margin: 16,
    marginBottom: 8,
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#dbeafe',
  },
  introText: { flex: 1, fontSize: 13, color: '#1e3a8a', lineHeight: 18 },
  card: {
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 16,
    borderRadius: 12,
    backgroundColor: '#ffffff',
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  target: { fontSize: 15, fontWeight: '700', color: '#111827' },
  protocol: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  metricsRow: { flexDirection: 'row', gap: 16, marginTop: 12 },
  metric: { flex: 1 },
  metricLabel: { fontSize: 11, color: '#6b7280', textTransform: 'uppercase' },
  metricValue: { fontSize: 16, fontWeight: '600', color: '#111827', marginTop: 2 },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  intervalRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  detailLabel: { fontSize: 13, color: '#6b7280' },
  detailValue: { fontSize: 13, color: '#111827', fontWeight: '500' },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#374151',
    marginTop: 16,
    textTransform: 'uppercase',
  },
  meaning: { fontSize: 12, color: '#6b7280', marginTop: 12, lineHeight: 17 },
  emptyText: { fontSize: 13, color: '#6b7280', textAlign: 'center', padding: 24, lineHeight: 19 },
  chip: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999 },
  chipText: { fontSize: 11, fontWeight: '600' },
});
