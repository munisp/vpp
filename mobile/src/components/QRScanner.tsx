import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { Camera, CameraType } from 'expo-camera';
import { BarCodeScanner, BarCodeScannerResult } from 'expo-barcode-scanner';
import { Ionicons } from '@expo/vector-icons';

interface QRScannerProps {
  onScan: (data: string) => void;
  onClose: () => void;
  title?: string;
  description?: string;
}

export default function QRScanner({
  onScan,
  onClose,
  title = 'Scan QR Code',
  description = 'Position the QR code within the frame',
}: QRScannerProps) {
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [scanned, setScanned] = useState(false);
  const [flashEnabled, setFlashEnabled] = useState(false);

  useEffect(() => {
    requestCameraPermission();
  }, []);

  const requestCameraPermission = async () => {
    const { status } = await Camera.requestCameraPermissionsAsync();
    setHasPermission(status === 'granted');
  };

  const handleBarCodeScanned = ({ type, data }: BarCodeScannerResult) => {
    if (scanned) return;

    setScanned(true);
    onScan(data);
  };

  const handleRescan = () => {
    setScanned(false);
  };

  const toggleFlash = () => {
    setFlashEnabled(!flashEnabled);
  };

  if (hasPermission === null) {
    return (
      <View style={styles.container}>
        <Text style={styles.message}>Requesting camera permission...</Text>
      </View>
    );
  }

  if (hasPermission === false) {
    return (
      <View style={styles.container}>
        <Ionicons name="camera-off" size={64} color="#dc2626" />
        <Text style={styles.message}>Camera permission denied</Text>
        <Text style={styles.description}>
          Please enable camera access in your device settings to scan QR codes
        </Text>
        <TouchableOpacity style={styles.button} onPress={onClose}>
          <Text style={styles.buttonText}>Close</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onClose} style={styles.closeButton}>
          <Ionicons name="close" size={28} color="white" />
        </TouchableOpacity>
        <View style={styles.headerContent}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.headerDescription}>{description}</Text>
        </View>
        <TouchableOpacity onPress={toggleFlash} style={styles.flashButton}>
          <Ionicons
            name={flashEnabled ? 'flash' : 'flash-off'}
            size={28}
            color="white"
          />
        </TouchableOpacity>
      </View>

      {/* Camera */}
      <Camera
        style={styles.camera}
        type={CameraType.back}
        barCodeScannerSettings={{
          barCodeTypes: [BarCodeScanner.Constants.BarCodeType.qr],
        }}
        onBarCodeScanned={scanned ? undefined : handleBarCodeScanned}
        flashMode={
          flashEnabled
            ? Camera.Constants.FlashMode.torch
            : Camera.Constants.FlashMode.off
        }
      >
        <View style={styles.overlay}>
          {/* Top overlay */}
          <View style={styles.overlaySection} />

          {/* Middle section with scanning frame */}
          <View style={styles.middleSection}>
            <View style={styles.overlaySection} />
            <View style={styles.scanFrame}>
              {/* Corner markers */}
              <View style={[styles.corner, styles.topLeft]} />
              <View style={[styles.corner, styles.topRight]} />
              <View style={[styles.corner, styles.bottomLeft]} />
              <View style={[styles.corner, styles.bottomRight]} />
            </View>
            <View style={styles.overlaySection} />
          </View>

          {/* Bottom overlay */}
          <View style={styles.overlaySection} />
        </View>
      </Camera>

      {/* Bottom controls */}
      <View style={styles.controls}>
        {scanned ? (
          <View style={styles.scannedContainer}>
            <Ionicons name="checkmark-circle" size={48} color="#10b981" />
            <Text style={styles.scannedText}>QR Code Scanned!</Text>
            <TouchableOpacity style={styles.rescanButton} onPress={handleRescan}>
              <Text style={styles.rescanButtonText}>Scan Another</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.instructionsContainer}>
            <Ionicons name="qr-code-outline" size={32} color="#6b7280" />
            <Text style={styles.instructions}>
              Align the QR code within the frame to scan
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'black',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 50,
    paddingHorizontal: 16,
    paddingBottom: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
  },
  closeButton: {
    padding: 8,
  },
  headerContent: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: 'white',
    marginBottom: 4,
  },
  headerDescription: {
    fontSize: 14,
    color: '#d1d5db',
    textAlign: 'center',
  },
  flashButton: {
    padding: 8,
  },
  camera: {
    flex: 1,
  },
  overlay: {
    flex: 1,
  },
  overlaySection: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  middleSection: {
    flexDirection: 'row',
    height: 300,
  },
  scanFrame: {
    width: 300,
    height: 300,
    position: 'relative',
  },
  corner: {
    position: 'absolute',
    width: 30,
    height: 30,
    borderColor: '#10b981',
  },
  topLeft: {
    top: 0,
    left: 0,
    borderTopWidth: 4,
    borderLeftWidth: 4,
  },
  topRight: {
    top: 0,
    right: 0,
    borderTopWidth: 4,
    borderRightWidth: 4,
  },
  bottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 4,
    borderLeftWidth: 4,
  },
  bottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 4,
    borderRightWidth: 4,
  },
  controls: {
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    paddingVertical: 24,
    paddingHorizontal: 16,
  },
  instructionsContainer: {
    alignItems: 'center',
  },
  instructions: {
    fontSize: 14,
    color: '#d1d5db',
    textAlign: 'center',
    marginTop: 12,
  },
  scannedContainer: {
    alignItems: 'center',
  },
  scannedText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#10b981',
    marginTop: 12,
    marginBottom: 16,
  },
  rescanButton: {
    backgroundColor: '#10b981',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  rescanButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  message: {
    fontSize: 18,
    fontWeight: '600',
    color: 'white',
    textAlign: 'center',
    marginTop: 24,
  },
  description: {
    fontSize: 14,
    color: '#d1d5db',
    textAlign: 'center',
    marginTop: 12,
    marginHorizontal: 32,
  },
  button: {
    backgroundColor: '#10b981',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    marginTop: 24,
  },
  buttonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
});
