import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
} from 'react-native';
import { trpc } from '../services/trpc';
import { LineChart } from 'react-native-chart-kit';
import { Dimensions } from 'react-native';

const screenWidth = Dimensions.get('window').width;

export default function MonitoringScreen() {
  const [selectedAsset, setSelectedAsset] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const { data: assets } = trpc.assets.list.useQuery();
  const { data: telemetry, refetch } = trpc.monitoring.getTelemetry.useQuery(
    { assetId: selectedAsset!, hours: 24 },
    { enabled: !!selectedAsset }
  );

  useEffect(() => {
    if (assets && assets.length > 0 && !selectedAsset) {
      setSelectedAsset(assets[0].id);
    }
  }, [assets]);

  const onRefresh = async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  };

  const latestData = telemetry && telemetry.length > 0 ? telemetry[0] : null;

  // Prepare chart data
  const chartData = telemetry
    ? {
        labels: telemetry.slice(0, 7).reverse().map((_, i) => `${i * 4}h`),
        datasets: [
          {
            data: telemetry
              .slice(0, 7)
              .reverse()
              .map((t) => (t.power || 0) / 1000), // Convert to kW
          },
        ],
      }
    : { labels: [], datasets: [{ data: [0] }] };

  return (
    <ScrollView
      style={styles.container}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    >
      {/* Asset Selector */}
      {assets && assets.length > 0 && (
        <View style={styles.assetSelector}>
          <Text style={styles.selectorLabel}>Select Asset:</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {assets.map((asset) => (
              <TouchableOpacity
                key={asset.id}
                style={[
                  styles.assetChip,
                  selectedAsset === asset.id && styles.assetChipActive,
                ]}
                onPress={() => setSelectedAsset(asset.id)}
              >
                <Text
                  style={[
                    styles.assetChipText,
                    selectedAsset === asset.id && styles.assetChipTextActive,
                  ]}
                >
                  {asset.name}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Real-time Metrics */}
      {latestData && (
        <View style={styles.metricsCard}>
          <Text style={styles.cardTitle}>Real-time Metrics</Text>
          <View style={styles.metricsGrid}>
            <MetricItem
              label="Power"
              value={`${((latestData.power || 0) / 1000).toFixed(2)} kW`}
              icon="⚡"
              color="#10b981"
            />
            <MetricItem
              label="Voltage"
              value={`${((latestData.voltage || 0) / 1000).toFixed(1)} V`}
              icon="🔌"
              color="#3b82f6"
            />
            <MetricItem
              label="Current"
              value={`${((latestData.current || 0) / 1000).toFixed(2)} A`}
              icon="⚙️"
              color="#f59e0b"
            />
            <MetricItem
              label="Frequency"
              value={`${((latestData.frequency || 0) / 1000).toFixed(2)} Hz`}
              icon="📊"
              color="#8b5cf6"
            />
            {latestData.stateOfCharge !== null && (
              <MetricItem
                label="Battery SoC"
                value={`${((latestData.stateOfCharge || 0) / 100).toFixed(0)}%`}
                icon="🔋"
                color="#06b6d4"
              />
            )}
            {latestData.temperature !== null && (
              <MetricItem
                label="Temperature"
                value={`${((latestData.temperature || 0) / 100).toFixed(1)}°C`}
                icon="🌡️"
                color="#ef4444"
              />
            )}
          </View>
        </View>
      )}

      {/* Power Chart */}
      {telemetry && telemetry.length > 0 && (
        <View style={styles.chartCard}>
          <Text style={styles.cardTitle}>Power Output (Last 24 Hours)</Text>
          <LineChart
            data={chartData}
            width={screenWidth - 48}
            height={220}
            chartConfig={{
              backgroundColor: '#fff',
              backgroundGradientFrom: '#fff',
              backgroundGradientTo: '#fff',
              decimalPlaces: 2,
              color: (opacity = 1) => `rgba(16, 185, 129, ${opacity})`,
              labelColor: (opacity = 1) => `rgba(107, 114, 128, ${opacity})`,
              style: {
                borderRadius: 16,
              },
              propsForDots: {
                r: '4',
                strokeWidth: '2',
                stroke: '#10b981',
              },
            }}
            bezier
            style={styles.chart}
          />
        </View>
      )}

      {/* Energy Production */}
      {latestData && (
        <View style={styles.energyCard}>
          <Text style={styles.cardTitle}>Energy Production</Text>
          <View style={styles.energyStats}>
            <View style={styles.energyStat}>
              <Text style={styles.energyValue}>
                {((latestData.energy || 0) / 1000).toFixed(2)} kWh
              </Text>
              <Text style={styles.energyLabel}>Total Energy</Text>
            </View>
            <View style={styles.energyDivider} />
            <View style={styles.energyStat}>
              <Text style={styles.energyValue}>
                {((latestData.power || 0) / 1000).toFixed(2)} kW
              </Text>
              <Text style={styles.energyLabel}>Current Power</Text>
            </View>
          </View>
        </View>
      )}

      {/* Status Indicators */}
      {latestData && (
        <View style={styles.statusCard}>
          <Text style={styles.cardTitle}>System Status</Text>
          <StatusItem
            label="Grid Connection"
            status="Connected"
            color="#10b981"
          />
          <StatusItem
            label="Power Quality"
            status={
              latestData.frequency &&
              Math.abs(latestData.frequency - 50000) < 500
                ? 'Good'
                : 'Warning'
            }
            color={
              latestData.frequency &&
              Math.abs(latestData.frequency - 50000) < 500
                ? '#10b981'
                : '#f59e0b'
            }
          />
          <StatusItem
            label="Asset Health"
            status="Operational"
            color="#10b981"
          />
        </View>
      )}

      {!selectedAsset && (
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>📊</Text>
          <Text style={styles.emptyText}>
            No assets to monitor. Register an asset to start monitoring.
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

function MetricItem({
  label,
  value,
  icon,
  color,
}: {
  label: string;
  value: string;
  icon: string;
  color: string;
}) {
  return (
    <View style={[styles.metricItem, { borderLeftColor: color }]}>
      <Text style={styles.metricIcon}>{icon}</Text>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

function StatusItem({
  label,
  status,
  color,
}: {
  label: string;
  status: string;
  color: string;
}) {
  return (
    <View style={styles.statusItem}>
      <Text style={styles.statusLabel}>{label}</Text>
      <View style={styles.statusBadge}>
        <View style={[styles.statusDot, { backgroundColor: color }]} />
        <Text style={[styles.statusText, { color }]}>{status}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
  },
  assetSelector: {
    backgroundColor: '#fff',
    padding: 16,
    paddingTop: 60,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  selectorLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#6b7280',
    marginBottom: 12,
  },
  assetChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#f3f4f6',
    marginRight: 8,
  },
  assetChipActive: {
    backgroundColor: '#10b981',
  },
  assetChipText: {
    color: '#6b7280',
    fontWeight: '500',
  },
  assetChipTextActive: {
    color: '#fff',
  },
  metricsCard: {
    backgroundColor: '#fff',
    margin: 16,
    padding: 16,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 16,
  },
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -4,
  },
  metricItem: {
    width: '48%',
    backgroundColor: '#f9fafb',
    padding: 12,
    borderRadius: 8,
    margin: '1%',
    borderLeftWidth: 3,
  },
  metricIcon: {
    fontSize: 20,
    marginBottom: 8,
  },
  metricValue: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#111827',
    marginBottom: 4,
  },
  metricLabel: {
    fontSize: 12,
    color: '#6b7280',
  },
  chartCard: {
    backgroundColor: '#fff',
    margin: 16,
    marginTop: 0,
    padding: 16,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  chart: {
    borderRadius: 8,
    marginVertical: 8,
  },
  energyCard: {
    backgroundColor: '#fff',
    margin: 16,
    marginTop: 0,
    padding: 16,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  energyStats: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  energyStat: {
    flex: 1,
    alignItems: 'center',
  },
  energyValue: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#10b981',
    marginBottom: 4,
  },
  energyLabel: {
    fontSize: 12,
    color: '#6b7280',
  },
  energyDivider: {
    width: 1,
    height: 40,
    backgroundColor: '#e5e7eb',
  },
  statusCard: {
    backgroundColor: '#fff',
    margin: 16,
    marginTop: 0,
    marginBottom: 32,
    padding: 16,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  statusItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  statusLabel: {
    fontSize: 14,
    color: '#374151',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  statusText: {
    fontSize: 14,
    fontWeight: '600',
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 48,
  },
  emptyIcon: {
    fontSize: 64,
    marginBottom: 16,
  },
  emptyText: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
  },
});
