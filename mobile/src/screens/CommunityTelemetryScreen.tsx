/**
 * "What your community's shared profile looks like, and how much of it we saw."
 *
 * Members are shown the same aggregate an operator sees for their community, with
 * the same honesty rules: a bucket that half the community skipped says so, a
 * battery that reported no state of charge contributes nothing to stored energy,
 * an unelapsed bucket is marked as still filling, and buckets the rollup never
 * computed are reported as a gap in the rollup rather than as a quiet community.
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

const BUCKET_MINUTES = 15;
const BUCKETS = 24;

interface Bucket {
  bucketStartsAt: Date;
  bucketMinutes: number;
  state: 'open' | 'closed';
  meanNetPowerWatts: number;
  integratedEnergyWh: number;
  expectedAssets: number;
  reportingAssets: number;
  silentAssets: number;
  samples: number;
  reportingCapacityWh: number;
  silentCapacityWh: number;
  socKnownAssets: number;
  socUnknownAssets: number;
  availableEnergyWh: number;
}

function Chip({ label, tone }: { label: string; tone: Tone }) {
  const color = TONE_COLOR[tone];
  return (
    <View style={[styles.chip, { backgroundColor: color.bg }]}>
      <Text style={[styles.chipText, { color: color.fg }]}>{label}</Text>
    </View>
  );
}

function power(watts: number): string {
  if (watts === 0) return '0.00 kW';
  return `${(Math.abs(watts) / 1000).toFixed(2)} kW ${watts > 0 ? 'generating' : 'consuming'}`;
}

function energy(wattHours: number): string {
  if (wattHours === 0) return '0.00 kWh';
  return `${(Math.abs(wattHours) / 1000).toFixed(2)} kWh ${wattHours > 0 ? 'generated' : 'used'}`;
}

/** Coverage by rated capacity: one silent battery is not one silent panel. */
function coverage(bucket: Bucket): { label: string; tone: Tone; meaning: string } {
  if (bucket.expectedAssets === 0) {
    return {
      label: 'No assets',
      tone: 'neutral',
      meaning: 'Nobody in this community has an active asset in this window.',
    };
  }
  const rated = bucket.reportingCapacityWh + bucket.silentCapacityWh;
  const share = rated > 0 ? bucket.reportingCapacityWh / rated : 0;
  if (bucket.reportingAssets === 0) {
    return {
      label: 'Nothing reported',
      tone: 'danger',
      meaning: `All ${bucket.expectedAssets} assets were silent, so this window measures nothing.`,
    };
  }
  if (share >= 0.99) {
    return {
      label: 'All reporting',
      tone: 'good',
      meaning: 'Every asset in the community reported in this window.',
    };
  }
  return {
    label: `${(share * 100).toFixed(0)}% seen`,
    tone: share >= 0.9 ? 'warning' : 'danger',
    meaning:
      `${bucket.silentAssets} of ${bucket.expectedAssets} assets reported nothing, hiding ` +
      `${(bucket.silentCapacityWh / 1000).toFixed(1)} kWh of rated capacity. The figures cover the rest only.`,
  };
}

function stored(bucket: Bucket): { label: string; tone: Tone; meaning: string } {
  const kwh = `${(bucket.availableEnergyWh / 1000).toFixed(1)} kWh`;
  if (bucket.socUnknownAssets === 0) {
    return {
      label: kwh,
      tone: 'good',
      meaning: 'Every battery reported its charge level in this window.',
    };
  }
  return {
    label: `at least ${kwh}`,
    tone: bucket.socKnownAssets === 0 ? 'danger' : 'warning',
    meaning:
      `${bucket.socUnknownAssets} batter${bucket.socUnknownAssets === 1 ? 'y' : 'ies'} did not report a ` +
      'charge level, so nothing is counted for them and this is a floor, not an estimate.',
  };
}

