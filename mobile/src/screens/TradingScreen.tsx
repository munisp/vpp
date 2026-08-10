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

  const utils = trpc.useUtils();

  const { data: preferences } = trpc.trading.getPreferences.useQuery();
  const { data: tradesData } = trpc.trading.list.useQuery({ limit: 50 });
  const {
    data: earnings,
    isLoading: earningsLoading,
    isError: earningsError,
  } = trpc.trading.getEarnings.useQuery();
  const {
    data: marketPrices,
    isLoading: pricesLoading,
    isError: pricesError,
    dataUpdatedAt: pricesUpdatedAt,
  } = trpc.trading.getMarketPrices.useQuery();

  const trades = tradesData?.trades;

  const createTradeMutation = trpc.trading.create.useMutation({
    onSuccess: async () => {
      await HapticService.tradeExecuted();
      Alert.alert('Success', 'Trade created successfully');
      setQuantity('');
      setPrice('');
      utils.trading.list.invalidate();
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

    const quantityNum = parseFloat(quantity);
    const priceNum = parseFloat(price);
    if (isNaN(quantityNum) || quantityNum <= 0 || isNaN(priceNum) || priceNum <= 0) {
      Alert.alert('Error', 'Please enter a valid quantity and price');
      return;
    }

    await HapticService.buttonPress();
    // Server input (server/routers/trading.ts -> create): energy in integer
    // watt-hours, price in integer cents per kWh. Manual user-initiated
    // trades map to export (sell) / import (buy) in manual mode.
    createTradeMutation.mutate({
      tradeType: activeTab === 'sell' ? 'export' : 'import',
      tradingMode: 'manual',
      energy: Math.round(quantityNum * 1000), // kWh -> Wh
      price: Math.round(priceNum * 100), // TZS -> cents per kWh
    });
  };

  // Server returns the latest market price per price type
  // (server/routers/trading.ts -> getMarketPrices), price in cents per kWh.
  const currentMarketPrice =
    marketPrices && marketPrices.length > 0 ? marketPrices[0].price : null;

  // Only compute a price change when two data points of the same price type
  // actually exist; otherwise omit the badge instead of fabricating one.
  const priceChangePercent = (() => {
    if (!marketPrices) return null;
    const byType = new Map<string, typeof marketPrices>();
    for (const row of marketPrices) {
      const list = byType.get(row.priceType) ?? [];
      list.push(row);
      byType.set(row.priceType, list);
    }
    for (const list of byType.values()) {
      if (list.length >= 2) {
        const sorted = [...list].sort(
          (a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );
        const prev = sorted[sorted.length - 2].price;
        const latest = sorted[sorted.length - 1].price;
        if (prev > 0) {
          return ((latest - prev) / prev) * 100;
        }
      }
    }
    return null;
  })();

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
              onPress={() =>
                ShareService.shareTradingOpportunity(
                  activeTab,
                  parseFloat(quantity) || 0,
                  // ShareService expects the price in cents per kWh.
                  price
                    ? Math.round(parseFloat(price) * 100)
                    : currentMarketPrice ?? 0
                )
              }
            />
          </View>
        </View>
        <View style={styles.earningsCard}>
          <Text style={styles.earningsLabel}>Net Earnings</Text>
          {earningsLoading ? (
            <Text style={styles.earningsValue}>…</Text>
          ) : earningsError || !earnings ? (
            <Text style={styles.earningsUnavailable}>Unavailable</Text>
          ) : (
            <Text style={styles.earningsValue}>
              {(earnings.netCents / 100).toFixed(0)} TZS
            </Text>
          )}
        </View>
      </View>

      {/* Market Price */}
      <View style={styles.marketCard}>
        <View style={styles.marketHeader}>
          <Text style={styles.marketTitle}>Current Market Price</Text>
          {priceChangePercent !== null && (
            <View style={styles.priceChange}>
              <Text style={styles.priceChangeText}>
                {priceChangePercent >= 0 ? '+' : ''}
                {priceChangePercent.toFixed(1)}%
              </Text>
            </View>
          )}
        </View>
        {pricesLoading ? (
          <Text style={styles.marketPrice}>Loading…</Text>
        ) : pricesError || currentMarketPrice === null ? (
          <Text style={styles.marketUnavailable}>
            Market price unavailable
          </Text>
        ) : (
          <Text style={styles.marketPrice}>
            {(currentMarketPrice / 100).toFixed(2)} TZS/kWh
          </Text>
        )}
        {!pricesLoading && !pricesError && (
          <Text style={styles.marketSubtext}>
            Last updated: {new Date(pricesUpdatedAt).toLocaleString()}
          </Text>
        )}
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
            {currentMarketPrice !== null && (
              <Text style={styles.inputHint}>
                Market price: {(currentMarketPrice / 100).toFixed(2)} TZS/kWh
              </Text>
            )}
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

      {/* Trades */}
      {trades && trades.length > 0 && (
        <View style={styles.tradesCard}>
          <Text style={styles.sectionTitle}>Your Trades</Text>
          {trades.map((trade) => (
            <TradeItem key={trade.id} trade={trade} />
          ))}
        </View>
      )}

      {/* Trading Preferences (real fields from trading.getPreferences) */}
      {preferences && (
        <View style={styles.preferencesCard}>
          <Text style={styles.sectionTitle}>Your Preferences</Text>
          <PreferenceItem
            label="Trading mode"
            value={preferences.tradingMode}
          />
          {'minExportPrice' in preferences && preferences.minExportPrice != null && (
            <PreferenceItem
              label="Min export price"
              value={`${(preferences.minExportPrice / 100).toFixed(2)} TZS/kWh`}
            />
          )}
          {'maxImportPrice' in preferences && preferences.maxImportPrice != null && (
            <PreferenceItem
              label="Max import price"
              value={`${(preferences.maxImportPrice / 100).toFixed(2)} TZS/kWh`}
            />
          )}
          <PreferenceItem
            label="P2P trading"
            value={preferences.enableP2P ? 'Enabled' : 'Disabled'}
          />
        </View>
      )}
    </ScrollView>
  );
}

function TradeItem({ trade }: { trade: any }) {
  // trades rows: tradeType 'export' | 'import' | 'p2p_sell' | 'p2p_buy',
  // energy in Wh, price in cents/kWh, totalAmount in cents.
  const isSell = trade.tradeType === 'export' || trade.tradeType === 'p2p_sell';
  return (
    <View style={styles.tradeItem}>
      <View style={styles.tradeHeader}>
        <View
          style={[
            styles.tradeType,
            {
              backgroundColor: isSell ? '#d1fae5' : '#dbeafe',
            },
          ]}
        >
          <Text
            style={[
              styles.tradeTypeText,
              { color: isSell ? '#065f46' : '#1e40af' },
            ]}
          >
            {isSell ? 'SELL' : 'BUY'}
          </Text>
        </View>
        <View
          style={[
            styles.tradeStatus,
            {
              backgroundColor:
                trade.status === 'pending' ? '#fef3c7' : '#d1fae5',
            },
          ]}
        >
          <Text
            style={[
              styles.tradeStatusText,
              {
                color:
                  trade.status === 'pending' ? '#92400e' : '#065f46',
              },
            ]}
          >
            {trade.status}
          </Text>
        </View>
      </View>
      <View style={styles.tradeDetails}>
        <Text style={styles.tradeQuantity}>
          {(trade.energy / 1000).toFixed(2)} kWh
        </Text>
        <Text style={styles.tradePrice}>
          @ {(trade.price / 100).toFixed(2)} TZS/kWh
        </Text>
      </View>
      <Text style={styles.tradeTotal}>
        Total: {(trade.totalAmount / 100).toFixed(0)} TZS
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
  earningsUnavailable: {
    fontSize: 16,
    fontWeight: '600',
    color: '#d1fae5',
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
  marketUnavailable: {
    fontSize: 16,
    fontWeight: '600',
    color: '#6b7280',
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
