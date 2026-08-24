/**
 * "Is the feeder itself in the way?"
 *
 * A read-only view of the electrical model behind a node and of the feasibility
 * studies that dispatch and flexibility clearing depend on. It holds the same
 * line the service does: only 'within limits' means the network was checked, and
 * a node that is not modelled, a solver that did not converge, and an engine
 * nobody could reach are three different kinds of "we do not know" — never a
 * pass.
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { trpc } from '../services/trpc';
import { HapticService } from '../services/hapticService';
import {
  FEASIBILITY_STATUS_COPY,
  type FeasibilityStatus,
  type Tone,
} from '../../../shared/network-feasibility-copy';

const TONE_COLOR: Record<Tone, { bg: string; fg: string }> = {
  good: { bg: '#d1fae5', fg: '#065f46' },
  warning: { bg: '#fef3c7', fg: '#92400e' },
  bad: { bg: '#fee2e2', fg: '#991b1b' },
  neutral: { bg: '#f3f4f6', fg: '#374151' },
};

function StatusChip({ status }: { status: FeasibilityStatus }) {
  const copy = FEASIBILITY_STATUS_COPY[status];
  const color = TONE_COLOR[copy.tone];
  return (
    <View style={[styles.chip, { backgroundColor: color.bg }]}>
      <Text style={[styles.chipText, { color: color.fg }]}>{copy.label}</Text>
    </View>
  );
}

export default function NetworkFeasibilityScreen({ navigation }: any) {
  const [refreshing, setRefreshing] = useState(false);
  const [nodeId, setNodeId] = useState<number | null>(null);

  const serviceQuery = trpc.networkModel.serviceStatus.useQuery();
  const nodesQuery = trpc.locationalFlexibility.nodes.useQuery({}, { retry: false });

  const nodes = nodesQuery.data ?? [];
  const activeNodeId = nodeId ?? nodes[0]?.nodeId ?? null;
  const activeNode = nodes.find(node => node.nodeId === activeNodeId) ?? null;

  const summaryQuery = trpc.networkModel.summary.useQuery(
    { nodeId: activeNodeId as number },
    { enabled: activeNodeId !== null, retry: false }
  );
  const studiesQuery = trpc.networkModel.studies.useQuery(
    { nodeId: activeNodeId as number, limit: 20 },
    { enabled: activeNodeId !== null, retry: false }
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await Promise.all([nodesQuery.refetch(), summaryQuery.refetch(), studiesQuery.refetch()]);
    setRefreshing(false);
  };

  const summary = summaryQuery.data ?? null;
  const studies = studiesQuery.data ?? [];

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <Text style={styles.title}>Network Feasibility</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.introCard}>
        <Ionicons name="git-network" size={20} color="#1e40af" />
        <Text style={styles.introText}>
          Power flow over the recorded electrical model — impedances, transformer ratings and the
          measured base case. Only "within limits" means a feeder was checked; anything else means
          nothing was established, and dispatch issued in that state is stamped network-unchecked.
        </Text>
      </View>

      {serviceQuery.data && !serviceQuery.data.configured && (
        <View style={styles.warnCard}>
          <Text style={styles.warnText}>{serviceQuery.data.note}</Text>
        </View>
      )}

      {nodesQuery.isLoading ? (
        <Text style={styles.emptyText}>Loading nodes…</Text>
      ) : nodesQuery.isError ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            {nodesQuery.error?.message || 'Could not load grid nodes'}
          </Text>
        </View>
      ) : nodes.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            No grid node has been registered, so there is no network to study.
          </Text>
        </View>
      ) : (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.nodeRow}>
            {nodes.map(node => {
              const active = node.nodeId === activeNodeId;
              return (
                <TouchableOpacity
                  key={node.nodeId}
                  style={[styles.nodeChip, active && styles.nodeChipActive]}
                  onPress={() => setNodeId(node.nodeId)}
                >
                  <Text style={[styles.nodeChipText, active && styles.nodeChipTextActive]}>
                    {node.code}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>{activeNode ? activeNode.name : 'Node'}</Text>
            {summaryQuery.isLoading ? (
              <Text style={styles.emptyText}>Reading the model…</Text>
            ) : summaryQuery.isError ? (
              <Text style={styles.emptyText}>
                {summaryQuery.error?.message || 'Could not read the electrical model'}
              </Text>
            ) : summary === null ? (
              <Text style={styles.emptyText}>No model was returned for this node.</Text>
            ) : summary.modelled ? (
              <>
                <View style={styles.chipRow}>
                  <View style={[styles.chip, { backgroundColor: TONE_COLOR.good.bg }]}>
                    <Text style={[styles.chipText, { color: TONE_COLOR.good.fg }]}>
                      Model usable
                    </Text>
                  </View>
                </View>
                <Text style={styles.detailText}>
                  {summary.buses} bus(es), {summary.lines} line(s), {summary.transformers}{' '}
                  transformer(s).
                </Text>
                <Text style={styles.detailText}>
                  {summary.sourceNodeCodes.length > 0
                    ? `Fed from ${summary.sourceNodeCodes.join(', ')}.`
                    : 'No source bus is recorded, so this model cannot be solved.'}
                </Text>
              </>
            ) : (
              <>
                <View style={styles.chipRow}>
                  <View style={[styles.chip, { backgroundColor: TONE_COLOR.warning.bg }]}>
                    <Text style={[styles.chipText, { color: TONE_COLOR.warning.fg }]}>
                      Not modelled
                    </Text>
                  </View>
                </View>
                <Text style={styles.detailText}>
                  {summary.reason ??
                    'There is no usable electrical model here, so nothing behind this node is network-checked.'}
                </Text>
              </>
            )}
          </View>

          <Text style={styles.sectionHeading}>Studies behind dispatch and awards</Text>
          {studiesQuery.isLoading ? (
            <Text style={styles.emptyText}>Loading studies…</Text>
          ) : studiesQuery.isError ? (
            <View style={styles.card}>
              <Text style={styles.emptyText}>
                {studiesQuery.error?.message || 'Could not load studies'}
              </Text>
            </View>
          ) : studies.length === 0 ? (
            <View style={styles.card}>
              <Text style={styles.emptyText}>
                No study has been run against this node — every dispatch and award behind it so far
                is network-unchecked.
              </Text>
            </View>
          ) : (
            studies.map(row => {
              const status = row.status as FeasibilityStatus;
              return (
                <View key={row.id} style={styles.card}>
                  <View style={styles.rowBetween}>
                    <Text style={styles.cardTitle}>{row.subject.replace(/_/g, ' ')}</Text>
                    <StatusChip status={status} />
                  </View>
                  {row.subjectReference ? (
                    <Text style={styles.detailText}>{row.subjectReference}</Text>
                  ) : null}
                  <Text style={styles.detailText}>
                    {row.limitingElement
                      ? `Limited by ${row.limitingElement} (${row.violationCount} violation${
                          row.violationCount === 1 ? '' : 's'
                        }).`
                      : (row.reason ?? FEASIBILITY_STATUS_COPY[status].meaning)}
                  </Text>
                  <Text style={styles.metaText}>
                    {new Date(row.createdAt).toLocaleString()} ·{' '}
                    {row.engine ?? 'not solved by any engine'}
                  </Text>
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
  warnCard: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#fef3c7',
  },
  warnText: { fontSize: 13, color: '#92400e' },
  nodeRow: { paddingHorizontal: 12, marginBottom: 8 },
  nodeChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    marginHorizontal: 4,
  },
  nodeChipActive: { backgroundColor: '#1e40af', borderColor: '#1e40af' },
  nodeChipText: { fontSize: 13, fontWeight: '600', color: '#374151' },
  nodeChipTextActive: { color: '#ffffff' },
  card: {
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  cardTitle: { fontSize: 15, fontWeight: '700', color: '#111827', textTransform: 'capitalize' },
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
  emptyText: { marginHorizontal: 16, fontSize: 13, color: '#6b7280', lineHeight: 19 },
  chip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  chipText: { fontSize: 12, fontWeight: '600' },
  chipRow: { flexDirection: 'row', marginTop: 8 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
