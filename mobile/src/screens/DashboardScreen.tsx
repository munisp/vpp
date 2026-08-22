import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { trpc } from '../services/trpc';
import { LineChart } from 'react-native-chart-kit';
import { Dimensions } from 'react-native';

const screenWidth = Dimensions.get('window').width;

export default function DashboardScreen({ navigation }: any) {
  const { data: assets, isLoading: assetsLoading, refetch } = trpc.assets.list.useQuery();
  const { data: earnings } = trpc.trading.getEarnings.useQuery();
  const { data: drEnrollment } = trpc.demandResponse.getEnrollment.useQuery();
  const { data: upcomingDrEvents } = trpc.demandResponse.getUpcomingEvents.useQuery();
  const { data: currentUser } = trpc.auth.me.useQuery();
  const { data: recentPayments } = trpc.payments.list.useQuery({ limit: 5 });
  const { data: recentTradesData } = trpc.trading.list.useQuery({ limit: 5 });

  // 7-day telemetry window for the production chart (first asset).
  const firstAssetId = assets && assets.length > 0 ? assets[0].id : null;
  const chartWindow = React.useMemo(() => {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - 7 * 24 * 60 * 60 * 1000);
    return {
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
    };
  }, [firstAssetId]);
  const { data: weekTelemetry, isLoading: weekLoading } =
    trpc.telemetry.getHistorical.useQuery(
      {
        assetId: firstAssetId!,
        startTime: chartWindow.startTime,
        endTime: chartWindow.endTime,
      },
      { enabled: !!firstAssetId }
    );

  const [refreshing, setRefreshing] = React.useState(false);

  const onRefresh = async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  };

  // Calculate totals
  const totalCapacity = assets?.reduce((sum, asset) => sum + asset.capacity, 0) || 0;
  const activeAssets = assets?.filter(a => a.status === 'active').length || 0;
  const netEarningsCents = earnings?.netCents;

  // Daily energy production (kWh) from real cumulative energy readings
  // (watt-hours). Per-day production = last reading - first reading.
  const dailyProduction = React.useMemo(() => {
    if (!weekTelemetry || weekTelemetry.length === 0) return null;
    const byDay = new Map<string, number[]>();
    for (const row of weekTelemetry) {
      if (row.energy == null) continue;
      const day = new Date(row.timestamp).toDateString();
      const list = byDay.get(day) ?? [];
      list.push(row.energy);
      byDay.set(day, list);
    }
    if (byDay.size === 0) return null;
    const days = Array.from(byDay.entries()).sort(
      (a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime()
    );
    const labels = days.map(([day]) =>
      new Date(day).toLocaleDateString([], { weekday: 'short' })
    );
    const data = days.map(([, values]) => {
      const min = Math.min(...values);
      const max = Math.max(...values);
      return Math.max(0, (max - min) / 1000); // Wh -> kWh
    });
    if (data.every((v) => v === 0)) return null;
    return { labels, data };
  }, [weekTelemetry]);

  // Recent activity merged from real payments and trades.
  const recentActivity = React.useMemo(() => {
    const items: {
      icon: string;
      title: string;
      description: string;
      date: Date;
    }[] = [];
    for (const p of recentPayments ?? []) {
      items.push({
        icon: '💰',
        title: 'Payment',
        description: `${(p.amount / 100).toFixed(0)} ${p.currency || 'TZS'} · ${p.status}`,
        date: new Date(p.createdAt),
      });
    }
    for (const t of recentTradesData?.trades ?? []) {
      const isSell = t.tradeType === 'export' || t.tradeType === 'p2p_sell';
      items.push({
        icon: '⚡',
        title: isSell ? 'Energy Sold' : 'Energy Bought',
        description: `${(t.energy / 1000).toFixed(2)} kWh · ${t.status}`,
        date: new Date(t.createdAt),
      });
    }
    return items
      .sort((a, b) => b.date.getTime() - a.date.getTime())
      .slice(0, 5);
  }, [recentPayments, recentTradesData]);

  return (
    <ScrollView
      style={styles.container}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.greeting}>Welcome back!</Text>
        <Text style={styles.subtitle}>Here's your energy overview</Text>
      </View>

      {/* Stats Cards */}
      <View style={styles.statsGrid}>
        <StatCard
          title="Total Capacity"
          value={`${(totalCapacity / 1000).toFixed(1)} kW`}
          icon="⚡"
          color="#10b981"
        />
        <StatCard
          title="Active Assets"
          value={activeAssets.toString()}
          icon="📊"
          color="#3b82f6"
        />
        <StatCard
          title="Net Earnings"
          value={
            netEarningsCents != null
              ? `${(netEarningsCents / 100).toFixed(0)} TZS`
              : '—'
          }
          icon="💰"
          color="#f59e0b"
        />
        <StatCard
          title="DR Events"
          value={(upcomingDrEvents?.length ?? 0).toString()}
          icon="🎯"
          color="#8b5cf6"
        />
      </View>

      {/* Energy Production Chart (real telemetry; hidden fabrication removed) */}
      <View style={styles.chartCard}>
        <Text style={styles.chartTitle}>Energy Production (Last 7 Days)</Text>
        {firstAssetId == null ? (
          <Text style={styles.chartEmpty}>
            Register an asset to see energy production data.
          </Text>
        ) : weekLoading ? (
          <Text style={styles.chartEmpty}>Loading production data…</Text>
        ) : dailyProduction ? (
          <LineChart
            data={{
              labels: dailyProduction.labels,
              datasets: [{ data: dailyProduction.data }],
            }}
            width={screenWidth - 48}
            height={200}
            chartConfig={{
              backgroundColor: '#fff',
              backgroundGradientFrom: '#fff',
              backgroundGradientTo: '#fff',
              decimalPlaces: 0,
              color: (opacity = 1) => `rgba(16, 185, 129, ${opacity})`,
              style: {
                borderRadius: 16,
              },
            }}
            bezier
            style={styles.chart}
          />
        ) : (
          <Text style={styles.chartEmpty}>
            No production data recorded in the last 7 days.
          </Text>
        )}
      </View>

      {/* DR enrollment banner */}
      {drEnrollment === null && (
        <View style={styles.actionsCard}>
          <Text style={styles.sectionTitle}>Demand Response</Text>
          <Text style={styles.drBannerText}>
            You are not enrolled in the demand response program yet.
          </Text>
          <TouchableOpacity
            style={styles.drBannerButton}
            onPress={() => navigation.navigate('DR')}
          >
            <Text style={styles.drBannerButtonText}>Enroll Now</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Quick Actions */}
      <View style={styles.actionsCard}>
        <Text style={styles.sectionTitle}>Quick Actions</Text>
        <View style={styles.actionsGrid}>
          <ActionButton
            icon="➕"
            label="Add Asset"
            onPress={() => navigation.navigate('Assets')}
          />
          <ActionButton
            icon="💱"
            label="Trade Energy"
            onPress={() => navigation.navigate('Trading')}
          />
          <ActionButton
            icon="💳"
            label="Payments"
            onPress={() => navigation.navigate('Payments')}
          />
          <ActionButton
            icon="⚙️"
            label="Settings"
            onPress={() => navigation.navigate('Settings')}
          />
        </View>
      </View>

      {/* Insights & Tools */}
      <View style={styles.actionsCard}>
        <Text style={styles.sectionTitle}>Insights & Tools</Text>
        <View style={styles.actionsGrid}>
          <ActionButton
            icon="👛"
            label="Wallet"
            onPress={() => navigation.navigate('Wallet')}
          />
          <ActionButton
            icon="🤖"
            label="Advisor"
            onPress={() => navigation.navigate('Advisor')}
          />
          <ActionButton
            icon="🌱"
            label="Carbon"
            onPress={() => navigation.navigate('Carbon')}
          />
          <ActionButton
            icon="🔋"
            label="Battery"
            onPress={() => navigation.navigate('BatteryHealth')}
          />
          <ActionButton
            icon="☀️"
            label="Solar Yield"
            onPress={() => navigation.navigate('SolarYield')}
          />
          <ActionButton
            icon="🔔"
            label="Price Alerts"
            onPress={() => navigation.navigate('PriceAlerts')}
          />
          <ActionButton
            icon="🎛️"
            label="Controls"
            onPress={() => navigation.navigate('ControlWindows')}
          />
          <ActionButton
            icon="🎯"
            label="Forecasts"
            onPress={() => navigation.navigate('ForecastAccuracy')}
          />
          <ActionButton
            icon="📖"
            label="Order Book"
            onPress={() => navigation.navigate('OrderBook')}
          />
          <ActionButton
            icon="🤝"
            label="P2P Market"
            onPress={() => navigation.navigate('P2PTrading')}
          />
          <ActionButton
            icon="📷"
            label="QR Payment"
            onPress={() => navigation.navigate('QRPayment')}
          />
          <ActionButton
            icon="📲"
            label="Register Device"
            onPress={() => navigation.navigate('QRDeviceRegistration')}
          />
          <ActionButton
            icon="🏆"
            label="Rewards"
            onPress={() => navigation.navigate('Gamification')}
          />
        </View>
      </View>

      {/* Admin Actions (only for admins) */}
      {currentUser?.role === 'admin' && (
        <View style={styles.actionsCard}>
          <Text style={styles.sectionTitle}>Admin Tools</Text>
          <View style={styles.actionsGrid}>
            <ActionButton
              icon="📊"
              label="Analytics"
              onPress={() => navigation.navigate('AdminAnalytics')}
            />
            <ActionButton
              icon="📝"
              label="Audit Logs"
              onPress={() => navigation.navigate('AuditLogs')}
            />
            <ActionButton
              icon="👥"
              label="Users"
              onPress={() => navigation.navigate('Settings')}
            />
            <ActionButton
              icon="⚡"
              label="Strategies"
              onPress={() => navigation.navigate('TradingStrategies')}
            />
            <ActionButton
              icon="🔄"
              label="Workflows"
              onPress={() => navigation.navigate('WorkflowMonitor')}
            />
          </View>
        </View>
      )}

      {/* Recent Activity (real payments and trades) */}
      <View style={styles.activityCard}>
        <Text style={styles.sectionTitle}>Recent Activity</Text>
        {recentActivity.length === 0 ? (
          <Text style={styles.chartEmpty}>No recent activity yet.</Text>
        ) : (
          recentActivity.map((item, index) => (
            <ActivityItem
              key={index}
              icon={item.icon}
              title={item.title}
              description={item.description}
              time={formatRelativeTime(item.date)}
            />
          ))
        )}
      </View>
    </ScrollView>
  );
}

