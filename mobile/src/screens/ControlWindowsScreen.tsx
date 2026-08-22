/**
 * "Who is controlling my devices right now, and until when."
 *
 * The owner-facing half of bounded control. Every card says what the platform
 * can prove: a command the MQTT broker took but the device never acknowledged
 * reads as unconfirmed, and a window that closed without its fallback landing is
 * shown in red rather than quietly disappearing from the list.
 */

import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { trpc } from '../services/trpc';
import { HapticService } from '../services/hapticService';

type Tone = 'live' | 'warning' | 'danger' | 'neutral';

const TONE_COLOR: Record<Tone, { bg: string; fg: string }> = {
  live: { bg: '#d1fae5', fg: '#065f46' },
  warning: { bg: '#fef3c7', fg: '#92400e' },
  danger: { bg: '#fee2e2', fg: '#991b1b' },
  neutral: { bg: '#f3f4f6', fg: '#374151' },
};

const STATE_COPY: Record<string, { label: string; tone: Tone; meaning: string }> = {
  active: { label: 'Active', tone: 'live', meaning: 'Inside a maintained control window.' },
  expiring: {
    label: 'Expiring',
    tone: 'warning',
    meaning: 'Closes shortly; without a refresh the fallback runs.',
  },
  scheduled: {
    label: 'Scheduled',
    tone: 'neutral',
    meaning: 'Accepted by the device; the window has not opened yet.',
  },
  expired_awaiting_fallback: {
    label: 'Expired — fallback pending',
    tone: 'danger',
    meaning: 'The window closed and the fallback has not been delivered yet.',
  },
  fallback_applied: {
    label: 'Fallback applied',
    tone: 'neutral',
    meaning: 'The device returned to its fallback behaviour.',
  },
  fallback_failed: {
    label: 'Fallback failed',
    tone: 'danger',
    meaning: 'The fallback was refused or unconfirmed; the asset may still hold the expired setpoint.',
  },
  held_past_window: {
    label: 'Held past window',
    tone: 'warning',
    meaning: 'hold_last: the expired setpoint is still running. This is not a safe state.',
  },
  rejected: {
    label: 'Rejected',
    tone: 'neutral',
    meaning: 'The device refused the command; nothing was applied.',
  },
  no_control: {
    label: 'Superseded',
    tone: 'neutral',
    meaning: 'Replaced by a later control for the same device.',
  },
};

const DELIVERY_COPY: Record<string, { label: string; tone: Tone }> = {
  accepted: { label: 'Device confirmed', tone: 'live' },
  broker_queued: { label: 'Sent, unconfirmed by device', tone: 'warning' },
  unconfirmed: { label: 'Delivery unknown', tone: 'danger' },
  rejected: { label: 'Refused', tone: 'neutral' },
};

const FALLBACK_COPY: Record<string, string> = {
  safe_limit: 'Falls back to a fixed safe limit',
  resume_local: 'Falls back to the device’s own local control',
  hold_last: 'Keeps the last setpoint — not a safe state',
};