export default function CommunityTelemetryScreen({ navigation }: any) {
  const [refreshing, setRefreshing] = useState(false);
  const [selectedCommunityId, setSelectedCommunityId] = useState<number | null>(null);

  const communitiesQuery = trpc.community.getUserCommunities.useQuery();
  const communities = communitiesQuery.data ?? [];
  const communityId = selectedCommunityId ?? (communities[0]?.id as number | undefined) ?? null;

  const seriesQuery = trpc.fleetTelemetry.community.useQuery(
    { communityId: communityId ?? 0, bucketMinutes: BUCKET_MINUTES, buckets: BUCKETS },
    { enabled: communityId !== null, refetchInterval: 60000 }
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await Promise.all([communitiesQuery.refetch(), communityId !== null ? seriesQuery.refetch() : null]);
    setRefreshing(false);
  };

  const buckets = (seriesQuery.data?.buckets ?? []) as Bucket[];
  const missingBuckets = seriesQuery.data?.missingBuckets ?? 0;
  const latest = buckets.length > 0 ? buckets[buckets.length - 1] : null;

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <Text style={styles.title}>Community Telemetry</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.introCard}>
        <Ionicons name="information-circle" size={20} color="#1e40af" />
        <Text style={styles.introText}>
          Your community's shared profile in 15-minute windows. Each window shows how much of the
          community was actually reporting, because a quiet window and an unmonitored one look the
          same otherwise.
        </Text>
      </View>

      {communities.length > 1 && (
        <View style={styles.tabRow}>
          {communities.map((community: any) => {
            const active = community.id === communityId;
            return (
              <TouchableOpacity
                key={community.id}
                onPress={() => setSelectedCommunityId(community.id)}
                style={[styles.tab, active && styles.tabActive]}
              >
                <Text style={[styles.tabText, active && styles.tabTextActive]}>
                  {community.name}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {communitiesQuery.isLoading ? (
        <Text style={styles.emptyText}>Loading your communities…</Text>
      ) : communities.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            You are not an active member of an energy community, so there is no shared profile to
            show.
          </Text>
        </View>
      ) : seriesQuery.isLoading ? (
        <Text style={styles.emptyText}>Loading the rolling profile…</Text>
      ) : seriesQuery.isError ? (
        <View style={styles.card}>
          {/* A failed read is an outage, not an idle community. */}
          <Text style={styles.emptyText}>
            {seriesQuery.error?.message || 'Could not load the rolling profile'}
          </Text>
        </View>
      ) : (
        <>
          {missingBuckets > 0 && (
            <View style={styles.warnCard}>
              <Ionicons name="alert-circle" size={20} color="#92400e" />
              <Text style={styles.warnText}>
                {missingBuckets} of the last {BUCKETS} windows were never computed. That is a gap in
                our aggregation, not a quiet community.
              </Text>
            </View>
          )}

          {latest && (
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.target}>Most recent window</Text>
                <Chip
                  label={latest.state === 'open' ? 'Still filling' : 'Closed'}
                  tone={latest.state === 'open' ? 'warning' : 'good'}
                />
              </View>
              <View style={styles.metricsRow}>
                <View style={styles.metric}>
                  <Text style={styles.metricLabel}>Community power</Text>
                  <Text style={styles.metricValue}>{power(latest.meanNetPowerWatts)}</Text>
                </View>
                <View style={styles.metric}>
                  <Text style={styles.metricLabel}>Energy</Text>
                  <Text style={styles.metricValue}>{energy(latest.integratedEnergyWh)}</Text>
                </View>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Coverage</Text>
                <Chip label={coverage(latest).label} tone={coverage(latest).tone} />
              </View>
              <Text style={styles.meaning}>{coverage(latest).meaning}</Text>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Stored energy</Text>
                <Chip label={stored(latest).label} tone={stored(latest).tone} />
              </View>
              <Text style={styles.meaning}>{stored(latest).meaning}</Text>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Readings used</Text>
                <Text style={styles.detailValue}>{latest.samples}</Text>
              </View>
            </View>
          )}

          {buckets.length === 0 ? (
            <View style={styles.card}>
              <Text style={styles.emptyText}>
                No window has been aggregated for this community yet. Nothing is estimated on
                demand, so this stays empty until aggregation runs.
              </Text>
            </View>
          ) : (
            <View style={styles.card}>
              <Text style={styles.sectionLabel}>Earlier windows</Text>
              {[...buckets]
                .reverse()
                .slice(0, 12)
                .map(bucket => {
                  const seen = coverage(bucket);
                  return (
                    <View key={bucket.bucketStartsAt.toISOString()} style={styles.detailRow}>
                      <Text style={styles.detailLabel}>
                        {bucket.bucketStartsAt.toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </Text>
                      <View style={styles.intervalRight}>
                        <Text style={styles.detailValue}>{power(bucket.meanNetPowerWatts)}</Text>
                        <Chip label={seen.label} tone={seen.tone} />
                      </View>
                    </View>
                  );
                })}
            </View>
          )}
        </>
      )}

      <View style={styles.card}>
        <Text style={styles.target}>What this is not</Text>
        <Text style={styles.meaning}>
          These figures are integrated from telemetry samples, so they are an operational view, not
          a bill. Money is settled from metered payments and your wallet, never from this screen.
        </Text>
      </View>

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
    gap: 10,
    margin: 16,
    marginBottom: 8,
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#eff6ff',
  },
  introText: { flex: 1, fontSize: 13, lineHeight: 19, color: '#1e3a8a' },
  warnCard: {
    flexDirection: 'row',
    gap: 10,
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#fffbeb',
  },
  warnText: { flex: 1, fontSize: 13, lineHeight: 19, color: '#92400e' },
  tabRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  tab: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: '#f3f4f6',
  },
  tabActive: { backgroundColor: '#1e40af' },
  tabText: { fontSize: 13, color: '#374151' },
  tabTextActive: { color: '#ffffff', fontWeight: '600' },
  card: {
    backgroundColor: '#ffffff',
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 16,
    borderRadius: 12,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  target: { fontSize: 15, fontWeight: '700', color: '#111827' },
  metricsRow: { flexDirection: 'row', gap: 16, marginTop: 4, marginBottom: 8 },
  metric: { flex: 1 },
  metricLabel: { fontSize: 12, color: '#6b7280' },
  metricValue: { fontSize: 15, fontWeight: '600', color: '#111827' },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  detailLabel: { fontSize: 13, color: '#6b7280' },
  detailValue: { fontSize: 13, color: '#111827', fontWeight: '500' },
  intervalRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#6b7280',
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  meaning: { fontSize: 12, lineHeight: 18, color: '#6b7280', marginBottom: 4 },
  emptyText: { fontSize: 13, color: '#6b7280', textAlign: 'center', paddingHorizontal: 16 },
  chip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  chipText: { fontSize: 12, fontWeight: '600' },
});
