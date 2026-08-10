import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
} from 'react-native';
import { trpc } from '../services/trpc';
import ShareButton from '../components/ShareButton';
import { ShareService } from '../services/shareService';
import { HapticService } from '../services/hapticService';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';

export default function TradingScreen() {
  const navigation = useNavigation();
  const [activeTab, setActiveTab] = useState<'buy' | 'sell'>('sell');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');

  const { data: preferences } = trpc.trading.getPreferences.useQuery();
  const { data: trades } = trpc.trading.getTrades.useQuery({ status: 'active' });
  const { data: earnings } = trpc.trading.getEarnings.useQuery();
  const { data: marketPrices } = trpc.trading.getMarketPrices.useQuery();

  const createTradeMutation = trpc.trading.createTrade.useMutation({
    onSuccess: async () => {
      await HapticService.tradeExecuted();
      Alert.alert('Success', 'Trade created successfully');
      setQuantity('');
      setPrice('');
    },
    onError: async (error) => {
      await HapticService.error();
      Alert.alert('Error', error.message);
    },
  });

  const handleCreateTrade = async () => {
    if (!quantity || !price) {
      await HapticService.validationError();
      Alert.alert('Error', 'Please enter quantity and price');
      return;
    }

    await HapticService.buttonPress();
    createTradeMutation.mutate({
      type: activeTab,
      quantity: parseInt(quantity),
      price: parseInt(price),
    });
  };

  const currentMarketPrice = marketPrices?.[0]?.price || 0;

  return (
    <ScrollView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <Text style={styles.title}>Energy Trading</Text>
          <View style={styles.headerActions}>
            <TouchableOpacity
              style={styles.strategiesButton}
              onPress={() => navigation.navigate('TradingStrategies' as never)}
            >
              <Ionicons name="flash-outline" size={18} color="#10b981" />
              <Text style={styles.strategiesButtonText}>Strategies</Text>
            </TouchableOpacity>
            <ShareButton
              variant="icon"
              size="small"
              onPress={() => ShareService.shareTradingOpportunity(
                activeTab,
                parseInt(quantity) || 10,
                parseInt(price) || currentMarketPrice
              )}
            />
          </View>
        </View>
        <View style={styles.earningsCard}>
          <Text style={styles.earningsLabel}>Total Earnings</Text>
          <Text style={styles.earningsValue}>
            {((earnings?.totalEarnings || 0) / 100).toFixed(0)} TZS
          </Text>
        </View>
      </View>

      {/* Market Price */}
      <View style={styles.marketCard}>
        <View style={styles.marketHeader}>
          <Text style={styles.marketTitle}>Current Market Price</Text>
          <View style={styles.priceChange}>
            <Text style={styles.priceChangeText}>+2.5%</Text>
          </View>
        </View>
        <Text style={styles.marketPrice}>
          {(currentMarketPrice / 100).toFixed(2)} TZS/kWh
        </Text>
        <Text style={styles.marketSubtext}>Last updated: Just now</Text>
      </View>

      {/* Trade Form */}
      <View style={styles.tradeCard}>
        <View style={styles.tabBar}>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'sell' && styles.tabActive]}
            onPress={() => setActiveTab('sell')}
          >
            <Text
              style={[
                styles.tabText,
                activeTab === 'sell' && styles.tabTextActive,
              ]}
            >
              Sell Energy
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'buy' && styles.tabActive]}
            onPress={() => setActiveTab('buy')}
          >
            <Text
              style={[
                styles.tabText,
                activeTab === 'buy' && styles.tabTextActive,
              ]}
            >
              Buy Energy
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.form}>
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Quantity (kWh)</Text>
            <TextInput
              style={styles.input}
              placeholder="Enter quantity"
              value={quantity}
              onChangeText={setQuantity}
              keyboardType="numeric"
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Price (TZS/kWh)</Text>
            <TextInput
              style={styles.input}
              placeholder="Enter price"
              value={price}
              onChangeText={setPrice}
              keyboardType="numeric"
            />
            <Text style={styles.inputHint}>
              Market price: {(currentMarketPrice / 100).toFixed(2)} TZS/kWh
            </Text>
          </View>

          <View style={styles.summary}>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Total Amount:</Text>
              <Text style={styles.summaryValue}>
                {((parseInt(quantity) || 0) * (parseInt(price) || 0)).toFixed(
                  0
                )}{' '}
                TZS
              </Text>
            </View>
          </View>

          <TouchableOpacity
            style={[
              styles.tradeButton,
              { backgroundColor: activeTab === 'sell' ? '#10b981' : '#3b82f6' },
            ]}
            onPress={handleCreateTrade}
          >
            <Text style={styles.tradeButtonText}>
              {activeTab === 'sell' ? 'Sell Energy' : 'Buy Energy'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Active Trades */}
      {trades && trades.length > 0 && (
        <View style={styles.tradesCard}>
          <Text style={styles.sectionTitle}>Active Trades</Text>
          {trades.map((trade) => (
            <TradeItem key={trade.id} trade={trade} />
          ))}
        </View>
      )}

      {/* Trading Preferences */}
      {preferences && (
        <View style={styles.preferencesCard}>
          <Text style={styles.sectionTitle}>Your Preferences</Text>
          <PreferenceItem
            label="Auto-sell enabled"
            value={preferences.autoSellEnabled ? 'Yes' : 'No'}
          />
          <PreferenceItem
            label="Min sell price"
            value={`${(preferences.minSellPrice / 100).toFixed(2)} TZS/kWh`}
          />
          <PreferenceItem
            label="Max buy price"
            value={`${(preferences.maxBuyPrice / 100).toFixed(2)} TZS/kWh`}
          />
        </View>
      )}
    </ScrollView>
  );
}

