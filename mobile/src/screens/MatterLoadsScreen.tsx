/**
 * "Which smart-home loads can this platform actually control, and which can it
 * prove?"
 *
 * Operators use the app in the field, and the temptation there is to read a
 * reachable node as a dispatchable one. So this screen leads with the count of
 * loads that can be commanded and never measured, marks the controller's
 * synthetic test nodes as not being appliances at all, and shows an unreported
 * measurement as unreported rather than as zero watts.
 *
 * Everything shown is the controller's last report held by the platform, not a
 * live read of the fabric — a failed read is an outage, never an empty fabric.
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

const CLUSTER_LABEL: Record<string, string> = {
  on_off: 'On/Off',
  level_control: 'Level',
  thermostat: 'Thermostat',
  electrical_power_measurement: 'Power metering',
  electrical_energy_measurement: 'Energy metering',
  device_energy_management: 'Energy management',
};

interface Capability {
  endpointId: number;
  clusterId: number;
  cluster: string | null;
}

interface Attribute {
  path: string;
  endpointId: number;
  clusterId: number;
  attributeId: number;
  cluster: string | null;
  value: unknown;
  reportedAt: string;
}

interface Node {
  id: number;
  fabricId: string;
  nodeId: string;
  available: boolean;
  isBridge: boolean;
  isTestNode: boolean;
  removedAt: string | null;
  lastReportedAt: string;
  capabilities: Capability[];
  attributes: Attribute[];
}

function Chip({ label, tone }: { label: string; tone: Tone }) {
  const color = TONE_COLOR[tone];
  return (
    <View style={[styles.chip, { backgroundColor: color.bg }]}>
      <Text style={[styles.chipText, { color: color.fg }]}>{label}</Text>
    </View>
  );
}

function verdict(node: Node): { label: string; tone: Tone; meaning: string } {
  if (node.removedAt) {
    return {
      label: 'Removed',
      tone: 'neutral',
      meaning: 'The controller no longer reports this node, so it cannot be commanded.',
    };
  }
  if (node.isTestNode) {
    return {
      label: 'Synthetic node',
      tone: 'danger',
      meaning:
        'A controller test node. It acknowledges commands no appliance performs, so nothing it reports is evidence of a load.',
    };
  }
  if (!node.available) {
    return {
      label: 'Unreachable',
      tone: 'danger',
      meaning:
        'The controller cannot reach this node. A command sent now would not arrive, and any window open on it is not being enforced at the device.',
    };
  }
  if (node.capabilities.length === 0) {
    return {
      label: 'No clusters',
      tone: 'warning',
      meaning:
        'Reachable, but it published no clusters, so the platform knows of no control it supports and refuses to command it.',
    };
  }
  return {
    label: 'Reachable',
    tone: 'good',
    meaning: 'Reachable. Only a measured attribute shows what the load actually did.',
  };
}

function isControllable(node: Node): boolean {
  if (node.removedAt || node.isTestNode) return false;
  return node.capabilities.some(
    capability =>
      capability.cluster === 'on_off' ||
      capability.cluster === 'level_control' ||
      capability.cluster === 'thermostat' ||
      capability.cluster === 'device_energy_management'
  );
}

/** Milliwatts to watts, or null when the node reported nothing readable. */
function measuredWatts(node: Node): number | null {
  const attribute = node.attributes.find(
    candidate =>
      candidate.cluster === 'electrical_power_measurement' && candidate.attributeId === 10
  );
  if (!attribute || typeof attribute.value !== 'number' || !Number.isFinite(attribute.value)) {
    return null;
  }
  return attribute.value / 1000;
}

/** Milliwatt-hours to watt-hours, or null when the node reported nothing readable. */
function measuredEnergyWh(node: Node): number | null {
  const attribute = node.attributes.find(
    candidate =>
      candidate.cluster === 'electrical_energy_measurement' && candidate.attributeId === 1
  );
  if (!attribute || typeof attribute.value !== 'number' || !Number.isFinite(attribute.value)) {
    return null;
  }
  return attribute.value / 1000;
}

