import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Modal,
  TextInput,
  Switch,
  Alert,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { trpc } from '../services/trpc';
import { Ionicons } from '@expo/vector-icons';

export default function TradingStrategiesScreen() {
  const [isCreateModalVisible, setIsCreateModalVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const { data: strategies, isLoading, refetch } = trpc.tradingStrategies.list.useQuery();
  const createMutation = trpc.tradingStrategies.create.useMutation();
  const deleteMutation = trpc.tradingStrategies.delete.useMutation();
  const activateMutation = trpc.tradingStrategies.activate.useMutation();
  const deactivateMutation = trpc.tradingStrategies.deactivate.useMutation();
  const backtestMutation = trpc.tradingStrategies.backtest.useMutation();

  const [formData, setFormData] = useState({
    name: '',
    description: '',
    tradingMode: 'both' as 'export' | 'import' | 'both',
    priority: 0,
    conditions: {
      priceThresholds: {
        minExportPrice: '',
        maxExportPrice: '',
        minImportPrice: '',
        maxImportPrice: '',
      },
      batteryLevels: {
        minSOC: '',
        maxSOC: '',
      },
      timeWindows: {
        startHour: '',
        endHour: '',
      },
      energyLimits: {
        minTradeSize: '',
        maxTradeSize: '',
        dailyLimit: '',
      },
    },
  });

  const handleCreate = async () => {
    if (!formData.name.trim()) {
      Alert.alert('Error', 'Please enter a strategy name');
      return;
    }

    try {
      await createMutation.mutateAsync({
        name: formData.name,
        description: formData.description,
        tradingMode: formData.tradingMode,
        priority: formData.priority,
        conditions: {
          priceThresholds: {
            minExportPrice: formData.conditions.priceThresholds.minExportPrice
              ? parseFloat(formData.conditions.priceThresholds.minExportPrice)
              : undefined,
            maxExportPrice: formData.conditions.priceThresholds.maxExportPrice
              ? parseFloat(formData.conditions.priceThresholds.maxExportPrice)
              : undefined,
            minImportPrice: formData.conditions.priceThresholds.minImportPrice
              ? parseFloat(formData.conditions.priceThresholds.minImportPrice)
              : undefined,
            maxImportPrice: formData.conditions.priceThresholds.maxImportPrice
              ? parseFloat(formData.conditions.priceThresholds.maxImportPrice)
              : undefined,
          },
          batteryLevels: {
            minSOC: formData.conditions.batteryLevels.minSOC
              ? parseFloat(formData.conditions.batteryLevels.minSOC)
              : undefined,
            maxSOC: formData.conditions.batteryLevels.maxSOC
              ? parseFloat(formData.conditions.batteryLevels.maxSOC)
              : undefined,
          },
          timeWindows: {
            startHour: formData.conditions.timeWindows.startHour
              ? parseInt(formData.conditions.timeWindows.startHour)
              : undefined,
            endHour: formData.conditions.timeWindows.endHour
              ? parseInt(formData.conditions.timeWindows.endHour)
              : undefined,
            daysOfWeek: [],
          },
          energyLimits: {
            minTradeSize: formData.conditions.energyLimits.minTradeSize
              ? parseFloat(formData.conditions.energyLimits.minTradeSize)
              : undefined,
            maxTradeSize: formData.conditions.energyLimits.maxTradeSize
              ? parseFloat(formData.conditions.energyLimits.maxTradeSize)
              : undefined,
            dailyLimit: formData.conditions.energyLimits.dailyLimit
              ? parseFloat(formData.conditions.energyLimits.dailyLimit)
              : undefined,
          },
        },
      });

      Alert.alert('Success', 'Strategy created successfully');
      setIsCreateModalVisible(false);
      refetch();
      // Reset form
      setFormData({
        name: '',
        description: '',
        tradingMode: 'both',
        priority: 0,
        conditions: {
          priceThresholds: { minExportPrice: '', maxExportPrice: '', minImportPrice: '', maxImportPrice: '' },
          batteryLevels: { minSOC: '', maxSOC: '' },
          timeWindows: { startHour: '', endHour: '' },
          energyLimits: { minTradeSize: '', maxTradeSize: '', dailyLimit: '' },
        },
      });
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to create strategy');
    }
  };

  const handleToggleActive = async (id: number, isActive: boolean) => {
    try {
      if (isActive) {
        await deactivateMutation.mutateAsync({ id });
        Alert.alert('Success', 'Strategy deactivated');
      } else {
        await activateMutation.mutateAsync({ id });
        Alert.alert('Success', 'Strategy activated');
      }
      refetch();
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to toggle strategy');
    }
  };

  const handleDelete = (id: number) => {
    Alert.alert(
      'Delete Strategy',
      'Are you sure you want to delete this strategy?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteMutation.mutateAsync({ id });
              Alert.alert('Success', 'Strategy deleted');
              refetch();
            } catch (error: any) {
              Alert.alert('Error', error.message || 'Failed to delete strategy');
            }
          },
        },
      ]
    );
  };

  const handleBacktest = async (id: number, period: '7d' | '30d' | '90d') => {
    try {
      const result = await backtestMutation.mutateAsync({ id, period });
      // The server states whether it measured anything at all, so an unmeasured
      // backtest is reported as such instead of as a 0% return.
      Alert.alert(
        result.results.measured ? 'Backtest Complete' : 'Nothing to Backtest',
        result.results.measured
          ? `${result.message}\n` +
            `Projected Profit: ${result.results.projectedProfit.toFixed(2)} TZS\n` +
            `Success Rate: ${result.results.successRate === null ? 'not measured' : `${result.results.successRate.toFixed(1)}%`}`
          : result.message
      );
      refetch();
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to run backtest');
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  };

  if (isLoading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#10b981" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Trading Strategies</Text>
        <TouchableOpacity
          style={styles.createButton}
          onPress={() => setIsCreateModalVisible(true)}
        >
          <Ionicons name="add" size={24} color="#fff" />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.scrollView}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        {strategies && strategies.length === 0 && (
          <View style={styles.emptyState}>
            <Ionicons name="trending-up-outline" size={64} color="#9ca3af" />
            <Text style={styles.emptyTitle}>No strategies yet</Text>
            <Text style={styles.emptyText}>
              Create your first automated trading strategy
            </Text>
            <TouchableOpacity
              style={styles.emptyButton}
              onPress={() => setIsCreateModalVisible(true)}
            >
              <Text style={styles.emptyButtonText}>Create Strategy</Text>
            </TouchableOpacity>
          </View>
        )}

        {strategies?.map((strategy) => (
          <View
            key={strategy.id}
            style={[
              styles.strategyCard,
              strategy.isActive && styles.strategyCardActive,
            ]}
          >
            <View style={styles.strategyHeader}>
              <View style={styles.strategyTitleRow}>
                <Text style={styles.strategyName}>{strategy.name}</Text>
                {strategy.isActive && (
                  <View style={styles.activeBadge}>
                    <Text style={styles.activeBadgeText}>Active</Text>
                  </View>
                )}
              </View>
              <View style={styles.strategyActions}>
                <Switch
                  value={strategy.isActive}
                  onValueChange={() => handleToggleActive(strategy.id, strategy.isActive)}
                  trackColor={{ false: '#d1d5db', true: '#10b981' }}
                  thumbColor="#fff"
                />
                <TouchableOpacity
                  onPress={() => handleDelete(strategy.id)}
                  style={styles.deleteButton}
                >
                  <Ionicons name="trash-outline" size={20} color="#ef4444" />
                </TouchableOpacity>
              </View>
            </View>

            {strategy.description && (
              <Text style={styles.strategyDescription}>{strategy.description}</Text>
            )}

            <View style={styles.strategyStats}>
              <View style={styles.statItem}>
                <Text style={styles.statLabel}>Mode</Text>
                <Text style={styles.statValue}>{strategy.tradingMode}</Text>
              </View>
              <View style={styles.statItem}>
                <Text style={styles.statLabel}>Priority</Text>
                <Text style={styles.statValue}>{strategy.priority}</Text>
              </View>
              <View style={styles.statItem}>
                <Text style={styles.statLabel}>Trades</Text>
                <Text style={styles.statValue}>
                  {(strategy.performanceMetrics as any)?.totalTrades || 0}
                </Text>
              </View>
              <View style={styles.statItem}>
                <Text style={styles.statLabel}>Profit</Text>
                <Text style={styles.statValue}>
                  {((strategy.performanceMetrics as any)?.totalProfit || 0).toFixed(0)} TZS
                </Text>
              </View>
            </View>

            {strategy.backtestResults && (
              <View style={styles.backtestResults}>
                <Text style={styles.backtestTitle}>
                  Backtest Results ({(strategy.backtestResults as any).period})
                </Text>
                <View style={styles.backtestStats}>
                  <View style={styles.backtestStat}>
                    <Text style={styles.backtestLabel}>Simulated Trades</Text>
                    <Text style={styles.backtestValue}>
                      {(strategy.backtestResults as any).simulatedTrades}
                    </Text>
                  </View>
                  <View style={styles.backtestStat}>
                    <Text style={styles.backtestLabel}>Projected Profit</Text>
                    <Text style={styles.backtestValue}>
                      {((strategy.backtestResults as any).projectedProfit || 0).toFixed(2)} TZS
                    </Text>
                  </View>
                  <View style={styles.backtestStat}>
                    <Text style={styles.backtestLabel}>Success Rate</Text>
                    <Text style={styles.backtestValue}>
                      {typeof (strategy.backtestResults as any).successRate === 'number'
                        ? `${(strategy.backtestResults as any).successRate.toFixed(1)}%`
                        : 'not measured'}
                    </Text>
                  </View>
                </View>
                {(strategy.backtestResults as any).measured === false && (
                  <Text style={styles.backtestCaveat}>
                    No recorded trade met this strategy's conditions over the period, so these
                    figures are the absence of a result rather than a measured return.
                  </Text>
                )}
              </View>
            )}

            <View style={styles.backtestButtons}>
              <TouchableOpacity
                style={styles.backtestButton}
                onPress={() => handleBacktest(strategy.id, '7d')}
                disabled={backtestMutation.isPending}
              >
                <Text style={styles.backtestButtonText}>Backtest 7d</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.backtestButton}
                onPress={() => handleBacktest(strategy.id, '30d')}
                disabled={backtestMutation.isPending}
              >
                <Text style={styles.backtestButtonText}>Backtest 30d</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.backtestButton}
                onPress={() => handleBacktest(strategy.id, '90d')}
                disabled={backtestMutation.isPending}
              >
                <Text style={styles.backtestButtonText}>Backtest 90d</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}
      </ScrollView>

      {/* Create Strategy Modal */}
      <Modal
        visible={isCreateModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setIsCreateModalVisible(false)}
      >
        <View style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Create Strategy</Text>
            <TouchableOpacity onPress={() => setIsCreateModalVisible(false)}>
              <Ionicons name="close" size={28} color="#000" />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.modalContent}>
            {/* Basic Info */}
            <View style={styles.formSection}>
              <Text style={styles.sectionTitle}>Basic Information</Text>
              
              <Text style={styles.label}>Strategy Name *</Text>
              <TextInput
                style={styles.input}
                value={formData.name}
                onChangeText={(text) => setFormData({ ...formData, name: text })}
                placeholder="e.g., Peak Hour Export"
              />

              <Text style={styles.label}>Description</Text>
              <TextInput
                style={[styles.input, styles.textArea]}
                value={formData.description}
                onChangeText={(text) => setFormData({ ...formData, description: text })}
                placeholder="Describe your strategy..."
                multiline
                numberOfLines={3}
              />

              <Text style={styles.label}>Trading Mode</Text>
              <View style={styles.segmentedControl}>
                {['export', 'import', 'both'].map((mode) => (
                  <TouchableOpacity
                    key={mode}
                    style={[
                      styles.segment,
                      formData.tradingMode === mode && styles.segmentActive,
                    ]}
                    onPress={() => setFormData({ ...formData, tradingMode: mode as any })}
                  >
                    <Text
                      style={[
                        styles.segmentText,
                        formData.tradingMode === mode && styles.segmentTextActive,
                      ]}
                    >
                      {mode.charAt(0).toUpperCase() + mode.slice(1)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.label}>Priority</Text>
              <TextInput
                style={styles.input}
                value={formData.priority.toString()}
                onChangeText={(text) =>
                  setFormData({ ...formData, priority: parseInt(text) || 0 })
                }
                keyboardType="number-pad"
                placeholder="0"
              />
            </View>

            {/* Price Thresholds */}
            <View style={styles.formSection}>
              <Text style={styles.sectionTitle}>💰 Price Thresholds (TZS/kWh)</Text>
              
              <View style={styles.row}>
                <View style={styles.halfWidth}>
                  <Text style={styles.label}>Min Export Price</Text>
                  <TextInput
                    style={styles.input}
                    value={formData.conditions.priceThresholds.minExportPrice}
                    onChangeText={(text) =>
                      setFormData({
                        ...formData,
                        conditions: {
                          ...formData.conditions,
                          priceThresholds: {
                            ...formData.conditions.priceThresholds,
                            minExportPrice: text,
                          },
                        },
                      })
                    }
                    keyboardType="decimal-pad"
                    placeholder="0.15"
                  />
                </View>
                <View style={styles.halfWidth}>
                  <Text style={styles.label}>Max Export Price</Text>
                  <TextInput
                    style={styles.input}
                    value={formData.conditions.priceThresholds.maxExportPrice}
                    onChangeText={(text) =>
                      setFormData({
                        ...formData,
                        conditions: {
                          ...formData.conditions,
                          priceThresholds: {
                            ...formData.conditions.priceThresholds,
                            maxExportPrice: text,
                          },
                        },
                      })
                    }
                    keyboardType="decimal-pad"
                    placeholder="0.25"
                  />
                </View>
              </View>

              <View style={styles.row}>
                <View style={styles.halfWidth}>
                  <Text style={styles.label}>Min Import Price</Text>
                  <TextInput
                    style={styles.input}
                    value={formData.conditions.priceThresholds.minImportPrice}
                    onChangeText={(text) =>
                      setFormData({
                        ...formData,
                        conditions: {
                          ...formData.conditions,
                          priceThresholds: {
                            ...formData.conditions.priceThresholds,
                            minImportPrice: text,
                          },
                        },
                      })
                    }
                    keyboardType="decimal-pad"
                    placeholder="0.10"
                  />
                </View>
                <View style={styles.halfWidth}>
                  <Text style={styles.label}>Max Import Price</Text>
                  <TextInput
                    style={styles.input}
                    value={formData.conditions.priceThresholds.maxImportPrice}
                    onChangeText={(text) =>
                      setFormData({
                        ...formData,
                        conditions: {
                          ...formData.conditions,
                          priceThresholds: {
                            ...formData.conditions.priceThresholds,
                            maxImportPrice: text,
                          },
                        },
                      })
                    }
                    keyboardType="decimal-pad"
                    placeholder="0.20"
                  />
                </View>
              </View>
            </View>

            {/* Battery Levels */}
            <View style={styles.formSection}>
              <Text style={styles.sectionTitle}>🔋 Battery Levels (SOC %)</Text>
              
              <View style={styles.row}>
                <View style={styles.halfWidth}>
                  <Text style={styles.label}>Min SOC to Sell</Text>
                  <TextInput
                    style={styles.input}
                    value={formData.conditions.batteryLevels.minSOC}
                    onChangeText={(text) =>
                      setFormData({
                        ...formData,
                        conditions: {
                          ...formData.conditions,
                          batteryLevels: {
                            ...formData.conditions.batteryLevels,
                            minSOC: text,
                          },
                        },
                      })
                    }
                    keyboardType="number-pad"
                    placeholder="80"
                  />
                </View>
                <View style={styles.halfWidth}>
                  <Text style={styles.label}>Max SOC to Buy</Text>
                  <TextInput
                    style={styles.input}
                    value={formData.conditions.batteryLevels.maxSOC}
                    onChangeText={(text) =>
                      setFormData({
                        ...formData,
                        conditions: {
                          ...formData.conditions,
                          batteryLevels: {
                            ...formData.conditions.batteryLevels,
                            maxSOC: text,
                          },
                        },
                      })
                    }
                    keyboardType="number-pad"
                    placeholder="50"
                  />
                </View>
              </View>
            </View>

            {/* Time Windows */}
            <View style={styles.formSection}>
              <Text style={styles.sectionTitle}>⏰ Time Windows</Text>
              
              <View style={styles.row}>
                <View style={styles.halfWidth}>
                  <Text style={styles.label}>Start Hour (0-23)</Text>
                  <TextInput
                    style={styles.input}
                    value={formData.conditions.timeWindows.startHour}
                    onChangeText={(text) =>
                      setFormData({
                        ...formData,
                        conditions: {
                          ...formData.conditions,
                          timeWindows: {
                            ...formData.conditions.timeWindows,
                            startHour: text,
                          },
                        },
                      })
                    }
                    keyboardType="number-pad"
                    placeholder="9"
                  />
                </View>
                <View style={styles.halfWidth}>
                  <Text style={styles.label}>End Hour (0-23)</Text>
                  <TextInput
                    style={styles.input}
                    value={formData.conditions.timeWindows.endHour}
                    onChangeText={(text) =>
                      setFormData({
                        ...formData,
                        conditions: {
                          ...formData.conditions,
                          timeWindows: {
                            ...formData.conditions.timeWindows,
                            endHour: text,
                          },
                        },
                      })
                    }
                    keyboardType="number-pad"
                    placeholder="17"
                  />
                </View>
              </View>
            </View>

            {/* Energy Limits */}
            <View style={styles.formSection}>
              <Text style={styles.sectionTitle}>⚡ Energy Limits (kWh)</Text>
              
              <View style={styles.row}>
                <View style={styles.halfWidth}>
                  <Text style={styles.label}>Min Trade Size</Text>
                  <TextInput
                    style={styles.input}
                    value={formData.conditions.energyLimits.minTradeSize}
                    onChangeText={(text) =>
                      setFormData({
                        ...formData,
                        conditions: {
                          ...formData.conditions,
                          energyLimits: {
                            ...formData.conditions.energyLimits,
                            minTradeSize: text,
                          },
                        },
                      })
                    }
                    keyboardType="decimal-pad"
                    placeholder="1"
                  />
                </View>
                <View style={styles.halfWidth}>
                  <Text style={styles.label}>Max Trade Size</Text>
                  <TextInput
                    style={styles.input}
                    value={formData.conditions.energyLimits.maxTradeSize}
                    onChangeText={(text) =>
                      setFormData({
                        ...formData,
                        conditions: {
                          ...formData.conditions,
                          energyLimits: {
                            ...formData.conditions.energyLimits,
                            maxTradeSize: text,
                          },
                        },
                      })
                    }
                    keyboardType="decimal-pad"
                    placeholder="50"
                  />
                </View>
              </View>

              <Text style={styles.label}>Daily Limit</Text>
              <TextInput
                style={styles.input}
                value={formData.conditions.energyLimits.dailyLimit}
                onChangeText={(text) =>
                  setFormData({
                    ...formData,
                    conditions: {
                      ...formData.conditions,
                      energyLimits: {
                        ...formData.conditions.energyLimits,
                        dailyLimit: text,
                      },
                    },
                  })
                }
                keyboardType="decimal-pad"
                placeholder="100"
              />
            </View>
          </ScrollView>

          <View style={styles.modalFooter}>
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={() => setIsCreateModalVisible(false)}
            >
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.submitButton, !formData.name && styles.submitButtonDisabled]}
              onPress={handleCreate}
              disabled={!formData.name || createMutation.isPending}
            >
              <Text style={styles.submitButtonText}>
                {createMutation.isPending ? 'Creating...' : 'Create Strategy'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f9fafb',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#111827',
  },
  createButton: {
    backgroundColor: '#10b981',
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scrollView: {
    flex: 1,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 48,
    marginTop: 64,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#111827',
    marginTop: 16,
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
    marginBottom: 24,
  },
  emptyButton: {
    backgroundColor: '#10b981',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  emptyButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  strategyCard: {
    backgroundColor: '#fff',
    margin: 16,
    marginBottom: 8,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  strategyCardActive: {
    borderColor: '#10b981',
    borderWidth: 2,
  },
  strategyHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  strategyTitleRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  strategyName: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
  },
  activeBadge: {
    backgroundColor: '#d1fae5',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  activeBadgeText: {
    color: '#065f46',
    fontSize: 12,
    fontWeight: '600',
  },
  strategyActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  deleteButton: {
    padding: 4,
  },
  strategyDescription: {
    fontSize: 14,
    color: '#6b7280',
    marginBottom: 16,
  },
  strategyStats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  statItem: {
    flex: 1,
  },
  statLabel: {
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 4,
  },
  statValue: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
  },
  backtestCaveat: {
    marginTop: 8,
    fontSize: 12,
    color: '#6b7280',
  },
  backtestResults: {
    backgroundColor: '#f3f4f6',
    padding: 12,
    borderRadius: 8,
    marginBottom: 12,
  },
  backtestTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 12,
  },
  backtestStats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  backtestStat: {
    flex: 1,
  },
  backtestLabel: {
    fontSize: 11,
    color: '#6b7280',
    marginBottom: 4,
  },
  backtestValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
  },
  backtestButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  backtestButton: {
    flex: 1,
    backgroundColor: '#f3f4f6',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    alignItems: 'center',
  },
  backtestButtonText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#374151',
  },
  // Modal styles
  modalContainer: {
    flex: 1,
    backgroundColor: '#fff',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#111827',
  },
  modalContent: {
    flex: 1,
    padding: 16,
  },
  formSection: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 16,
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
    color: '#374151',
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#f9fafb',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    marginBottom: 16,
  },
  textArea: {
    height: 80,
    textAlignVertical: 'top',
  },
  row: {
    flexDirection: 'row',
    gap: 12,
  },
  halfWidth: {
    flex: 1,
  },
  segmentedControl: {
    flexDirection: 'row',
    backgroundColor: '#f3f4f6',
    borderRadius: 8,
    padding: 4,
    marginBottom: 16,
  },
  segment: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 6,
  },
  segmentActive: {
    backgroundColor: '#fff',
  },
  segmentText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#6b7280',
  },
  segmentTextActive: {
    color: '#111827',
  },
  modalFooter: {
    flexDirection: 'row',
    gap: 12,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d1d5db',
  },
  cancelButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#374151',
  },
  submitButton: {
    flex: 1,
    backgroundColor: '#10b981',
    paddingVertical: 12,
    alignItems: 'center',
    borderRadius: 8,
  },
  submitButtonDisabled: {
    backgroundColor: '#9ca3af',
  },
  submitButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
});
