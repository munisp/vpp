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

const tzs = (cents: number | null | undefined) =>
  cents == null ? '—' : `${(cents / 100).toFixed(0)} TZS`;

type AdvisorResult = {
  llmAvailable: boolean;
  llmModel: string | null;
  llmError: string | null;
  recommendations: string[];
  ruleBasedTips: string[];
  digest: string | null;
  cached: boolean;
  generatedAt: string;
  facts: {
    windowDays: number;
    assets: { total: number; solar: number; battery: number; solarCapacityW: number };
    solarGenerationWh: number | null;
    meterImportWh: number | null;
    selfConsumptionRatio: number | null;
    trades30d: {
      executedCount: number;
      exportRevenueCents: number;
      executedExportWh: number;
    };
    payments30d: { completedCount: number; failedCount: number };
  };
};

function LlmStatusBanner({ result }: { result: AdvisorResult }) {
  if (result.llmAvailable) {
    return (
      <View style={[styles.statusBanner, styles.statusBannerOk]}>
        <Ionicons name="sparkles" size={14} color="#065f46" />
        <Text style={styles.statusBannerOkText}>
          AI-generated advice{result.llmModel ? ` (${result.llmModel})` : ''}
          {result.cached ? ' · cached' : ''}
        </Text>
      </View>
    );
  }
  return (
    <View style={[styles.statusBanner, styles.statusBannerWarn]}>
      <Ionicons name="information-circle" size={14} color="#92400e" />
      <Text style={styles.statusBannerWarnText}>
        AI assistant unavailable — showing rule-based tips from your real data.
      </Text>
    </View>
  );
}

export default function AdvisorScreen({ navigation }: any) {
  // Toggling refresh:true changes the query input, forcing a server-side
  // bypass of its 1h advice cache.
  const [refreshRecs, setRefreshRecs] = useState(false);
  const [refreshDigest, setRefreshDigest] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const recsQuery = trpc.energyAdvisor.getRecommendations.useQuery(
    { refresh: refreshRecs },
    { staleTime: 60_000 }
  );
  const digestQuery = trpc.energyAdvisor.getWeeklyDigest.useQuery(
    { refresh: refreshDigest },
    { staleTime: 60_000 }
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await Promise.all([recsQuery.refetch(), digestQuery.refetch()]);
    setRefreshing(false);
  };

  const recs = recsQuery.data as AdvisorResult | undefined;
  const digest = digestQuery.data as AdvisorResult | undefined;

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
        <Text style={styles.title}>Energy Advisor</Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Recommendations */}
      <View style={styles.card}>
        <View style={styles.cardHeaderRow}>
          <Text style={styles.sectionTitle}>Recommendations</Text>
          <TouchableOpacity
            onPress={() => setRefreshRecs(true)}
            disabled={recsQuery.isLoading || recsQuery.isFetching}
          >
            <Ionicons name="refresh" size={20} color="#10b981" />
          </TouchableOpacity>
        </View>

        {recsQuery.isLoading ? (
          <Text style={styles.emptyText}>Generating recommendations…</Text>
        ) : recsQuery.isError ? (
          <Text style={styles.emptyText}>Could not load recommendations</Text>
        ) : recs ? (
          <>
            <LlmStatusBanner result={recs} />
            {recs.recommendations.length === 0 ? (
              <Text style={styles.emptyText}>
                No recommendations available for this period yet.
              </Text>
            ) : (
              recs.recommendations.map((tip, i) => (
                <View key={i} style={styles.tipRow}>
                  <Text style={styles.tipBullet}>•</Text>
                  <Text style={styles.tipText}>{tip}</Text>
                </View>
              ))
            )}
            <Text style={styles.generatedAt}>
              Generated {new Date(recs.generatedAt).toLocaleString()}
            </Text>
          </>
        ) : null}
      </View>

      {/* 30-day facts */}
      {recs && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Last {recs.facts.windowDays} Days (Facts)</Text>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Solar generation</Text>
            <Text style={styles.detailValue}>{kwh(recs.facts.solarGenerationWh)}</Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Grid import</Text>
            <Text style={styles.detailValue}>{kwh(recs.facts.meterImportWh)}</Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Self-consumption</Text>
            <Text style={styles.detailValue}>
              {recs.facts.selfConsumptionRatio != null
                ? `${Math.round(recs.facts.selfConsumptionRatio * 100)}%`
                : '—'}
            </Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Executed trades</Text>
            <Text style={styles.detailValue}>{recs.facts.trades30d.executedCount}</Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Export revenue</Text>
            <Text style={styles.detailValue}>
              {tzs(recs.facts.trades30d.exportRevenueCents)}
            </Text>
          </View>
          <View style={[styles.detailRow, { borderBottomWidth: 0 }]}>
            <Text style={styles.detailLabel}>Failed payments</Text>
            <Text style={styles.detailValue}>{recs.facts.payments30d.failedCount}</Text>
          </View>
        </View>
      )}

      {/* Weekly digest */}
      <View style={styles.card}>
        <View style={styles.cardHeaderRow}>
          <Text style={styles.sectionTitle}>Weekly Digest</Text>
          <TouchableOpacity
            onPress={() => setRefreshDigest(true)}
            disabled={digestQuery.isLoading || digestQuery.isFetching}
          >
            <Ionicons name="refresh" size={20} color="#10b981" />
          </TouchableOpacity>
        </View>

        {digestQuery.isLoading ? (
          <Text style={styles.emptyText}>Preparing digest…</Text>
        ) : digestQuery.isError ? (
          <Text style={styles.emptyText}>Could not load weekly digest</Text>
        ) : digest ? (
          <>
            <LlmStatusBanner result={digest} />
            {digest.digest ? (
              <Text style={styles.digestText}>{digest.digest}</Text>
            ) : (
              <Text style={styles.emptyText}>No digest available for this week.</Text>
            )}
            {digest.recommendations.length > 0 && (
              <View style={{ marginTop: 12 }}>
                {digest.recommendations.map((tip, i) => (
                  <View key={i} style={styles.tipRow}>
                    <Text style={styles.tipBullet}>•</Text>
                    <Text style={styles.tipText}>{tip}</Text>
                  </View>
                ))}
              </View>
            )}
            <Text style={styles.generatedAt}>
              Generated {new Date(digest.generatedAt).toLocaleString()}
            </Text>
          </>
        ) : null}
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
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 12,
  },
  statusBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 12,
    gap: 6,
  },
  statusBannerOk: {
    backgroundColor: '#d1fae5',
  },
  statusBannerOkText: {
    fontSize: 12,
    color: '#065f46',
    fontWeight: '600',
    flex: 1,
  },
  statusBannerWarn: {
    backgroundColor: '#fef3c7',
  },
  statusBannerWarnText: {
    fontSize: 12,
    color: '#92400e',
    fontWeight: '600',
    flex: 1,
  },
  tipRow: {
    flexDirection: 'row',
    marginBottom: 10,
  },
  tipBullet: {
    fontSize: 16,
    color: '#10b981',
    marginRight: 8,
    lineHeight: 22,
  },
  tipText: {
    flex: 1,
    fontSize: 14,
    color: '#374151',
    lineHeight: 22,
  },
  digestText: {
    fontSize: 14,
    color: '#374151',
    lineHeight: 22,
  },
  generatedAt: {
    fontSize: 11,
    color: '#9ca3af',
    marginTop: 12,
  },
  emptyText: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
    paddingVertical: 12,
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
  },
  detailValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
  },
});
