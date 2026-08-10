import React, { useEffect, useState } from 'react';
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
  wh == null ? '—' : `${(wh / 1000).toFixed(2)} kWh`;

const pct = (v: number | null | undefined, digits = 1) =>
  v == null ? '—' : `${v.toFixed(digits)}%`;

export default function BatteryHealthScreen({ navigation }: any) {
  const [selectedAssetId, setSelectedAssetId] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const assetsQuery = trpc.assets.list.useQuery();

  const batteryAssets = (assetsQuery.data?.assets ?? []).filter(
    (a) => a.assetType === 'battery'
  );

  // Auto-select the first battery asset once assets load.
  useEffect(() => {
    if (selectedAssetId == null && batteryAssets.length > 0) {
      setSelectedAssetId(batteryAssets[0].id);
    }
  }, [assetsQuery.data]);

  const healthQuery = trpc.batteryHealth.getBatteryHealth.useQuery(
    { assetId: selectedAssetId as number },
    { enabled: selectedAssetId != null }
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await Promise.all([
      assetsQuery.refetch(),
      selectedAssetId != null ? healthQuery.refetch() : Promise.resolve(),
    ]);
    setRefreshing(false);
  };

  const health = healthQuery.data;

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
        <Text style={styles.title}>Battery Health</Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Asset selector */}
      {assetsQuery.isLoading ? (
        <Text style={styles.emptyText}>Loading assets…</Text>
      ) : assetsQuery.isError ? (
        <Text style={styles.emptyText}>Could not load assets</Text>
      ) : batteryAssets.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            No battery assets registered. Add a battery asset to see health analytics.
          </Text>
        </View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.selectorRow}
        >
          {batteryAssets.map((a) => (
            <TouchableOpacity
              key={a.id}
              style={[
                styles.assetChip,
                selectedAssetId === a.id && styles.assetChipActive,
              ]}
              onPress={() => setSelectedAssetId(a.id)}
            >
              <Text
                style={[
                  styles.assetChipText,
                  selectedAssetId === a.id && styles.assetChipTextActive,
                ]}
              >
                {a.name}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Health report */}
      {selectedAssetId != null && (
        <>
          {healthQuery.isLoading ? (
            <Text style={styles.emptyText}>Computing health metrics…</Text>
          ) : healthQuery.isError ? (
            <View style={styles.card}>
              <Text style={styles.emptyText}>
                {healthQuery.error?.message || 'Could not compute battery health'}
              </Text>
            </View>
          ) : health ? (
            <>
              {/* Insufficient data notice */}
              {health.insufficientData && (
                <View style={styles.insufficientCard}>
                  <Ionicons name="information-circle" size={20} color="#92400e" />
                  <Text style={styles.insufficientText}>
                    {health.reason ||
                      'Not enough telemetry yet — health metrics need at least 7 days of data.'}
                  </Text>
                </View>
              )}

              {/* Headline metrics */}
              <View style={styles.metricsRow}>
                <View style={styles.metricCard}>
                  <Text style={styles.metricLabel}>State of Health</Text>
                  <Text style={styles.metricValue}>{pct(health.estimatedSohPct)}</Text>
                </View>
                <View style={styles.metricCard}>
                  <Text style={styles.metricLabel}>Round-Trip Eff.</Text>
                  <Text style={styles.metricValue}>
                    {pct(health.roundTripEfficiencyPct)}
                  </Text>
                </View>
              </View>
              <View style={styles.metricsRow}>
                <View style={styles.metricCard}>
                  <Text style={styles.metricLabel}>Full Cycles</Text>
                  <Text style={styles.metricValue}>
                    {health.fullCycleEquivalents != null
                      ? health.fullCycleEquivalents.toFixed(1)
                      : '—'}
                  </Text>
                </View>
                <View style={styles.metricCard}>
                  <Text style={styles.metricLabel}>Degradation / week</Text>
                  <Text style={styles.metricValue}>
                    {health.weeklyDegradationSlopePctPerWeek != null
                      ? `${health.weeklyDegradationSlopePctPerWeek.toFixed(2)}%`
                      : '—'}
                  </Text>
                </View>
              </View>

              {/* Warranty risk */}
              {health.warrantyRisk && (
                <View style={styles.warrantyCard}>
                  <Ionicons name="warning" size={20} color="#dc2626" />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.warrantyTitle}>Warranty risk</Text>
                    {health.warrantyRiskReasons.map((r, i) => (
                      <Text key={i} style={styles.warrantyReason}>
                        • {r}
                      </Text>
                    ))}
                  </View>
                </View>
              )}

              {/* Detail card */}
              <View style={styles.card}>
                <Text style={styles.sectionTitle}>Telemetry Window</Text>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Data span</Text>
                  <Text style={styles.detailValue}>
                    {health.spanDays != null ? `${health.spanDays.toFixed(1)} days` : '—'}
                  </Text>
                </View>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Samples</Text>
                  <Text style={styles.detailValue}>
                    {health.sampleCount} ({health.socSampleCount} SoC)
                  </Text>
                </View>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Charge energy</Text>
                  <Text style={styles.detailValue}>{kwh(health.chargeEnergyWh)}</Text>
                </View>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Discharge energy</Text>
                  <Text style={styles.detailValue}>{kwh(health.dischargeEnergyWh)}</Text>
                </View>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Window start</Text>
                  <Text style={styles.detailValue}>
                    {health.windowStart
                      ? new Date(health.windowStart).toLocaleDateString()
                      : '—'}
                  </Text>
                </View>
                <View style={[styles.detailRow, { borderBottomWidth: 0 }]}>
                  <Text style={styles.detailLabel}>Window end</Text>
                  <Text style={styles.detailValue}>
                    {health.windowEnd
                      ? new Date(health.windowEnd).toLocaleDateString()
                      : '—'}
                  </Text>
                </View>
              </View>

              {/* Weekly efficiencies */}
              {health.weeklyEfficiencies.length > 0 && (
                <View style={styles.card}>
                  <Text style={styles.sectionTitle}>Weekly Efficiency</Text>
                  {health.weeklyEfficiencies.map((w, i) => (
                    <View
                      key={i}
                      style={[
                        styles.detailRow,
                        i === health.weeklyEfficiencies.length - 1 && {
                          borderBottomWidth: 0,
                        },
                      ]}
                    >
                      <Text style={styles.detailLabel}>
                        Week of {new Date(w.weekStart).toLocaleDateString()}
                      </Text>
                      <Text style={styles.detailValue}>{pct(w.efficiencyPct)}</Text>
                    </View>
                  ))}
                </View>
              )}

              <Text style={styles.computedAt}>
                Computed {new Date(health.computedAt).toLocaleString()}
              </Text>
            </>
          ) : null}
        </>
      )}
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
  selectorRow: {
    flexDirection: 'row',
    marginBottom: 16,
  },
  assetChip: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: 'white',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginRight: 8,
  },
  assetChipActive: {
    backgroundColor: '#10b981',
    borderColor: '#10b981',
  },
  assetChipText: {
    fontSize: 14,
    color: '#6b7280',
    fontWeight: '600',
  },
  assetChipTextActive: {
    color: 'white',
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
  insufficientCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fef3c7',
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    gap: 8,
  },
  insufficientText: {
    flex: 1,
    fontSize: 13,
    color: '#92400e',
    lineHeight: 18,
  },
  metricsRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 12,
  },
  metricCard: {
    flex: 1,
    backgroundColor: 'white',
    borderRadius: 16,
    padding: 16,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  metricLabel: {
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 6,
    textAlign: 'center',
  },
  metricValue: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#111827',
  },
  warrantyCard: {
    flexDirection: 'row',
    backgroundColor: '#fee2e2',
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    gap: 8,
  },
  warrantyTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#dc2626',
    marginBottom: 4,
  },
  warrantyReason: {
    fontSize: 13,
    color: '#7f1d1d',
    lineHeight: 18,
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
  },
  detailValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
  },
  computedAt: {
    fontSize: 11,
    color: '#9ca3af',
    textAlign: 'center',
    marginBottom: 24,
  },
  emptyText: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
    paddingVertical: 12,
    lineHeight: 20,
  },
});