function formatMeasurement(value: number | null, unit: string): string {
  if (value === null) return 'Not reported';
  const magnitude = Math.abs(value);
  const decimals = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${unit}`;
}

export default function MatterLoadsScreen({ navigation }: any) {
  const [refreshing, setRefreshing] = useState(false);
  const nodesQuery = trpc.matterLoads.nodes.useQuery();

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await nodesQuery.refetch();
    setRefreshing(false);
  };

  const nodes = (nodesQuery.data?.nodes ?? []) as unknown as Node[];
  const active = nodes.filter(node => !node.removedAt);
  const controllable = active.filter(isControllable);
  const unverifiable = controllable.filter(
    node => node.available && measuredWatts(node) === null && measuredEnergyWh(node) === null
  );
  const synthetic = active.filter(node => node.isTestNode);

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <Text style={styles.title}>Smart-Home Loads</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.introCard}>
        <Ionicons name="home" size={20} color="#1e40af" />
        <Text style={styles.introText}>
          Matter appliances the controller last reported to the platform. Reachable is not the same
          as controlled, and controlled is not the same as measured.
        </Text>
      </View>

      {nodesQuery.isLoading ? (
        <Text style={styles.emptyText}>Loading fabric…</Text>
      ) : nodesQuery.isError ? (
        <View style={styles.card}>
          {/* A failed read is an outage, never an empty fabric. */}
          <Text style={styles.emptyText}>
            {nodesQuery.error?.message || 'Could not read the Matter fabric'}
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.summaryRow}>
            <View style={styles.summaryCell}>
              <Text style={styles.summaryValue}>{controllable.length}</Text>
              <Text style={styles.summaryLabel}>Controllable</Text>
            </View>
            <View style={styles.summaryCell}>
              <Text style={styles.summaryValue}>{unverifiable.length}</Text>
              <Text style={styles.summaryLabel}>Cannot be verified</Text>
            </View>
            <View style={styles.summaryCell}>
              <Text style={styles.summaryValue}>{synthetic.length}</Text>
              <Text style={styles.summaryLabel}>Synthetic nodes</Text>
            </View>
          </View>

          {unverifiable.length > 0 && (
            <View style={styles.warnCard}>
              <Text style={styles.warnText}>
                {unverifiable.length} load(s) can be commanded and have reported no measurement, so a
                dispatch to them cannot be shown to have happened.
              </Text>
            </View>
          )}

          {nodes.length === 0 ? (
            <View style={styles.card}>
              <Text style={styles.emptyText}>
                No Matter node has been reported. The platform has no Matter stack of its own:
                without a controller connected there is nothing to show and nothing to command.
              </Text>
            </View>
          ) : (
            nodes.map(node => {
              const state = verdict(node);
              return (
                <View key={node.id} style={styles.card}>
                  <View style={styles.cardHeader}>
                    <Text style={styles.target}>Node {node.nodeId}</Text>
                    <Chip label={state.label} tone={state.tone} />
                  </View>
                  <Text style={styles.meaning}>{state.meaning}</Text>

                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Controls</Text>
                    <Text style={styles.detailValue}>
                      {node.capabilities.length === 0
                        ? 'None published'
                        : node.capabilities
                            .map(
                              capability =>
                                (capability.cluster ? CLUSTER_LABEL[capability.cluster] : null) ??
                                `Cluster ${capability.clusterId}`
                            )
                            .join(', ')}
                    </Text>
                  </View>
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Measured power</Text>
                    <Text style={styles.detailValue}>
                      {formatMeasurement(measuredWatts(node), 'W')}
                    </Text>
                  </View>
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Measured energy</Text>
                    <Text style={styles.detailValue}>
                      {formatMeasurement(measuredEnergyWh(node), 'Wh')}
                    </Text>
                  </View>
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Last report</Text>
                    <Text style={styles.detailValue}>
                      {new Date(node.lastReportedAt).toLocaleString()}
                    </Text>
                  </View>
                </View>
              );
            })
          )}
        </>
      )}
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
  summaryRow: { flexDirection: 'row', marginHorizontal: 16, gap: 8 },
  summaryCell: {
    flex: 1,
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#ffffff',
    alignItems: 'center',
  },
  summaryValue: { fontSize: 20, fontWeight: '700', color: '#111827' },
  summaryLabel: { fontSize: 11, color: '#6b7280', textAlign: 'center' },
  warnCard: {
    margin: 16,
    marginBottom: 0,
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#fef3c7',
  },
  warnText: { fontSize: 12, color: '#92400e', lineHeight: 17 },
  card: {
    margin: 16,
    marginBottom: 0,
    padding: 14,
    borderRadius: 10,
    backgroundColor: '#ffffff',
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  target: { fontSize: 15, fontWeight: '600', color: '#111827' },
  meaning: { fontSize: 12, color: '#6b7280', marginTop: 6, lineHeight: 17 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  detailLabel: { fontSize: 12, color: '#6b7280' },
  detailValue: { fontSize: 12, color: '#111827', fontWeight: '500', flexShrink: 1, textAlign: 'right' },
  chip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  chipText: { fontSize: 11, fontWeight: '600' },
  emptyText: { fontSize: 13, color: '#6b7280', textAlign: 'center', padding: 16 },
});
