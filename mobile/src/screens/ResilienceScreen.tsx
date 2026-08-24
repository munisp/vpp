/**
 * "If the grid drops right now, does the clinic stay on, and for how long?"
 *
 * Read-only on purpose. Declaring a critical load or islanding a microgrid are
 * operator actions taken against physical switchgear, and this screen offers
 * neither — it shows what the register and the last readings support, and names
 * the survey or registration missing behind every figure it cannot produce.
 *
 * The autonomy number this replaced was invented from "assume a 2-hour battery",
 * so an `unknown` here is the honest answer, not a loading state.
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { trpc } from '../services/trpc';
import { HapticService } from '../services/hapticService';
import {
  CRITICAL_LOAD_CATEGORY_LABEL,
  DEMAND_SOURCE_COPY,
  RATING_SOURCE_COPY,
  autonomyCopy,
  criticalServiceCopy,
  hoursLabel,
  type Tone,
} from '../../../shared/microgrid-resilience-copy';

const TONE_COLOR: Record<Tone, { bg: string; fg: string }> = {
  live: { bg: '#cffafe', fg: '#155e75' },
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

interface ResilienceScreenProps {
  navigation: { goBack: () => void };
}

export default function ResilienceScreen({ navigation }: ResilienceScreenProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [selectedCommunityId, setSelectedCommunityId] = useState<number | null>(null);

  const communitiesQuery = trpc.community.getUserCommunities.useQuery();
  const communities = communitiesQuery.data ?? [];
  const communityId = selectedCommunityId ?? communities[0]?.id ?? null;

  const statusQuery = trpc.community.getMicrogridStatus.useQuery(
    { communityId: communityId ?? 0 },
    { enabled: communityId !== null, refetchInterval: 60000, retry: false }
  );
  const loadsQuery = trpc.community.listCriticalLoads.useQuery(
    { communityId: communityId ?? 0, includeInactive: false },
    { enabled: communityId !== null, retry: false }
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await Promise.all([
      communitiesQuery.refetch(),
      communityId !== null ? statusQuery.refetch() : null,
      communityId !== null ? loadsQuery.refetch() : null,
    ]);
    setRefreshing(false);
  };

  const resilience = statusQuery.data?.resilience;
  const autonomy = resilience?.autonomy;
  const critical = resilience?.criticalService;
  const storage = resilience?.storage;
  const autonomyState = autonomyCopy(
    autonomy?.hours ?? null,
    autonomy?.basis ?? null,
    autonomy?.reason ?? null
  );
  const criticalState = criticalServiceCopy(critical?.served ?? null, critical?.reason ?? null);
  const demandSource = critical?.demandSource ? DEMAND_SOURCE_COPY[critical.demandSource] : null;

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <Text style={styles.title}>Resilience</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.introCard}>
        <Ionicons name="information-circle" size={20} color="#1e40af" />
        <Text style={styles.introText}>
          What your microgrid can carry through an outage, computed from declared critical loads,
          registered battery energy and readings from the last 15 minutes. Anything unsurveyed reads
          as unknown rather than as an estimate.
        </Text>
      </View>

      {communities.length > 1 && (
        <View style={styles.tabRow}>
          {communities.map((community) => {
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
            You are not an active member of an energy community, so there is no microgrid to assess.
          </Text>
        </View>
      ) : statusQuery.isLoading ? (
        <Text style={styles.emptyText}>Reading the microgrid…</Text>
      ) : statusQuery.isError ? (
        <View style={styles.card}>
          {/* A failed read is an unknown microgrid, not a healthy one. */}
          <Text style={styles.emptyText}>
            {statusQuery.error?.message || 'Could not read this microgrid'} — its state is unknown
            right now.
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.target}>Critical loads</Text>
              <Chip label={criticalState.label} tone={criticalState.tone} />
            </View>
            <Text style={styles.meaning}>{criticalState.meaning}</Text>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Critical demand</Text>
              <View style={styles.intervalRight}>
                <Text style={styles.detailValue}>
                  {critical?.demandKw === null || critical?.demandKw === undefined
                    ? 'unknown'
                    : `${critical.demandKw} kW`}
                </Text>
                {demandSource && <Chip label={demandSource.label} tone={demandSource.tone} />}
              </View>
            </View>
            {demandSource && <Text style={styles.meaning}>{demandSource.meaning}</Text>}
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Supply available</Text>
              <Text style={styles.detailValue}>
                {critical?.availableSupplyKw === null || critical?.availableSupplyKw === undefined
                  ? 'unknown'
                  : `${critical.availableSupplyKw} kW`}
              </Text>
            </View>
            {critical && critical.unservedKw !== null && critical.unservedKw > 0 && (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Not covered</Text>
                <Text style={[styles.detailValue, { color: '#991b1b' }]}>
                  {critical.unservedKw} kW
                </Text>
              </View>
            )}
          </View>

          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.target}>Ride-through</Text>
              <Chip label={autonomyState.label} tone={autonomyState.tone} />
            </View>
            <View style={styles.metricsRow}>
              <View style={styles.metric}>
                <Text style={styles.metricLabel}>Hours on storage</Text>
                <Text style={styles.metricValue}>
                  {hoursLabel(autonomy?.hours ?? null) ?? 'unknown'}
                </Text>
              </View>
              <View style={styles.metric}>
                <Text style={styles.metricLabel}>Usable stored</Text>
                <Text style={styles.metricValue}>
                  {storage?.usableEnergyWh === null || storage?.usableEnergyWh === undefined
                    ? 'unknown'
                    : `${(storage.usableEnergyWh / 1000).toFixed(2)} kWh`}
                </Text>
              </View>
            </View>
            <Text style={styles.meaning}>{autonomyState.meaning}</Text>
            {critical?.autonomyTargetHours !== null && critical?.autonomyTargetHours !== undefined && (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>
                  Longest declared target: {critical.autonomyTargetHours} h
                </Text>
                <Chip
                  label={
                    critical.meetsAutonomyTarget === null
                      ? 'unjudged'
                      : critical.meetsAutonomyTarget
                        ? 'met'
                        : 'not met'
                  }
                  tone={
                    critical.meetsAutonomyTarget === null
                      ? 'warning'
                      : critical.meetsAutonomyTarget
                        ? 'good'
                        : 'danger'
                  }
                />
              </View>
            )}
          </View>

          {(resilience?.limitations.length ?? 0) > 0 && (
            <View style={styles.warnCard}>
              <Ionicons name="alert-circle" size={20} color="#92400e" />
              <View style={{ flex: 1 }}>
                <Text style={styles.warnText}>What this assessment could not establish:</Text>
                {(resilience?.limitations ?? []).map(limitation => (
                  <Text key={limitation} style={styles.warnText}>
                    • {limitation}
                  </Text>
                ))}
              </View>
            </View>
          )}

          <View style={styles.card}>
            <Text style={styles.sectionLabel}>Declared critical loads</Text>
            {loadsQuery.isLoading ? (
              <Text style={styles.emptyText}>Reading the register…</Text>
            ) : loadsQuery.isError ? (
              <Text style={styles.emptyText}>
                {loadsQuery.error?.message || 'Could not read the register'}
              </Text>
            ) : (loadsQuery.data?.length ?? 0) === 0 ? (
              <Text style={styles.meaning}>
                Nothing has been declared critical for this community, so coverage above is unknown
                rather than satisfied.
              </Text>
            ) : (
              (loadsQuery.data ?? []).map(load => {
                const rating = RATING_SOURCE_COPY[load.ratingSource];
                return (
                  <View key={load.id} style={styles.loadRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.detailValue}>{load.label}</Text>
                      <Text style={styles.metricLabel}>
                        {CRITICAL_LOAD_CATEGORY_LABEL[load.category] ?? load.category} · priority{' '}
                        {load.priority} · {(load.ratedPowerW / 1000).toFixed(2)} kW
                        {load.autonomyTargetHours === null
                          ? ''
                          : ` · ${load.autonomyTargetHours} h target`}
                      </Text>
                    </View>
                    {rating && <Chip label={rating.label} tone={rating.tone} />}
                  </View>
                );
              })
            )}
          </View>

          <View style={styles.card}>
            <Text style={styles.target}>What this screen cannot do</Text>
            <Text style={styles.meaning}>
              Declaring a critical load and islanding the microgrid are operator actions against
              physical switchgear and are not offered here. Islanding is refused entirely while
              critical-load coverage is anything other than covered.
            </Text>
          </View>
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
    marginBottom: 12,
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#fffbeb',
  },
  warnText: { fontSize: 13, lineHeight: 19, color: '#92400e' },
  tabRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  tab: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: '#f3f4f6' },
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
  loadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e5e7eb',
  },
  detailLabel: { fontSize: 13, color: '#6b7280', flexShrink: 1 },
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
