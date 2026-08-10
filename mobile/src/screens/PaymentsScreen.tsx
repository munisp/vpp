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
} from 'react-native';
import { trpc } from '../services/trpc';
import ShareButton from '../components/ShareButton';
import { ShareService } from '../services/shareService';
import { HapticService } from '../services/hapticService';

export default function PaymentsScreen() {
  const [modalVisible, setModalVisible] = useState(false);
  const [selectedGateway, setSelectedGateway] = useState<'mpesa' | 'airtel' | 'tigo'>('mpesa');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [amount, setAmount] = useState('');

  const { data: payments } = trpc.payments.list.useQuery({ limit: 20 });
  const { data: balance } = trpc.payments.getBalance.useQuery();

  const initiatePaymentMutation = trpc.paymentProcessing.initiatePayment.useMutation({
    onSuccess: async (data) => {
      await HapticService.paymentCompleted();
      Alert.alert(
        'Payment Initiated',
        'Please check your phone to complete the payment',
        [{ text: 'OK', onPress: () => setModalVisible(false) }]
      );
    },
    onError: async (error) => {
      await HapticService.paymentFailed();
      Alert.alert('Error', error.message);
    },
  });

  const handleInitiatePayment = async () => {
    if (!phoneNumber || !amount) {
      await HapticService.validationError();
      Alert.alert('Error', 'Please enter phone number and amount');
      return;
    }

    await HapticService.buttonPress();
    initiatePaymentMutation.mutate({
      gateway: selectedGateway,
      amount: parseInt(amount) * 100, // Convert to cents
      phoneNumber,
      description: 'VPP Platform Payment',
    });
  };

  return (
    <ScrollView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Payments</Text>
      </View>

      {/* Balance Card */}
      <View style={styles.balanceCard}>
        <Text style={styles.balanceLabel}>Available Balance</Text>
        <Text style={styles.balanceAmount}>
          {((balance?.balance || 0) / 100).toFixed(0)} TZS
        </Text>
        <View style={styles.balanceActions}>
          <TouchableOpacity
            style={styles.balanceButton}
            onPress={() => setModalVisible(true)}
          >
            <Text style={styles.balanceButtonText}>💳 Top Up</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.balanceButton}>
            <Text style={styles.balanceButtonText}>💸 Withdraw</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Quick Stats */}
      <View style={styles.statsRow}>
        <View style={styles.statCard}>
          <Text style={styles.statLabel}>This Month</Text>
          <Text style={styles.statValue}>
            {((balance?.earned || 0) / 100).toFixed(0)} TZS
          </Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statLabel}>Pending</Text>
          <Text style={styles.statValue}>
            {((balance?.pending || 0) / 100).toFixed(0)} TZS
          </Text>
        </View>
      </View>

      {/* Payment History */}
      <View style={styles.historyCard}>
        <Text style={styles.sectionTitle}>Payment History</Text>
        {payments && payments.length > 0 ? (
          payments.map((payment) => (
            <PaymentItem key={payment.id} payment={payment} />
          ))
        ) : (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No payments yet</Text>
          </View>
        )}
      </View>

      {/* Payment Modal */}
      <Modal
        visible={modalVisible}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Top Up Balance</Text>

            {/* Gateway Selection */}
            <Text style={styles.inputLabel}>Select Payment Method</Text>
            <View style={styles.gatewaySelector}>
              <TouchableOpacity
                style={[
                  styles.gatewayButton,
                  selectedGateway === 'mpesa' && styles.gatewayButtonActive,
                ]}
                onPress={() => setSelectedGateway('mpesa')}
              >
                <Text style={styles.gatewayIcon}>💳</Text>
                <Text
                  style={[
                    styles.gatewayText,
                    selectedGateway === 'mpesa' && styles.gatewayTextActive,
                  ]}
                >
                  M-Pesa
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.gatewayButton,
                  selectedGateway === 'airtel' && styles.gatewayButtonActive,
                ]}
                onPress={() => setSelectedGateway('airtel')}
              >
                <Text style={styles.gatewayIcon}>📱</Text>
                <Text
                  style={[
                    styles.gatewayText,
                    selectedGateway === 'airtel' && styles.gatewayTextActive,
                  ]}
                >
                  Airtel
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.gatewayButton,
                  selectedGateway === 'tigo' && styles.gatewayButtonActive,
                ]}
                onPress={() => setSelectedGateway('tigo')}
              >
                <Text style={styles.gatewayIcon}>💰</Text>
                <Text
                  style={[
                    styles.gatewayText,
                    selectedGateway === 'tigo' && styles.gatewayTextActive,
                  ]}
                >
                  Tigo Pesa
                </Text>
              </TouchableOpacity>
            </View>

            {/* Phone Number */}
            <Text style={styles.inputLabel}>Phone Number</Text>
            <TextInput
              style={styles.input}
              placeholder="255XXXXXXXXX"
              value={phoneNumber}
              onChangeText={setPhoneNumber}
              keyboardType="phone-pad"
            />

            {/* Amount */}
            <Text style={styles.inputLabel}>Amount (TZS)</Text>
            <TextInput
              style={styles.input}
              placeholder="Enter amount"
              value={amount}
              onChangeText={setAmount}
              keyboardType="numeric"
            />

            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => setModalVisible(false)}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.submitButton}
                onPress={handleInitiatePayment}
                disabled={initiatePaymentMutation.isLoading}
              >
                <Text style={styles.submitButtonText}>
                  {initiatePaymentMutation.isLoading ? 'Processing...' : 'Pay Now'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

function PaymentItem({ payment }: { payment: any }) {
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return '#10b981';
      case 'pending':
        return '#f59e0b';
      case 'failed':
        return '#ef4444';
      default:
        return '#6b7280';
    }
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'credit':
        return '💰';
      case 'debit':
        return '💸';
      default:
        return '💳';
    }
  };

  return (
    <View style={styles.paymentItem}>
      <View style={styles.paymentIcon}>
        <Text style={styles.paymentIconText}>{getTypeIcon(payment.type)}</Text>
      </View>
      <View style={styles.paymentContent}>
        <Text style={styles.paymentDescription}>{payment.description}</Text>
        <Text style={styles.paymentDate}>
          {new Date(payment.createdAt).toLocaleDateString()}
        </Text>
      </View>
      <View style={styles.paymentRight}>
        <Text
          style={[
            styles.paymentAmount,
            { color: payment.type === 'credit' ? '#10b981' : '#111827' },
          ]}
        >
          {payment.type === 'credit' ? '+' : '-'}
          {(payment.amount / 100).toFixed(0)} TZS
        </Text>
        <View
          style={[
            styles.paymentStatus,
            { backgroundColor: getStatusColor(payment.status) },
          ]}
        >
          <Text style={styles.paymentStatusText}>{payment.status}</Text>
        </View>
      </View>
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
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#111827',
  },
  balanceCard: {
    backgroundColor: '#10b981',
    margin: 16,
    padding: 24,
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 4,
  },
  balanceLabel: {
    fontSize: 14,
    color: '#d1fae5',
    marginBottom: 8,
  },
  balanceAmount: {
    fontSize: 36,
    fontWeight: 'bold',
    color: '#fff',
    marginBottom: 24,
  },
  balanceActions: {
    flexDirection: 'row',
  },
  balanceButton: {
    flex: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    paddingVertical: 12,
    borderRadius: 8,
    marginRight: 8,
    alignItems: 'center',
  },
  balanceButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
  statsRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  statCard: {
    flex: 1,
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 12,
    marginRight: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  statLabel: {
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 4,
  },
  statValue: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#111827',
  },
  historyCard: {
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
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 16,
  },
  paymentItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  paymentIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#f0fdf4',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  paymentIconText: {
    fontSize: 20,
  },
  paymentContent: {
    flex: 1,
  },
  paymentDescription: {
    fontSize: 14,
    fontWeight: '500',
    color: '#111827',
    marginBottom: 2,
  },
  paymentDate: {
    fontSize: 12,
    color: '#6b7280',
  },
  paymentRight: {
    alignItems: 'flex-end',
  },
  paymentAmount: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  paymentStatus: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  paymentStatusText: {
    fontSize: 10,
    color: '#fff',
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  empty: {
    padding: 32,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
    color: '#6b7280',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: 40,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#111827',
    marginBottom: 24,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 8,
  },
  gatewaySelector: {
    flexDirection: 'row',
    marginBottom: 16,
  },
  gatewayButton: {
    flex: 1,
    padding: 12,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    marginRight: 8,
    alignItems: 'center',
  },
  gatewayButtonActive: {
    backgroundColor: '#10b981',
    borderColor: '#10b981',
  },
  gatewayIcon: {
    fontSize: 24,
    marginBottom: 4,
  },
  gatewayText: {
    fontSize: 12,
    color: '#6b7280',
    fontWeight: '500',
  },
  gatewayTextActive: {
    color: '#fff',
  },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    marginBottom: 16,
  },
  modalButtons: {
    flexDirection: 'row',
    marginTop: 8,
  },
  cancelButton: {
    flex: 1,
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d1d5db',
    marginRight: 8,
    alignItems: 'center',
  },
  cancelButtonText: {
    color: '#6b7280',
    fontWeight: '600',
  },
  submitButton: {
    flex: 1,
    padding: 16,
    borderRadius: 8,
    backgroundColor: '#10b981',
    alignItems: 'center',
  },
  submitButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
});
