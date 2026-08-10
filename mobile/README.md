# VPP Consumer Mobile App

React Native mobile application for the Virtual Power Plant Consumer Platform.

## Features

- **Dashboard** - Real-time energy metrics and quick actions
- **Asset Management** - Register and manage solar panels, batteries
- **Monitoring** - Live charts for power generation and consumption
- **Trading** - Buy/sell energy in the marketplace
- **Payments** - Mobile money integration (M-Pesa, Airtel Money, Tigo Pesa)
- **Settings** - User preferences and account management

## Tech Stack

- **React Native** - Cross-platform mobile framework
- **Expo** - Development and build tooling
- **React Navigation** - Navigation library
- **tRPC** - Type-safe API client
- **React Query** - Data fetching and caching
- **React Native Chart Kit** - Data visualization

## Prerequisites

- Node.js 18+ and pnpm
- Expo CLI: `npm install -g expo-cli`
- iOS: Xcode 14+ (Mac only)
- Android: Android Studio with SDK 33+

## Installation

```bash
cd mobile
pnpm install
```

## Development

### Start Development Server

```bash
pnpm start
```

This opens Expo Dev Tools. Choose your platform:
- Press `i` for iOS simulator
- Press `a` for Android emulator
- Scan QR code with Expo Go app for physical device

### Run on iOS

```bash
pnpm ios
```

### Run on Android

```bash
pnpm android
```

## Configuration

### API Endpoint

Update the API URL in `src/services/trpc.ts`:

```typescript
const API_URL = 'https://your-api-server.com';
```

Or set environment variable:

```bash
export EXPO_PUBLIC_API_URL=https://your-api-server.com
```

### App Configuration

Edit `app.json` to customize:
- App name and slug
- Bundle identifiers
- Icons and splash screens
- Permissions

## Project Structure

```
mobile/
├── App.tsx                 # Main entry point
├── app.json               # Expo configuration
├── package.json           # Dependencies
├── tsconfig.json          # TypeScript config
└── src/
    ├── navigation/        # Navigation setup
    │   └── AppNavigator.tsx
    ├── screens/           # Screen components
    │   ├── DashboardScreen.tsx
    │   ├── AssetsScreen.tsx
    │   ├── MonitoringScreen.tsx
    │   ├── TradingScreen.tsx
    │   ├── PaymentsScreen.tsx
    │   └── SettingsScreen.tsx
    ├── components/        # Reusable components
    │   ├── MetricCard.tsx
    │   ├── Chart.tsx
    │   └── AssetCard.tsx
    ├── services/          # API and services
    │   ├── trpc.ts       # tRPC client
    │   └── auth.ts       # Authentication
    ├── hooks/            # Custom React hooks
    │   ├── useAuth.ts
    │   └── useWebSocket.ts
    ├── utils/            # Utility functions
    │   └── format.ts
    └── types/            # TypeScript types
        └── index.ts
```

## Screen Implementation Guide

### Dashboard Screen

```typescript
import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { trpc } from '../services/trpc';
import MetricCard from '../components/MetricCard';

export default function DashboardScreen() {
  const { data: telemetry } = trpc.telemetry.getLatest.useQuery();
  const { data: assets } = trpc.assets.list.useQuery();

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>Dashboard</Text>
      
      <View style={styles.metricsGrid}>
        <MetricCard
          title="Generation"
          value={`${telemetry?.solarGeneration || 0} W`}
          icon="flash"
          color="#16a34a"
        />
        <MetricCard
          title="Consumption"
          value={`${telemetry?.consumption || 0} W`}
          icon="home"
          color="#dc2626"
        />
        <MetricCard
          title="Battery"
          value={`${telemetry?.batteryCharge || 0}%`}
          icon="battery-charging"
          color="#2563eb"
        />
        <MetricCard
          title="Grid"
          value={`${telemetry?.gridFlow || 0} W`}
          icon="swap-horizontal"
          color="#f59e0b"
        />
      </View>

      <Text style={styles.sectionTitle}>My Assets</Text>
      <Text style={styles.assetCount}>
        {assets?.assets.length || 0} registered assets
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
    padding: 16,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    marginBottom: 24,
  },
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '600',
    marginTop: 24,
    marginBottom: 12,
  },
  assetCount: {
    fontSize: 16,
    color: '#6b7280',
  },
});
```

### Assets Screen

