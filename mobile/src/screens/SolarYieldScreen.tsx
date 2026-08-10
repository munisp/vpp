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

export default function SolarYieldScreen({ navigation }: any) {
  const [selectedAssetId, setSelectedAssetId] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const assetsQuery = trpc.assets.list.useQuery();

  const solarAssets = (assetsQuery.data?.assets ?? []).filter(
    (a) => a.assetType === 'solar'
  );

  // Auto-select the first solar asset once assets load.
  useEffect(() => {
    if (selectedAssetId == null && solarAssets.length > 0) {
      setSelectedAssetId(solarAssets[0].id);
    }
  }, [assetsQuery.data]);

  const enabled = selectedAssetId != null;
  const forecastQuery = trpc.solarYield.getYieldForecast.useQuery(
    { assetId: selectedAssetId as number },
    { enabled }
  );
  const prQuery = trpc.solarYield.getPerformanceRatio.useQuery(
    { assetId: selectedAssetId as number },
    { enabled }
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await Promise.all([
      assetsQuery.refetch(),
      enabled ? forecastQuery.refetch() : Promise.resolve(),
      enabled ? prQuery.refetch() : Promise.resolve(),
    ]);
    setRefreshing(false);
  };

  const forecast = forecastQuery.data;
  const pr = prQuery.data;

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
        <Text style={styles.title}>Solar Yield</Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Asset selector */}
      {assetsQuery.isLoading ? (
        <Text style={styles.emptyText}>Loading assets…</Text>
      ) : assetsQuery.isError ? (
        <Text style={styles.emptyText}>Could not load assets</Text>
      ) : solarAssets.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>
            No solar assets registered. Add a solar asset to see yield forecasts.
          </Text>
        </View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.selectorRow}
        >
          {solarAssets.map((a) => (
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

      {/* Forecast */}
      {enabled && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>3-Day Yield Forecast</Text>
          {forecastQuery.isLoading ? (
            <Text style={styles.emptyText}>Computing forecast…</Text>
          ) : forecastQuery.isError ? (
            <Text style={styles.emptyText}>
              {forecastQuery.error?.message || 'Could not compute forecast'}
            </Text>
          ) : forecast ? (
            <>
              {!forecast.forecastAvailable ? (
                <View style={styles.noticeBanner}>
                  <Ionicons name="cloud-offline" size={16} color="#92400e" />
                  <Text style={styles.noticeBannerText}>
                    {forecast.reason || 'Forecast unavailable'}
                  </Text>
                </View>
              ) : (
                <>
                  {forecast.mockData === true && (
                    <View style={styles.noticeBanner}>
                      <Ionicons name="flask" size={16} color="#92400e" />
                      <Text style={styles.noticeBannerText}>
                        Based on mock weather data (no live weather service configured)
                      </Text>
                    </View>
                  )}
                  {forecast.days.map((d, i) => (
                    <View
                      key={i}
                      style={[
                        styles.detailRow,
                        i === forecast.days.length - 1 && { borderBottomWidth: 0 },
                      ]}
                    >
                      <View>
                        <Text style={styles.dayDate}>{d.date}</Text>
                        <Text style={styles.daySub}>
                          {d.peakSunHours.toFixed(1)} peak sun hours
                        </Text>
                      </View>
                      <Text style={styles.detailValue}>
                        {d.expectedYieldWh != null
                          ? `${(d.expectedYieldWh / 1000).toFixed(1)} kWh`
                          : '—'}
                      </Text>
                    </View>
                  ))}
                  {forecast.learnedDerate == null && (
                    <Text style={styles.footnote}>
                      Expected yields unavailable — not enough history to learn a
                      performance ratio yet.
                    </Text>
                  )}
                </>
              )}
            </>
          ) : null}
        </View>
      )}

      {/* Performance ratio */}
      {enabled && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Performance Ratio</Text>
          {prQuery.isLoading ? (
            <Text style={styles.emptyText}>Analysing history…</Text>
          ) : prQuery.isError ? (
            <Text style={styles.emptyText}>
              {prQuery.error?.message || 'Could not compute performance ratio'}
            </Text>
          ) : pr ? (
            <>
              {pr.insufficientHistory && (
                <View style={styles.noticeBanner}>
                  <Ionicons name="information-circle" size={16} color="#92400e" />
                  <Text style={styles.noticeBannerText}>
                    Insufficient history ({pr.daysWithData} day
                    {pr.daysWithData === 1 ? '' : 's'} with data over the last{' '}
                    {pr.historyDays} days)
                  </Text>
                </View>
              )}
              {pr.underperforming && (
                <View style={styles.underperformBanner}>
                  <Ionicons name="trending-down" size={16} color="#dc2626" />
                  <Text style={styles.underperformText}>
                    Recent output is below this asset's learned baseline — check for
                    shading or soiling.
                  </Text>
                </View>
              )}
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Learned baseline (median PR)</Text>
                <Text style={styles.detailValue}>
                  {pr.learnedDerate != null ? pr.learnedDerate.toFixed(2) : '—'}
                </Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Recent PR</Text>
                <Text style={styles.detailValue}>
                  {pr.recentPerformanceRatio != null
                    ? pr.recentPerformanceRatio.toFixed(2)
                    : '—'}
                </Text>
              </View>
              <View style={[styles.detailRow, { borderBottomWidth: 0 }]}>
                <Text style={styles.detailLabel}>Location source</Text>
                <Text style={styles.detailValue}>
                  {pr.locationSource === 'asset' ? 'Asset coordinates' : 'Default (Tanzania)'}
                </Text>
              </View>

              {pr.daily.length > 0 && (
                <>
                  <Text style={[styles.sectionTitle, { marginTop: 16, fontSize: 15 }]}>
                    Recent Days
                  </Text>
                  {pr.daily.slice(-7).map((d, i) => (
                    <View
                      key={i}
                      style={[
                        styles.detailRow,
                        i === Math.min(pr.daily.length, 7) - 1 && { borderBottomWidth: 0 },
                      ]}
                    >
                      <View>
                        <Text style={styles.dayDate}>{d.date}</Text>
                        <Text style={styles.daySub}>
                          actual {(d.actualWh / 1000).toFixed(1)} kWh · clear-sky{' '}
                          {(d.clearSkyWh / 1000).toFixed(1)} kWh
                        </Text>
                      </View>
                      <Text style={styles.detailValue}>
                        {d.performanceRatio != null
                          ? `PR ${d.performanceRatio.toFixed(2)}`
                          : '—'}
                      </Text>
                    </View>
                  ))}
                </>
              )}
            </>
          ) : null}
        </View>
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
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 12,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
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
  },
  dayDate: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
  },
  daySub: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 2,
  },
  noticeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fef3c7',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 12,
    gap: 6,
  },
  noticeBannerText: {
    flex: 1,
    fontSize: 12,
    color: '#92400e',
    fontWeight: '600',
    lineHeight: 17,
  },
  underperformBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fee2e2',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 12,
    gap: 6,
  },
  underperformText: {
    flex: 1,
    fontSize: 12,
    color: '#dc2626',
    fontWeight: '600',
    lineHeight: 17,
  },
  footnote: {
    fontSize: 12,
    color: '#9ca3af',
    marginTop: 12,
    lineHeight: 17,
  },
  emptyText: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
    paddingVertical: 12,
    lineHeight: 20,
  },
});
