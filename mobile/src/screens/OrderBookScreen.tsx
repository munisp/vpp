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
  RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { trpc } from '../services/trpc';
import { HapticService } from '../services/hapticService';

const kwhDisplay = (wh: number) => (wh / 1000).toFixed(2);
const priceDisplay = (centsPerKwh: number) => (centsPerKwh / 100).toFixed(2);

export default function OrderBookScreen({ navigation }: any) {
  const [modalVisible, setModalVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Order form
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [energyKwh, setEnergyKwh] = useState('');
  const [priceTzs, setPriceTzs] = useState('');

  const utils = trpc.useUtils();

  const bookQuery = trpc.p2pMatching.getOrderBook.useQuery();
  const myOrdersQuery = trpc.p2pMatching.getMyOrders.useQuery();

  const submitOrderMutation = trpc.p2pMatching.submitOrder.useMutation({
    onSuccess: async (result) => {
      await HapticService.success();
      const fillText =
        result.status === 'filled'
          ? `Fully filled (${kwhDisplay(result.filledEnergyWh)} kWh in ${result.matches.length} match${
              result.matches.length === 1 ? '' : 'es'
            }).`
          : result.filledEnergyWh > 0
          ? `Partially filled: ${kwhDisplay(result.filledEnergyWh)} kWh matched, ${kwhDisplay(
              result.remainingEnergyWh
            )} kWh resting on the book.`
          : 'No immediate match — your order is resting on the book.';
      Alert.alert(
        result.status === 'filled' ? 'Order Filled' : 'Order Placed',
        fillText
      );
      setModalVisible(false);
      setEnergyKwh('');
      setPriceTzs('');
      utils.p2pMatching.getOrderBook.invalidate();
      utils.p2pMatching.getMyOrders.invalidate();
    },
    onError: async (error) => {
      await HapticService.error();
      Alert.alert('Order Failed', error.message);
    },
  });

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await Promise.all([bookQuery.refetch(), myOrdersQuery.refetch()]);
    setRefreshing(false);
  };

  const handleSubmit = () => {
    const energy = parseFloat(energyKwh);
    const price = parseFloat(priceTzs);

    if (isNaN(energy) || energy <= 0) {
      Alert.alert('Error', 'Please enter a valid energy amount (kWh)');
      return;
    }
    if (isNaN(price) || price <= 0) {
      Alert.alert('Error', 'Please enter a valid price (TZS/kWh)');
      return;
    }

    // Server input: energyWh int, priceCentsPerKwh int (max for buy, min for sell)
    submitOrderMutation.mutate({
      side,
      energyWh: Math.round(energy * 1000),
      priceCentsPerKwh: Math.round(price * 100),
    });
  };

  const book = bookQuery.data;
  const maxDepth = Math.max(
    1,
    ...(book?.bids.map((b) => b.energyWh) ?? []),
    ...(book?.asks.map((a) => a.energyWh) ?? [])
  );
  const myOrders = myOrdersQuery.data ?? [];

  const renderLevel = (
    level: { priceCentsPerKwh: number; energyWh: number; orderCount: number },
    kind: 'bid' | 'ask'
  ) => (
    <View key={`${kind}-${level.priceCentsPerKwh}`} style={styles.levelRow}>
      <View
        style={[
          styles.depthBar,
          kind === 'bid' ? styles.depthBarBid : styles.depthBarAsk,
          { width: `${Math.max(6, (level.energyWh / maxDepth) * 100)}%` },
        ]}
      />
      <View style={styles.levelContent}>
        <Text style={[styles.levelPrice, kind === 'bid' ? styles.bidText : styles.askText]}>
          {priceDisplay(level.priceCentsPerKwh)} TZS/kWh
        </Text>
        <Text style={styles.levelMeta}>
          {kwhDisplay(level.energyWh)} kWh · {level.orderCount} order
          {level.orderCount === 1 ? '' : 's'}
        </Text>
      </View>
    </View>
  );

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
          <Text style={styles.title}>P2P Order Book</Text>
          <View style={{ width: 40 }} />
        </View>

        {/* Link to manual offers flow */}
        <TouchableOpacity
          style={styles.linkCard}
          onPress={() => navigation.navigate('P2PTrading')}
        >
          <Ionicons name="swap-horizontal" size={20} color="#10b981" />
          <Text style={styles.linkText}>
            Prefer direct offers? Open the P2P marketplace
          </Text>
          <Ionicons name="chevron-forward" size={18} color="#6b7280" />
        </TouchableOpacity>

        {/* Order book */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Market Depth</Text>
          {bookQuery.isLoading ? (
            <Text style={styles.emptyText}>Loading order book…</Text>
          ) : bookQuery.isError ? (
            <Text style={styles.emptyText}>Could not load order book</Text>
          ) : book ? (
            <>
              <Text style={styles.sideHeader}>Asks (sell offers)</Text>
              {book.asks.length === 0 ? (
                <Text style={styles.emptyText}>No open asks</Text>
              ) : (
                [...book.asks].reverse().map((a) => renderLevel(a, 'ask'))
              )}
              <View style={styles.spreadRow}>
                <Text style={styles.spreadText}>
                  {book.asks.length > 0 && book.bids.length > 0
                    ? `Spread: ${priceDisplay(
                        book.asks[0].priceCentsPerKwh - book.bids[0].priceCentsPerKwh
                      )} TZS/kWh`
                    : '—'}
                </Text>
              </View>
              <Text style={styles.sideHeader}>Bids (buy orders)</Text>
              {book.bids.length === 0 ? (
                <Text style={styles.emptyText}>No open bids</Text>
              ) : (
                book.bids.map((b) => renderLevel(b, 'bid'))
              )}
              <Text style={styles.generatedAt}>
                As of {new Date(book.generatedAt).toLocaleTimeString()}
              </Text>
            </>
          ) : null}
        </View>

        {/* My open orders */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>My Open Orders</Text>
          {myOrdersQuery.isLoading ? (
            <Text style={styles.emptyText}>Loading your orders…</Text>
          ) : myOrdersQuery.isError ? (
            <Text style={styles.emptyText}>Could not load your orders</Text>
          ) : myOrders.length === 0 ? (
            <Text style={styles.emptyText}>No open orders</Text>
          ) : (
            myOrders.map((o) => (
              <View key={o.id} style={styles.orderRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.orderTitle}>
                    {o.tradeType === 'p2p_buy' ? 'Buy' : 'Sell'} ·{' '}
                    {priceDisplay(o.price)} TZS/kWh
                  </Text>
                  <Text style={styles.orderMeta}>
                    {kwhDisplay(o.remainingEnergyWh)} kWh remaining of{' '}
                    {kwhDisplay(o.energy)} kWh
                    {o.filledEnergyWh > 0
                      ? ` · ${kwhDisplay(o.filledEnergyWh)} kWh filled`
                      : ''}
                  </Text>
                  <Text style={styles.orderMeta}>
                    {o.createdAt ? new Date(o.createdAt).toLocaleString() : '—'}
                  </Text>
                </View>
              </View>
            ))
          )}
        </View>

        <TouchableOpacity style={styles.addButton} onPress={() => setModalVisible(true)}>
          <Ionicons name="add" size={22} color="white" />
          <Text style={styles.addButtonText}>Place Order</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Submit order modal */}
      <Modal
        visible={modalVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Place Order</Text>

            <View style={styles.sideRow}>
              <TouchableOpacity
                style={[styles.sideButton, side === 'buy' && styles.sideBuyActive]}
                onPress={() => setSide('buy')}
              >
                <Text
                  style={[styles.sideButtonText, side === 'buy' && styles.sideTextActive]}
                >
                  Buy
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.sideButton, side === 'sell' && styles.sideSellActive]}
                onPress={() => setSide('sell')}
              >
                <Text
                  style={[styles.sideButtonText, side === 'sell' && styles.sideTextActive]}
                >
                  Sell
                </Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.inputLabel}>Energy (kWh)</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. 5"
              placeholderTextColor="#9ca3af"
              keyboardType="numeric"
              value={energyKwh}
              onChangeText={setEnergyKwh}
            />

            <Text style={styles.inputLabel}>
              {side === 'buy' ? 'Maximum price' : 'Minimum price'} (TZS/kWh)
            </Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. 250"
              placeholderTextColor="#9ca3af"
              keyboardType="numeric"
              value={priceTzs}
              onChangeText={setPriceTzs}
            />

            <TouchableOpacity
              style={styles.saveButton}
              onPress={handleSubmit}
              disabled={submitOrderMutation.isPending}
            >
              <Text style={styles.saveButtonText}>
                {submitOrderMutation.isPending ? 'Submitting…' : 'Submit Order'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.modalCancel}
              onPress={() => setModalVisible(false)}
            >
              <Text style={styles.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
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
  linkCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ecfdf5',
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    gap: 8,
  },
  linkText: {
    flex: 1,
    fontSize: 13,
    color: '#065f46',
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
  sideHeader: {
    fontSize: 13,
    fontWeight: '700',
    color: '#6b7280',
    textTransform: 'uppercase',
    marginTop: 8,
    marginBottom: 8,
  },
  levelRow: {
    marginBottom: 8,
    justifyContent: 'center',
    minHeight: 40,
  },
  depthBar: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    borderRadius: 6,
    opacity: 0.25,
  },
  depthBarBid: {
    backgroundColor: '#10b981',
  },
  depthBarAsk: {
    backgroundColor: '#ef4444',
  },
  levelContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  levelPrice: {
    fontSize: 14,
    fontWeight: '700',
  },
  bidText: {
    color: '#065f46',
  },
  askText: {
    color: '#991b1b',
  },
  levelMeta: {
    fontSize: 12,
    color: '#374151',
  },
  spreadRow: {
    alignItems: 'center',
    paddingVertical: 8,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#e5e7eb',
    marginVertical: 4,
  },
  spreadText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6b7280',
  },
  generatedAt: {
    fontSize: 11,
    color: '#9ca3af',
    marginTop: 8,
    textAlign: 'right',
  },
  orderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  orderTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111827',
  },
  orderMeta: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 2,
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
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#111827',
    marginBottom: 16,
  },
  sideRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  sideButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  sideBuyActive: {
    backgroundColor: '#10b981',
    borderColor: '#10b981',
  },
  sideSellActive: {
    backgroundColor: '#ef4444',
    borderColor: '#ef4444',
  },
  sideButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#6b7280',
  },
  sideTextActive: {
    color: 'white',
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
