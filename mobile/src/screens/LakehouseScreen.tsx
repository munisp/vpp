/**
 * "Is anything actually in the lake?" — the operator's field view.
 *
 * Same records as the web console, from the same copy map: what the ingestion job
 * recorded. A dataset with no runs reads `never ingested` rather than empty, a
 * failed run shows the job's own error, and a backlog that could not be counted
 * reads `unknown` rather than zero.
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { trpc } from '../services/trpc';
import { HapticService } from '../services/hapticService';
import {
  DATASET_STATE_COPY,
  backlogLabel,
  bytesLabel,
  runStateCopy,
  whenLabel,
  type DatasetState,
  type Tone,
} from '../../../shared/lakehouse-state';

const TONE_COLOR: Record<Tone, { bg: string; fg: string }> = {
  good: { bg: '#d1fae5', fg: '#065f46' },
  warning: { bg: '#fef3c7', fg: '#92400e' },
  danger: { bg: '#fee2e2', fg: '#991b1b' },
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

export default function LakehouseScreen({ navigation }: any) {
  const [refreshing, setRefreshing] = useState(false);
  const { data: currentUser } = trpc.auth.me.useQuery();
  const isAdmin = currentUser?.role === 'admin';

  const status = trpc.lakehouse.status.useQuery(undefined, { enabled: isAdmin });
  const runs = trpc.lakehouse.runs.useQuery({ limit: 15 }, { enabled: isAdmin });

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await Promise.all([
      isAdmin ? status.refetch() : Promise.resolve(),
      isAdmin ? runs.refetch() : Promise.resolve(),
    ]);
    setRefreshing(false);
  };

  const datasets = status.data?.datasets ?? [];
  const recentRuns = runs.data?.runs ?? [];

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <Text style={styles.title}>Lakehouse</Text>
        <View style={{ width: 40 }} />
      </View>

      {!isAdmin ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            Ingestion state is visible to platform administrators only.
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.introCard}>
            <Ionicons name="server-outline" size={20} color="#1e40af" />
            <Text style={styles.introText}>
              A run counts as succeeded only once its stored object has been read back and its
              digest matched. Datasets that have never been ingested are shown as absent, not empty.
            </Text>
          </View>

          {status.isError ? (
            /* A failed read is missing information, never an all-clear. */
            <View style={styles.dangerCard}>
              <Text style={styles.dangerTitle}>Ingestion state could not be read</Text>
              <Text style={styles.dangerText}>
                {status.error?.message} — nothing is known about what is in the lake right now.
              </Text>
            </View>
          ) : status.isLoading ? (
            <Text style={styles.emptyText}>Loading ingestion state…</Text>
          ) : (
            <>
              <View style={status.data?.allFresh ? styles.card : styles.warnCard}>
                <Text style={styles.headline}>{status.data?.detail}</Text>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Freshness budget</Text>
                  <Text style={styles.detailValue}>{status.data?.freshnessSeconds ?? 0}s</Text>
                </View>
              </View>

              <Text style={styles.sectionTitle}>Datasets ({datasets.length})</Text>
              {datasets.map(dataset => {
                const copy = DATASET_STATE_COPY[dataset.state as DatasetState];
                return (
                  <View key={dataset.dataset} style={styles.card}>
                    <View style={styles.cardHeader}>
                      <Text style={styles.target}>{dataset.dataset}</Text>
                      <Chip label={copy.label} tone={copy.tone} />
                    </View>
                    <Text style={styles.meaning}>{dataset.detail}</Text>
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>Rows ingested</Text>
                      <Text style={styles.detailValue}>{dataset.rowsIngested}</Text>
                    </View>
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>Not yet in the lake</Text>
                      <Text style={styles.detailValue}>{backlogLabel(dataset.rowsBehind)}</Text>
                    </View>
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>Last success</Text>
                      <Text style={styles.detailValue}>{whenLabel(dataset.lastSuccessAt)}</Text>
                    </View>
                  </View>
                );
              })}

              <Text style={styles.sectionTitle}>Recent runs ({recentRuns.length})</Text>
              {recentRuns.length === 0 ? (
                <View style={styles.card}>
                  <Text style={styles.emptyText}>
                    No ingestion run has been recorded against this database.
                  </Text>
                </View>
              ) : (
                recentRuns.map(run => {
                  const copy = runStateCopy(run.state);
                  return (
                    <View key={run.id} style={styles.card}>
                      <View style={styles.cardHeader}>
                        <Text style={styles.target}>{run.dataset}</Text>
                        <Chip label={copy.label} tone={copy.tone} />
                      </View>
                      <Text style={styles.meaning}>{run.error ?? copy.meaning}</Text>
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>Rows / size</Text>
                        <Text style={styles.detailValue}>
                          {run.rowsWritten} · {bytesLabel(run.bytesWritten)}
                        </Text>
                      </View>
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>Finished</Text>
                        <Text style={styles.detailValue}>{whenLabel(run.finishedAt)}</Text>
                      </View>
                    </View>
                  );
                })
              )}
            </>
          )}
        </>
      )}

      <View style={{ height: 24 }} />
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
  backButton: { width: 40, height: 40, justifyContent: 'center' },
  title: { fontSize: 18, fontWeight: '600', color: '#111827' },
  introCard: {
    flexDirection: 'row',
    gap: 10,
    margin: 16,
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#eff6ff',
  },
  introText: { flex: 1, fontSize: 13, color: '#1e3a8a', lineHeight: 18 },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
    marginTop: 20,
    marginHorizontal: 16,
  },
  card: { margin: 16, marginBottom: 0, padding: 14, borderRadius: 10, backgroundColor: '#ffffff' },
  warnCard: { margin: 16, marginBottom: 0, padding: 14, borderRadius: 10, backgroundColor: '#fef3c7' },
  dangerCard: { margin: 16, marginBottom: 0, padding: 14, borderRadius: 10, backgroundColor: '#fee2e2' },
  dangerTitle: { fontSize: 14, fontWeight: '600', color: '#991b1b' },
  dangerText: { fontSize: 12, color: '#991b1b', marginTop: 4, lineHeight: 17 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headline: { fontSize: 15, fontWeight: '600', color: '#111827' },
  target: { fontSize: 15, fontWeight: '600', color: '#111827', flexShrink: 1 },
  meaning: { fontSize: 12, color: '#6b7280', marginTop: 6, lineHeight: 17 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  detailLabel: { fontSize: 12, color: '#6b7280' },
  detailValue: {
    fontSize: 12,
    color: '#111827',
    fontWeight: '500',
    flexShrink: 1,
    textAlign: 'right',
  },
  chip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  chipText: { fontSize: 11, fontWeight: '600' },
  emptyText: { fontSize: 13, color: '#6b7280', textAlign: 'center', padding: 16 },
});
