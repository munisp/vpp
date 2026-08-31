/**
 * The member's own equipment, drawn as a vertical single-line diagram.
 *
 * Same rules as the web twin, and for the same reason: a phone screen showing a
 * tidy list of components with numbers next to them is read as "everything is
 * fine". So a component that has not reported inside its expected interval is
 * marked stale with the age of its last reading, a component that has never
 * reported says exactly that, and nothing is filled in with a zero. The measured
 * total is labelled as covering only the components that reported.
 */

import React, { useCallback } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { EvidenceState, TwinEdge, TwinNode } from '../../../shared/digital-twin';
import { trpc } from '../services/trpc';

type Evidence = EvidenceState;

const EVIDENCE_COLOR: Record<Evidence, { bg: string; fg: string; line: string }> = {
  measured: { bg: '#cffafe', fg: '#155e75', line: '#06b6d4' },
  stale: { bg: '#fef3c7', fg: '#92400e', line: '#f59e0b' },
  never: { bg: '#f3f4f6', fg: '#4b5563', line: '#9ca3af' },
};

const EVIDENCE_LABEL: Record<Evidence, string> = {
  measured: 'reporting',
  stale: 'stale',
  never: 'never reported',
};

const KIND_ICON: Record<string, keyof typeof Ionicons.glyphMap> = {
  grid: 'git-network-outline',
  site: 'business-outline',
  solar: 'sunny-outline',
  wind: 'flag-outline',
  battery: 'battery-half-outline',
  meter: 'speedometer-outline',
  generator: 'flame-outline',
  ev_charger: 'car-outline',
  load: 'flash-outline',
  other: 'help-circle-outline',
};

function watts(value: number | null): string | null {
  if (value === null) return null;
  const kilowatts = value / 1000;
  if (Math.abs(kilowatts) >= 1) return `${kilowatts.toFixed(1)} kW`;
  return `${Math.round(value)} W`;
}

