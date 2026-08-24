/**
 * "How often has my power gone off, and for how long?"
 *
 * Read-only and scoped to the signed-in customer's own connections — a household
 * sees its own outage history, not the fleet's. Recording or closing an
 * interruption is an operator action against named evidence and is not offered
 * here.
 *
 * Every figure is computed over the connections somebody actually monitors. An
 * unmonitored connection is shown as unmonitored rather than as a connection
 * with no interruptions, and a figure covering an outage still in progress is
 * labelled a lower bound.
 */

import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { trpc } from '../services/trpc';
import { HapticService } from '../services/hapticService';
import {
  DETECTION_SOURCE_COPY,
  INDEX_MEANING,
  INTERRUPTION_CAUSE_LABEL,
  MONITORING_COPY,
  coverageSummary,
  indexValue,
  percentValue,
  reliabilityBasisCopy,
  reliabilityReasonCopy,
  type ReliabilityTone,
} from '../../../shared/reliability-copy';

const TONE_COLOR: Record<ReliabilityTone, { bg: string; fg: string }> = {
  live: { bg: '#cffafe', fg: '#155e75' },
  good: { bg: '#d1fae5', fg: '#065f46' },
  warning: { bg: '#fef3c7', fg: '#92400e' },
  danger: { bg: '#fee2e2', fg: '#991b1b' },
  neutral: { bg: '#f3f4f6', fg: '#374151' },
};

const WINDOWS: Array<{ days: number; label: string }> = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];

function Chip({ label, tone }: { label: string; tone: ReliabilityTone }) {
  const color = TONE_COLOR[tone];
  return (
    <View style={[styles.chip, { backgroundColor: color.bg }]}>
      <Text style={[styles.chipText, { color: color.fg }]}>{label}</Text>
    </View>
  );
}

function Metric({
  label,
  value,
  unit,
  meaning,
}: {
  label: string;
  value: string | null;
  unit: string;
  meaning: string;
}) {
  return (
    <View style={styles.metricCard}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value ?? '—'}</Text>
      <Text style={styles.metricUnit}>{unit}</Text>
      <Text style={styles.metricMeaning}>{meaning}</Text>
    </View>
  );
}

interface ServiceReliabilityScreenProps {
  navigation: { goBack: () => void };
}

