import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { trpc } from '../services/trpc';
import { HapticService } from '../services/hapticService';

type ChargeWindow = {
  startTime: string;
  endTime: string;
  priceCentsPerKwh: number;
  energyWh: number;
  costCents: number;
};

const UNAVAILABLE_REASONS: Record<string, string> = {
  no_tariff: 'No dynamic tariff is published for your country, so no cost-optimal schedule can be computed.',
  no_soc_telemetry: 'No state-of-charge telemetry has been recorded for this asset, so the energy needed is unknown.',
  insufficient_time: 'There is not enough time before departure to reach the target at the given charge power.',
};

const formatKwh = (wh: number | null | undefined) =>
  wh == null ? '—' : `${(wh / 1000).toFixed(2)} kWh`;

const formatCents = (cents: number | null | undefined) =>
  cents == null ? '—' : `${(cents / 100).toFixed(2)}`;

export default function EvChargingScreen({ navigation }: any) {
  const [refreshing, setRefreshing] = useState(false);

  // Plan form
  const [assetId, setAssetId] = useState<number | null>(null);
  const [hoursUntilDeparture, setHoursUntilDeparture] = useState('');
  const [targetSoc, setTargetSoc] = useState('');
  const [maxPowerW, setMaxPowerW] = useState('');

  const utils = trpc.useUtils();

  const assetsQuery = trpc.assets.list.useQuery();
  const batteryAssets = (assetsQuery.data?.assets ?? []).filter(
    (a) => a.assetType === 'battery'
  );

  const plansQuery = trpc.evChargingPlanner.listPlans.useQuery({ limit: 20 });
  const plans = plansQuery.data ?? [];

  const createPlanMutation = trpc.evChargingPlanner.createPlan.useMutation({
    onSuccess: async (plan) => {
      await HapticService.success();
      if (plan.scheduleAvailable) {
        Alert.alert('Plan Created', 'A cost-optimal charging schedule is ready.');
      } else {
        Alert.alert(
          'Plan Saved Without Schedule',
          UNAVAILABLE_REASONS[plan.unavailableReason ?? ''] ??
            'No schedule could be computed for this plan.'
        );
      }
      utils.evChargingPlanner.listPlans.invalidate();
    },
    onError: async (error) => {
      await HapticService.error();
      Alert.alert('Error', error.message);
    },
  });

  const cancelMutation = trpc.evChargingPlanner.cancelPlan.useMutation({
    onSuccess: async () => {
      await HapticService.success();
      utils.evChargingPlanner.listPlans.invalidate();
    },
    onError: async (error) => {
      await HapticService.error();
      Alert.alert('Error', error.message);
    },
  });

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await Promise.all([assetsQuery.refetch(), plansQuery.refetch()]);
    setRefreshing(false);
  };

  const handleCreatePlan = () => {
    if (assetId == null) {
      Alert.alert('Error', 'Select a battery asset first');
      return;
    }
    const hours = parseFloat(hoursUntilDeparture);
    if (isNaN(hours) || hours <= 0) {
      Alert.alert('Error', 'Enter a valid number of hours until departure');
      return;
    }
    const soc = parseFloat(targetSoc);
    if (isNaN(soc) || soc <= 0 || soc > 100) {
      Alert.alert('Error', 'Enter a target state of charge between 1 and 100%');
      return;
    }
    const power = parseFloat(maxPowerW);
    if (isNaN(power) || power <= 0) {
      Alert.alert('Error', 'Enter a valid max charge power (W)');
      return;
    }

    createPlanMutation.mutate({
      assetId,
      departureTime: new Date(Date.now() + hours * 3600000),
      targetSocPct100: Math.round(soc * 100),
      maxChargePowerW: Math.round(power),
    });
  };

  const handleCancel = (planId: number) => {
    Alert.alert('Cancel Plan', 'Cancel this charging plan?', [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Cancel Plan',
        style: 'destructive',
        onPress: () => cancelMutation.mutate({ planId }),
      },
    ]);
  };

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
        <Text style={styles.title}>EV Charging</Text>
        <View style={{ width: 40 }} />
      </View>

      {/* New plan form */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Plan a Charge</Text>

        <Text style={styles.inputLabel}>Battery asset</Text>
        {assetsQuery.isLoading ? (
          <Text style={styles.emptyText}>Loading assets…</Text>
        ) : batteryAssets.length === 0 ? (
          <Text style={styles.emptyText}>
            No battery assets registered. EV charging planning requires a battery asset.
          </Text>
        ) : (
          <View style={styles.chipRowWrap}>
            {batteryAssets.map((a) => (
              <TouchableOpacity
                key={a.id}
                style={[styles.chip, assetId === a.id && styles.chipActive]}
                onPress={() => setAssetId(a.id)}
              >
                <Text style={[styles.chipText, assetId === a.id && styles.chipTextActive]}>
                  {a.name}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <Text style={styles.inputLabel}>Departure in (hours from now)</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. 8"
          placeholderTextColor="#9ca3af"
          keyboardType="numeric"
          value={hoursUntilDeparture}
          onChangeText={setHoursUntilDeparture}
        />

        <Text style={styles.inputLabel}>Target state of charge (%)</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. 80"
          placeholderTextColor="#9ca3af"
          keyboardType="numeric"
          value={targetSoc}
          onChangeText={setTargetSoc}
        />

        <Text style={styles.inputLabel}>Max charge power (W)</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. 7000"
          placeholderTextColor="#9ca3af"
          keyboardType="numeric"
          value={maxPowerW}
          onChangeText={setMaxPowerW}
        />

        <TouchableOpacity
          style={styles.saveButton}
          onPress={handleCreatePlan}
          disabled={createPlanMutation.isPending || batteryAssets.length === 0}
        >
          <Text style={styles.saveButtonText}>
            {createPlanMutation.isPending ? 'Planning…' : 'Create Plan'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Plans */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>My Charging Plans</Text>
        {plansQuery.isLoading ? (
          <Text style={styles.emptyText}>Loading plans…</Text>
        ) : plansQuery.isError ? (
          <Text style={styles.emptyText}>Could not load charging plans</Text>
        ) : plans.length === 0 ? (
          <Text style={styles.emptyText}>No charging plans yet.</Text>
        ) : (
          plans.map((p) => (
            <View key={p.id} style={styles.planCard}>
              <View style={styles.planHeader}>
                <Text style={styles.planTitle}>
                  Depart {p.departureTime ? new Date(p.departureTime).toLocaleString() : '—'}
                </Text>
                <View
                  style={[
                    styles.statusChip,
                    p.status === 'scheduled' && styles.statusScheduled,
                    p.status === 'infeasible' && styles.statusInfeasible,
                    p.status === 'cancelled' && styles.statusCancelled,
                    p.status === 'completed' && styles.statusScheduled,
                  ]}
                >
                  <Text style={styles.statusChipText}>{p.status}</Text>
                </View>
              </View>

              <Text style={styles.planMeta}>
                Target {(p.targetSocPct100 / 100).toFixed(0)}% SoC
                {p.startSocPct100 != null
                  ? ` · start ${(p.startSocPct100 / 100).toFixed(0)}%`
                  : ' · start SoC —'}
                {p.energyNeededWh != null ? ` · needs ${formatKwh(p.energyNeededWh)}` : ''}
              </Text>

              {!p.scheduleAvailable && (
                <View style={styles.unavailableBox}>
                  <Ionicons name="information-circle-outline" size={16} color="#92400e" />
                  <Text style={styles.unavailableText}>
                    No schedule available:{' '}
                    {p.unavailableReason
                      ? UNAVAILABLE_REASONS[p.unavailableReason] ?? p.unavailableReason
                      : 'reason not recorded'}
                  </Text>
                </View>
              )}

              {p.scheduleAvailable && (
                <>
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Expected cost</Text>
                    <Text style={styles.detailValue}>{formatCents(p.expectedCostCents)}</Text>
                  </View>
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Charging now instead</Text>
                    <Text style={styles.detailValue}>
                      {formatCents(p.naiveImmediateCostCents)}
                    </Text>
                  </View>
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Savings vs charging now</Text>
                    <Text style={[styles.detailValue, { color: '#10b981' }]}>
                      {p.savingsVsImmediateCents != null
                        ? formatCents(p.savingsVsImmediateCents)
                        : '—'}
                    </Text>
                  </View>

                  {(p.windows ?? []).length > 0 && (
                    <Text style={[styles.inputLabel, { marginTop: 8 }]}>
                      Charge windows (cheapest-first allocation):
                    </Text>
                  )}
                  {(p.windows as ChargeWindow[] | null ?? []).map((w, i) => (
                    <View key={i} style={styles.windowRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.windowTime}>
                          {new Date(w.startTime).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                          {' – '}
                          {new Date(w.endTime).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </Text>
                        <Text style={styles.windowMeta}>
                          {formatKwh(w.energyWh)} @ {(w.priceCentsPerKwh / 100).toFixed(2)}/kWh
                        </Text>
                      </View>
                      <Text style={styles.detailValue}>{formatCents(w.costCents)}</Text>
                    </View>
                  ))}
                </>
              )}

              {(p.status === 'scheduled' || p.status === 'infeasible') && (
                <TouchableOpacity
                  style={styles.cancelButton}
                  onPress={() => handleCancel(p.id)}
                  disabled={cancelMutation.isPending}
                >
                  <Text style={styles.cancelButtonText}>Cancel Plan</Text>
                </TouchableOpacity>
              )}
            </View>
          ))
        )}
      </View>

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
  input: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    color: '#111827',
    marginBottom: 12,
    backgroundColor: '#f9fafb',
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
  saveButton: {
    backgroundColor: '#10b981',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  saveButtonText: {
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
  planCard: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  planHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
    gap: 8,
  },
  planTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111827',
    flex: 1,
  },
  planMeta: {
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 4,
  },
  statusChip: {
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  statusScheduled: {
    backgroundColor: '#d1fae5',
  },
  statusInfeasible: {
    backgroundColor: '#fef3c7',
  },
  statusCancelled: {
    backgroundColor: '#e5e7eb',
  },
  statusChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#111827',
  },
  unavailableBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#fef3c7',
    borderRadius: 12,
    padding: 12,
    marginTop: 8,
    gap: 8,
  },
  unavailableText: {
    fontSize: 13,
    color: '#92400e',
    flex: 1,
    lineHeight: 18,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
    gap: 8,
  },
  detailLabel: {
    fontSize: 13,
    color: '#6b7280',
  },
  detailValue: {
    fontSize: 13,
    fontWeight: '600',
    color: '#111827',
  },
  windowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  windowTime: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
  },
  windowMeta: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 2,
  },
  cancelButton: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: '#dc2626',
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
  },
  cancelButtonText: {
    color: '#dc2626',
    fontSize: 14,
    fontWeight: '600',
  },
});
