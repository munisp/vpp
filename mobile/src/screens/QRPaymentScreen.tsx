import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  Modal,
  ScrollView,
  TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import QRScanner from '../components/QRScanner';
import { trpc } from '../services/trpc';
import { HapticService } from '../services/hapticService';

export default function QRPaymentScreen({ navigation }: any) {
  const [scannerVisible, setScannerVisible] = useState(false);
  const [scannedData, setScannedData] = useState<any>(null);
  const [phoneNumber, setPhoneNumber] = useState('');

  // Server endpoint: trpc.payments.initiate (server/routers/payments.ts).
  // Input: paymentType enum, amount in integer cents, paymentMethod enum,
  // optional phoneNumber (required for the mobile-money gateway prompt).
  const initiatePaymentMutation = trpc.payments.initiate.useMutation({
    onSuccess: async (data) => {
      await HapticService.paymentCompleted();
      Alert.alert(
        'Payment Initiated',
        `${data.message || 'Please check your phone to complete the payment.'}${
          data.payment?.id ? `\nReference: PAY${data.payment.id}` : ''
        }`,
        [
          {
            text: 'OK',
            onPress: () => {
              setScannedData(null);
              navigation.goBack();
            },
          },
        ]
      );
    },
    onError: async (error) => {
      await HapticService.paymentFailed();
      Alert.alert('Payment Failed', error.message);
    },
  });

  const handleScan = async (data: string) => {
    await HapticService.qrScanned();
    try {
      // Parse QR code data
      // Expected format: vpp://payment?amount=1000&recipient=John&reference=INV-001
      const url = new URL(data);
      
      if (url.protocol !== 'vpp:' || url.hostname !== 'payment') {
        Alert.alert('Invalid QR Code', 'This QR code is not a valid payment request');
        setScannerVisible(false);
        return;
      }

      const amount = url.searchParams.get('amount');
      const recipient = url.searchParams.get('recipient');
      const reference = url.searchParams.get('reference');

      if (!amount) {
        Alert.alert('Invalid QR Code', 'Payment amount not found');
        setScannerVisible(false);
        return;
      }

      setScannedData({
        amount: parseInt(amount),
        recipient: recipient || 'Unknown',
        reference: reference || '',
      });
      setScannerVisible(false);
    } catch (error) {
      Alert.alert('Invalid QR Code', 'Could not parse QR code data');
      setScannerVisible(false);
    }
  };

  const handleConfirmPayment = () => {
    if (!scannedData) return;

    if (!phoneNumber.trim()) {
      Alert.alert(
        'Phone Number Required',
        'Enter the mobile money phone number that will receive the M-Pesa payment prompt.'
      );
      return;
    }

    Alert.alert(
      'Confirm Payment',
      `Pay ${(scannedData.amount / 100).toFixed(0)} TZS to ${scannedData.recipient}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          onPress: () => {
            // amount from the QR is already integer cents; the gateway
            // prompt is only sent when a phone number is provided.
            initiatePaymentMutation.mutate({
              paymentType: 'invoice',
              amount: scannedData.amount,
              paymentMethod: 'mpesa',
              phoneNumber: phoneNumber || undefined,
            });
          },
        },
      ]
    );
  };

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            style={styles.backButton}
          >
            <Ionicons name="arrow-back" size={24} color="#111827" />
          </TouchableOpacity>
          <Text style={styles.title}>QR Payment</Text>
          <View style={{ width: 40 }} />
        </View>

        {/* Instructions */}
        {!scannedData && (
          <View style={styles.instructionsCard}>
            <Ionicons name="qr-code-outline" size={64} color="#10b981" />
            <Text style={styles.instructionsTitle}>Scan to Pay</Text>
            <Text style={styles.instructionsText}>
              Scan a payment QR code to quickly process payments without manual entry
            </Text>
          </View>
        )}

        {/* Scanned payment details */}
        {scannedData && (
          <View style={styles.paymentCard}>
            <View style={styles.paymentHeader}>
              <Ionicons name="checkmark-circle" size={48} color="#10b981" />
              <Text style={styles.paymentTitle}>Payment Request</Text>
            </View>

            <View style={styles.paymentDetails}>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Amount</Text>
                <Text style={styles.detailValue}>
                  {(scannedData.amount / 100).toFixed(0)} TZS
                </Text>
              </View>

              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Recipient</Text>
                <Text style={styles.detailValue}>{scannedData.recipient}</Text>
              </View>

              {scannedData.reference && (
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Reference</Text>
                  <Text style={styles.detailValue}>{scannedData.reference}</Text>
                </View>
              )}
            </View>

            <Text style={styles.phoneLabel}>M-Pesa phone number</Text>
            <TextInput
              style={styles.phoneInput}
              placeholder="e.g. 2557XXXXXXXX"
              placeholderTextColor="#9ca3af"
              keyboardType="phone-pad"
              value={phoneNumber}
              onChangeText={setPhoneNumber}
            />

            <TouchableOpacity
              style={styles.confirmButton}
              onPress={handleConfirmPayment}
              disabled={initiatePaymentMutation.isLoading}
            >
              <Text style={styles.confirmButtonText}>
                {initiatePaymentMutation.isLoading ? 'Processing...' : 'Confirm Payment'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.cancelButton}
              onPress={() => setScannedData(null)}
            >
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Scan button */}
        {!scannedData && (
          <TouchableOpacity
            style={styles.scanButton}
            onPress={() => setScannerVisible(true)}
          >
            <Ionicons name="scan" size={24} color="white" />
            <Text style={styles.scanButtonText}>Scan QR Code</Text>
          </TouchableOpacity>
        )}

        {/* How it works */}
        <View style={styles.howItWorksCard}>
          <Text style={styles.howItWorksTitle}>How it works</Text>
          <View style={styles.stepContainer}>
            <View style={styles.step}>
              <View style={styles.stepNumber}>
                <Text style={styles.stepNumberText}>1</Text>
              </View>
              <Text style={styles.stepText}>Tap "Scan QR Code" button</Text>
            </View>
            <View style={styles.step}>
              <View style={styles.stepNumber}>
                <Text style={styles.stepNumberText}>2</Text>
              </View>
              <Text style={styles.stepText}>Point camera at payment QR code</Text>
            </View>
            <View style={styles.step}>
              <View style={styles.stepNumber}>
                <Text style={styles.stepNumberText}>3</Text>
              </View>
              <Text style={styles.stepText}>Review and confirm payment details</Text>
            </View>
            <View style={styles.step}>
              <View style={styles.stepNumber}>
                <Text style={styles.stepNumberText}>4</Text>
              </View>
              <Text style={styles.stepText}>Complete payment on your phone</Text>
            </View>
          </View>
        </View>
      </ScrollView>

      {/* QR Scanner Modal */}
      <Modal
        visible={scannerVisible}
        animationType="slide"
        onRequestClose={() => setScannerVisible(false)}
      >
        <QRScanner
          onScan={handleScan}
          onClose={() => setScannerVisible(false)}
          title="Scan Payment QR"
          description="Align the payment QR code within the frame"
        />
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
  },
  content: {
    padding: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 24,
  },
  backButton: {
    padding: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#111827',
  },
  instructionsCard: {
    backgroundColor: 'white',
    borderRadius: 16,
    padding: 32,
    alignItems: 'center',
    marginBottom: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  instructionsTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#111827',
    marginTop: 16,
    marginBottom: 8,
  },
  instructionsText: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
    lineHeight: 20,
  },
  paymentCard: {
    backgroundColor: 'white',
    borderRadius: 16,
    padding: 24,
    marginBottom: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  paymentHeader: {
    alignItems: 'center',
    marginBottom: 24,
  },
  paymentTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#111827',
    marginTop: 12,
  },
  paymentDetails: {
    marginBottom: 24,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
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
  phoneLabel: {
    fontSize: 14,
    color: '#6b7280',
    marginBottom: 8,
  },
  phoneInput: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    color: '#111827',
    marginBottom: 16,
    backgroundColor: '#f9fafb',
  },
  confirmButton: {
    backgroundColor: '#10b981',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 12,
  },
  confirmButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  cancelButton: {
    backgroundColor: '#f3f4f6',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  cancelButtonText: {
    color: '#6b7280',
    fontSize: 16,
    fontWeight: '600',
  },
  scanButton: {
    backgroundColor: '#10b981',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    borderRadius: 12,
    marginBottom: 24,
    shadowColor: '#10b981',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  scanButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
    marginLeft: 8,
  },
  howItWorksCard: {
    backgroundColor: 'white',
    borderRadius: 16,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  howItWorksTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 16,
  },
  stepContainer: {
    gap: 16,
  },
  step: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  stepNumber: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#10b981',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  stepNumberText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '600',
  },
  stepText: {
    flex: 1,
    fontSize: 14,
    color: '#6b7280',
  },
});
