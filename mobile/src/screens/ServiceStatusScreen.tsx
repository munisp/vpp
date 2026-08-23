/**
 * "Is the platform able to do what it says right now?"
 *
 * A member sees two things here: whether their earnings can be measured, and
 * whether a control sent to their asset can be confirmed. An operator in the
 * field additionally sees each dependency by the last real call made to it.
 *
 * The failure this screen guards against is a quiet green dashboard: a
 * dependency nobody has called is drawn as unobserved, never as healthy, and a
 * failed read of this screen is an outage rather than an all-clear.
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

const DEPENDENCY_LABEL: Record<string, string> = {
  optimizer: 'Dispatch optimizer',
  mqtt_broker: 'MQTT broker',
  grid_protocols: 'Grid protocol service',
  matter_controller: 'Matter controller',
  payment_gateway: 'Payment gateway',
  market_broker: 'Market broker',
  meter_telemetry: 'Meter telemetry',
};

const STATE_COPY: Record<string, { label: string; tone: Tone; meaning: string }> = {
  up: {
    label: 'Answering',
    tone: 'good',
    meaning: 'A real call to it succeeded recently.',
  },
  down: {
    label: 'Outage',
    tone: 'danger',
    meaning: 'Consecutive calls failed, so an outage is open until one succeeds.',
  },
  unknown: {
    label: 'Unobserved',
    tone: 'warning',
    meaning:
      'No recent successful call. Silence is not health, so anything needing this evidence is held back.',
  },
};

const POSTURE_COPY: Record<string, { label: string; tone: Tone }> = {
  available: { label: 'Normal', tone: 'good' },
  degraded: { label: 'Unverified', tone: 'warning' },
  refused: { label: 'Paused', tone: 'danger' },
};

interface Posture {
  dependency: string;
  state: string;
  lastObservation: { operation: string; observedAt: string } | null;
  stalenessSeconds: number;
  reason: string;
}

interface Action {
  id: number;
  capability: string;
  subject: string;
  missingDependencies: string[];
  evidenceLimit: string;
  actedAt: string;
}

function Chip({ label, tone }: { label: string; tone: Tone }) {
  const color = TONE_COLOR[tone];
  return (
    <View style={[styles.chip, { backgroundColor: color.bg }]}>
      <Text style={[styles.chipText, { color: color.fg }]}>{label}</Text>
    </View>
  );
}

function formatAge(observedAt: string | null): string {
  if (!observedAt) return 'never';
  const seconds = Math.max(0, (Date.now() - new Date(observedAt).getTime()) / 1000);
  if (seconds < 90) return `${Math.round(seconds)}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export default function ServiceStatusScreen({ navigation }: any) {
  const [refreshing, setRefreshing] = useState(false);
  const { data: currentUser } = trpc.auth.me.useQuery();
  const isAdmin = currentUser?.role === 'admin';

  const memberStatus = trpc.degradedOperation.memberStatus.useQuery();
  const posture = trpc.degradedOperation.posture.useQuery(undefined, { enabled: isAdmin });
  const actions = trpc.degradedOperation.openActions.useQuery(undefined, { enabled: isAdmin });

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await Promise.all([
      memberStatus.refetch(),
      isAdmin ? posture.refetch() : Promise.resolve(),
      isAdmin ? actions.refetch() : Promise.resolve(),
    ]);
    setRefreshing(false);
  };

  const dependencies = (posture.data?.dependencies ?? []) as unknown as Posture[];
  const openActions = (actions.data?.actions ?? []) as unknown as Action[];
  const settlement = memberStatus.data?.settlement;
  const control = memberStatus.data?.control;

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <Text style={styles.title}>Service Status</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.introCard}>
        <Ionicons name="pulse" size={20} color="#1e40af" />
        <Text style={styles.introText}>
          What the platform can currently prove. Where it cannot measure something, it pauses that
          part rather than showing a figure that looks measured.
        </Text>
      </View>

      {memberStatus.isError ? (
        <View style={styles.card}>
          {/* A failed read is an outage, never an all-clear. */}
          <Text style={styles.emptyText}>
            {memberStatus.error?.message || 'Could not read service status'}
          </Text>
        </View>
      ) : memberStatus.isLoading ? (
        <Text style={styles.emptyText}>Loading status…</Text>
      ) : (
        <>
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.target}>Earnings measurement</Text>
              <Chip
                label={POSTURE_COPY[settlement?.posture ?? 'refused'].label}
                tone={POSTURE_COPY[settlement?.posture ?? 'refused'].tone}
              />
            </View>
            <Text style={styles.meaning}>
              {settlement?.limitation ??
                'Delivered energy is being measured from your meter as normal.'}
            </Text>
          </View>

          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.target}>Asset controls</Text>
              <Chip
                label={POSTURE_COPY[control?.posture ?? 'refused'].label}
                tone={POSTURE_COPY[control?.posture ?? 'refused'].tone}
              />
            </View>
            <Text style={styles.meaning}>
              {control?.limitation ??
                'Controls are being delivered and their effect confirmed as normal.'}
            </Text>
          </View>
        </>
      )}

      {isAdmin && (
        <>
          <Text style={styles.sectionTitle}>Dependencies</Text>
          {posture.isError ? (
            <View style={styles.card}>
              <Text style={styles.emptyText}>
                {posture.error?.message || 'Could not read dependency posture'}
              </Text>
            </View>
          ) : (
            dependencies.map(dependency => {
              const copy = STATE_COPY[dependency.state] ?? STATE_COPY.unknown;
              return (
                <View key={dependency.dependency} style={styles.card}>
                  <View style={styles.cardHeader}>
                    <Text style={styles.target}>
                      {DEPENDENCY_LABEL[dependency.dependency] ?? dependency.dependency}
                    </Text>
                    <Chip label={copy.label} tone={copy.tone} />
                  </View>
                  <Text style={styles.meaning}>{copy.meaning}</Text>
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Last call</Text>
                    <Text style={styles.detailValue}>
                      {dependency.lastObservation
                        ? `${dependency.lastObservation.operation} · ${formatAge(dependency.lastObservation.observedAt)}`
                        : 'None recorded'}
                    </Text>
                  </View>
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Unobserved after</Text>
                    <Text style={styles.detailValue}>
                      {Math.round(dependency.stalenessSeconds / 60)}m
                    </Text>
                  </View>
                </View>
              );
            })
          )}

          <Text style={styles.sectionTitle}>
            Actions taken without evidence ({openActions.length})
          </Text>
          {openActions.length === 0 ? (
            <View style={styles.card}>
              <Text style={styles.emptyText}>
                Nothing outstanding. Reconciling an action needs a written note, so that is done from
                the operator console.
              </Text>
            </View>
          ) : (
            openActions.map(action => (
              <View key={action.id} style={styles.warnCard}>
                <Text style={styles.warnTitle}>{action.capability}</Text>
                <Text style={styles.warnText}>{action.subject}</Text>
                <Text style={styles.warnText}>{action.evidenceLimit}</Text>
                <Text style={styles.warnMeta}>
                  {new Date(action.actedAt).toLocaleString()} ·{' '}
                  {action.missingDependencies
                    .map(dependency => DEPENDENCY_LABEL[dependency] ?? dependency)
                    .join(', ')}
                </Text>
              </View>
            ))
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
  card: {
    margin: 16,
    marginBottom: 0,
    padding: 14,
    borderRadius: 10,
    backgroundColor: '#ffffff',
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
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
  warnCard: {
    margin: 16,
    marginBottom: 0,
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#fef3c7',
  },
  warnTitle: { fontSize: 13, fontWeight: '600', color: '#92400e' },
  warnText: { fontSize: 12, color: '#92400e', lineHeight: 17, marginTop: 4 },
  warnMeta: { fontSize: 11, color: '#a16207', marginTop: 6 },
  chip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  chipText: { fontSize: 11, fontWeight: '600' },
  emptyText: { fontSize: 13, color: '#6b7280', textAlign: 'center', padding: 16 },
});
