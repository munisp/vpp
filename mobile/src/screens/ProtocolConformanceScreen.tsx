/**
 * "Is that protocol proven, or just claimed?"
 *
 * Read-only on purpose: nothing on a phone can make a protocol proven, because
 * proof is a vector-set run reported by the protocol services over the signed
 * ingest route. What a commissioning engineer standing in front of a charger
 * does need is the answer to whether this platform has ever spoken that wire
 * successfully, what peer it spoke to — a simulator proves the adapter, not the
 * device, and says so here — and which controls went out unproven.
 *
 * A protocol with no vector set reads as untestable, not as failed.
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { trpc } from '../services/trpc';
import { HapticService } from '../services/hapticService';
import {
  CONFORMANCE_ADAPTER_LABELS,
  CONFORMANCE_OUTCOME_COPY,
  PROTOCOL_PROOF_COPY,
  type ConformanceAdapter,
  type ConformanceRunOutcome,
  type ProtocolProofState,
  type Tone,
} from '../../../shared/protocol-conformance-copy';

const TONE_COLOR: Record<Tone, { bg: string; fg: string }> = {
  good: { bg: '#d1fae5', fg: '#065f46' },
  warning: { bg: '#fef3c7', fg: '#92400e' },
  bad: { bg: '#fee2e2', fg: '#991b1b' },
  neutral: { bg: '#f3f4f6', fg: '#374151' },
};

function Chip({ label, tone }: { label: string; tone: Tone }) {
  const color = TONE_COLOR[tone];
  return (
    <View style={[styles.chip, { backgroundColor: color.bg }]}>
      <Text style={[styles.chipText, { color: color.fg }]}>{label}</Text>
    </View>
  );
}

function when(value: string | Date | null | undefined): string {
  if (!value) return 'never';
  return new Date(value).toLocaleString();
}

export default function ProtocolConformanceScreen({ navigation }: any) {
  const [refreshing, setRefreshing] = useState(false);
  const [openRunId, setOpenRunId] = useState<number | null>(null);

  const coverageQuery = trpc.protocolConformance.coverage.useQuery(undefined, { retry: false });
  const runsQuery = trpc.protocolConformance.runs.useQuery({ limit: 25 }, { retry: false });
  const unprovenQuery = trpc.protocolConformance.unprovenDispatches.useQuery(
    { limit: 25 },
    { retry: false }
  );
  const runQuery = trpc.protocolConformance.run.useQuery(
    { runId: openRunId as number },
    { enabled: openRunId !== null, retry: false }
  );

  const coverage = coverageQuery.data ?? [];
  const runs = runsQuery.data ?? [];
  const unproven = unprovenQuery.data ?? [];

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await Promise.all([coverageQuery.refetch(), runsQuery.refetch(), unprovenQuery.refetch()]);
    setRefreshing(false);
  };

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <Text style={styles.title}>Protocol Conformance</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.introCard}>
        <Ionicons name="ribbon-outline" size={20} color="#1e40af" />
        <Text style={styles.introText}>
          Evidence, not claims. A protocol counts as proven only while a run exists in which every
          case executed and passed. A run against a simulator proves the adapter, never the device
          in front of you.
        </Text>
      </View>

      {coverageQuery.isError ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            {coverageQuery.error?.message || 'Could not load conformance evidence'}
          </Text>
        </View>
      ) : coverageQuery.isLoading ? (
        <Text style={styles.emptyText}>Loading evidence…</Text>
      ) : (
        <>
          <Text style={styles.sectionHeading}>Evidence per adapter</Text>
          {coverage.map(row => {
            const copy = PROTOCOL_PROOF_COPY[row.state as ProtocolProofState];
            return (
              <View key={row.adapter} style={styles.card}>
                <View style={styles.rowBetween}>
                  <Text style={styles.cardTitle}>
                    {CONFORMANCE_ADAPTER_LABELS[row.adapter as ConformanceAdapter]}
                  </Text>
                  <Chip label={copy.label} tone={copy.tone} />
                </View>
                <Text style={styles.detailText}>{copy.meaning}</Text>
                <Text style={styles.metaText}>
                  {row.run
                    ? `${row.run.target === 'device' ? 'device' : 'simulator'} · ${row.run.deviceModel} · ${row.run.passedCases}/${row.run.totalCases} cases · ${when(row.run.completedAt)}`
                    : 'no run has ever been recorded for this adapter'}
                </Text>
                <Text style={styles.metaText}>
                  {row.claimingAssets} asset(s) claim it · {row.certifiedAssets} certified against a
                  run
                </Text>
              </View>
            );
          })}

          <Text style={styles.sectionHeading}>Runs</Text>
          {runs.length === 0 ? (
            <View style={styles.card}>
              <Text style={styles.emptyText}>
                No conformance run has been recorded on this deployment, so nothing here is proven.
              </Text>
            </View>
          ) : (
            runs.map(row => {
              const copy = CONFORMANCE_OUTCOME_COPY[row.outcome as ConformanceRunOutcome];
              const open = openRunId === row.id;
              return (
                <TouchableOpacity
                  key={row.id}
                  style={styles.card}
                  onPress={() => setOpenRunId(open ? null : row.id)}
                >
                  <View style={styles.rowBetween}>
                    <Text style={styles.cardTitle}>
                      {CONFORMANCE_ADAPTER_LABELS[row.adapter as ConformanceAdapter]}{' '}
                      {row.protocolVersion}
                    </Text>
                    <Chip label={copy.label} tone={copy.tone} />
                  </View>
                  <Text style={styles.detailText}>
                    {row.passedCases} passed · {row.failedCases} failed · {row.skippedCases} skipped
                  </Text>
                  <Text style={styles.metaText}>
                    {row.vectorSetId} v{row.vectorSetVersion} ·{' '}
                    {row.target === 'device' ? 'device' : 'simulator'} ·{' '}
                    {row.deviceIdentifier ?? row.deviceModel}
                  </Text>
                  <Text style={styles.metaText}>
                    run by {row.operator} · completed {when(row.completedAt)}
                  </Text>
                  {open &&
                    (runQuery.isLoading ? (
                      <Text style={styles.metaText}>Loading cases…</Text>
                    ) : runQuery.data ? (
                      <View style={styles.caseBlock}>
                        <Text style={styles.metaText}>
                          artifact sha256 {runQuery.data.artifactChecksum}
                        </Text>
                        {runQuery.data.cases.map(one => (
                          <View key={one.caseId} style={styles.caseRow}>
                            <Text style={styles.caseId}>{one.caseId}</Text>
                            <Chip
                              label={one.outcome}
                              tone={
                                one.outcome === 'pass'
                                  ? 'good'
                                  : one.outcome === 'fail'
                                    ? 'bad'
                                    : 'warning'
                              }
                            />
                          </View>
                        ))}
                      </View>
                    ) : null)}
                </TouchableOpacity>
              );
            })
          )}

          <Text style={styles.sectionHeading}>Controls issued unproven</Text>
          {unproven.length === 0 ? (
            <View style={styles.card}>
              <Text style={styles.emptyText}>
                No control has been issued over an unproven protocol since labelling began.
              </Text>
            </View>
          ) : (
            unproven.map(row => {
              const copy = PROTOCOL_PROOF_COPY[row.protocolProof as ProtocolProofState];
              return (
                <View key={row.id} style={styles.card}>
                  <View style={styles.rowBetween}>
                    <Text style={styles.cardTitle}>
                      #{row.id} · {row.protocol}
                    </Text>
                    <Chip label={copy.label} tone={copy.tone} />
                  </View>
                  <Text style={styles.detailText}>
                    {row.targetRef}
                    {row.assetId !== null ? ` · asset ${row.assetId}` : ''}
                  </Text>
                  <Text style={styles.metaText}>issued {when(row.createdAt)}</Text>
                </View>
              );
            })
          )}
        </>
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
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  backButton: { width: 40, height: 40, justifyContent: 'center' },
  title: { fontSize: 18, fontWeight: '700', color: '#111827' },
  introCard: {
    flexDirection: 'row',
    gap: 10,
    margin: 16,
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#eff6ff',
  },
  introText: { flex: 1, fontSize: 13, lineHeight: 19, color: '#1e3a8a' },
  card: {
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  cardTitle: { fontSize: 15, fontWeight: '700', color: '#111827', flexShrink: 1 },
  sectionHeading: {
    marginHorizontal: 16,
    marginBottom: 8,
    fontSize: 13,
    fontWeight: '700',
    color: '#6b7280',
    textTransform: 'uppercase',
  },
  detailText: { marginTop: 6, fontSize: 13, lineHeight: 19, color: '#374151' },
  metaText: { marginTop: 8, fontSize: 12, color: '#6b7280' },
  emptyText: { fontSize: 13, color: '#6b7280', lineHeight: 19 },
  chip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  chipText: { fontSize: 12, fontWeight: '600' },
  caseBlock: { marginTop: 10, borderTopWidth: 1, borderTopColor: '#e5e7eb', paddingTop: 8 },
  caseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  caseId: { fontSize: 12, color: '#374151', flexShrink: 1, marginRight: 8 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
