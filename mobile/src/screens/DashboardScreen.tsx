import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { trpc } from '../services/trpc';
import {
  MobileNavGroup,
  getMobileNavGroups,
  searchMobileNav,
} from '../../../shared/mobile-nav';
import { LineChart } from 'react-native-chart-kit';
import { Dimensions } from 'react-native';

const screenWidth = Dimensions.get('window').width;

export default function DashboardScreen({ navigation }: any) {
  const { data: assetList, isLoading: assetsLoading, refetch } = trpc.assets.list.useQuery();
  const assets = assetList?.assets;
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

      {/* Destinations, grouped and collapsed so the dashboard does not become
          one long scroll of buttons. */}
      <NavigatorSection
        role={currentUser?.role}
        onNavigate={screen => navigation.navigate(screen)}
      />

      {/* Programs & Tools: new innovation screens, kept as a local grid because
          the shared mobile-nav registry is owned by another workstream. */}
      <View style={styles.actionsCard}>
        <Text style={styles.sectionTitle}>Programs & Tools</Text>
        <View style={styles.actionsGrid}>
          <ActionButton
            icon="🎯"
            label="Budget"
            onPress={() => navigation.navigate('BudgetPlanner')}
          />
          <ActionButton
            icon="🚗"
            label="EV Charging"
            onPress={() => navigation.navigate('EvCharging')}
          />
          <ActionButton
            icon="⚠️"
            label="Outage Risk"
            onPress={() => navigation.navigate('OutageRisk')}
          />
          <ActionButton
            icon="🏷️"
            label="Tariffs"
            onPress={() => navigation.navigate('TariffAdvisor')}
          />
          <ActionButton
            icon="🏅"
            label="Challenges"
            onPress={() => navigation.navigate('Challenges')}
          />
          <ActionButton
            icon="📬"
            label="Digest"
            onPress={() => navigation.navigate('DigestSettings')}
          />
          <ActionButton
            icon="🏘️"
            label="Portfolio"
            onPress={() => navigation.navigate('Portfolio')}
          />
          <ActionButton
            icon="🔧"
            label="Work Orders"
            onPress={() => navigation.navigate('WorkOrders')}
          />
        </View>
      </View>

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


/**
 * Groups every destination behind collapsed section headers with a filter, so
 * reaching a page is a search or two taps rather than a long scroll. Only the
 * quick actions start expanded.
 */
function NavigatorSection({
  role,
  onNavigate,
}: {
  role?: string;
  onNavigate: (screen: string) => void;
}) {
  const groups = React.useMemo(() => getMobileNavGroups(role), [role]);
  const [query, setQuery] = React.useState('');
  const [openGroups, setOpenGroups] = React.useState<string[]>(() =>
    getMobileNavGroups(role)
      .filter(group => group.defaultOpen)
      .map(group => group.id)
  );
  const matches = React.useMemo(() => searchMobileNav(groups, query), [groups, query]);

  const toggle = (group: MobileNavGroup) =>
    setOpenGroups(previous =>
      previous.includes(group.id)
        ? previous.filter(id => id !== group.id)
        : [...previous, group.id]
    );

  const go = (screen: string) => {
    setQuery('');
    onNavigate(screen);
  };

  return (
    <View style={styles.actionsCard}>
      <Text style={styles.sectionTitle}>Go to</Text>
      <TextInput
        style={styles.navSearch}
        value={query}
        onChangeText={setQuery}
        placeholder="Find a page"
        placeholderTextColor="#9ca3af"
        autoCorrect={false}
        accessibilityLabel="Find a page"
      />

      {query.trim() ? (
        matches.length === 0 ? (
          <Text style={styles.navEmpty}>No page matches “{query.trim()}”.</Text>
        ) : (
          matches.map(({ item, groupLabel }) => (
            <TouchableOpacity
              key={item.screen}
              style={styles.navRow}
              onPress={() => go(item.screen)}
            >
              <Text style={styles.navRowIcon}>{item.icon}</Text>
              <Text style={styles.navRowLabel}>{item.label}</Text>
              <Text style={styles.navRowGroup}>{groupLabel}</Text>
            </TouchableOpacity>
          ))
        )
      ) : (
        groups.map(group => {
          const isOpen = openGroups.includes(group.id);
          return (
            <View key={group.id}>
              <TouchableOpacity
                style={styles.navGroupHeader}
                onPress={() => toggle(group)}
                accessibilityRole="button"
                accessibilityState={{ expanded: isOpen }}
              >
                <Text style={styles.navGroupChevron}>{isOpen ? '\u2304' : '\u203A'}</Text>
                <Text style={styles.navGroupLabel}>{group.label}</Text>
                <Text style={styles.navGroupCount}>{group.items.length}</Text>
              </TouchableOpacity>
              {isOpen && (
                <View style={styles.actionsGrid}>
                  {group.items.map(item => (
                    <ActionButton
                      key={item.screen}
                      icon={item.icon}
                      label={item.label}
                      onPress={() => go(item.screen)}
                    />
                  ))}
                </View>
              )}
            </View>
          );
        })
      )}
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
  navSearch: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    color: '#111827',
    marginBottom: 12,
  },
  navEmpty: {
    fontSize: 14,
    color: '#6b7280',
    paddingVertical: 12,
  },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  navRowIcon: {
    fontSize: 18,
    marginRight: 10,
  },
  navRowLabel: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
    color: '#111827',
  },
  navRowGroup: {
    fontSize: 11,
    color: '#9ca3af',
  },
  navGroupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#f3f4f6',
  },
  navGroupChevron: {
    fontSize: 16,
    color: '#6b7280',
    width: 18,
  },
  navGroupLabel: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
  },
  navGroupCount: {
    fontSize: 12,
    color: '#9ca3af',
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