function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}

function StatCard({
  title,
  value,
  icon,
  color,
}: {
  title: string;
  value: string;
  icon: string;
  color: string;
}) {
  return (
    <View style={[styles.statCard, { borderLeftColor: color }]}>
      <Text style={styles.statIcon}>{icon}</Text>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statTitle}>{title}</Text>
    </View>
  );
}

function ActionButton({
  icon,
  label,
  onPress,
}: {
  icon: string;
  label: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.actionButton} onPress={onPress}>
      <Text style={styles.actionIcon}>{icon}</Text>
      <Text style={styles.actionLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

function ActivityItem({
  icon,
  title,
  description,
  time,
}: {
  icon: string;
  title: string;
  description: string;
  time: string;
}) {
  return (
    <View style={styles.activityItem}>
      <View style={styles.activityIcon}>
        <Text style={styles.activityIconText}>{icon}</Text>
      </View>
      <View style={styles.activityContent}>
        <Text style={styles.activityTitle}>{title}</Text>
        <Text style={styles.activityDescription}>{description}</Text>
      </View>
      <Text style={styles.activityTime}>{time}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
  },
  header: {
    padding: 24,
    backgroundColor: '#10b981',
    paddingTop: 60,
  },
  greeting: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#fff',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 16,
    color: '#d1fae5',
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: 16,
    marginTop: -32,
  },
  statCard: {
    width: '48%',
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 12,
    margin: '1%',
    borderLeftWidth: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  statIcon: {
    fontSize: 24,
    marginBottom: 8,
  },
  statValue: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#111827',
    marginBottom: 4,
  },
  statTitle: {
    fontSize: 12,
    color: '#6b7280',
  },
  chartCard: {
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
  chartTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 16,
  },
  chart: {
    borderRadius: 8,
  },
  chartEmpty: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
    paddingVertical: 24,
  },
  drBannerText: {
    fontSize: 14,
    color: '#6b7280',
    marginBottom: 12,
  },
  drBannerButton: {
    backgroundColor: '#8b5cf6',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  drBannerButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
  actionsCard: {
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
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 16,
  },
  actionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  actionButton: {
    width: '48%',
    aspectRatio: 1,
    backgroundColor: '#f3f4f6',
    borderRadius: 12,
    margin: '1%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionIcon: {
    fontSize: 32,
    marginBottom: 8,
  },
  actionLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#374151',
  },
  activityCard: {
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
    marginBottom: 32,
  },
  activityItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  activityIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#f0fdf4',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  activityIconText: {
    fontSize: 20,
  },
  activityContent: {
    flex: 1,
  },
  activityTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 2,
  },
  activityDescription: {
    fontSize: 12,
    color: '#6b7280',
  },
  activityTime: {
    fontSize: 11,
    color: '#9ca3af',
  },
});
