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
import { trpc } from '../lib/trpc';
import { Ionicons } from '@expo/vector-icons';

const screenWidth = Dimensions.get('window').width;

type DateRange = 'today' | 'week' | 'month' | 'year';

export default function AdminAnalyticsScreen() {
  const [dateRange, setDateRange] = useState<DateRange>('month');
  const [refreshing, setRefreshing] = useState(false);

  const { data: userGrowth, isLoading: loadingUserGrowth, refetch: refetchUserGrowth } =
    trpc.adminAnalytics.getUserGrowth.useQuery({ period: dateRange });
  
  const { data: tradingMetrics, isLoading: loadingTrading, refetch: refetchTrading } =
    trpc.adminAnalytics.getTradingMetrics.useQuery({ period: dateRange });
  
  const { data: revenueMetrics, isLoading: loadingRevenue, refetch: refetchRevenue } =
    trpc.adminAnalytics.getRevenueMetrics.useQuery({ period: dateRange });
  
  const { data: systemHealth, isLoading: loadingHealth, refetch: refetchHealth } =
    trpc.adminAnalytics.getSystemHealth.useQuery();

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([
      refetchUserGrowth(),
      refetchTrading(),
      refetchRevenue(),
      refetchHealth(),
    ]);
    setRefreshing(false);
  };

  const isLoading = loadingUserGrowth || loadingTrading || loadingRevenue || loadingHealth;

  if (isLoading && !refreshing) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#10b981" />
      </View>
    );
  }

  // Prepare chart data
  const userGrowthChartData = {
    labels: userGrowth?.data.map((d) => d.label) || [],
    datasets: [
      {
        data: userGrowth?.data.map((d) => d.value) || [0],
        color: (opacity = 1) => `rgba(16, 185, 129, ${opacity})`,
        strokeWidth: 2,
      },
    ],
  };

  const tradingVolumeChartData = {
    labels: tradingMetrics?.volumeByPeriod.map((d) => d.label) || [],
    datasets: [
      {
        data: tradingMetrics?.volumeByPeriod.map((d) => d.value) || [0],
      },
    ],
  };

  const revenueChartData = {
    labels: revenueMetrics?.revenueByPeriod.map((d) => d.label) || [],
    datasets: [
      {
        data: revenueMetrics?.revenueByPeriod.map((d) => d.value) || [0],
        color: (opacity = 1) => `rgba(59, 130, 246, ${opacity})`,
        strokeWidth: 2,
      },
    ],
  };

  const tradeTypesPieData = tradingMetrics?.tradeTypes.map((t, index) => ({
    name: t.type,
    population: t.count,
    color: ['#10b981', '#3b82f6', '#f59e0b'][index % 3],
    legendFontColor: '#374151',
    legendFontSize: 12,
  })) || [];

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
            <Text style={styles.kpiValue}>{userGrowth?.totalUsers || 0}</Text>
            <Text style={styles.kpiLabel}>Total Users</Text>
          </View>
          <View style={styles.kpiCard}>
            <Ionicons name="flash" size={24} color="#3b82f6" />
            <Text style={styles.kpiValue}>
              {((tradingMetrics?.totalEnergyTraded || 0) / 1000).toFixed(1)}k
            </Text>
            <Text style={styles.kpiLabel}>kWh Traded</Text>
          </View>
        </View>

        <View style={styles.kpiContainer}>
          <View style={styles.kpiCard}>
            <Ionicons name="cash" size={24} color="#f59e0b" />
            <Text style={styles.kpiValue}>
              {((revenueMetrics?.totalRevenue || 0) / 1000).toFixed(0)}k
            </Text>
            <Text style={styles.kpiLabel}>Revenue (TZS)</Text>
          </View>
          <View style={styles.kpiCard}>
            <Ionicons name="trending-up" size={24} color="#8b5cf6" />
            <Text style={styles.kpiValue}>{tradingMetrics?.activeTraders || 0}</Text>
            <Text style={styles.kpiLabel}>Active Traders</Text>
          </View>
        </View>

        {/* User Growth Chart */}
        <View style={styles.chartCard}>
          <Text style={styles.chartTitle}>User Growth</Text>
          <LineChart
            data={userGrowthChartData}
            width={screenWidth - 48}
            height={220}
            chartConfig={chartConfig}
            bezier
            style={styles.chart}
          />
        </View>

        {/* Trading Volume Chart */}
        <View style={styles.chartCard}>
          <Text style={styles.chartTitle}>Trading Volume (kWh)</Text>
          <BarChart
            data={tradingVolumeChartData}
            width={screenWidth - 48}
            height={220}
            chartConfig={{
              ...chartConfig,
              color: (opacity = 1) => `rgba(59, 130, 246, ${opacity})`,
            }}
            style={styles.chart}
            yAxisSuffix=""
          />
        </View>

        {/* Revenue Trends Chart */}
        <View style={styles.chartCard}>
          <Text style={styles.chartTitle}>Revenue Trends (TZS)</Text>
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
        </View>

        {/* Trade Types Distribution */}
        {tradeTypesPieData.length > 0 && (
          <View style={styles.chartCard}>
            <Text style={styles.chartTitle}>Trade Types Distribution</Text>
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
          </View>
        )}

        {/* System Health */}
        <View style={styles.chartCard}>
          <Text style={styles.chartTitle}>System Health</Text>
          <View style={styles.healthGrid}>
            <View style={styles.healthItem}>
              <Text style={styles.healthLabel}>Active Users (24h)</Text>
              <Text style={styles.healthValue}>{systemHealth?.activeUsers24h || 0}</Text>
            </View>
            <View style={styles.healthItem}>
              <Text style={styles.healthLabel}>Pending Trades</Text>
              <Text style={styles.healthValue}>{systemHealth?.pendingTrades || 0}</Text>
            </View>
            <View style={styles.healthItem}>
              <Text style={styles.healthLabel}>Failed Trades (24h)</Text>
              <Text style={styles.healthValue}>{systemHealth?.failedTrades24h || 0}</Text>
            </View>
            <View style={styles.healthItem}>
              <Text style={styles.healthLabel}>Avg Response Time</Text>
              <Text style={styles.healthValue}>
                {systemHealth?.avgResponseTime || 0}ms
              </Text>
            </View>
          </View>
        </View>

        {/* Top Performers */}
        <View style={styles.chartCard}>
          <Text style={styles.chartTitle}>Top Performers</Text>
          {tradingMetrics?.topTraders?.slice(0, 5).map((trader, index) => (
            <View key={trader.userId} style={styles.traderItem}>
              <View style={styles.traderRank}>
                <Text style={styles.traderRankText}>#{index + 1}</Text>
              </View>
              <View style={styles.traderInfo}>
                <Text style={styles.traderName}>{trader.userName}</Text>
                <Text style={styles.traderStats}>
                  {trader.totalTrades} trades • {(trader.totalEnergy / 1000).toFixed(1)}k kWh
                </Text>
              </View>
              <Text style={styles.traderRevenue}>
                {(trader.totalRevenue / 1000).toFixed(1)}k TZS
              </Text>
            </View>
          ))}
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
