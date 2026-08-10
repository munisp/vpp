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
  const { data: drStatus } = trpc.demandResponse.getStatus.useQuery();
  const { data: currentUser } = trpc.auth.me.useQuery();

  const [refreshing, setRefreshing] = React.useState(false);

  const onRefresh = async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  };

  // Calculate totals
  const totalCapacity = assets?.reduce((sum, asset) => sum + asset.capacity, 0) || 0;
  const activeAssets = assets?.filter(a => a.status === 'active').length || 0;
  const totalEarnings = earnings?.totalEarnings || 0;

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
          title="Total Earnings"
          value={`${(totalEarnings / 100).toFixed(0)} TZS`}
          icon="💰"
          color="#f59e0b"
        />
        <StatCard
          title="DR Events"
          value={drStatus?.activeEvents?.toString() || '0'}
          icon="🎯"
          color="#8b5cf6"
        />
      </View>

      {/* Energy Production Chart */}
      <View style={styles.chartCard}>
        <Text style={styles.chartTitle}>Energy Production (Last 7 Days)</Text>
        <LineChart
          data={{
            labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
            datasets: [
              {
                data: [45, 52, 48, 58, 55, 60, 54],
              },
            ],
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
      </View>

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

      {/* Recent Activity */}
      <View style={styles.activityCard}>
        <Text style={styles.sectionTitle}>Recent Activity</Text>
        <ActivityItem
          icon="⚡"
          title="Energy Sold"
          description="150 kWh sold to grid"
          time="2 hours ago"
        />
        <ActivityItem
          icon="💰"
          title="Payment Received"
          description="45,000 TZS credited"
          time="5 hours ago"
        />
        <ActivityItem
          icon="🎯"
          title="DR Event Completed"
          description="Peak shaving event - 25 kW reduced"
          time="1 day ago"
        />
      </View>
    </ScrollView>
  );
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