function TradeItem({ trade }: { trade: any }) {
  return (
    <View style={styles.tradeItem}>
      <View style={styles.tradeHeader}>
        <View
          style={[
            styles.tradeType,
            {
              backgroundColor:
                trade.type === 'sell' ? '#d1fae5' : '#dbeafe',
            },
          ]}
        >
          <Text
            style={[
              styles.tradeTypeText,
              { color: trade.type === 'sell' ? '#065f46' : '#1e40af' },
            ]}
          >
            {trade.type.toUpperCase()}
          </Text>
        </View>
        <View
          style={[
            styles.tradeStatus,
            {
              backgroundColor:
                trade.status === 'active' ? '#fef3c7' : '#d1fae5',
            },
          ]}
        >
          <Text
            style={[
              styles.tradeStatusText,
              {
                color:
                  trade.status === 'active' ? '#92400e' : '#065f46',
              },
            ]}
          >
            {trade.status}
          </Text>
        </View>
      </View>
      <View style={styles.tradeDetails}>
        <Text style={styles.tradeQuantity}>{trade.quantity} kWh</Text>
        <Text style={styles.tradePrice}>
          @ {(trade.price / 100).toFixed(2)} TZS/kWh
        </Text>
      </View>
      <Text style={styles.tradeTotal}>
        Total: {((trade.quantity * trade.price) / 100).toFixed(0)} TZS
      </Text>
    </View>
  );
}

function PreferenceItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.preferenceItem}>
      <Text style={styles.preferenceLabel}>{label}</Text>
      <Text style={styles.preferenceValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
  },
  header: {
    padding: 16,
    paddingTop: 60,
    backgroundColor: '#10b981',
  },
  headerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  strategiesButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    gap: 4,
  },
  strategiesButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#10b981',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
  },
  earningsCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    padding: 16,
    borderRadius: 12,
  },
  earningsLabel: {
    fontSize: 14,
    color: '#d1fae5',
    marginBottom: 4,
  },
  earningsValue: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#fff',
  },
  marketCard: {
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
  marketHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  marketTitle: {
    fontSize: 14,
    color: '#6b7280',
  },
  priceChange: {
    backgroundColor: '#d1fae5',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  priceChangeText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#065f46',
  },
  marketPrice: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#111827',
    marginBottom: 4,
  },
  marketSubtext: {
    fontSize: 12,
    color: '#9ca3af',
  },
  tradeCard: {
    backgroundColor: '#fff',
    margin: 16,
    marginTop: 0,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  tab: {
    flex: 1,
    paddingVertical: 16,
    alignItems: 'center',
  },
  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: '#10b981',
  },
  tabText: {
    fontSize: 16,
    color: '#6b7280',
  },
  tabTextActive: {
    color: '#10b981',
    fontWeight: '600',
  },
  form: {
    padding: 16,
  },
  inputGroup: {
    marginBottom: 16,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
  },
  inputHint: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 4,
  },
  summary: {
    backgroundColor: '#f9fafb',
    padding: 16,
    borderRadius: 8,
    marginBottom: 16,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  summaryLabel: {
    fontSize: 14,
    color: '#6b7280',
  },
  summaryValue: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#111827',
  },
  tradeButton: {
    paddingVertical: 16,
    borderRadius: 8,
    alignItems: 'center',
  },
  tradeButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  tradesCard: {
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
  tradeItem: {
    padding: 12,
    backgroundColor: '#f9fafb',
    borderRadius: 8,
    marginBottom: 12,
  },
  tradeHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  tradeType: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  tradeTypeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  tradeStatus: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  tradeStatusText: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  tradeDetails: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  tradeQuantity: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
    marginRight: 8,
  },
  tradePrice: {
    fontSize: 14,
    color: '#6b7280',
  },
  tradeTotal: {
    fontSize: 14,
    color: '#374151',
  },
  preferencesCard: {
    backgroundColor: '#fff',
    margin: 16,
    marginTop: 0,
    marginBottom: 32,
    padding: 16,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  preferenceItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  preferenceLabel: {
    fontSize: 14,
    color: '#374151',
  },
  preferenceValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
  },
});
