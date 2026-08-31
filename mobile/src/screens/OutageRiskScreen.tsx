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

const formatScore = (score: number | null | undefined) =>
  score == null ? '—' : score.toFixed(1);

const scoreColor = (score: number | null | undefined) => {
  if (score == null) return '#6b7280';
  if (score >= 66) return '#dc2626';
  if (score >= 33) return '#f59e0b';
  return '#10b981';
};

export default function OutageRiskScreen({ navigation }: any) {
  const [refreshing, setRefreshing] = useState(false);
  const [assetId, setAssetId] = useState<number | null>(null);

  const utils = trpc.useUtils();

  const assetsQuery = trpc.assets.list.useQuery();
  const assets = assetsQuery.data?.assets ?? [];
  const selectedAssetId = assetId ?? assets[0]?.id ?? null;

  const historyQuery = trpc.outageRisk.getRiskHistory.useQuery(
    { assetId: selectedAssetId!, limit: 10 },
    { enabled: selectedAssetId != null }
  );
  const history = historyQuery.data ?? [];
  const latest = history[0] ?? null;

  const computeMutation = trpc.outageRisk.computeRisk.useMutation({
    onSuccess: async (result) => {
      await HapticService.success();
      if (result.insufficientData) {
        Alert.alert(
          'Insufficient Data',
          result.reason ?? 'Not enough data to compute a risk score.'
        );
      }
      utils.outageRisk.getRiskHistory.invalidate();
    },
    onError: async (error) => {
      await HapticService.error();
      Alert.alert('Error', error.message);
    },
  });

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await Promise.all([assetsQuery.refetch(), historyQuery.refetch()]);
    setRefreshing(false);
  };

  // Latest computed result (from the mutation) or the latest history row.
  const latestScore =
    computeMutation.data && computeMutation.data.assetId === selectedAssetId
      ? computeMutation.data.score
      : latest != null
        ? latest.scoreMilli != null
          ? latest.scoreMilli / 1000
          : null
        : null;
  const latestInsufficient =
    computeMutation.data && computeMutation.data.assetId === selectedAssetId
      ? computeMutation.data.insufficientData
      : latest?.insufficientData ?? null;
  const latestReason =
    computeMutation.data && computeMutation.data.assetId === selectedAssetId
      ? computeMutation.data.reason
      : latest?.reason ?? null;

  const components =
    computeMutation.data && computeMutation.data.assetId === selectedAssetId
      ? computeMutation.data.components
      : latest
        ? {
            anomaly:
              latest.anomalyComponentMilli != null
                ? latest.anomalyComponentMilli / 1000
                : null,
            telemetryGap:
              latest.telemetryGapComponentMilli != null
                ? latest.telemetryGapComponentMilli / 1000
                : null,
            gridQuality:
              latest.gridQualityComponentMilli != null
                ? latest.gridQualityComponentMilli / 1000
                : null,
          }
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
        <Text style={styles.title}>Outage Risk</Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Asset selector */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Asset</Text>
        {assetsQuery.isLoading ? (
          <Text style={styles.emptyText}>Loading assets…</Text>
        ) : assets.length === 0 ? (
          <Text style={styles.emptyText}>
            No assets registered. Register an asset to compute outage risk.
          </Text>
        ) : (
          <View style={styles.chipRowWrap}>
            {assets.map((a) => (
              <TouchableOpacity
                key={a.id}
                style={[styles.chip, selectedAssetId === a.id && styles.chipActive]}
                onPress={() => setAssetId(a.id)}
              >
                <Text
                  style={[styles.chipText, selectedAssetId === a.id && styles.chipTextActive]}
                >
                  {a.name}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <TouchableOpacity
          style={styles.computeButton}
          onPress={() =>
            selectedAssetId != null && computeMutation.mutate({ assetId: selectedAssetId })
          }
          disabled={computeMutation.isPending || selectedAssetId == null}
        >
          <Ionicons name="analytics" size={18} color="white" />
          <Text style={styles.computeButtonText}>
            {computeMutation.isPending ? 'Computing…' : 'Compute Risk Now'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Current score */}
      {selectedAssetId != null && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Latest Score</Text>
          {historyQuery.isLoading ? (
            <Text style={styles.emptyText}>Loading score…</Text>
          ) : latestInsufficient === null ? (
            <Text style={styles.emptyText}>
              No risk score computed for this asset yet. Run a computation above.
            </Text>
          ) : latestInsufficient ? (
            <View style={styles.unavailableBox}>
              <Ionicons name="information-circle-outline" size={16} color="#92400e" />
              <Text style={styles.unavailableText}>
                Insufficient data for a score:{' '}
                {latestReason ?? 'not enough telemetry history.'}
              </Text>
            </View>
          ) : (
            <View style={styles.scoreBlock}>
              <Text style={[styles.scoreValue, { color: scoreColor(latestScore) }]}>
                {formatScore(latestScore)}
              </Text>
              <Text style={styles.scoreLabel}>/ 100 outage risk</Text>
            </View>
          )}

          {/* Component breakdown */}
          {components != null && latestInsufficient === false && (
            <View style={{ marginTop: 12 }}>
              <Text style={styles.inputLabel}>Component breakdown (0–100 each)</Text>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Grid anomaly history</Text>
                <Text style={styles.detailValue}>{formatScore(components.anomaly)}</Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Telemetry gaps</Text>
                <Text style={styles.detailValue}>{formatScore(components.telemetryGap)}</Text>
              </View>
              <View style={[styles.detailRow, { borderBottomWidth: 0 }]}>
                <Text style={styles.detailLabel}>Grid quality (voltage/frequency)</Text>
                <Text style={styles.detailValue}>{formatScore(components.gridQuality)}</Text>
              </View>
              <Text style={styles.methodNote}>
                Components with no data are excluded from the composite rather than assumed.
              </Text>
            </View>
          )}
        </View>
      )}

      {/* History */}
      {selectedAssetId != null && history.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Score History</Text>
          {history.map((h) => (
            <View key={h.id} style={styles.historyRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.historyDate}>
                  {h.computedAt ? new Date(h.computedAt).toLocaleString() : '—'}
                </Text>
                <Text style={styles.historyMeta}>
                  {h.insufficientData
                    ? h.reason ?? 'insufficient data'
                    : `${h.telemetrySampleCount} samples over ${(h.spanDays10 / 10).toFixed(1)} days`}
                </Text>
              </View>
              <Text
                style={[
                  styles.historyScore,
                  {
                    color: h.insufficientData
                      ? '#6b7280'
                      : scoreColor(h.scoreMilli != null ? h.scoreMilli / 1000 : null),
                  },
                ]}
              >
                {h.insufficientData || h.scoreMilli == null
                  ? '—'
                  : (h.scoreMilli / 1000).toFixed(1)}
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
  inputLabel: {
    fontSize: 14,
    color: '#6b7280',
    marginBottom: 6,
    marginTop: 4,
  },
  chipRowWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
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
  computeButton: {
    backgroundColor: '#10b981',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
    marginTop: 4,
  },
  computeButtonText: {
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
  scoreBlock: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  scoreValue: {
    fontSize: 48,
    fontWeight: 'bold',
  },
  scoreLabel: {
    fontSize: 13,
    color: '#6b7280',
    marginTop: 4,
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
  },
  methodNote: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 8,
    fontStyle: 'italic',
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  historyDate: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
  },
  historyMeta: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 2,
  },
  historyScore: {
    fontSize: 20,
    fontWeight: 'bold',
    marginLeft: 8,
  },
});
