import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { trpc } from '../services/trpc';
import { HapticService } from '../services/hapticService';

type TariffResult = {
  tariffId: number;
  version: number;
  country: string;
  computedCostCents: number;
  unpricedWh: number;
  complete: boolean;
  rank: number;
};

const UNAVAILABLE_REASONS: Record<string, string> = {
  no_published_tariffs: 'No dynamic tariffs are published yet, so there is nothing to compare against.',
  insufficient_usage: 'Not enough interval usage history (about a week of hourly data is needed) to price your profile.',
};

const formatCents = (cents: number | null | undefined) =>
  cents == null ? '—' : (cents / 100).toFixed(2);

const formatKwh = (wh: number | null | undefined) =>
  wh == null ? '—' : `${(wh / 1000).toFixed(2)} kWh`;

export default function TariffAdvisorScreen({ navigation }: any) {
  const [refreshing, setRefreshing] = useState(false);

  const utils = trpc.useUtils();

  const comparisonsQuery = trpc.tariffAdvisor.listComparisons.useQuery({ limit: 5 });
  const comparisons = comparisonsQuery.data ?? [];

  const compareMutation = trpc.tariffAdvisor.compareTariffs.useMutation({
    onSuccess: async () => {
      await HapticService.success();
      utils.tariffAdvisor.listComparisons.invalidate();
    },
    onError: async (error) => {
      await HapticService.error();
      Alert.alert('Error', error.message);
    },
  });

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await comparisonsQuery.refetch();
    setRefreshing(false);
  };

  // Prefer the fresh mutation result; otherwise the most recent stored row.
  const latest = compareMutation.data ?? null;
  const latestStored = comparisons[0] ?? null;

  const latestAvailable =
    latest != null ? latest.available : latestStored?.available ?? null;
  const latestReason =
    latest != null
      ? latest.unavailableReason
      : latestStored?.unavailableReason ?? null;
  const latestResults: TariffResult[] =
    latest != null ? latest.results : ((latestStored?.results as TariffResult[] | null) ?? []);
  const savingsCents =
    latest != null ? latest.savingsVsCurrentCents : latestStored?.savingsVsCurrentCents ?? null;
  const cheapestId =
    latest != null ? latest.cheapestTariffId : latestStored?.cheapestTariffId ?? null;
  const currentId =
    latest != null ? latest.currentTariffId : latestStored?.currentTariffId ?? null;
  const usageWh = latest != null ? latest.usageWh : latestStored?.usageWh ?? null;
  const spanDays =
    latest != null
      ? latest.spanDays
      : latestStored?.spanDays10 != null
        ? latestStored.spanDays10 / 10
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
        <Text style={styles.title}>Tariff Advisor</Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Compare trigger */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Compare Tariffs</Text>
        <Text style={styles.bodyText}>
          Prices your real interval usage from the last 30 days against every published
          dynamic tariff version, ranked cheapest-first.
        </Text>
        <TouchableOpacity
          style={styles.saveButton}
          onPress={() => compareMutation.mutate()}
          disabled={compareMutation.isPending}
        >
          <Text style={styles.saveButtonText}>
            {compareMutation.isPending ? 'Comparing…' : 'Run Comparison'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Latest comparison */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Latest Comparison</Text>
        {comparisonsQuery.isLoading && latest == null ? (
          <Text style={styles.emptyText}>Loading comparisons…</Text>
        ) : comparisonsQuery.isError && latest == null ? (
          <Text style={styles.emptyText}>Could not load comparisons</Text>
        ) : latestAvailable === null ? (
          <Text style={styles.emptyText}>
            No comparison yet. Run one above to price your usage against published tariffs.
          </Text>
        ) : latestAvailable === false ? (
          <View style={styles.unavailableBox}>
            <Ionicons name="information-circle-outline" size={16} color="#92400e" />
            <Text style={styles.unavailableText}>
              Comparison unavailable:{' '}
              {latestReason ? UNAVAILABLE_REASONS[latestReason] ?? latestReason : 'unknown reason'}
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Usage priced</Text>
              <Text style={styles.detailValue}>
                {formatKwh(usageWh)}
                {spanDays != null ? ` over ${spanDays.toFixed(1)} days` : ''}
              </Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Savings vs current tariff</Text>
              <Text style={[styles.detailValue, { color: '#10b981' }]}>
                {savingsCents != null ? formatCents(savingsCents) : '—'}
              </Text>
            </View>

            <Text style={[styles.inputLabel, { marginTop: 10 }]}>
              Ranked cheapest-first:
            </Text>
            {latestResults.map((r) => (
              <View key={r.tariffId} style={styles.tariffRow}>
                <Text style={styles.rankBadge}>#{r.rank}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.tariffTitle}>
                    Tariff v{r.version} · {r.country}
                    {r.tariffId === currentId ? ' (current)' : ''}
                  </Text>
                  {!r.complete && (
                    <Text style={styles.tariffWarning}>
                      Partial pricing — {formatKwh(r.unpricedWh)} of usage fell in unpriced
                      hours; the true cost is understated.
                    </Text>
                  )}
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={styles.detailValue}>{formatCents(r.computedCostCents)}</Text>
                  {r.tariffId === cheapestId && (
                    <Text style={styles.cheapestLabel}>cheapest</Text>
                  )}
                </View>
              </View>
            ))}
          </>
        )}
      </View>

      {/* History */}
      {comparisons.length > 1 && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Past Comparisons</Text>
          {comparisons.slice(1).map((c) => (
            <View key={c.id} style={styles.detailRow}>
              <Text style={styles.detailLabel}>
                {c.computedAt ? new Date(c.computedAt).toLocaleString() : '—'}
              </Text>
              <Text style={styles.detailValue}>
                {c.available
                  ? c.savingsVsCurrentCents != null
                    ? `saves ${formatCents(c.savingsVsCurrentCents)}`
                    : 'no savings figure'
                  : c.unavailableReason
                    ? UNAVAILABLE_REASONS[c.unavailableReason] ?? c.unavailableReason
                    : 'unavailable'}
              </Text>
            </View>
          ))}
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
  bodyText: {
    fontSize: 14,
    color: '#6b7280',
    lineHeight: 20,
    marginBottom: 12,
  },
  inputLabel: {
    fontSize: 14,
    color: '#6b7280',
    marginBottom: 6,
    marginTop: 4,
  },
  saveButton: {
    backgroundColor: '#10b981',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  saveButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  emptyText: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
    paddingVertical: 12,
    lineHeight: 20,
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
  tariffRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
    gap: 10,
  },
  rankBadge: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#10b981',
    width: 30,
  },
  tariffTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
  },
  tariffWarning: {
    fontSize: 12,
    color: '#92400e',
    marginTop: 2,
    lineHeight: 16,
  },
  cheapestLabel: {
    fontSize: 11,
    color: '#10b981',
    fontWeight: '600',
    marginTop: 2,
  },
});
