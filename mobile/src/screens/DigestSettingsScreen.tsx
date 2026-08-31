import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  Switch,
  RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { trpc } from '../services/trpc';
import { HapticService } from '../services/hapticService';

type Channel = 'email' | 'sms';

const formatKwh = (wh: number | null | undefined) =>
  wh == null ? 'no data' : `${(wh / 1000).toFixed(2)} kWh`;

const formatDate = (d: unknown) => (d ? new Date(d as string).toLocaleDateString() : '—');

export default function DigestSettingsScreen({ navigation }: any) {
  const [refreshing, setRefreshing] = useState(false);

  const utils = trpc.useUtils();

  const subsQuery = trpc.digest.mySubscriptions.useQuery();
  const subs = subsQuery.data ?? [];

  const runsQuery = trpc.digest.myRuns.useQuery({ limit: 12 });
  const runs = runsQuery.data ?? [];

  const previewQuery = trpc.digest.preview.useQuery();
  const preview = previewQuery.data ?? null;

  const subscribeMutation = trpc.digest.subscribe.useMutation({
    onSuccess: async () => {
      await HapticService.success();
      utils.digest.mySubscriptions.invalidate();
    },
    onError: async (error) => {
      await HapticService.error();
      Alert.alert('Could Not Subscribe', error.message);
    },
  });

  const unsubscribeMutation = trpc.digest.unsubscribe.useMutation({
    onSuccess: async () => {
      await HapticService.success();
      utils.digest.mySubscriptions.invalidate();
    },
    onError: async (error) => {
      await HapticService.error();
      Alert.alert('Error', error.message);
    },
  });

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await Promise.all([subsQuery.refetch(), runsQuery.refetch(), previewQuery.refetch()]);
    setRefreshing(false);
  };

  const isEnabled = (channel: Channel) =>
    subs.some((s) => s.channel === channel && s.enabled);

  const handleToggle = (channel: Channel, value: boolean) => {
    if (value) {
      subscribeMutation.mutate({ channel });
    } else {
      unsubscribeMutation.mutate({ channel });
    }
  };

  const busy = subscribeMutation.isPending || unsubscribeMutation.isPending;

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <Text style={styles.title}>Weekly Digest</Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Subscriptions */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Subscriptions</Text>
        <Text style={styles.bodyText}>
          A weekly summary of your real consumption, generation, payments and vended
          tokens, dispatched by the platform scheduler.
        </Text>
        {subsQuery.isLoading ? (
          <Text style={styles.emptyText}>Loading subscriptions…</Text>
        ) : subsQuery.isError ? (
          <Text style={styles.emptyText}>Could not load subscriptions</Text>
        ) : (
          <>
            <View style={styles.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.switchLabel}>Email digest</Text>
                <Text style={styles.switchHint}>Requires an email address on file</Text>
              </View>
              <Switch
                value={isEnabled('email')}
                onValueChange={(v) => handleToggle('email', v)}
                disabled={busy}
                trackColor={{ false: '#d1d5db', true: '#10b981' }}
              />
            </View>
            <View style={styles.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.switchLabel}>SMS digest</Text>
                <Text style={styles.switchHint}>Requires a phone number on file</Text>
              </View>
              <Switch
                value={isEnabled('sms')}
                onValueChange={(v) => handleToggle('sms', v)}
                disabled={busy}
                trackColor={{ false: '#d1d5db', true: '#10b981' }}
              />
            </View>
          </>
        )}
      </View>

      {/* This week so far */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>This Week So Far</Text>
        {previewQuery.isLoading ? (
          <Text style={styles.emptyText}>Compiling stats…</Text>
        ) : previewQuery.isError ? (
          <Text style={styles.emptyText}>Could not compile this week's stats</Text>
        ) : preview == null ? (
          <Text style={styles.emptyText}>No stats available.</Text>
        ) : (
          <>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Consumption</Text>
              <Text style={styles.detailValue}>{formatKwh(preview.consumptionWh)}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Solar generation</Text>
              <Text style={styles.detailValue}>{formatKwh(preview.generationWh)}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Payments completed</Text>
              <Text style={styles.detailValue}>
                {preview.payments.length === 0
                  ? 'none'
                  : preview.payments
                      .map((p) => `${(p.totalCents / 100).toFixed(2)} ${p.currency} (${p.count})`)
                      .join(', ')}
              </Text>
            </View>
            <View style={[styles.detailRow, { borderBottomWidth: 0 }]}>
              <Text style={styles.detailLabel}>Prepaid tokens vended</Text>
              <Text style={styles.detailValue}>
                {preview.tokens.count === 0
                  ? 'none'
                  : `${preview.tokens.count} (${preview.tokens.totalEnergyKwh} kWh)`}
              </Text>
            </View>
          </>
        )}
      </View>

      {/* Run history */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Dispatch History</Text>
        {runsQuery.isLoading ? (
          <Text style={styles.emptyText}>Loading history…</Text>
        ) : runsQuery.isError ? (
          <Text style={styles.emptyText}>Could not load dispatch history</Text>
        ) : runs.length === 0 ? (
          <Text style={styles.emptyText}>
            No digest runs yet. Runs are recorded each week for enabled subscriptions.
          </Text>
        ) : (
          runs.map((r) => (
            <View key={r.id} style={styles.runRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.runTitle}>
                  {r.channel} · week of {formatDate(r.periodStart)}
                </Text>
                <Text style={styles.runMeta}>
                  {r.sentAt
                    ? `Sent ${new Date(r.sentAt).toLocaleString()}`
                    : formatDate(r.createdAt)}
                </Text>
                {r.error ? (
                  <Text style={styles.runError} numberOfLines={2}>
                    {r.error}
                  </Text>
                ) : null}
              </View>
              <View
                style={[
                  styles.statusChip,
                  r.status === 'sent' && styles.statusSent,
                  r.status === 'failed' && styles.statusFailed,
                  r.status === 'skipped' && styles.statusSkipped,
                ]}
              >
                <Text style={styles.statusChipText}>{r.status}</Text>
              </View>
            </View>
          ))
        )}
      </View>

      <View style={{ height: 24 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
    padding: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
    marginTop: 8,
  },
  backButton: {
    padding: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#111827',
  },
  card: {
    backgroundColor: 'white',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 12,
  },
  bodyText: {
    fontSize: 14,
    color: '#6b7280',
    lineHeight: 20,
    marginBottom: 12,
  },
  emptyText: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
    paddingVertical: 12,
    lineHeight: 20,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    gap: 8,
  },
  switchLabel: {
    fontSize: 16,
    color: '#111827',
  },
  switchHint: {
    fontSize: 12,
    color: '#9ca3af',
    marginTop: 2,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    gap: 8,
  },
  detailLabel: {
    fontSize: 14,
    color: '#6b7280',
    flexShrink: 1,
  },
  detailValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
    textAlign: 'right',
    flexShrink: 1,
  },
  runRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    gap: 8,
  },
  runTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
  },
  runMeta: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 2,
  },
  runError: {
    fontSize: 12,
    color: '#dc2626',
    marginTop: 2,
  },
  statusChip: {
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  statusSent: {
    backgroundColor: '#d1fae5',
  },
  statusFailed: {
    backgroundColor: '#fee2e2',
  },
  statusSkipped: {
    backgroundColor: '#fef3c7',
  },
  statusChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#111827',
  },
});