function remaining(validTo: string | Date): string {
  const seconds = Math.round((new Date(validTo).getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  const parts = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  return seconds < 0 ? `${parts} overdue` : `${parts} left`;
}

function power(watts: number | null | undefined): string {
  if (watts == null) return '—';
  const kw = (watts / 1000).toFixed(2);
  return watts > 0 ? `${kw} kW export` : watts < 0 ? `${kw} kW import` : '0 kW idle';
}

function Chip({ label, tone }: { label: string; tone: Tone }) {
  const color = TONE_COLOR[tone];
  return (
    <View style={[styles.chip, { backgroundColor: color.bg }]}>
      <Text style={[styles.chipText, { color: color.fg }]}>{label}</Text>
    </View>
  );
}

export default function ControlWindowsScreen({ navigation }: any) {
  const [refreshing, setRefreshing] = useState(false);
  const [, setTick] = useState(0);

  const policyQuery = trpc.controlWindows.policy.useQuery();
  const minesQuery = trpc.controlWindows.mine.useQuery({ limit: 25 }, { refetchInterval: 15000 });

  // Local tick so the countdown keeps moving between refetches instead of
  // showing a stale "5m left" on a window that has already closed.
  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await Promise.all([policyQuery.refetch(), minesQuery.refetch()]);
    setRefreshing(false);
  };

  const rows = minesQuery.data?.assignments ?? [];
  const policy = policyQuery.data;

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <Text style={styles.title}>Control Windows</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.introCard}>
        <Ionicons name="information-circle" size={20} color="#1e40af" />
        <Text style={styles.introText}>
          Every command the platform sends your hardware expires. If the platform goes quiet, your
          device falls back on its own — it never keeps an old target forever.
          {policy
            ? ` Windows here last between ${Math.round(policy.minValiditySeconds / 60)} and ${Math.round(
                policy.maxValiditySeconds / 60
              )} minutes.`
            : ''}
        </Text>
      </View>

      {minesQuery.isLoading ? (
        <Text style={styles.emptyText}>Loading your controls…</Text>
      ) : minesQuery.isError ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            {minesQuery.error?.message || 'Could not load control windows'}
          </Text>
        </View>
      ) : rows.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            No platform control is running on your assets. They are following their own local logic.
          </Text>
        </View>
      ) : (
        rows.map((row: any) => {
          const a = row.assignment;
          const state = STATE_COPY[row.state] ?? {
            label: row.state,
            tone: 'neutral' as Tone,
            meaning: '',
          };
          const delivery = DELIVERY_COPY[a.delivery] ?? {
            label: a.delivery,
            tone: 'neutral' as Tone,
          };
          return (
            <View key={a.id} style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.target}>
                  {a.targetRef}
                  {a.subTargetRef ? `:${a.subTargetRef}` : ''}
                </Text>
                <Chip label={state.label} tone={state.tone} />
              </View>
              <Text style={styles.protocol}>
                {String(a.protocol).toUpperCase()} · {String(a.source).replace(/_/g, ' ')}
              </Text>

              <View style={styles.metricsRow}>
                <View style={styles.metric}>
                  <Text style={styles.metricLabel}>Setpoint</Text>
                  <Text style={styles.metricValue}>{power(a.setpointWatts)}</Text>
                </View>
                <View style={styles.metric}>
                  <Text style={styles.metricLabel}>Window</Text>
                  <Text style={styles.metricValue}>{remaining(a.validTo)}</Text>
                </View>
              </View>

              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Delivery</Text>
                <Chip label={delivery.label} tone={delivery.tone} />
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>When it expires</Text>
                <Text style={styles.detailValue}>
                  {FALLBACK_COPY[a.fallbackPolicy] ?? a.fallbackPolicy}
                </Text>
              </View>
              {a.fallbackPolicy === 'safe_limit' && (
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Safe limit</Text>
                  <Text style={styles.detailValue}>{power(a.fallbackLimitWatts)}</Text>
                </View>
              )}

              {state.meaning ? <Text style={styles.meaning}>{state.meaning}</Text> : null}
              {a.fallbackDetail ? <Text style={styles.meaning}>{a.fallbackDetail}</Text> : null}
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
  card: {
    marginHorizontal: 16,
    marginTop: 8,
    padding: 16,
    borderRadius: 12,
    backgroundColor: '#ffffff',
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  target: { fontSize: 15, fontWeight: '700', color: '#111827', flex: 1, marginRight: 8 },
  protocol: { fontSize: 11, color: '#6b7280', marginTop: 2, textTransform: 'uppercase' },
  metricsRow: { flexDirection: 'row', gap: 12, marginTop: 12 },
  metric: { flex: 1, backgroundColor: '#f9fafb', borderRadius: 8, padding: 10 },
  metricLabel: { fontSize: 11, color: '#6b7280' },
  metricValue: { fontSize: 15, fontWeight: '600', color: '#111827', marginTop: 2 },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  detailLabel: { fontSize: 12, color: '#6b7280' },
  detailValue: { fontSize: 12, color: '#111827', fontWeight: '500', flexShrink: 1, textAlign: 'right' },
  meaning: { fontSize: 12, color: '#6b7280', marginTop: 10, lineHeight: 17 },
  chip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  chipText: { fontSize: 11, fontWeight: '600' },
  emptyText: { fontSize: 13, color: '#6b7280', textAlign: 'center', padding: 8 },
});
