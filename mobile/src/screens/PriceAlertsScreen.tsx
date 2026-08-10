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

type AlertType = 'above' | 'below' | 'between';
type Country = 'nigeria' | 'tanzania';
type PriceType = 'off_peak' | 'shoulder' | 'peak' | 'super_peak';

const ALERT_TYPES: AlertType[] = ['above', 'below', 'between'];
const COUNTRIES: Country[] = ['nigeria', 'tanzania'];
const PRICE_TYPES: { value: PriceType; label: string }[] = [
  { value: 'off_peak', label: 'Off-peak' },
  { value: 'shoulder', label: 'Shoulder' },
  { value: 'peak', label: 'Peak' },
  { value: 'super_peak', label: 'Super-peak' },
];

const priceTypeLabel = (v: string) =>
  PRICE_TYPES.find((p) => p.value === v)?.label ?? v;

export default function PriceAlertsScreen({ navigation }: any) {
  const [modalVisible, setModalVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Subscribe form (prices are integer TZS/kWh per server schema)
  const [name, setName] = useState('');
  const [alertType, setAlertType] = useState<AlertType>('below');
  const [targetPrice, setTargetPrice] = useState('');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [country, setCountry] = useState<Country>('tanzania');
  const [priceType, setPriceType] = useState<PriceType>('peak');
  const [notifyPush, setNotifyPush] = useState(true);
  const [notifySMS, setNotifySMS] = useState(false);

  const utils = trpc.useUtils();

  const subsQuery = trpc.priceAlertEngine.listMySubscriptions.useQuery();

  const subscribeMutation = trpc.priceAlertEngine.subscribe.useMutation({
    onSuccess: async () => {
      await HapticService.success();
      Alert.alert('Subscribed', 'Price alert created.');
      setModalVisible(false);
      resetForm();
      utils.priceAlertEngine.listMySubscriptions.invalidate();
    },
    onError: async (error) => {
      await HapticService.error();
      Alert.alert('Error', error.message);
    },
  });

  const unsubscribeMutation = trpc.priceAlertEngine.unsubscribe.useMutation({
    onSuccess: async () => {
      await HapticService.success();
      utils.priceAlertEngine.listMySubscriptions.invalidate();
    },
    onError: async (error) => {
      await HapticService.error();
      Alert.alert('Error', error.message);
    },
  });

  const resetForm = () => {
    setName('');
    setAlertType('below');
    setTargetPrice('');
    setMinPrice('');
    setMaxPrice('');
    setCountry('tanzania');
    setPriceType('peak');
    setNotifyPush(true);
    setNotifySMS(false);
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await subsQuery.refetch();
    setRefreshing(false);
  };

  const parsePrice = (v: string) => {
    const n = parseInt(v, 10);
    return isNaN(n) || n <= 0 ? null : n;
  };

  const handleSubscribe = () => {
    if (!name.trim()) {
      Alert.alert('Error', 'Please enter a name for this alert');
      return;
    }

    const input: Parameters<typeof subscribeMutation.mutate>[0] = {
      name: name.trim(),
      alertType,
      country,
      priceType,
      notifyPush,
      notifySMS,
      cooldownMinutes: 60,
    };

    if (alertType === 'above' || alertType === 'below') {
      const t = parsePrice(targetPrice);
      if (t == null) {
        Alert.alert('Error', 'Enter a valid target price (TZS/kWh)');
        return;
      }
      input.targetPrice = t;
    } else {
      const lo = parsePrice(minPrice);
      const hi = parsePrice(maxPrice);
      if (lo == null || hi == null || lo >= hi) {
        Alert.alert('Error', 'Between alerts need a valid min price below the max price');
        return;
      }
      input.minPrice = lo;
      input.maxPrice = hi;
    }

    subscribeMutation.mutate(input);
  };

  const handleUnsubscribe = (id: number, alertName: string) => {
    Alert.alert('Unsubscribe', `Remove "${alertName}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => unsubscribeMutation.mutate({ priceAlertId: id }),
      },
    ]);
  };

  const subs = subsQuery.data?.subscriptions ?? [];

  const thresholdText = (s: (typeof subs)[number]) => {
    if (s.alertType === 'between') {
      return `${s.minPrice ?? '—'} – ${s.maxPrice ?? '—'} TZS/kWh`;
    }
    return `${s.alertType} ${s.targetPrice ?? '—'} TZS/kWh`;
  };

  return (
    <View style={styles.wrapper}>
      <ScrollView
        style={styles.container}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
            <Ionicons name="arrow-back" size={24} color="#111827" />
          </TouchableOpacity>
          <Text style={styles.title}>Price Alerts</Text>
          <View style={{ width: 40 }} />
        </View>

        {/* Subscriptions */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>My Subscriptions</Text>
          {subsQuery.isLoading ? (
            <Text style={styles.emptyText}>Loading subscriptions…</Text>
          ) : subsQuery.isError ? (
            <Text style={styles.emptyText}>Could not load subscriptions</Text>
          ) : subs.length === 0 ? (
            <Text style={styles.emptyText}>
              No price alerts yet. Subscribe to get notified when market prices cross a
              threshold.
            </Text>
          ) : (
            subs.map((s) => (
              <View key={s.id} style={styles.subRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.subName}>{s.name}</Text>
                  <Text style={styles.subMeta}>
                    {thresholdText(s)}
                    {s.scope
                      ? ` · ${s.scope.country} ${priceTypeLabel(s.scope.priceType)}`
                      : ''}
                  </Text>
                  <Text style={styles.subMeta}>
                    Triggered {s.triggerCount}×
                    {s.lastTriggeredAt
                      ? ` · last ${new Date(s.lastTriggeredAt).toLocaleDateString()}`
                      : ''}
                    {!s.isActive ? ' · inactive' : ''}
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => handleUnsubscribe(s.id, s.name)}
                  style={styles.removeButton}
                >
                  <Ionicons name="trash-outline" size={20} color="#dc2626" />
                </TouchableOpacity>
              </View>
            ))
          )}
        </View>

        <TouchableOpacity style={styles.addButton} onPress={() => setModalVisible(true)}>
          <Ionicons name="add" size={22} color="white" />
          <Text style={styles.addButtonText}>New Price Alert</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Subscribe modal */}
      <Modal
        visible={modalVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <ScrollView>
              <Text style={styles.modalTitle}>New Price Alert</Text>

              <Text style={styles.inputLabel}>Name</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. Cheap off-peak window"
                placeholderTextColor="#9ca3af"
                value={name}
                onChangeText={setName}
              />

              <Text style={styles.inputLabel}>Alert when price is</Text>
              <View style={styles.chipRow}>
                {ALERT_TYPES.map((t) => (
                  <TouchableOpacity
                    key={t}
                    style={[styles.chip, alertType === t && styles.chipActive]}
                    onPress={() => setAlertType(t)}
                  >
                    <Text
                      style={[styles.chipText, alertType === t && styles.chipTextActive]}
                    >
                      {t}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              {alertType === 'between' ? (
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.inputLabel}>Min (TZS/kWh)</Text>
                    <TextInput
                      style={styles.input}
                      keyboardType="numeric"
                      value={minPrice}
                      onChangeText={setMinPrice}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.inputLabel}>Max (TZS/kWh)</Text>
                    <TextInput
                      style={styles.input}
                      keyboardType="numeric"
                      value={maxPrice}
                      onChangeText={setMaxPrice}
                    />
                  </View>
                </View>
              ) : (
                <>
                  <Text style={styles.inputLabel}>Target price (TZS/kWh)</Text>
                  <TextInput
                    style={styles.input}
                    keyboardType="numeric"
                    value={targetPrice}
                    onChangeText={setTargetPrice}
                  />
                </>
              )}

              <Text style={styles.inputLabel}>Market</Text>
              <View style={styles.chipRow}>
                {COUNTRIES.map((c) => (
                  <TouchableOpacity
                    key={c}
                    style={[styles.chip, country === c && styles.chipActive]}
                    onPress={() => setCountry(c)}
                  >
                    <Text style={[styles.chipText, country === c && styles.chipTextActive]}>
                      {c}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.inputLabel}>Price period</Text>
              <View style={styles.chipRowWrap}>
                {PRICE_TYPES.map((p) => (
                  <TouchableOpacity
                    key={p.value}
                    style={[styles.chip, priceType === p.value && styles.chipActive]}
                    onPress={() => setPriceType(p.value)}
                  >
                    <Text
                      style={[styles.chipText, priceType === p.value && styles.chipTextActive]}
                    >
                      {p.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <View style={styles.switchRow}>
                <Text style={styles.switchLabel}>Push notification</Text>
                <Switch
                  value={notifyPush}
                  onValueChange={setNotifyPush}
                  trackColor={{ false: '#d1d5db', true: '#10b981' }}
                />
              </View>
              <View style={styles.switchRow}>
                <Text style={styles.switchLabel}>SMS notification</Text>
                <Switch
                  value={notifySMS}
                  onValueChange={setNotifySMS}
                  trackColor={{ false: '#d1d5db', true: '#10b981' }}
                />
              </View>

              <TouchableOpacity
                style={styles.saveButton}
                onPress={handleSubscribe}
                disabled={subscribeMutation.isLoading}
              >
                <Text style={styles.saveButtonText}>
                  {subscribeMutation.isLoading ? 'Subscribing…' : 'Subscribe'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalCancel}
                onPress={() => setModalVisible(false)}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
    backgroundColor: '#f9fafb',
  },
  container: {
    flex: 1,
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
  subRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  subName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111827',
  },
  subMeta: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 2,
  },
  removeButton: {
    padding: 8,
  },
  addButton: {
    backgroundColor: '#10b981',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingVertical: 14,
    marginBottom: 24,
    gap: 6,
  },
  addButtonText: {
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
    maxHeight: '90%',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#111827',
    marginBottom: 16,
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
  chipRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
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
  saveButton: {
    backgroundColor: '#10b981',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  saveButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
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
