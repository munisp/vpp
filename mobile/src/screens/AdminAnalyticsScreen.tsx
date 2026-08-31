import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Dimensions,
  RefreshControl,
} from 'react-native';
import { LineChart, BarChart, PieChart } from 'react-native-chart-kit';
import { trpc } from '../services/trpc';
import { Ionicons } from '@expo/vector-icons';

const screenWidth = Dimensions.get('window').width;

type DateRange = 'today' | 'week' | 'month' | 'year';

// The analytics router groups by calendar day and returns ISO dates.
const dayLabel = (date: string) => date.slice(5);

export default function AdminAnalyticsScreen() {
  const [dateRange, setDateRange] = useState<DateRange>('month');
  const [refreshing, setRefreshing] = useState(false);

  const dateRangeParams = React.useMemo(() => {
    const end = new Date();
    const start = new Date();
    switch (dateRange) {
      case 'today':
        start.setHours(0, 0, 0, 0);
        break;
      case 'week':
        start.setDate(start.getDate() - 7);
        break;
      case 'month':
        start.setMonth(start.getMonth() - 1);
        break;
      case 'year':
        start.setFullYear(start.getFullYear() - 1);
        break;
    }
    return { startDate: start.toISOString(), endDate: end.toISOString() };
  }, [dateRange]);

  const { data: userGrowth, isLoading: loadingUserGrowth, isError: errorUserGrowth, refetch: refetchUserGrowth } =
    trpc.adminAnalytics.getUserGrowth.useQuery(dateRangeParams);

  const { data: tradingMetrics, isLoading: loadingTrading, isError: errorTrading, refetch: refetchTrading } =
    trpc.adminAnalytics.getTradingMetrics.useQuery(dateRangeParams);

  const { data: revenueMetrics, isLoading: loadingRevenue, isError: errorRevenue, refetch: refetchRevenue } =
    trpc.adminAnalytics.getRevenueMetrics.useQuery(dateRangeParams);

  const { data: topPerformers, isLoading: loadingPerformers, isError: errorPerformers, refetch: refetchPerformers } =
    trpc.adminAnalytics.getTopPerformers.useQuery({ ...dateRangeParams, limit: 5 });

  const { data: systemHealth, isLoading: loadingHealth, isError: errorHealth, refetch: refetchHealth } =
    trpc.adminAnalytics.getSystemHealth.useQuery();

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([
      refetchUserGrowth(),
      refetchTrading(),
      refetchRevenue(),
      refetchPerformers(),
      refetchHealth(),
    ]);
    setRefreshing(false);
  };

  const isLoading =
    loadingUserGrowth || loadingTrading || loadingRevenue || loadingPerformers || loadingHealth;

  const isError =
    errorUserGrowth || errorTrading || errorRevenue || errorPerformers || errorHealth;

  if (isLoading && !refreshing) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#10b981" />
      </View>
    );
  }

  // Failed queries must not render as zeroed-out dashboards.
  if (isError) {
    return (
      <View style={styles.centerContainer}>
        <Ionicons name="alert-circle-outline" size={48} color="#ef4444" />
        <Text style={styles.errorTitle}>Could not load analytics</Text>
        <Text style={styles.errorText}>
          One or more analytics queries failed. Check your connection and try again.
        </Text>
        <TouchableOpacity style={styles.retryButton} onPress={onRefresh}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const usersByDate = userGrowth?.usersByDate ?? [];
  const tradesByDate = tradingMetrics?.tradesByDate ?? [];
  const revenueByDate = revenueMetrics?.revenueByDate ?? [];
  const tradesByType = tradingMetrics?.tradesByType ?? [];

  const userGrowthChartData = {
    labels: usersByDate.map((row) => dayLabel(row.date)),
    datasets: [
      {
        data: usersByDate.map((row) => row.count),
        color: (opacity = 1) => `rgba(16, 185, 129, ${opacity})`,
        strokeWidth: 2,
      },
    ],
  };

  const tradingVolumeChartData = {
    labels: tradesByDate.map((row) => dayLabel(row.date)),
    datasets: [{ data: tradesByDate.map((row) => row.energy) }],
  };

  // Payment amounts are stored in minor units (cents).
  const revenueChartData = {
    labels: revenueByDate.map((row) => dayLabel(row.date)),
    datasets: [
      {
        data: revenueByDate.map((row) => Number(row.revenue) / 100),
        color: (opacity = 1) => `rgba(59, 130, 246, ${opacity})`,
        strokeWidth: 2,
      },
    ],
  };

  const tradeTypesPieData = tradesByType.map((row, index) => ({
    name: row.type,
    population: row.count,
    color: ['#10b981', '#3b82f6', '#f59e0b'][index % 3],
    legendFontColor: '#374151',
    legendFontSize: 12,
  }));

  const chartConfig = {
    backgroundColor: '#ffffff',
    backgroundGradientFrom: '#ffffff',
    backgroundGradientTo: '#ffffff',
    decimalPlaces: 0,
    color: (opacity = 1) => `rgba(16, 185, 129, ${opacity})`,
    labelColor: (opacity = 1) => `rgba(55, 65, 81, ${opacity})`,
    style: {
      borderRadius: 16,
    },
    propsForDots: {
      r: '4',
      strokeWidth: '2',
      stroke: '#10b981',
    },
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Analytics Dashboard</Text>
      </View>

      {/* Date Range Filter */}
      <View style={styles.filterContainer}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {(['today', 'week', 'month', 'year'] as DateRange[]).map((range) => (
            <TouchableOpacity
              key={range}
              style={[
                styles.filterButton,
                dateRange === range && styles.filterButtonActive,
              ]}
              onPress={() => setDateRange(range)}
            >
              <Text
                style={[
                  styles.filterButtonText,
                  dateRange === range && styles.filterButtonTextActive,
                ]}
              >
                {range.charAt(0).toUpperCase() + range.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      <ScrollView
        style={styles.scrollView}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        {/* KPI Cards */}
        <View style={styles.kpiContainer}>
          <View style={styles.kpiCard}>
            <Ionicons name="people" size={24} color="#10b981" />
            <Text style={styles.kpiValue}>{userGrowth?.totalUsers ?? 0}</Text>
            <Text style={styles.kpiLabel}>Total Users</Text>
          </View>
          <View style={styles.kpiCard}>
            <Ionicons name="flash" size={24} color="#3b82f6" />
            <Text style={styles.kpiValue}>{tradingMetrics?.totalEnergy ?? 0}</Text>
            <Text style={styles.kpiLabel}>kWh Traded (executed)</Text>
          </View>
        </View>

        <View style={styles.kpiContainer}>
          <View style={styles.kpiCard}>
            <Ionicons name="cash" size={24} color="#f59e0b" />
            <Text style={styles.kpiValue}>
              {(Number(revenueMetrics?.totalRevenue ?? 0) / 100).toFixed(0)}
            </Text>
            <Text style={styles.kpiLabel}>
              Completed payments ({revenueMetrics?.totalPayments ?? 0}), currencies not separated
            </Text>
          </View>
          <View style={styles.kpiCard}>
            <Ionicons name="trending-up" size={24} color="#8b5cf6" />
            <Text style={styles.kpiValue}>{userGrowth?.activeUsers ?? 0}</Text>
            <Text style={styles.kpiLabel}>Users who traded</Text>
          </View>
        </View>

        {/* User Growth Chart */}
        <View style={styles.chartCard}>
          <Text style={styles.chartTitle}>New Users per Day</Text>
          {usersByDate.length > 0 ? (
            <LineChart
              data={userGrowthChartData}
              width={screenWidth - 48}
              height={220}
              chartConfig={chartConfig}
              bezier
              style={styles.chart}
            />
          ) : (
            <Text style={styles.emptyText}>No users signed up in this range</Text>
          )}
        </View>

        {/* Trading Volume Chart */}
        <View style={styles.chartCard}>
          <Text style={styles.chartTitle}>Traded Energy per Day (kWh)</Text>
          {tradesByDate.length > 0 ? (
            <BarChart
              data={tradingVolumeChartData}
              width={screenWidth - 48}
              height={220}
              chartConfig={{
                ...chartConfig,
                color: (opacity = 1) => `rgba(59, 130, 246, ${opacity})`,
              }}
              style={styles.chart}
              yAxisLabel=""
              yAxisSuffix=""
            />
          ) : (
            <Text style={styles.emptyText}>No executed trades in this range</Text>
          )}
        </View>

        {/* Revenue Trends Chart */}
        <View style={styles.chartCard}>
          <Text style={styles.chartTitle}>Completed Payments per Day</Text>
          {revenueByDate.length > 0 ? (
            <LineChart
              data={revenueChartData}
              width={screenWidth - 48}
              height={220}
              chartConfig={{
                ...chartConfig,
                color: (opacity = 1) => `rgba(59, 130, 246, ${opacity})`,
              }}
              bezier
              style={styles.chart}
            />
          ) : (
            <Text style={styles.emptyText}>No completed payments in this range</Text>
          )}
        </View>

        {/* Trade Types Distribution */}
        <View style={styles.chartCard}>
          <Text style={styles.chartTitle}>Trade Types Distribution</Text>
          {tradeTypesPieData.length > 0 ? (
            <PieChart
              data={tradeTypesPieData}
              width={screenWidth - 48}
              height={220}
              chartConfig={chartConfig}
              accessor="population"
              backgroundColor="transparent"
              paddingLeft="15"
              style={styles.chart}
            />
          ) : (
            <Text style={styles.emptyText}>No executed trades in this range</Text>
          )}
        </View>

        {/* System Health */}
        <View style={styles.chartCard}>
          <Text style={styles.chartTitle}>System Health</Text>
          <View style={styles.healthGrid}>
            <View style={styles.healthItem}>
              <Text style={styles.healthLabel}>Registered Assets</Text>
              <Text style={styles.healthValue}>{systemHealth?.totalAssets ?? 0}</Text>
            </View>
            <View style={styles.healthItem}>
              <Text style={styles.healthLabel}>Active Assets</Text>
              <Text style={styles.healthValue}>
                {systemHealth?.activeAssets ?? 0} ({systemHealth?.assetHealthRate ?? '0'}%)
              </Text>
            </View>
            <View style={styles.healthItem}>
              <Text style={styles.healthLabel}>Telemetry Rows (24h)</Text>
              <Text style={styles.healthValue}>{systemHealth?.recentTelemetry ?? 0}</Text>
            </View>
            <View style={styles.healthItem}>
              <Text style={styles.healthLabel}>Pending Trades</Text>
              <Text style={styles.healthValue}>{systemHealth?.pendingTrades ?? 0}</Text>
            </View>
          </View>
        </View>

        {/* Top Performers */}
        <View style={styles.chartCard}>
          <Text style={styles.chartTitle}>Top Performers</Text>
          {(topPerformers?.topTraders ?? []).length > 0 ? (
            (topPerformers?.topTraders ?? []).map((trader, index) => (
              <View key={trader.userId} style={styles.traderItem}>
                <View style={styles.traderRank}>
                  <Text style={styles.traderRankText}>#{index + 1}</Text>
                </View>
                <View style={styles.traderInfo}>
                  <Text style={styles.traderName}>{trader.userName}</Text>
                  <Text style={styles.traderStats}>{trader.totalTrades} trades</Text>
                </View>
                <Text style={styles.traderRevenue}>{trader.totalEnergy} kWh</Text>
              </View>
            ))
          ) : (
            <Text style={styles.emptyText}>No executed trades in this range</Text>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f9fafb',
    padding: 24,
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
    marginTop: 12,
  },
  errorText: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 16,
  },
  retryButton: {
    backgroundColor: '#10b981',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  retryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  header: {
    padding: 16,
    paddingTop: 60,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#111827',
  },
  filterContainer: {
    backgroundColor: '#fff',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  filterButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginRight: 8,
    borderRadius: 20,
    backgroundColor: '#f3f4f6',
  },
  filterButtonActive: {
    backgroundColor: '#10b981',
  },
  filterButtonText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#374151',
  },
  filterButtonTextActive: {
    color: '#fff',
  },
  scrollView: {
    flex: 1,
  },
  kpiContainer: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 12,
  },
  kpiCard: {
    flex: 1,
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  kpiValue: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#111827',
    marginTop: 8,
  },
  kpiLabel: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 4,
  },
  chartCard: {
    backgroundColor: '#fff',
    margin: 16,
    marginBottom: 0,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  chartTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 16,
  },
  chart: {
    marginVertical: 8,
    borderRadius: 16,
  },
  emptyText: {
    fontSize: 13,
    color: '#6b7280',
    paddingVertical: 24,
    textAlign: 'center',
  },
  healthGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  healthItem: {
    flex: 1,
    minWidth: '45%',
    backgroundColor: '#f9fafb',
    padding: 12,
    borderRadius: 8,
  },
  healthLabel: {
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 4,
  },
  healthValue: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
  },
  traderItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  traderRank: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#f3f4f6',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  traderRankText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
  },
  traderInfo: {
    flex: 1,
  },
  traderName: {
    fontSize: 14,
    fontWeight: '500',
    color: '#111827',
    marginBottom: 2,
  },
  traderStats: {
    fontSize: 12,
    color: '#6b7280',
  },
  traderRevenue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#10b981',
  },
});
