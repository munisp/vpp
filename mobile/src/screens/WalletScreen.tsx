import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Modal,
  Alert,
  Switch,
  RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { trpc } from '../services/trpc';
import { HapticService } from '../services/hapticService';

type TopUpMethod = 'mpesa' | 'airtel_money' | 'tigo_pesa';

const METHOD_LABELS: Record<TopUpMethod, string> = {
  mpesa: 'M-Pesa',
  airtel_money: 'Airtel Money',
  tigo_pesa: 'Tigo Pesa',
};

const formatTzs = (cents: number | null | undefined) =>
  cents == null ? '—' : `${(cents / 100).toFixed(0)} TZS`;

export default function WalletScreen({ navigation }: any) {
  const [topUpModalVisible, setTopUpModalVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Top-up form
  const [topUpAmount, setTopUpAmount] = useState('');
  const [topUpMethod, setTopUpMethod] = useState<TopUpMethod>('mpesa');
  const [topUpPhone, setTopUpPhone] = useState('');

  // Settings form
  const [thresholdTzs, setThresholdTzs] = useState('');
  const [autoTopUp, setAutoTopUp] = useState(false);
  const [autoAmountTzs, setAutoAmountTzs] = useState('');
  const [settingsMethod, setSettingsMethod] = useState<TopUpMethod>('mpesa');
  const [settingsPhone, setSettingsPhone] = useState('');
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  const utils = trpc.useUtils();

  const {
    data: wallet,
    isLoading: walletLoading,
    isError: walletError,
    refetch: refetchWallet,
  } = trpc.energyWallet.getWallet.useQuery();

  // Pre-fill the settings form once from the server's stored settings.
  React.useEffect(() => {
    if (!settingsLoaded && wallet?.settings) {
      const s = wallet.settings;
      setThresholdTzs(
        s.lowBalanceThresholdCents != null ? String(s.lowBalanceThresholdCents / 100) : ''
      );
      setAutoTopUp(!!s.autoTopUp);
      setAutoAmountTzs(
        s.topUpAmountCents != null ? String(s.topUpAmountCents / 100) : ''
      );
      if (s.preferredMethod) setSettingsMethod(s.preferredMethod as TopUpMethod);
      setSettingsPhone(s.phoneNumber ?? '');
      if (s.phoneNumber) setTopUpPhone(s.phoneNumber);
      setSettingsLoaded(true);
    }
  }, [wallet, settingsLoaded]);

  const {
    data: attemptsData,
    isLoading: attemptsLoading,
    isError: attemptsError,
    refetch: refetchAttempts,
  } = trpc.energyWallet.listTopUpAttempts.useQuery({ limit: 20 });

  const updateSettingsMutation = trpc.energyWallet.updateWalletSettings.useMutation({
    onSuccess: async () => {
      await HapticService.success();
      Alert.alert('Saved', 'Wallet settings updated.');
      utils.energyWallet.getWallet.invalidate();
    },
    onError: async (error) => {
      await HapticService.error();
      Alert.alert('Error', error.message);
    },
  });

  const requestTopUpMutation = trpc.energyWallet.requestTopUp.useMutation({
    onSuccess: async (result) => {
      if (result.topUpInitiated) {
        await HapticService.paymentCompleted();
        Alert.alert(
          'Top-Up Initiated',
          result.gatewayMessage || 'Check your phone to approve the payment prompt.'
        );
        setTopUpModalVisible(false);
        setTopUpAmount('');
      } else {
        await HapticService.paymentFailed();
        Alert.alert(
          'Top-Up Not Initiated',
          result.gatewayMessage || result.reason || 'The gateway rejected the top-up request.'
        );
      }
      utils.energyWallet.getWallet.invalidate();
      utils.energyWallet.listTopUpAttempts.invalidate();
    },
    onError: async (error) => {
      await HapticService.paymentFailed();
      Alert.alert('Top-Up Failed', error.message);
    },
  });

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await Promise.all([refetchWallet(), refetchAttempts()]);
    setRefreshing(false);
  };

  const handleSaveSettings = () => {
    const threshold = thresholdTzs.trim() ? parseFloat(thresholdTzs) : null;
    const autoAmount = autoAmountTzs.trim() ? parseFloat(autoAmountTzs) : null;

    if (threshold != null && (isNaN(threshold) || threshold < 0)) {
      Alert.alert('Error', 'Please enter a valid low-balance threshold');
      return;
    }
    if (autoTopUp) {
      if (autoAmount == null || isNaN(autoAmount) || autoAmount <= 0) {
        Alert.alert('Error', 'Auto top-up requires a valid top-up amount');
        return;
      }
      if (!settingsPhone.trim() || settingsPhone.trim().length < 9) {
        Alert.alert('Error', 'Auto top-up requires a valid phone number');
        return;
      }
    }

    updateSettingsMutation.mutate({
      lowBalanceThresholdCents: threshold != null ? Math.round(threshold * 100) : null,
      autoTopUp,
      topUpAmountCents: autoAmount != null && !isNaN(autoAmount) ? Math.round(autoAmount * 100) : null,
      preferredMethod: settingsMethod,
      phoneNumber: settingsPhone.trim() || null,
    });
  };

  const handleRequestTopUp = () => {
    const amount = parseFloat(topUpAmount);
    if (isNaN(amount) || amount <= 0) {
      Alert.alert('Error', 'Please enter a valid top-up amount');
      return;
    }
    if (!topUpPhone.trim() || topUpPhone.trim().length < 9) {
      Alert.alert('Error', 'Please enter a valid phone number (min 9 digits)');
      return;
    }
    requestTopUpMutation.mutate({
      amountCents: Math.round(amount * 100),
      method: topUpMethod,
      phoneNumber: topUpPhone.trim(),
    });
  };

  const attempts = attemptsData?.attempts ?? [];

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
        <Text style={styles.title}>Energy Wallet</Text>
        <View style={{ width: 40 }} />
      </View>

      {/* Balance card */}
      <View style={styles.balanceCard}>
        <Text style={styles.balanceLabel}>Wallet Balance</Text>
        {walletLoading ? (
          <Text style={styles.balanceAmount}>Loading…</Text>
        ) : walletError || !wallet ? (
          <Text style={styles.balanceUnavailable}>Balance unavailable</Text>
        ) : (
          <>
            <Text style={styles.balanceAmount}>{formatTzs(wallet.balanceCents)}</Text>
            {wallet.belowThreshold === true && (
              <View style={styles.warningChip}>
                <Ionicons name="warning" size={14} color="#92400e" />
                <Text style={styles.warningChipText}>Below low-balance threshold</Text>
              </View>
            )}
          </>
        )}
        <TouchableOpacity
          style={styles.topUpButton}
          onPress={() => setTopUpModalVisible(true)}
        >
          <Ionicons name="add-circle" size={20} color="white" />
          <Text style={styles.topUpButtonText}>Top Up</Text>
        </TouchableOpacity>
      </View>

      {/* Ledger breakdown */}
      {wallet && !walletError && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Ledger Breakdown</Text>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Payments completed</Text>
            <Text style={styles.detailValue}>
              {formatTzs(wallet.ledger?.paymentsCompletedCents)}
            </Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Bills issued</Text>
            <Text style={styles.detailValue}>
              {formatTzs(wallet.ledger?.billingsIssuedCents)}
            </Text>
          </View>
          <View style={[styles.detailRow, { borderBottomWidth: 0 }]}>
            <Text style={styles.detailLabel}>Token purchases</Text>
            <Text style={styles.detailValue}>
              {formatTzs(wallet.ledger?.tokenPurchasesCents)}
            </Text>
          </View>
        </View>
      )}

      {/* Settings */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Wallet Settings</Text>

        <Text style={styles.inputLabel}>Low-balance threshold (TZS)</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. 5000"
          placeholderTextColor="#9ca3af"
          keyboardType="numeric"
          value={thresholdTzs}
          onChangeText={setThresholdTzs}
        />

        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Auto top-up</Text>
          <Switch
            value={autoTopUp}
            onValueChange={setAutoTopUp}
            trackColor={{ false: '#d1d5db', true: '#10b981' }}
          />
        </View>

        {autoTopUp && (
          <>
            <Text style={styles.inputLabel}>Auto top-up amount (TZS)</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. 10000"
              placeholderTextColor="#9ca3af"
              keyboardType="numeric"
              value={autoAmountTzs}
              onChangeText={setAutoAmountTzs}
            />
          </>
        )}

        <Text style={styles.inputLabel}>Preferred method</Text>
        <View style={styles.methodRow}>
          {(Object.keys(METHOD_LABELS) as TopUpMethod[]).map((m) => (
            <TouchableOpacity
              key={m}
              style={[styles.methodChip, settingsMethod === m && styles.methodChipActive]}
              onPress={() => setSettingsMethod(m)}
            >
              <Text
                style={[
                  styles.methodChipText,
                  settingsMethod === m && styles.methodChipTextActive,
                ]}
              >
                {METHOD_LABELS[m]}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.inputLabel}>Phone number</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. 2557XXXXXXXX"
          placeholderTextColor="#9ca3af"
          keyboardType="phone-pad"
          value={settingsPhone}
          onChangeText={setSettingsPhone}
        />

        <TouchableOpacity
          style={styles.saveButton}
          onPress={handleSaveSettings}
          disabled={updateSettingsMutation.isPending}
        >
          <Text style={styles.saveButtonText}>
            {updateSettingsMutation.isPending ? 'Saving…' : 'Save Settings'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Top-up attempts */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Top-Up History</Text>
        {attemptsLoading ? (
          <Text style={styles.emptyText}>Loading top-ups…</Text>
        ) : attemptsError ? (
          <Text style={styles.emptyText}>Could not load top-up history</Text>
        ) : attempts.length === 0 ? (
          <Text style={styles.emptyText}>No top-ups yet</Text>
        ) : (
          attempts.map((a) => (
            <View key={a.id} style={styles.attemptRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.attemptAmount}>{formatTzs(a.amountCents)}</Text>
                <Text style={styles.attemptMeta}>
                  {METHOD_LABELS[a.method as TopUpMethod] ?? a.method} · {a.triggerType} ·{' '}
                  {a.createdAt ? new Date(a.createdAt).toLocaleDateString() : '—'}
                </Text>
                {a.status === 'failed' && a.errorMessage ? (
                  <Text style={styles.attemptError} numberOfLines={2}>
                    {a.errorMessage}
                  </Text>
                ) : null}
              </View>
              <View
                style={[
                  styles.statusChip,
                  a.status === 'completed' && styles.statusCompleted,
                  a.status === 'failed' && styles.statusFailed,
                  a.status === 'initiated' && styles.statusInitiated,
                ]}
              >
                <Text style={styles.statusChipText}>{a.status}</Text>
              </View>
            </View>
          ))
        )}
      </View>

      {/* Top-up modal */}
      <Modal
        visible={topUpModalVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setTopUpModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Top Up Wallet</Text>

            <Text style={styles.inputLabel}>Amount (TZS)</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. 10000"
              placeholderTextColor="#9ca3af"
              keyboardType="numeric"
              value={topUpAmount}
              onChangeText={setTopUpAmount}
            />

            <Text style={styles.inputLabel}>Method</Text>
            <View style={styles.methodRow}>
              {(Object.keys(METHOD_LABELS) as TopUpMethod[]).map((m) => (
                <TouchableOpacity
                  key={m}
                  style={[styles.methodChip, topUpMethod === m && styles.methodChipActive]}
                  onPress={() => setTopUpMethod(m)}
                >
                  <Text
                    style={[
                      styles.methodChipText,
                      topUpMethod === m && styles.methodChipTextActive,
                    ]}
                  >
                    {METHOD_LABELS[m]}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.inputLabel}>Phone number</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. 2557XXXXXXXX"
              placeholderTextColor="#9ca3af"
              keyboardType="phone-pad"
              value={topUpPhone}
              onChangeText={setTopUpPhone}
            />

            <TouchableOpacity
              style={styles.saveButton}
              onPress={handleRequestTopUp}
              disabled={requestTopUpMutation.isPending}
            >
              <Text style={styles.saveButtonText}>
                {requestTopUpMutation.isPending ? 'Initiating…' : 'Request Top-Up'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.modalCancel}
              onPress={() => setTopUpModalVisible(false)}
            >
              <Text style={styles.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
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
  balanceCard: {
    backgroundColor: '#10b981',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    marginBottom: 16,
  },
  balanceLabel: {
    fontSize: 14,
    color: '#d1fae5',
    marginBottom: 8,
  },
  balanceAmount: {
    fontSize: 36,
    fontWeight: 'bold',
    color: 'white',
  },
  balanceUnavailable: {
    fontSize: 18,
    color: '#d1fae5',
  },
  warningChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fef3c7',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginTop: 10,
    gap: 4,
  },
  warningChipText: {
    fontSize: 12,
    color: '#92400e',
    fontWeight: '600',
  },
  topUpButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.25)',
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 10,
    marginTop: 16,
    gap: 6,
  },
  topUpButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
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
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  detailLabel: {
    fontSize: 14,
    color: '#6b7280',
  },
  detailValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
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
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  switchLabel: {
    fontSize: 16,
    color: '#111827',
  },
  methodRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  methodChip: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
  },
  methodChipActive: {
    backgroundColor: '#10b981',
    borderColor: '#10b981',
  },
  methodChipText: {
    fontSize: 13,
    color: '#6b7280',
    fontWeight: '600',
  },
  methodChipTextActive: {
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
  },
  attemptRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  attemptAmount: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
  },
  attemptMeta: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 2,
  },
  attemptError: {
    fontSize: 12,
    color: '#dc2626',
    marginTop: 2,
  },
  statusChip: {
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginLeft: 8,
  },
  statusCompleted: {
    backgroundColor: '#d1fae5',
  },
  statusFailed: {
    backgroundColor: '#fee2e2',
  },
  statusInitiated: {
    backgroundColor: '#fef3c7',
  },
  statusChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#111827',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: 'white',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#111827',
    marginBottom: 16,
  },
  modalCancel: {
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  modalCancelText: {
    color: '#6b7280',
    fontSize: 16,
    fontWeight: '600',
  },
});
