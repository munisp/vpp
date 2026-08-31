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

type Period = '24h' | '7d' | '30d' | '90d';

const PERIODS: { value: Period; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
];

const METHOD_LABELS: Record<string, string> = {
  energy_register: 'energy register',
  power_integration: 'power integration',
};

const formatKwh = (wh: number | null | undefined) =>
  wh == null ? '—' : `${(wh / 1000).toFixed(2)} kWh`;

export default function PortfolioScreen({ navigation }: any) {
  const [period, setPeriod] = useState<Period>('7d');
  const [refreshing, setRefreshing] = useState(false);

  const overviewQuery = trpc.portfolio.overview.useQuery({ period });
  const overview = overviewQuery.data ?? null;

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await overviewQuery.refetch();
    setRefreshing(false);
  };

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
        <Text style={styles.title}>Portfolio</Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Period selector */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Period</Text>
        <View style={styles.chipRowWrap}>
          {PERIODS.map((p) => (
            <TouchableOpacity
              key={p.value}
              style={[styles.chip, period === p.value && styles.chipActive]}
              onPress={() => setPeriod(p.value)}
            >
              <Text style={[styles.chipText, period === p.value && styles.chipTextActive]}>
                {p.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Totals */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Totals</Text>
        {overviewQuery.isLoading ? (
          <Text style={styles.emptyText}>Rolling up your sites…</Text>
        ) : overviewQuery.isError ? (
          <Text style={styles.emptyText}>Could not load the portfolio rollup</Text>
        ) : overview == null ? (
          <Text style={styles.emptyText}>No portfolio data.</Text>
        ) : (
          <>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Generation</Text>
              <Text style={styles.detailValue}>{formatKwh(overview.totals.generationWh)}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Consumption</Text>
              <Text style={styles.detailValue}>{formatKwh(overview.totals.consumptionWh)}</Text>
            </View>
            <View style={[styles.detailRow, { borderBottomWidth: 0 }]}>
              <Text style={styles.detailLabel}>Mean battery health</Text>
              <Text style={styles.detailValue}>
                {overview.totals.meanBatterySohPct != null
                  ? `${overview.totals.meanBatterySohPct.toFixed(1)}%`
                  : '—'}
              </Text>
            </View>
            <Text style={styles.coverageNote}>
              Totals cover {overview.totals.availableSiteCount} of {overview.totals.siteCount}{' '}
              sites
              {overview.totals.unavailableSiteCount > 0
                ? ` — ${overview.totals.unavailableSiteCount} site(s) had no usable data in this period and are excluded rather than counted as zero.`
                : '.'}
            </Text>
          </>
        )}
      </View>

      {/* Per-site cards */}
      {overview != null && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Sites</Text>
          {overview.sites.length === 0 ? (
            <Text style={styles.emptyText}>No assets registered.</Text>
          ) : (
            overview.sites.map((s) => (
              <View key={s.assetId} style={styles.siteCard}>
                <View style={styles.siteHeader}>
                  <Text style={styles.siteName}>{s.assetName}</Text>
                  <Text style={styles.siteType}>{s.assetType}</Text>
                </View>

                {!s.available ? (
                  <View style={styles.unavailableBox}>
                    <Ionicons name="information-circle-outline" size={16} color="#92400e" />
                    <Text style={styles.unavailableText}>
                      Unavailable: {s.reason ?? 'no usable data in this period'}
                    </Text>
                  </View>
                ) : (
                  <>
                    {s.generationWh != null && (
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>Generation</Text>
                        <Text style={styles.detailValue}>{formatKwh(s.generationWh)}</Text>
                      </View>
                    )}
                    {s.consumptionWh != null && (
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>Consumption</Text>
                        <Text style={styles.detailValue}>{formatKwh(s.consumptionWh)}</Text>
                      </View>
                    )}
                    {s.measurementMethod != null && (
                      <Text style={styles.siteMeta}>
                        Measured via {METHOD_LABELS[s.measurementMethod] ?? s.measurementMethod}{' '}
                        · {s.sampleCount} samples
                      </Text>
                    )}
                  </>
                )}

                {s.batterySohPct != null && (
                  <Text style={styles.siteMeta}>
                    Battery SoH {s.batterySohPct.toFixed(1)}%
                    {s.batterySohAsOf
                      ? ` (as of ${new Date(s.batterySohAsOf).toLocaleDateString()})`
                      : ''}
                  </Text>
                )}
              </View>
            ))
          )}
        </View>
      )}

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
  chipRowWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chipActive: {
    backgroundColor: '#10b981',
    borderColor: '#10b981',
  },
  chipText: {
    fontSize: 13,
    color: '#6b7280',
    fontWeight: '600',
  },
  chipTextActive: {
    color: 'white',
  },
  emptyText: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
    paddingVertical: 12,
    lineHeight: 20,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
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
  },
  coverageNote: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 8,
    fontStyle: 'italic',
    lineHeight: 17,
  },
  siteCard: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  siteHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  siteName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111827',
    flex: 1,
  },
  siteType: {
    fontSize: 12,
    color: '#6b7280',
    marginLeft: 8,
  },
  siteMeta: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 6,
  },
  unavailableBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#fef3c7',
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  unavailableText: {
    fontSize: 13,
    color: '#92400e',
    flex: 1,
    lineHeight: 18,
  },
});
