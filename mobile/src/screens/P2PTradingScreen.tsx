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
import ShareButton from '../components/ShareButton';
import { ShareService } from '../services/shareService';
import { HapticService } from '../services/hapticService';

export default function P2PTradingScreen({ navigation }: any) {
  const [activeTab, setActiveTab] = useState<'browse' | 'my-offers'>('browse');
  const [createModalVisible, setCreateModalVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Form state (the server only supports publishing sell offers)
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');

  const utils = trpc.useUtils();

  const {
    data: offers,
    refetch: refetchOffers,
    isLoading: offersLoading,
    isError: offersError,
  } = trpc.p2pTrading.getOffers.useQuery({ limit: 50 });

  const {
    data: myOffers,
    refetch: refetchMyOffers,
    isLoading: myOffersLoading,
    isError: myOffersError,
  } = trpc.p2pTrading.getMyOffers.useQuery();

  const createOfferMutation = trpc.p2pTrading.createOffer.useMutation({
    onSuccess: async () => {
      await HapticService.success();
      Alert.alert('Success', 'Your offer has been created!');
      setCreateModalVisible(false);
      setQuantity('');
      setPrice('');
      utils.p2pTrading.getOffers.invalidate();
      utils.p2pTrading.getMyOffers.invalidate();
    },
    onError: async (error) => {
      await HapticService.error();
      Alert.alert('Error', error.message);
    },
  });

  const acceptOfferMutation = trpc.p2pTrading.acceptOffer.useMutation({
    onSuccess: async () => {
      await HapticService.offerAccepted();
      Alert.alert('Success', 'Trade accepted! Check your trades for details.');
      utils.p2pTrading.getOffers.invalidate();
    },
    onError: async (error) => {
      await HapticService.error();
      Alert.alert('Error', error.message);
    },
  });

  const cancelOfferMutation = trpc.p2pTrading.cancelOffer.useMutation({
    onSuccess: () => {
      Alert.alert('Success', 'Offer cancelled');
      utils.p2pTrading.getMyOffers.invalidate();
      utils.p2pTrading.getOffers.invalidate();
    },
    onError: (error) => {
      Alert.alert('Error', error.message);
    },
  });

  const onRefresh = async () => {
    setRefreshing(true);
    await HapticService.pullToRefresh();
    await Promise.all([refetchOffers(), refetchMyOffers()]);
    setRefreshing(false);
  };

  const handleCreateOffer = async () => {
    if (!quantity || !price) {
      await HapticService.validationError();
      Alert.alert('Error', 'Please fill in all required fields');
      return;
    }

    await HapticService.buttonPress();

    const quantityNum = parseFloat(quantity);
    const priceNum = parseFloat(price);

    if (isNaN(quantityNum) || quantityNum <= 0) {
      Alert.alert('Error', 'Please enter a valid quantity');
      return;
    }

    if (isNaN(priceNum) || priceNum <= 0) {
      Alert.alert('Error', 'Please enter a valid price');
      return;
    }

    // Server input (server/routers/p2p-trading.ts -> createOffer):
    //   energy: integer watt-hours, price: integer cents per kWh.
    createOfferMutation.mutate({
      energy: Math.round(quantityNum * 1000), // kWh -> Wh
      price: Math.round(priceNum * 100), // TZS -> cents per kWh
    });
  };

  const handleAcceptOffer = (offerId: number) => {
    Alert.alert(
      'Confirm Trade',
      'Are you sure you want to accept this offer?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Accept',
          onPress: () => acceptOfferMutation.mutate({ offerId }),
        },
      ]
    );
  };

  const handleCancelOffer = (offerId: number) => {
    Alert.alert(
      'Cancel Offer',
      'Are you sure you want to cancel this offer?',
      [
        { text: 'No', style: 'cancel' },
        {
          text: 'Yes',
          style: 'destructive',
          onPress: () => cancelOfferMutation.mutate({ offerId }),
        },
      ]
    );
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <Text style={styles.title}>P2P Trading</Text>
        <TouchableOpacity
          onPress={() => setCreateModalVisible(!createModalVisible)}
          style={styles.addButton}
        >
          <Ionicons name="add-circle" size={28} color="#10b981" />
        </TouchableOpacity>
      </View>

      {/* Link to the order-book matcher */}
      <TouchableOpacity
        style={styles.orderBookLink}
        onPress={() => navigation.navigate('OrderBook')}
      >
        <Ionicons name="book-outline" size={18} color="#10b981" />
        <Text style={styles.orderBookLinkText}>
          View live order book & place matched orders
        </Text>
        <Ionicons name="chevron-forward" size={18} color="#6b7280" />
      </TouchableOpacity>

      {/* Create Offer Form */}
      {createModalVisible && (
        <View style={styles.createForm}>
          <Text style={styles.formTitle}>Create Sell Offer</Text>
          <Text style={styles.formSubtitle}>
            Publish surplus energy for other users to buy.
          </Text>

          {/* Quantity */}
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Quantity (kWh)</Text>
            <TextInput
              style={styles.input}
              value={quantity}
              onChangeText={setQuantity}
              keyboardType="numeric"
              placeholder="e.g., 10"
            />
          </View>

          {/* Price */}
          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Price per kWh (TZS)</Text>
            <TextInput
              style={styles.input}
              value={price}
              onChangeText={setPrice}
              keyboardType="numeric"
              placeholder="e.g., 250"
            />
          </View>

          {/* Actions */}
          <View style={styles.formActions}>
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={() => setCreateModalVisible(false)}
            >
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.submitButton}
              onPress={handleCreateOffer}
              disabled={createOfferMutation.isLoading}
            >
              <Text style={styles.submitButtonText}>
                {createOfferMutation.isLoading ? 'Creating...' : 'Create Offer'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Tabs */}
      <View style={styles.tabs}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'browse' && styles.activeTab]}
          onPress={() => setActiveTab('browse')}
        >
          <Text
            style={[
              styles.tabText,
              activeTab === 'browse' && styles.activeTabText,
            ]}
          >
            Browse Offers
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'my-offers' && styles.activeTab]}
          onPress={() => setActiveTab('my-offers')}
        >
          <Text
            style={[
              styles.tabText,
              activeTab === 'my-offers' && styles.activeTabText,
            ]}
          >
            My Offers
          </Text>
        </TouchableOpacity>
      </View>

      {/* Content */}
      <ScrollView
        style={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        {activeTab === 'browse' && (
          <View style={styles.offersContainer}>
            {offersLoading && (
              <View style={styles.emptyState}>
                <Text style={styles.emptyText}>Loading offers…</Text>
              </View>
            )}

            {offersError && (
              <View style={styles.emptyState}>
                <Ionicons name="alert-circle-outline" size={64} color="#d1d5db" />
                <Text style={styles.emptyText}>Could not load offers</Text>
                <Text style={styles.emptyDescription}>
                  Pull down to try again.
                </Text>
              </View>
            )}

            {/* Server shape: energy in Wh, price in cents/kWh, all offers
                are sell offers (p2p_sell). */}
            {offers?.map((offer) => (
              <View key={offer.id} style={styles.offerCard}>
                <View style={styles.offerHeader}>
                  <View style={[styles.offerTypeBadge, styles.sellBadge]}>
                    <Text style={styles.offerTypeBadgeText}>SELL</Text>
                  </View>
                  <Text style={styles.offerUser}>
                    {offer.sellerName || 'Unknown seller'}
                  </Text>
                </View>

                <View style={styles.offerDetails}>
                  <View style={styles.offerDetail}>
                    <Ionicons name="flash" size={20} color="#f59e0b" />
                    <Text style={styles.offerDetailText}>
                      {(offer.energy / 1000).toFixed(2)} kWh
                    </Text>
                  </View>
                  <View style={styles.offerDetail}>
                    <Ionicons name="cash" size={20} color="#10b981" />
                    <Text style={styles.offerDetailText}>
                      {(offer.price / 100).toFixed(2)} TZS/kWh
                    </Text>
                  </View>
                </View>

                <View style={styles.offerFooter}>
                  <Text style={styles.offerTime}>
                    Total {(offer.totalAmount / 100).toFixed(0)} TZS ·{' '}
                    {new Date(offer.createdAt).toLocaleDateString()}
                  </Text>
                  <View style={styles.offerActions}>
                    <TouchableOpacity
                      style={styles.acceptButton}
                      onPress={() => handleAcceptOffer(offer.id)}
                      disabled={acceptOfferMutation.isLoading}
                    >
                      <Text style={styles.acceptButtonText}>Accept</Text>
                    </TouchableOpacity>
                    <ShareButton
                      onPress={() =>
                        ShareService.shareP2POffer(
                          'sell',
                          offer.energy / 1000,
                          offer.price
                        )
                      }
                      size="small"
                    />
                  </View>
                </View>
              </View>
            ))}

            {!offersLoading && !offersError && !offers?.length && (
              <View style={styles.emptyState}>
                <Ionicons name="swap-horizontal-outline" size={64} color="#d1d5db" />
                <Text style={styles.emptyText}>No active offers</Text>
                <Text style={styles.emptyDescription}>
                  Be the first to create an offer!
                </Text>
              </View>
            )}
          </View>
        )}

        {activeTab === 'my-offers' && (
          <View style={styles.offersContainer}>
            {myOffersLoading && (
              <View style={styles.emptyState}>
                <Text style={styles.emptyText}>Loading your offers…</Text>
              </View>
            )}

            {myOffersError && (
              <View style={styles.emptyState}>
                <Ionicons name="alert-circle-outline" size={64} color="#d1d5db" />
                <Text style={styles.emptyText}>Could not load your offers</Text>
                <Text style={styles.emptyDescription}>
                  Pull down to try again.
                </Text>
              </View>
            )}

            {/* Server shape: trades rows with tradeType
                'p2p_sell' | 'p2p_buy', energy in Wh, price in cents/kWh and
                status 'pending' | 'executed' | 'cancelled' | 'failed'. */}
            {myOffers?.map((offer) => (
              <View key={offer.id} style={styles.offerCard}>
                <View style={styles.offerHeader}>
                  <View
                    style={[
                      styles.offerTypeBadge,
                      offer.tradeType === 'p2p_sell'
                        ? styles.sellBadge
                        : styles.buyBadge,
                    ]}
                  >
                    <Text style={styles.offerTypeBadgeText}>
                      {offer.tradeType === 'p2p_sell' ? 'SELL' : 'BUY'}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.statusBadge,
                      offer.status === 'pending'
                        ? styles.activeBadge
                        : styles.inactiveBadge,
                    ]}
                  >
                    <Text style={styles.statusBadgeText}>
                      {offer.status.toUpperCase()}
                    </Text>
                  </View>
                </View>

                <View style={styles.offerDetails}>
                  <View style={styles.offerDetail}>
                    <Ionicons name="flash" size={20} color="#f59e0b" />
                    <Text style={styles.offerDetailText}>
                      {(offer.energy / 1000).toFixed(2)} kWh
                    </Text>
                  </View>
                  <View style={styles.offerDetail}>
                    <Ionicons name="cash" size={20} color="#10b981" />
                    <Text style={styles.offerDetailText}>
                      {(offer.price / 100).toFixed(2)} TZS/kWh
                    </Text>
                  </View>
                </View>

                <View style={styles.offerFooter}>
                  <Text style={styles.offerTime}>
                    Total {(offer.totalAmount / 100).toFixed(0)} TZS ·{' '}
                    {new Date(offer.createdAt).toLocaleDateString()}
                  </Text>
                  {offer.status === 'pending' && offer.tradeType === 'p2p_sell' && (
                    <TouchableOpacity
                      style={styles.cancelOfferButton}
                      onPress={() => handleCancelOffer(offer.id)}
                      disabled={cancelOfferMutation.isLoading}
                    >
                      <Text style={styles.cancelOfferButtonText}>Cancel</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            ))}

            {!myOffersLoading && !myOffersError && !myOffers?.length && (
              <View style={styles.emptyState}>
                <Ionicons name="document-outline" size={64} color="#d1d5db" />
                <Text style={styles.emptyText}>No offers yet</Text>
                <Text style={styles.emptyDescription}>
                  Create your first offer to start trading
                </Text>
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 50,
    paddingBottom: 16,
    backgroundColor: 'white',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  backButton: {
    padding: 8,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#111827',
  },
  addButton: {
    padding: 8,
  },
  orderBookLink: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ecfdf5',
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    gap: 8,
  },
  orderBookLinkText: {
    flex: 1,
    fontSize: 13,
    color: '#065f46',
    fontWeight: '600',
  },
  createForm: {
    backgroundColor: 'white',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  formTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 4,
  },
  formSubtitle: {
    fontSize: 13,
    color: '#6b7280',
    marginBottom: 16,
  },
  typeSelector: {
    flexDirection: 'row',
    marginBottom: 16,
    gap: 8,
  },
  typeButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: '#f3f4f6',
    alignItems: 'center',
  },
  typeButtonActive: {
    backgroundColor: '#10b981',
  },
  typeButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#6b7280',
  },
  typeButtonTextActive: {
    color: 'white',
  },
  inputGroup: {
    marginBottom: 16,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#374151',
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: '#111827',
  },
  textArea: {
    height: 80,
    textAlignVertical: 'top',
  },
  formActions: {
    flexDirection: 'row',
    gap: 12,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: '#f3f4f6',
    alignItems: 'center',
  },
  cancelButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#6b7280',
  },
  submitButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: '#10b981',
    alignItems: 'center',
  },
  submitButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: 'white',
  },
  tabs: {
    flexDirection: 'row',
    backgroundColor: 'white',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  tab: {
    flex: 1,
    paddingVertical: 16,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  activeTab: {
    borderBottomColor: '#10b981',
  },
  tabText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#6b7280',
  },
  activeTabText: {
    color: '#10b981',
  },
  content: {
    flex: 1,
  },
  offersContainer: {
    padding: 16,
  },
  offerCard: {
    backgroundColor: 'white',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 2,
  },
  offerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  offerTypeBadge: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
  },
  sellBadge: {
    backgroundColor: '#fef3c7',
  },
  buyBadge: {
    backgroundColor: '#dbeafe',
  },
  offerTypeBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#111827',
  },
  offerUser: {
    fontSize: 14,
    fontWeight: '500',
    color: '#6b7280',
  },
  statusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
  },
  activeBadge: {
    backgroundColor: '#d1fae5',
  },
  inactiveBadge: {
    backgroundColor: '#f3f4f6',
  },
  statusBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#111827',
  },
  offerDetails: {
    flexDirection: 'row',
    gap: 16,
    marginBottom: 12,
  },
  offerDetail: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  offerDetailText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
  },
  offerDescription: {
    fontSize: 14,
    color: '#6b7280',
    marginBottom: 12,
  },
  offerFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  offerTime: {
    fontSize: 12,
    color: '#9ca3af',
  },
  offerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  acceptButton: {
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#10b981',
  },
  acceptButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: 'white',
  },
  cancelOfferButton: {
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#fee2e2',
  },
  cancelOfferButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#dc2626',
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 64,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#6b7280',
    marginTop: 16,
  },
  emptyDescription: {
    fontSize: 14,
    color: '#9ca3af',
    marginTop: 8,
    textAlign: 'center',
  },
});
