/**
 * "What was this site sized to, and on whose numbers?"
 *
 * Read-only by design: a study fixes capital assumptions, and running one is a
 * desk job with a keyboard, not something to do from a phone in a village. What
 * a field officer or a community representative does need on a phone is the
 * record — the sizing, the cost, where the load came from, and every version of
 * it, including the versions that concluded nothing.
 *
 * A missing number reads as missing here. "Not costed" and "no payback" are not
 * zeros, and a study that was refused shows the reason it was refused.
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { trpc } from '../services/trpc';
import { HapticService } from '../services/hapticService';
import {
  DESIGN_STATUS_COPY,
  PROFILE_SOURCE_COPY,
  centsPerKwhLabel,
  paybackLabel,
  unmetLabel,
  wattHoursLabel,
  wattsLabel,
  type DesignStudyStatus,
  type ProfileSource,
  type Tone,
} from '../../../shared/design-study-copy';
import {
  FEASIBILITY_STATUS_COPY,
  type FeasibilityStatus,
} from '../../../shared/network-feasibility-copy';

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

export default function DesignStudyScreen({ navigation }: any) {
  const [refreshing, setRefreshing] = useState(false);
  const [studyId, setStudyId] = useState<number | null>(null);

  const serviceQuery = trpc.designStudy.serviceStatus.useQuery(undefined, { retry: false });
  const studiesQuery = trpc.designStudy.studies.useQuery({ limit: 50 }, { retry: false });

  const studies = studiesQuery.data ?? [];
  const activeStudyId = studyId ?? studies[0]?.id ?? null;
  const versionsQuery = trpc.designStudy.versions.useQuery(
    { studyId: activeStudyId as number, limit: 25 },
    { enabled: activeStudyId !== null, retry: false }
  );
  const versions = versionsQuery.data ?? [];
  const latest = versions[0] ?? null;

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await Promise.all([studiesQuery.refetch(), versionsQuery.refetch()]);
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
        <Text style={styles.title}>Design Studies</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.introCard}>
        <Ionicons name="calculator" size={20} color="#1e40af" />
        <Text style={styles.introText}>
          Sizing and costing for sites that have not been built. Every figure follows from the
          inputs frozen on the version beside it — nothing here is recomputed on this phone, and a
          study with no recommendation says why it has none.
        </Text>
      </View>

      {serviceQuery.data && !serviceQuery.data.optimizerConfigured && (
        <View style={styles.warnCard}>
          <Text style={styles.warnText}>{serviceQuery.data.note}</Text>
        </View>
      )}

      {studiesQuery.isLoading ? (
        <Text style={styles.emptyText}>Loading studies…</Text>
      ) : studiesQuery.isError ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            {studiesQuery.error?.message || 'Could not load design studies'}
          </Text>
        </View>
      ) : studies.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            No site has been studied yet. Studies are run from the planning console.
          </Text>
        </View>
      ) : (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRowScroll}>
            {studies.map(study => {
              const active = study.id === activeStudyId;
              return (
                <TouchableOpacity
                  key={study.id}
                  style={[styles.studyChip, active && styles.studyChipActive]}
                  onPress={() => setStudyId(study.id)}
                >
                  <Text style={[styles.studyChipText, active && styles.studyChipTextActive]}>
                    {study.reference} · v{study.latestVersion ?? '?'}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {latest && (
            <View style={styles.card}>
              <View style={styles.rowBetween}>
                <Text style={styles.cardTitle}>Version {latest.version}</Text>
                <Chip
                  label={DESIGN_STATUS_COPY[latest.status as DesignStudyStatus].label}
                  tone={DESIGN_STATUS_COPY[latest.status as DesignStudyStatus].tone}
                />
              </View>
              <Text style={styles.detailText}>
                {latest.reason ?? DESIGN_STATUS_COPY[latest.status as DesignStudyStatus].meaning}
              </Text>
              {latest.recommendedPvW !== null ? (
                <>
                  <Text style={styles.detailText}>
                    {wattsLabel(latest.recommendedPvW)} PV ·{' '}
                    {wattHoursLabel(latest.recommendedBatteryWh)} storage ·{' '}
                    {wattsLabel(latest.recommendedBatteryW)} inverter
                  </Text>
                  <Text style={styles.detailText}>
                    {centsPerKwhLabel(latest.lcoeCentsPerKwhX100)} ·{' '}
                    {paybackLabel(latest.paybackMonths)} · {unmetLabel(latest.unmetPpm)}
                  </Text>
                  {latest.fuelLitresSavedPerYear !== null && (
                    <Text style={styles.detailText}>
                      {latest.fuelLitresSavedPerYear.toFixed(0)} litres of fuel and{' '}
                      {latest.emissionsKgSavedPerYear === null
                        ? 'an unassessed mass of CO₂e'
                        : `${latest.emissionsKgSavedPerYear.toFixed(0)} kg CO₂e`}{' '}
                      displaced each year against the baseline.
                    </Text>
                  )}
                </>
              ) : (
                <Text style={styles.detailText}>
                  No sizing on this version — nothing may be read as a cost or a payback for this
                  site from it.
                </Text>
              )}
              <View style={styles.chipRow}>
                <Chip
                  label={PROFILE_SOURCE_COPY[latest.loadSource as ProfileSource].label}
                  tone={PROFILE_SOURCE_COPY[latest.loadSource as ProfileSource].tone}
                />
              </View>
              <Text style={styles.metaText}>
                {PROFILE_SOURCE_COPY[latest.loadSource as ProfileSource].meaning}
                {latest.loadReference ? ` (${latest.loadReference})` : ''}
              </Text>
              <Text style={styles.metaText}>
                {latest.networkStatus === null
                  ? 'The feeder was not checked for this version: a sizing alone says nothing about whether the network can carry it.'
                  : `Feeder check: ${
                      FEASIBILITY_STATUS_COPY[latest.networkStatus as FeasibilityStatus].label
                    } — ${FEASIBILITY_STATUS_COPY[latest.networkStatus as FeasibilityStatus].meaning}`}
              </Text>
              <Text style={styles.metaText}>
                Inputs {latest.inputDigest.slice(0, 12)} · {new Date(latest.createdAt).toLocaleString()}
              </Text>
            </View>
          )}

          <Text style={styles.sectionHeading}>Every version</Text>
          {versionsQuery.isLoading ? (
            <Text style={styles.emptyText}>Loading versions…</Text>
          ) : (
            versions.map(version => {
              const copy = DESIGN_STATUS_COPY[version.status as DesignStudyStatus];
              return (
                <View key={version.id} style={styles.card}>
                  <View style={styles.rowBetween}>
                    <Text style={styles.cardTitle}>v{version.version}</Text>
                    <Chip label={copy.label} tone={copy.tone} />
                  </View>
                  <Text style={styles.detailText}>
                    {version.recommendedPvW === null
                      ? (version.reason ?? copy.meaning)
                      : `${wattsLabel(version.recommendedPvW)} PV, ${wattHoursLabel(
                          version.recommendedBatteryWh
                        )} storage · ${centsPerKwhLabel(
                          version.lcoeCentsPerKwhX100
                        )} · ${paybackLabel(version.paybackMonths)}`}
                  </Text>
                  <Text style={styles.metaText}>
                    {PROFILE_SOURCE_COPY[version.loadSource as ProfileSource].label} load ·{' '}
                    {new Date(version.createdAt).toLocaleString()}
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
  chipRowScroll: { paddingHorizontal: 12, marginBottom: 8 },
  studyChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    marginHorizontal: 4,
  },
  studyChipActive: { backgroundColor: '#1e40af', borderColor: '#1e40af' },
  studyChipText: { fontSize: 13, fontWeight: '600', color: '#374151' },
  studyChipTextActive: { color: '#ffffff' },
  card: {
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  cardTitle: { fontSize: 15, fontWeight: '700', color: '#111827' },
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
