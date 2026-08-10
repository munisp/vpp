import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  Modal,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import QRScanner from '../components/QRScanner';
import { trpc } from '../services/trpc';
import { HapticService } from '../services/hapticService';

export default function QRDeviceRegistrationScreen({ navigation }: any) {
  const [scannerVisible, setScannerVisible] = useState(false);
  const [scannedData, setScannedData] = useState<any>(null);

  const utils = trpc.useUtils();
  const registerAssetMutation = trpc.assets.register.useMutation({
    onSuccess: async () => {
      await HapticService.deviceRegistered();
      Alert.alert(
        'Device Registered',
        'Your device has been successfully registered!',
        [
          {
            text: 'OK',
            onPress: () => {
              utils.assets.list.invalidate();
              setScannedData(null);
              navigation.goBack();
            },
          },
        ]
      );
    },
    onError: async (error) => {
      await HapticService.error();
      Alert.alert('Registration Failed', error.message);
    },
  });

  const handleScan = async (data: string) => {
    await HapticService.qrScanned();
    try {
      // Parse QR code data
      // Expected format: vpp://device?type=solar&name=Solar Panel&capacity=5000&serial=SP123456
      const url = new URL(data);
      
      if (url.protocol !== 'vpp:' || url.hostname !== 'device') {
        Alert.alert('Invalid QR Code', 'This QR code is not a valid device registration code');
        setScannerVisible(false);
        return;
      }

      const type = url.searchParams.get('type');
      const name = url.searchParams.get('name');
      const capacity = url.searchParams.get('capacity');
      const serial = url.searchParams.get('serial');
      const make = url.searchParams.get('make');
      const model = url.searchParams.get('model');

      if (!type || !name || !capacity) {
        Alert.alert('Invalid QR Code', 'Required device information not found');
        setScannerVisible(false);
        return;
      }

      setScannedData({
        type,
        name,
        capacity: parseInt(capacity),
        serialNumber: serial || '',
        make: make || '',
        model: model || '',
      });
      setScannerVisible(false);
    } catch (error) {
      Alert.alert('Invalid QR Code', 'Could not parse QR code data');
      setScannerVisible(false);
    }
  };

  const handleConfirmRegistration = () => {
    if (!scannedData) return;

    registerAssetMutation.mutate({
      assetType: scannedData.type,
      name: scannedData.name,
      capacity: scannedData.capacity,
      serialNumber: scannedData.serialNumber,
      make: scannedData.make,
      model: scannedData.model,
    });
  };

  const getAssetIcon = (type: string) => {
    switch (type) {
      case 'solar':
        return 'sunny';
      case 'battery':
        return 'battery-charging';
      case 'meter':
        return 'speedometer';
      case 'generator':
        return 'flash';
      case 'wind':
        return 'leaf';
      default:
        return 'hardware-chip';
    }
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
          <Text style={styles.title}>Register Device</Text>
          <View style={{ width: 40 }} />
        </View>

        {/* Instructions */}
        {!scannedData && (
          <View style={styles.instructionsCard}>
            <Ionicons name="hardware-chip-outline" size={64} color="#8b5cf6" />
            <Text style={styles.instructionsTitle}>Scan Device QR Code</Text>
            <Text style={styles.instructionsText}>
              Scan the QR code on your solar panel, battery, or other energy device to quickly register it
            </Text>
          </View>
        )}

        {/* Scanned device details */}
        {scannedData && (
          <View style={styles.deviceCard}>
            <View style={styles.deviceHeader}>
              <Ionicons
                name={getAssetIcon(scannedData.type)}
                size={48}
                color="#8b5cf6"
              />
              <Text style={styles.deviceTitle}>Device Found</Text>
            </View>

            <View style={styles.deviceDetails}>
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Type</Text>
                <Text style={styles.detailValue}>
                  {scannedData.type.charAt(0).toUpperCase() + scannedData.type.slice(1)}
                </Text>
              </View>

              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Name</Text>
                <Text style={styles.detailValue}>{scannedData.name}</Text>
              </View>

              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Capacity</Text>
                <Text style={styles.detailValue}>{scannedData.capacity}W</Text>
              </View>

              {scannedData.make && (
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Make</Text>
                  <Text style={styles.detailValue}>{scannedData.make}</Text>
                </View>
              )}

              {scannedData.model && (
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Model</Text>
                  <Text style={styles.detailValue}>{scannedData.model}</Text>
                </View>
              )}

              {scannedData.serialNumber && (
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>Serial Number</Text>
                  <Text style={styles.detailValue}>{scannedData.serialNumber}</Text>
                </View>
              )}
            </View>

            <TouchableOpacity
              style={styles.confirmButton}
              onPress={handleConfirmRegistration}
              disabled={registerAssetMutation.isLoading}
            >
              <Text style={styles.confirmButtonText}>
                {registerAssetMutation.isLoading ? 'Registering...' : 'Register Device'}
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
            <Text style={styles.scanButtonText}>Scan Device QR Code</Text>
          </TouchableOpacity>
        )}

        {/* Benefits */}
        <View style={styles.benefitsCard}>
          <Text style={styles.benefitsTitle}>Why register your device?</Text>
          <View style={styles.benefitContainer}>
            <View style={styles.benefit}>
              <Ionicons name="trending-up" size={24} color="#10b981" />
              <Text style={styles.benefitText}>
                Start earning from your solar energy
              </Text>
            </View>
            <View style={styles.benefit}>
              <Ionicons name="stats-chart" size={24} color="#3b82f6" />
              <Text style={styles.benefitText}>
                Monitor real-time performance
              </Text>
            </View>
            <View style={styles.benefit}>
              <Ionicons name="swap-horizontal" size={24} color="#f59e0b" />
              <Text style={styles.benefitText}>
                Trade energy in the marketplace
              </Text>
            </View>
            <View style={styles.benefit}>
              <Ionicons name="flash" size={24} color="#8b5cf6" />
              <Text style={styles.benefitText}>
                Participate in demand response events
              </Text>
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
          title="Scan Device QR"
          description="Align the device QR code within the frame"
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
  deviceCard: {
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
  deviceHeader: {
    alignItems: 'center',
    marginBottom: 24,
  },
  deviceTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#111827',
    marginTop: 12,
  },
  deviceDetails: {
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
  confirmButton: {
    backgroundColor: '#8b5cf6',
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
    backgroundColor: '#8b5cf6',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    borderRadius: 12,
    marginBottom: 24,
    shadowColor: '#8b5cf6',
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
  benefitsCard: {
    backgroundColor: 'white',
    borderRadius: 16,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  benefitsTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 16,
  },
  benefitContainer: {
    gap: 16,
  },
  benefit: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  benefitText: {
    flex: 1,
    fontSize: 14,
    color: '#6b7280',
    marginLeft: 12,
  },
});