```typescript
import React, { useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from 'react-native';
import { trpc } from '../services/trpc';
import { Ionicons } from '@expo/vector-icons';

export default function AssetsScreen() {
  const { data } = trpc.assets.list.useQuery();
  const utils = trpc.useUtils();
  const deleteMutation = trpc.assets.delete.useMutation({
    onSuccess: () => {
      utils.assets.list.invalidate();
    },
  });

  const renderAsset = ({ item }: { item: any }) => (
    <View style={styles.assetCard}>
      <View style={styles.assetHeader}>
        <Ionicons
          name={item.assetType === 'solar' ? 'sunny' : 'battery-charging'}
          size={32}
          color="#16a34a"
        />
        <View style={styles.assetInfo}>
          <Text style={styles.assetName}>{item.name}</Text>
          <Text style={styles.assetType}>{item.assetType}</Text>
        </View>
      </View>
      <View style={styles.assetDetails}>
        <Text>Capacity: {item.capacity}W</Text>
        <Text>Status: {item.status}</Text>
      </View>
      <TouchableOpacity
        style={styles.deleteButton}
        onPress={() => deleteMutation.mutate({ id: item.id })}
      >
        <Text style={styles.deleteText}>Delete</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={styles.container}>
      <Text style={styles.title}>My Assets</Text>
      <FlatList
        data={data?.assets || []}
        renderItem={renderAsset}
        keyExtractor={(item) => item.id.toString()}
        contentContainerStyle={styles.list}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
    padding: 16,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    marginBottom: 16,
  },
  list: {
    gap: 12,
  },
  assetCard: {
    backgroundColor: 'white',
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  assetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  assetInfo: {
    marginLeft: 12,
    flex: 1,
  },
  assetName: {
    fontSize: 18,
    fontWeight: '600',
  },
  assetType: {
    fontSize: 14,
    color: '#6b7280',
    textTransform: 'capitalize',
  },
  assetDetails: {
    marginBottom: 12,
  },
  deleteButton: {
    backgroundColor: '#dc2626',
    padding: 8,
    borderRadius: 6,
    alignItems: 'center',
  },
  deleteText: {
    color: 'white',
    fontWeight: '600',
  },
});
```

## Authentication

Implement OAuth flow:

1. **Login Screen** - Redirect to web OAuth
2. **Token Storage** - Save JWT in secure storage
3. **API Headers** - Include token in tRPC requests

```typescript
// src/services/auth.ts
import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'auth_token';

export async function saveToken(token: string) {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function getToken() {
  return await SecureStore.getItemAsync(TOKEN_KEY);
}

export async function removeToken() {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}
```

## Mobile Money Integration

### M-Pesa STK Push

```typescript
const { mutate: initiatePayment } = trpc.payments.initiate.useMutation({
  onSuccess: (data) => {
    // Show success message
    Alert.alert('Payment Initiated', 'Check your phone for M-Pesa prompt');
    
    // Poll for payment status
    pollPaymentStatus(data.referenceId);
  },
});

function handlePayment() {
  initiatePayment({
    amount: 10000, // TZS 100.00
    phoneNumber: '+255712345678',
    provider: 'mpesa',
  });
}
```

## Push Notifications

Configure Expo notifications:

```bash
expo install expo-notifications
```

```typescript
import * as Notifications from 'expo-notifications';

// Request permissions
const { status } = await Notifications.requestPermissionsAsync();

// Get push token
const token = await Notifications.getExpoPushTokenAsync();

// Send token to server
await trpc.system.registerPushToken.mutate({ token: token.data });
```

## Building for Production

### iOS

1. Configure app in Apple Developer Portal
2. Create provisioning profile
3. Build:

```bash
eas build --platform ios
```

### Android

1. Generate signing key
2. Configure in `app.json`
3. Build:

```bash
eas build --platform android
```

## Testing

### Unit Tests

```bash
pnpm test
```

### E2E Tests

Use Detox or Appium for end-to-end testing.

## Troubleshooting

### Metro Bundler Issues

```bash
expo start --clear
```

### iOS Simulator Not Starting

```bash
xcrun simctl list devices
```

### Android Emulator Connection

```bash
adb reverse tcp:3000 tcp:3000
```

## Performance Optimization

1. **Image Optimization** - Use `expo-image` for optimized images
2. **List Virtualization** - Use `FlatList` for long lists
3. **Memoization** - Use `React.memo` and `useMemo`
4. **Code Splitting** - Lazy load screens
5. **Bundle Size** - Analyze with `expo-bundle-analyzer`

## Deployment

### Over-the-Air Updates

Use Expo Updates for instant updates:

```bash
eas update --branch production
```

### App Store Submission

Follow platform guidelines:
- iOS: App Store Connect
- Android: Google Play Console

## Support

- Expo Documentation: https://docs.expo.dev
- React Native: https://reactnative.dev
- tRPC: https://trpc.io

## License

Proprietary - VPP Consumer Platform