export default function ServiceReliabilityScreen({ navigation }: ServiceReliabilityScreenProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [days, setDays] = useState(30);

  const period = useMemo(() => {
    const end = new Date();
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    return { start, end };
  }, [days]);

  const query = trpc.reliability.myReliability.useQuery(period, { retry: false });

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await query.refetch();
    setRefreshing(false);
  };

  const assessment = query.data?.assessment;
  const basis = reliabilityBasisCopy(assessment?.basis ?? null);
  const reason = reliabilityReasonCopy(assessment?.reason ?? null);
  const servicePoints = query.data?.servicePoints ?? [];
  const interruptions = query.data?.interruptions ?? [];

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <Text style={styles.title}>Supply reliability</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.introCard}>
        <Ionicons name="information-circle" size={20} color="#1e40af" />
        <Text style={styles.introText}>
          Your own outage history, from interruptions recorded against your connections. This is
          power at your meter, not the app's uptime — and where nobody is monitoring a connection it
          says so instead of reporting perfect supply.
        </Text>
      </View>

      <View style={styles.tabRow}>
        {WINDOWS.map((window) => {
          const active = window.days === days;
          return (
            <TouchableOpacity
              key={window.days}
              onPress={() => setDays(window.days)}
              style={[styles.tab, active && styles.tabActive]}
            >
              <Text style={[styles.tabText, active && styles.tabTextActive]}>{window.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {query.isError && (
        <View style={styles.errorCard}>
          <Text style={styles.errorTitle}>Reliability could not be read</Text>
          <Text style={styles.errorText}>
            {query.error.message} — your supply history for this period is unknown right now. This is
            not an all-clear.
          </Text>
        </View>
      )}

      {query.isLoading && <Text style={styles.loading}>Reading your connections…</Text>}

      {reason && (
        <View style={styles.warnCard}>
          <Text style={styles.warnTitle}>No index is reported: {reason.label}</Text>
          <Text style={styles.warnText}>{reason.meaning}</Text>
        </View>
      )}

      {assessment && (
        <>
          <View style={styles.basisRow}>
            <Chip label={basis.label} tone={basis.tone} />
            <Text style={styles.basisText}>{basis.meaning}</Text>
          </View>

          <View style={styles.metricGrid}>
            <Metric
              label="Interruptions"
              value={indexValue(assessment.indices.saifi, 2)}
              unit="per connection (SAIFI)"
              meaning={INDEX_MEANING.saifi}
            />
            <Metric
              label="Time without power"
              value={indexValue(assessment.indices.saidiMinutes, 1)}
              unit="minutes per connection (SAIDI)"
              meaning={INDEX_MEANING.saidi}
            />
            <Metric
              label="Average outage"
              value={indexValue(assessment.indices.caidiMinutes, 1)}
              unit="minutes (CAIDI)"
              meaning={INDEX_MEANING.caidi}
            />
            <Metric
              label="Supplied"
              value={percentValue(assessment.indices.asai, 3)}
              unit="% of minutes (ASAI)"
              meaning={INDEX_MEANING.asai}
            />
            <Metric
              label="Momentary dips"
              value={indexValue(assessment.indices.maifi, 2)}
              unit="per connection (MAIFI)"
              meaning={INDEX_MEANING.maifi}
            />
            <Metric
              label="Coverage"
              value={String(assessment.coverage.observedServicePoints)}
              unit="connections observed"
              meaning={coverageSummary(assessment.coverage)}
            />
          </View>

          {assessment.coverage.openInterruptions > 0 && (
            <View style={styles.warnCard}>
              <Text style={styles.warnTitle}>
                {assessment.coverage.openInterruptions} interruption(s) still open
              </Text>
              <Text style={styles.warnText}>
                Counted only up to now, so the minutes above can only grow until supply is recorded
                as restored.
              </Text>
            </View>
          )}

          <Text style={styles.sectionTitle}>What this does not cover</Text>
          {assessment.limitations.length === 0 ? (
            <Text style={styles.bodyText}>
              Every observed connection was supplied for the whole period and every counted
              interruption is closed with restoration evidence.
            </Text>
          ) : (
            assessment.limitations.map((limitation) => (
              <View key={limitation} style={styles.limitationRow}>
                <Ionicons name="alert-circle-outline" size={16} color="#92400e" />
                <Text style={styles.limitationText}>{limitation}</Text>
              </View>
            ))
          )}
        </>
      )}

      <Text style={styles.sectionTitle}>Your connections</Text>
      {servicePoints.length === 0 ? (
        <Text style={styles.bodyText}>
          No connection is registered to you. Until one is, no reliability figure can be reported for
          your supply — and none is.
        </Text>
      ) : (
        servicePoints.map((point) => {
          const copy = MONITORING_COPY[point.monitoring];
          return (
            <View key={point.id} style={styles.rowCard}>
              <View style={styles.rowHead}>
                <Text style={styles.rowTitle}>{point.code}</Text>
                <Chip label={copy?.label ?? point.monitoring} tone={copy?.tone ?? 'neutral'} />
              </View>
              <Text style={styles.rowMeta}>
                {point.pointClass.replace('_', ' ')} · connected{' '}
                {new Date(point.connectedAt).toLocaleDateString()}
              </Text>
              <Text style={styles.rowMeaning}>{copy?.meaning ?? ''}</Text>
            </View>
          );
        })
      )}

      <Text style={styles.sectionTitle}>Recorded interruptions</Text>
      {interruptions.length === 0 ? (
        <Text style={styles.bodyText}>No interruption has been recorded on your connections.</Text>
      ) : (
        interruptions.map((row) => {
          const source = DETECTION_SOURCE_COPY[row.detectionSource];
          return (
            <View key={row.id} style={styles.rowCard}>
              <View style={styles.rowHead}>
                <Text style={styles.rowTitle}>
                  {INTERRUPTION_CAUSE_LABEL[row.cause] ?? row.cause}
                </Text>
                {row.endedAt === null ? (
                  <Chip label="still out" tone="danger" />
                ) : (
                  <Chip label="restored" tone="good" />
                )}
              </View>
              <Text style={styles.rowMeta}>
                {new Date(row.startedAt).toLocaleString()}
                {row.endedAt ? ` → ${new Date(row.endedAt).toLocaleString()}` : ''}
              </Text>
              <Text style={styles.rowMeaning}>
                {source ? source.meaning : `Detected by ${row.detectionSource}`}
              </Text>
              {row.excludeFromIndices && (
                <Text style={styles.rowExcluded}>
                  Excluded from the indices above: {row.exclusionReason}
                </Text>
              )}
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
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 8,
    backgroundColor: '#ffffff',
  },
  backButton: { padding: 8 },
  title: { fontSize: 18, fontWeight: '700', color: '#111827' },
  introCard: {
    flexDirection: 'row',
    gap: 8,
    margin: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#eff6ff',
  },
  introText: { flex: 1, fontSize: 13, color: '#1e3a8a', lineHeight: 18 },
  tabRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, marginBottom: 8 },
  tab: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: '#e5e7eb',
  },
  tabActive: { backgroundColor: '#111827' },
  tabText: { fontSize: 13, color: '#374151', fontWeight: '600' },
  tabTextActive: { color: '#ffffff' },
  basisRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  basisText: { flex: 1, fontSize: 12, color: '#4b5563', lineHeight: 16 },
  metricGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 8,
    gap: 8,
  },
  metricCard: {
    flexGrow: 1,
    flexBasis: '45%',
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 12,
  },
  metricLabel: { fontSize: 12, color: '#6b7280', fontWeight: '600' },
  metricValue: { fontSize: 22, fontWeight: '700', color: '#111827' },
  metricUnit: { fontSize: 11, color: '#6b7280' },
  metricMeaning: { fontSize: 11, color: '#4b5563', marginTop: 6, lineHeight: 15 },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111827',
    paddingHorizontal: 12,
    marginTop: 20,
    marginBottom: 8,
  },
  bodyText: { fontSize: 13, color: '#4b5563', paddingHorizontal: 12, lineHeight: 18 },
  rowCard: {
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#ffffff',
  },
  rowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowTitle: { fontSize: 14, fontWeight: '700', color: '#111827', flex: 1, marginRight: 8 },
  rowMeta: { fontSize: 12, color: '#6b7280', marginTop: 4 },
  rowMeaning: { fontSize: 12, color: '#4b5563', marginTop: 6, lineHeight: 16 },
  rowExcluded: { fontSize: 12, color: '#92400e', marginTop: 6 },
  limitationRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    marginBottom: 6,
  },
  limitationText: { flex: 1, fontSize: 12, color: '#92400e', lineHeight: 16 },
  chip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  chipText: { fontSize: 11, fontWeight: '700' },
  errorCard: {
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#fee2e2',
  },
  errorTitle: { fontSize: 14, fontWeight: '700', color: '#991b1b' },
  errorText: { fontSize: 12, color: '#7f1d1d', marginTop: 4, lineHeight: 16 },
  warnCard: {
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#fef3c7',
  },
  warnTitle: { fontSize: 14, fontWeight: '700', color: '#92400e' },
  warnText: { fontSize: 12, color: '#92400e', marginTop: 4, lineHeight: 16 },
  loading: { fontSize: 13, color: '#6b7280', paddingHorizontal: 12, marginBottom: 8 },
});
