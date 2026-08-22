/**
 * "How close have the forecasts we act on your behalf been to reality."
 *
 * The owner-facing half of forecast scoring. Numbers here only exist where real
 * actuals arrived and were paired with the forecast; a type with no actuals says
 * so rather than showing the model's own self-reported confidence.
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

const TYPE_LABEL: Record<string, string> = {
  load: 'Load',
  solar_generation: 'Solar generation',
  wind_generation: 'Wind generation',
  net_load: 'Net load',
  price: 'Price',
  emissions: 'Grid emissions',
};

function unitFor(forecastType: string): string {
  switch (forecastType) {
    case 'load':
    case 'solar_generation':
    case 'wind_generation':
    case 'net_load':
      return 'W';
    case 'price':
      return '/kWh';
    case 'emissions':
      return 'g/kWh';
    default:
      return '';
  }
}

function percent(bp: number | null | undefined): string {
  return bp == null ? 'not measured' : `${(bp / 100).toFixed(1)}%`;
}

function magnitude(value: number | null | undefined, unit: string): string {
  return value == null ? 'not measured' : `${value.toFixed(1)} ${unit}`;
}

/** Signed: a forecast that always runs low under-commits your asset every day. */
function bias(value: number | null | undefined, unit: string): string {
  if (value == null) return 'not measured';
  if (Math.abs(value) < 0.05) return 'balanced';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)} ${unit} ${value > 0 ? 'high' : 'low'}`;
}

function calibration(coverageBp: number | null, targetBp: number): { label: string; tone: Tone } {
  if (coverageBp == null) return { label: 'Not measured', tone: 'neutral' };
  const drift = coverageBp - targetBp;
  if (drift < -1500) return { label: 'Overconfident', tone: 'danger' };
  if (drift < -500) return { label: 'Slightly overconfident', tone: 'warning' };
  if (drift > 1500) return { label: 'Band too wide', tone: 'warning' };
  return { label: 'Calibrated', tone: 'good' };
}

function evidence(
  row: { scoredRuns: number; unmeasuredRuns: number; sampleCount: number },
  minSamples: number
): { label: string; tone: Tone } {
  if (row.scoredRuns === 0) return { label: 'Unmeasured', tone: 'neutral' };
  if (row.sampleCount < minSamples * 4 || row.unmeasuredRuns > row.scoredRuns) {
    return { label: 'Thin evidence', tone: 'warning' };
  }
  return { label: 'Measured', tone: 'good' };
}

function Chip({ label, tone }: { label: string; tone: Tone }) {
  const color = TONE_COLOR[tone];
  return (
    <View style={[styles.chip, { backgroundColor: color.bg }]}>
      <Text style={[styles.chipText, { color: color.fg }]}>{label}</Text>
    </View>
  );
}

export default function ForecastAccuracyScreen({ navigation }: any) {
  const [refreshing, setRefreshing] = useState(false);

  const summaryQuery = trpc.forecasting.accuracySummary.useQuery(
    { sinceDays: 30 },
    { refetchInterval: 60000 }
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await summaryQuery.refetch();
    setRefreshing(false);
  };

  const rows = summaryQuery.data?.rows ?? [];
  const targetCoverageBp = summaryQuery.data?.targetCoverageBp ?? 8000;
  const minSamples = summaryQuery.data?.minScoringSamples ?? 4;
  const unmeasured = rows.reduce((total: number, row: any) => total + row.unmeasuredRuns, 0);

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <Text style={styles.title}>Forecast Accuracy</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.introCard}>
        <Ionicons name="information-circle" size={20} color="#1e40af" />
        <Text style={styles.introText}>
          Each figure compares a past forecast with the readings that actually arrived
          afterwards. Where actuals never arrived we say the forecast is unmeasured instead of
          showing you a score it did not earn.
        </Text>
      </View>

      {unmeasured > 0 && (
        <View style={styles.warnCard}>
          <Text style={styles.warnText}>
            {unmeasured} forecast run{unmeasured === 1 ? '' : 's'} in the last 30 days could not be
            scored — fewer than {minSamples} readings were paired with them.
          </Text>
        </View>
      )}

      {summaryQuery.isLoading ? (
        <Text style={styles.emptyText}>Loading measured accuracy…</Text>
      ) : summaryQuery.isError ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            {summaryQuery.error?.message || 'Could not load forecast accuracy'}
          </Text>
        </View>
      ) : rows.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            No forecast has been scored against actuals yet, so its accuracy is unknown rather
            than good. Scores appear once a forecast period has passed and the readings for it
            have arrived.
          </Text>
        </View>
      ) : (
        rows.map((row: any) => {
          const unit = unitFor(row.forecastType);
          const support = evidence(row, minSamples);
          const band = calibration(row.coverageBp, targetCoverageBp);
          return (
            <View key={`${row.forecastType}-${row.scopeId ?? 'all'}-${row.modelVersion}`} style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.target}>{TYPE_LABEL[row.forecastType] ?? row.forecastType}</Text>
                <Chip label={support.label} tone={support.tone} />
              </View>
              <Text style={styles.protocol}>model {row.modelVersion}</Text>

              <View style={styles.metricsRow}>
                <View style={styles.metric}>
                  <Text style={styles.metricLabel}>Typical error</Text>
                  <Text style={styles.metricValue}>{percent(row.mapeBp)}</Text>
                </View>
                <View style={styles.metric}>
                  <Text style={styles.metricLabel}>Average miss</Text>
                  <Text style={styles.metricValue}>{magnitude(row.mae, unit)}</Text>
                </View>
              </View>

              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Direction</Text>
                <Text style={styles.detailValue}>{bias(row.bias, unit)}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Stated range</Text>
                <Chip label={band.label} tone={band.tone} />
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Range width</Text>
                <Text style={styles.detailValue}>{magnitude(row.intervalWidth, unit)}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Readings used</Text>
                <Text style={styles.detailValue}>
                  {row.sampleCount} across {row.scoredRuns} run{row.scoredRuns === 1 ? '' : 's'}
                </Text>
              </View>

              <Text style={styles.meaning}>
                {row.coverageBp == null
                  ? 'No actuals were paired with the stated range, so its reliability is unknown.'
                  : `Actuals landed inside the stated range ${percent(row.coverageBp)} of the time against a ${percent(targetCoverageBp)} target.`}
              </Text>
            </View>
          );
        })
      )}

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
  warnCard: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#fef3c7',
  },
  warnText: { fontSize: 13, color: '#92400e', lineHeight: 18 },
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
  detailLabel: { fontSize: 13, color: '#6b7280' },
  detailValue: { fontSize: 13, color: '#111827', fontWeight: '500' },
  meaning: { fontSize: 12, color: '#6b7280', marginTop: 12, lineHeight: 17 },
  emptyText: { fontSize: 13, color: '#6b7280', textAlign: 'center', padding: 24, lineHeight: 19 },
  chip: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999 },
  chipText: { fontSize: 11, fontWeight: '600' },
});
