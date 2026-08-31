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

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const formatKwh = (wh: number | null | undefined) =>
  wh == null ? '—' : `${(wh / 1000).toFixed(2)} kWh`;

const formatCents = (cents: number | null | undefined, currency?: string | null) =>
  cents == null ? '—' : `${(cents / 100).toFixed(2)} ${currency ?? ''}`.trim();

const PROJECTION_REASONS: Record<string, string> = {
  month_not_started: 'The month has not started yet — there is nothing to project from.',
  month_complete: 'The month is over — actuals exist, so a projection is not meaningful.',
  no_consumption_data: 'No consumption data recorded this month yet.',
  insufficient_days: 'A pace projection needs at least 3 days of real data.',
};

export default function BudgetPlannerScreen({ navigation }: any) {
  const [refreshing, setRefreshing] = useState(false);
  const [selectedBudgetId, setSelectedBudgetId] = useState<number | null>(null);

  const now = new Date();
  // Set-budget form (defaults to the current month)
  const [formYear, setFormYear] = useState(now.getUTCFullYear());
  const [formMonth, setFormMonth] = useState(now.getUTCMonth() + 1); // 1-12
  const [targetKwh, setTargetKwh] = useState('');
  const [targetCost, setTargetCost] = useState('');

  const utils = trpc.useUtils();

  const budgetsQuery = trpc.budgetPlanner.listBudgets.useQuery({ limit: 12 });
  const budgets = budgetsQuery.data?.budgets ?? [];

  const selectedBudget = budgets.find((b) => b.id === selectedBudgetId) ?? budgets[0] ?? null;

  const checkpointsQuery = trpc.budgetPlanner.listCheckpoints.useQuery(
    { budgetId: selectedBudget!.id, limit: 12 },
    { enabled: selectedBudget != null }
  );
  const checkpoints = checkpointsQuery.data?.checkpoints ?? [];
  const latestCheckpoint = checkpoints[0] ?? null;

  const setBudgetMutation = trpc.budgetPlanner.setBudget.useMutation({
    onSuccess: async () => {
      await HapticService.success();
      Alert.alert('Saved', 'Budget target saved.');
      setTargetKwh('');
      setTargetCost('');
      utils.budgetPlanner.listBudgets.invalidate();
    },
    onError: async (error) => {
      await HapticService.error();
      Alert.alert('Error', error.message);
    },
  });

  const checkpointMutation = trpc.budgetPlanner.recordCheckpoint.useMutation({
    onSuccess: async () => {
      await HapticService.success();
      utils.budgetPlanner.listCheckpoints.invalidate();
    },
    onError: async (error) => {
      await HapticService.error();
      Alert.alert('Error', error.message);
    },
  });

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await Promise.all([budgetsQuery.refetch(), checkpointsQuery.refetch()]);
    setRefreshing(false);
  };

  const shiftMonth = (delta: number) => {
    let m = formMonth + delta;
    let y = formYear;
    if (m < 1) {
      m = 12;
      y -= 1;
    } else if (m > 12) {
      m = 1;
      y += 1;
    }
    setFormMonth(m);
    setFormYear(y);
  };

  const handleSaveBudget = () => {
    const kwh = targetKwh.trim() ? parseFloat(targetKwh) : null;
    const cost = targetCost.trim() ? parseFloat(targetCost) : null;

    if (kwh != null && (isNaN(kwh) || kwh <= 0)) {
      Alert.alert('Error', 'Enter a valid positive kWh target');
      return;
    }
    if (cost != null && (isNaN(cost) || cost <= 0)) {
      Alert.alert('Error', 'Enter a valid positive cost target');
      return;
    }
    if (kwh == null && cost == null) {
      Alert.alert('Error', 'Set at least one target: kWh and/or cost');
      return;
    }

    setBudgetMutation.mutate({
      year: formYear,
      month: formMonth,
      targetKwh: kwh != null ? Math.round(kwh) : null,
      targetCostCents: cost != null ? Math.round(cost * 100) : null,
    });
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
        <Text style={styles.title}>Energy Budget</Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Set budget */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Set Monthly Target</Text>

        <Text style={styles.inputLabel}>Month</Text>
        <View style={styles.monthRow}>
          <TouchableOpacity style={styles.monthArrow} onPress={() => shiftMonth(-1)}>
            <Ionicons name="chevron-back" size={20} color="#111827" />
          </TouchableOpacity>
          <Text style={styles.monthLabel}>
            {MONTH_NAMES[formMonth - 1]} {formYear}
          </Text>
          <TouchableOpacity style={styles.monthArrow} onPress={() => shiftMonth(1)}>
            <Ionicons name="chevron-forward" size={20} color="#111827" />
          </TouchableOpacity>
        </View>

        <Text style={styles.inputLabel}>Energy target (kWh)</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. 150"
          placeholderTextColor="#9ca3af"
          keyboardType="numeric"
          value={targetKwh}
          onChangeText={setTargetKwh}
        />

        <Text style={styles.inputLabel}>Cost target (major units, e.g. TZS)</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. 50000"
          placeholderTextColor="#9ca3af"
          keyboardType="numeric"
          value={targetCost}
          onChangeText={setTargetCost}
        />

        <TouchableOpacity
          style={styles.saveButton}
          onPress={handleSaveBudget}
          disabled={setBudgetMutation.isPending}
        >
          <Text style={styles.saveButtonText}>
            {setBudgetMutation.isPending ? 'Saving…' : 'Save Budget'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Budget list */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>My Budgets</Text>
        {budgetsQuery.isLoading ? (
          <Text style={styles.emptyText}>Loading budgets…</Text>
        ) : budgetsQuery.isError ? (
          <Text style={styles.emptyText}>Could not load budgets</Text>
        ) : budgets.length === 0 ? (
          <Text style={styles.emptyText}>No budgets yet. Set a monthly target above.</Text>
        ) : (
          budgets.map((b) => (
            <TouchableOpacity
              key={b.id}
              style={[styles.budgetRow, selectedBudget?.id === b.id && styles.budgetRowActive]}
              onPress={() => setSelectedBudgetId(b.id)}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.budgetTitle}>
                  {MONTH_NAMES[b.month - 1]} {b.year}
                </Text>
                <Text style={styles.budgetMeta}>
                  {b.targetKwh != null ? `${b.targetKwh} kWh` : '—'}
                  {' · '}
                  {b.targetCostCents != null
                    ? formatCents(b.targetCostCents, b.currency)
                    : '—'}
                </Text>
              </View>
              {selectedBudget?.id === b.id && (
                <Ionicons name="checkmark-circle" size={20} color="#10b981" />
              )}
            </TouchableOpacity>
          ))
        )}
      </View>

      {/* Progress for the selected budget */}
      {selectedBudget && (
        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.sectionTitle}>
              Progress — {MONTH_NAMES[selectedBudget.month - 1]} {selectedBudget.year}
            </Text>
          </View>

          <TouchableOpacity
            style={styles.saveButton}
            onPress={() => checkpointMutation.mutate({ budgetId: selectedBudget.id })}
            disabled={checkpointMutation.isPending}
          >
            <Text style={styles.saveButtonText}>
              {checkpointMutation.isPending ? 'Measuring…' : 'Refresh Checkpoint'}
            </Text>
          </TouchableOpacity>

          <View style={{ marginTop: 12 }}>
            {checkpointsQuery.isLoading ? (
              <Text style={styles.emptyText}>Loading progress…</Text>
            ) : checkpointsQuery.isError ? (
              <Text style={styles.emptyText}>Could not load checkpoints</Text>
            ) : latestCheckpoint == null ? (
              <Text style={styles.emptyText}>
                No checkpoints yet. Refresh a checkpoint to measure real consumption against
                this target.
              </Text>
            ) : (
              <>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Days elapsed</Text>
                  <Text style={styles.detailValue}>
                    {latestCheckpoint.daysElapsed} / {latestCheckpoint.daysInMonth}
                  </Text>
                </View>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Consumed (month to date)</Text>
                  <Text style={styles.detailValue}>
                    {formatKwh(latestCheckpoint.consumedWh)}
                    {selectedBudget.targetKwh != null && latestCheckpoint.consumedWh != null
                      ? ` of ${selectedBudget.targetKwh} kWh`
                      : ''}
                  </Text>
                </View>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Billed cost (month to date)</Text>
                  <Text style={styles.detailValue}>
                    {formatCents(latestCheckpoint.billedCostCents, selectedBudget.currency)}
                    {selectedBudget.targetCostCents != null &&
                    latestCheckpoint.billedCostCents != null
                      ? ` of ${formatCents(selectedBudget.targetCostCents, selectedBudget.currency)}`
                      : ''}
                  </Text>
                </View>

                {latestCheckpoint.projectionAvailable ? (
                  <>
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>Projected month-end (pace)</Text>
                      <Text style={styles.detailValue}>
                        {formatKwh(latestCheckpoint.projectedMonthEndWh)}
                      </Text>
                    </View>
                    <View style={[styles.detailRow, { borderBottomWidth: 0 }]}>
                      <Text style={styles.detailLabel}>Projected cost (pace)</Text>
                      <Text style={styles.detailValue}>
                        {formatCents(
                          latestCheckpoint.projectedMonthEndCostCents,
                          selectedBudget.currency
                        )}
                      </Text>
                    </View>
                    <Text style={styles.projectionNote}>
                      Month-end figures are pace projections from real measured consumption,
                      not measurements.
                    </Text>
                  </>
                ) : (
                  <View style={styles.unavailableBox}>
                    <Ionicons name="information-circle-outline" size={16} color="#92400e" />
                    <Text style={styles.unavailableText}>
                      Projection unavailable:{' '}
                      {latestCheckpoint.projectionUnavailableReason
                        ? PROJECTION_REASONS[latestCheckpoint.projectionUnavailableReason] ??
                          latestCheckpoint.projectionUnavailableReason
                        : 'Not enough data yet.'}
                    </Text>
                  </View>
                )}
              </>
            )}
          </View>
        </View>
      )}

      {/* Checkpoint history */}
      {selectedBudget && checkpoints.length > 1 && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Checkpoint History</Text>
          {checkpoints.slice(1).map((c) => (
            <View key={c.id} style={styles.detailRow}>
              <Text style={styles.detailLabel}>
                {c.checkpointAt ? new Date(c.checkpointAt).toLocaleDateString() : '—'}
              </Text>
              <Text style={styles.detailValue}>
                {formatKwh(c.consumedWh)}
                {c.projectionAvailable && c.projectedMonthEndWh != null
                  ? ` → ${formatKwh(c.projectedMonthEndWh)} (proj.)`
                  : ''}
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
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
  monthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  monthArrow: {
    padding: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
  },
  monthLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
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
  budgetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  budgetRowActive: {
    backgroundColor: '#f0fdf4',
  },
  budgetTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111827',
  },
  budgetMeta: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 2,
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
    textAlign: 'right',
    flexShrink: 1,
  },
  projectionNote: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 8,
    fontStyle: 'italic',
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
});