function age(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/**
 * The measured companions of a power reading, joined for one line. The server
 * nulls every one of these unless the node is currently measured, so nothing
 * here is ever a fabricated zero.
 */
function readings(node: TwinNode): string | null {
  const parts: string[] = [];
  if (node.voltageVolts != null) parts.push(`${node.voltageVolts.toFixed(1)} V`);
  if (node.frequencyHz != null) parts.push(`${node.frequencyHz.toFixed(2)} Hz`);
  if (node.temperatureCelsius != null) parts.push(`${node.temperatureCelsius.toFixed(1)} °C`);
  if (node.energyWh != null) {
    parts.push(
      Math.abs(node.energyWh) >= 1000
        ? `${(node.energyWh / 1000).toFixed(1)} kWh`
        : `${Math.round(node.energyWh)} Wh`
    );
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

const DIRECTION_COPY: Record<TwinEdge['direction'], string> = {
  in: 'into the bus',
  out: 'out of the bus',
  idle: 'measured zero',
  unknown: 'flow unknown',
};

function Chip({ label, evidence }: { label: string; evidence: Evidence }) {
  const color = EVIDENCE_COLOR[evidence];
  return (
    <View style={[styles.chip, { backgroundColor: color.bg }]}>
      <Text style={[styles.chipText, { color: color.fg }]}>{label}</Text>
    </View>
  );
}

function NodeCard({ node, edge }: { node: TwinNode; edge?: TwinEdge }) {
  const color = EVIDENCE_COLOR[node.evidence];
  const power = watts(node.powerWatts);
  const last = watts(node.lastPowerWatts);
  const icon = KIND_ICON[node.kind] ?? KIND_ICON.other;
  // A pending asset is drawn dashed: its place in the plant is unconfirmed.
  const pending = node.approvalStatus === 'pending';
  const measuredReadings = node.evidence === 'measured' ? readings(node) : null;

  return (
    <View style={styles.nodeRow}>
      <View style={[styles.connector, { backgroundColor: color.line }]} />
      <View
        style={[
          styles.nodeCard,
          { borderColor: color.line },
          pending ? styles.nodeCardPending : null,
        ]}
      >
        <View style={styles.nodeHeader}>
          <Ionicons name={icon} size={18} color={color.fg} />
          <Text style={styles.nodeLabel} numberOfLines={1}>
            {node.label}
          </Text>
          {pending ? <Chip label="not yet approved" evidence="stale" /> : null}
          <Chip label={EVIDENCE_LABEL[node.evidence]} evidence={node.evidence} />
        </View>

        <Text style={styles.nodeValue}>
          {node.evidence === 'measured'
            ? (power ?? 'no power reading')
            : node.evidence === 'stale'
              ? `${last ?? 'no reading'} · ${age(node.ageSeconds) ?? 'age unknown'}`
              : 'no telemetry on record'}
          {node.stateOfChargePercent !== null
            ? ` · ${node.stateOfChargePercent.toFixed(0)}% SoC`
            : ''}
        </Text>

        {measuredReadings ? <Text style={styles.nodeReadings}>{measuredReadings}</Text> : null}

        {edge ? (
          <Text style={styles.nodeFlow}>
            {edge.flowWatts === null
              ? DIRECTION_COPY[edge.direction]
              : `${watts(edge.flowWatts)} ${DIRECTION_COPY[edge.direction]}`}
            {edge.animated ? ' · measured now' : ''}
          </Text>
        ) : null}

        <Text style={styles.nodeDetail}>{node.detail}</Text>

        {node.assetId !== undefined ? (
          <Text style={styles.nodeMeta}>
            rated {watts(node.capacity) ?? 'unknown'} ·{' '}
            {node.devices.length === 0
              ? 'no device registered'
              : node.devices
                  .map(device => `${device.deviceType}${device.enabled ? '' : ' (disabled)'}`)
                  .join(', ')}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export default function DigitalTwinScreen() {
  const twin = trpc.digitalTwin.mine.useQuery(undefined, { refetchInterval: 30_000 });

  const onRefresh = useCallback(() => {
    void twin.refetch();
  }, [twin]);

  if (twin.isLoading) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator size="large" color="#06b6d4" />
        <Text style={styles.centreText}>Reading your equipment</Text>
      </View>
    );
  }

  if (twin.isError || !twin.data) {
    return (
      <View style={styles.centre}>
        <Ionicons name="alert-circle-outline" size={32} color="#991b1b" />
        <Text style={styles.errorTitle}>The twin could not be read</Text>
        <Text style={styles.errorBody}>
          {twin.error?.message ??
            'No diagram is shown. Treat your equipment state as unknown, not as idle.'}
        </Text>
      </View>
    );
  }

  const graph = twin.data;
  const nodes: TwinNode[] = graph.nodes;
  const edges: TwinEdge[] = graph.edges;
  /**
   * A boundary meter has two edges: one into the bus like any asset, and the
   * `edge:grid:` edge that actually carries the measured grid exchange. The
   * grid edge is the one that says what the meter is for, so it wins.
   */
  const edgeFor = (node: TwinNode) => {
    if (node.kind === 'meter' && node.assetId !== undefined) {
      return (
        edges.find(edge => edge.id === `edge:grid:${node.assetId}`) ??
        edges.find(edge => edge.from === node.id || edge.to === node.id)
      );
    }
    return edges.find(edge => edge.from === node.id || edge.to === node.id);
  };

  const grid = nodes.filter(node => node.kind === 'grid');
  const site = nodes.filter(node => node.kind === 'site');
  const assets = nodes.filter(node => node.assetId !== undefined);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={twin.isFetching} onRefresh={onRefresh} />}
    >
      <Text style={styles.title}>Digital twin</Text>
      <Text style={styles.subtitle}>
        Built from the latest telemetry row each component wrote. A flow shown here is a
        measurement the platform received, not confirmation that the device obeyed.
      </Text>

      <View style={styles.summary}>
        <View style={styles.summaryTile}>
          <Text style={styles.summaryLabel}>Net behind the meter</Text>
          <Text style={styles.summaryValue}>
            {graph.measuredBehindMeter > 0 ? watts(graph.measuredNetPowerWatts) : 'unknown'}
          </Text>
          <Text style={styles.summaryMeta}>
            {graph.coverage.measured}/{graph.coverage.assets} components reporting; meters measure
            the boundary and are not added in
          </Text>
        </View>
        <View style={styles.summaryTile}>
          <Text style={styles.summaryLabel}>Grid exchange</Text>
          <Text style={styles.summaryValue}>
            {graph.meteredGridPowerWatts === null
              ? 'unknown'
              : watts(graph.meteredGridPowerWatts)}
          </Text>
          <Text style={styles.summaryMeta}>
            {graph.meteredGridPowerWatts === null
              ? 'no meter is reporting, so import and export are unknown, not zero'
              : 'measured at the meter'}
          </Text>
        </View>
        <View style={styles.summaryTile}>
          <Text style={styles.summaryLabel}>Not currently seen</Text>
          <Text style={styles.summaryValue}>
            {graph.coverage.stale + graph.coverage.neverObserved}
          </Text>
          <Text style={styles.summaryMeta}>
            {graph.coverage.stale} stale · {graph.coverage.neverObserved} never reported ·{' '}
            {watts(graph.coverage.unseenCapacity) ?? '0 W'} unseen
          </Text>
        </View>
      </View>

      {grid.concat(site).map(node => (
        <NodeCard key={node.id} node={node} edge={edgeFor(node)} />
      ))}

      <Text style={styles.sectionTitle}>Equipment</Text>
      {assets.length === 0 ? (
        <Text style={styles.empty}>
          No equipment is registered against your account, so there is nothing to draw.
        </Text>
      ) : (
        assets.map(node => <NodeCard key={node.id} node={node} edge={edgeFor(node)} />)
      )}

      <Text style={styles.caveat}>{graph.caveat}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f8fafc' },
  content: { padding: 16, paddingBottom: 40 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  centreText: { marginTop: 12, color: '#475569' },
  errorTitle: { marginTop: 12, fontSize: 16, fontWeight: '700', color: '#991b1b' },
  errorBody: { marginTop: 6, textAlign: 'center', color: '#7f1d1d' },
  title: { fontSize: 24, fontWeight: '700', color: '#0f172a' },
  subtitle: { marginTop: 6, fontSize: 13, lineHeight: 18, color: '#475569' },
  summary: { flexDirection: 'row', gap: 12, marginTop: 16 },
  summaryTile: {
    flex: 1,
    backgroundColor: '#ffffff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 12,
  },
  summaryLabel: { fontSize: 11, textTransform: 'uppercase', color: '#64748b', letterSpacing: 0.5 },
  summaryValue: { marginTop: 4, fontSize: 20, fontWeight: '700', color: '#0f172a' },
  summaryMeta: { marginTop: 4, fontSize: 11, color: '#64748b' },
  sectionTitle: {
    marginTop: 20,
    marginBottom: 4,
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: '#475569',
  },
  nodeRow: { flexDirection: 'row', marginTop: 12 },
  connector: { width: 3, borderRadius: 2, marginRight: 10 },
  nodeCard: {
    flex: 1,
    backgroundColor: '#ffffff',
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
  },
  nodeCardPending: { borderStyle: 'dashed' },
  nodeReadings: { marginTop: 2, fontSize: 12, color: '#475569' },
  nodeHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  nodeLabel: { flex: 1, fontSize: 15, fontWeight: '600', color: '#0f172a' },
  nodeValue: { marginTop: 8, fontSize: 16, fontWeight: '600', color: '#0f172a' },
  nodeFlow: { marginTop: 2, fontSize: 12, color: '#155e75' },
  nodeDetail: { marginTop: 6, fontSize: 12, lineHeight: 17, color: '#64748b' },
  nodeMeta: { marginTop: 6, fontSize: 11, color: '#94a3b8' },
  chip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  chipText: { fontSize: 11, fontWeight: '600' },
  empty: { fontSize: 13, color: '#64748b' },
  caveat: {
    marginTop: 20,
    fontSize: 12,
    lineHeight: 18,
    color: '#475569',
    fontStyle: 'italic',
  },
});
