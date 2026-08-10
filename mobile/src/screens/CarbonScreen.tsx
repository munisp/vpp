import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { trpc } from '../services/trpc';
import { HapticService } from '../services/hapticService';

const kwh = (wh: number | null | undefined) =>
  wh == null ? '—' : `${(wh / 1000).toFixed(1)} kWh`;

const kg = (grams: number | null | undefined) =>
  grams == null ? '—' : `${(grams / 1000).toFixed(1)} kg`;

const CERTIFICATE_ENERGY_WH = 100_000; // one certificate per 100 kWh (server-side constant)

export default function CarbonScreen({ navigation }: any) {
  const [refreshing, setRefreshing] = useState(false);

  const summaryQuery = trpc.carbonCredits.getMyCarbonSummary.useQuery();
  const certsQuery = trpc.carbonCredits.listMyCertificates.useQuery({ limit: 50 });

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await Promise.all([summaryQuery.refetch(), certsQuery.refetch()]);
    setRefreshing(false);
  };

  const summary = summaryQuery.data;
  const certs = certsQuery.data ?? [];

  const progressToNext =
    summary != null
      ? Math.min(1, Math.max(0, summary.uncertifiedEnergyWh / CERTIFICATE_ENERGY_WH))
      : null;

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
        <Text style={styles.title}>Carbon Credits</Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Summary card */}
      <View style={styles.heroCard}>
        <Ionicons name="leaf" size={40} color="white" />
        {summaryQuery.isLoading ? (
          <Text style={styles.heroValue}>Loading…</Text>
        ) : summaryQuery.isError || !summary ? (
          <Text style={styles.heroUnavailable}>Carbon summary unavailable</Text>
        ) : (
          <>
            {summary.co2AvoidedGrams != null ? (
              <>
                <Text style={styles.heroValue}>{kg(summary.co2AvoidedGrams)}</Text>
                <Text style={styles.heroLabel}>CO₂ avoided from your solar generation</Text>
              </>
            ) : (
              <>
                <Text style={styles.heroValue}>—</Text>
                <Text style={styles.heroLabel}>
                  CO₂ avoided unavailable — no live emission factor for your region
                </Text>
              </>
            )}
          </>
        )}
      </View>

      {summary && !summaryQuery.isError && (
        <>
          {/* Detail rows */}
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Summary</Text>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Solar generation (tracked)</Text>
              <Text style={styles.detailValue}>{kwh(summary.solarGenerationWh)}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Region</Text>
              <Text style={styles.detailValue}>{summary.region || '—'}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Emission factor</Text>
              <Text style={styles.detailValue}>
                {summary.emissionFactorGramsPerKwh != null
                  ? `${summary.emissionFactorGramsPerKwh} g/kWh${
                      summary.emissionFactorDataSource
                        ? ` (${summary.emissionFactorDataSource})`
                        : ''
                    }`
                  : '—'}
              </Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Certificates minted</Text>
              <Text style={styles.detailValue}>{summary.certificatesMintedTotal}</Text>
            </View>
            <View style={[styles.detailRow, { borderBottomWidth: 0 }]}>
              <Text style={styles.detailLabel}>Certified energy</Text>
              <Text style={styles.detailValue}>{kwh(summary.certifiedEnergyWh)}</Text>
            </View>
            {summary.newCertificatesMinted > 0 && (
              <View style={styles.mintedBanner}>
                <Ionicons name="checkmark-circle" size={14} color="#065f46" />
                <Text style={styles.mintedBannerText}>
                  {summary.newCertificatesMinted} new certificate
                  {summary.newCertificatesMinted === 1 ? '' : 's'} minted
                </Text>
              </View>
            )}
          </View>

          {/* Progress to next certificate */}
          {progressToNext != null && (
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Next Certificate</Text>
              <View style={styles.progressTrack}>
                <View
                  style={[styles.progressFill, { flex: progressToNext }]}
                />
                <View style={{ flex: 1 - progressToNext }} />
              </View>
              <Text style={styles.progressText}>
                {kwh(summary.uncertifiedEnergyWh)} of 100.0 kWh verified generation
              </Text>
            </View>
          )}
        </>
      )}

      {/* Certificates list */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>My Certificates</Text>
        {certsQuery.isLoading ? (
          <Text style={styles.emptyText}>Loading certificates…</Text>
        ) : certsQuery.isError ? (
          <Text style={styles.emptyText}>Could not load certificates</Text>
        ) : certs.length === 0 ? (
          <Text style={styles.emptyText}>
            No certificates yet — one is minted per 100 kWh of verified solar generation.
          </Text>
        ) : (
          certs.map((c) => (
            <View key={c.id} style={styles.certRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.certTitle}>
                  Certificate #{c.sequence} · {(c.energyWh / 1000).toFixed(0)} kWh
                </Text>
                <Text style={styles.certMeta}>
                  {kg(c.co2AvoidedGrams)} CO₂ · {c.region} ·{' '}
                  {c.mintedAt ? new Date(c.mintedAt).toLocaleDateString() : '—'}
                </Text>
                <Text style={styles.certHash} numberOfLines={1}>
                  {c.certificateHash}
                </Text>
              </View>
              <View
                style={[
                  styles.statusChip,
                  c.status === 'minted' ? styles.statusMinted : styles.statusRetired,
                ]}
              >
                <Text style={styles.statusChipText}>{c.status}</Text>
              </View>
            </View>
          ))
        )}
      </View>
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
  heroCard: {
    backgroundColor: '#059669',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    marginBottom: 16,
  },
  heroValue: {
    fontSize: 36,
    fontWeight: 'bold',
    color: 'white',
    marginTop: 12,
  },
  heroLabel: {
    fontSize: 13,
    color: '#d1fae5',
    marginTop: 6,
    textAlign: 'center',
  },
  heroUnavailable: {
    fontSize: 16,
    color: '#d1fae5',
    marginTop: 12,
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
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  detailLabel: {
    fontSize: 14,
    color: '#6b7280',
    flex: 1,
  },
  detailValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
    textAlign: 'right',
    flex: 1,
  },
  mintedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#d1fae5',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginTop: 12,
    gap: 6,
  },
  mintedBannerText: {
    fontSize: 12,
    color: '#065f46',
    fontWeight: '600',
  },
  progressTrack: {
    flexDirection: 'row',
    height: 10,
    borderRadius: 5,
    backgroundColor: '#e5e7eb',
    overflow: 'hidden',
  },
  progressFill: {
    backgroundColor: '#10b981',
  },
  progressText: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 8,
  },
  emptyText: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
    paddingVertical: 12,
    lineHeight: 20,
  },
  certRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  certTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111827',
  },
  certMeta: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 2,
  },
  certHash: {
    fontSize: 10,
    color: '#9ca3af',
    marginTop: 2,
    fontFamily: 'monospace' as any,
  },
  statusChip: {
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginLeft: 8,
  },
  statusMinted: {
    backgroundColor: '#d1fae5',
  },
  statusRetired: {
    backgroundColor: '#e5e7eb',
  },
  statusChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#111827',
  },
});
