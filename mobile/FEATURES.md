# VPP Platform Mobile App - Feature Documentation

## Overview

The VPP Platform mobile app is a full-featured React Native application that provides consumers with complete access to the Virtual Power Plant ecosystem. Built with Expo, the app delivers native mobile experiences on both iOS and Android platforms.

## Core Features

### 1. Dashboard
- Real-time energy metrics and statistics
- Quick access to key functions
- Asset status overview
- Trading earnings summary
- DR event notifications
- Pull-to-refresh functionality

### 2. Asset Management
- Register new energy devices
- View all registered assets
- Monitor asset status and performance
- Delete or deactivate assets
- QR code-based device registration

### 3. Energy Monitoring
- Real-time telemetry data
- Interactive charts and graphs
- Historical performance tracking
- Multi-asset monitoring
- 24-hour energy production/consumption data

### 4. Energy Trading
- Buy and sell energy in the marketplace
- View current market prices
- Track active trades
- Monitor trading earnings
- Set trading preferences
- Automatic trade matching

### 5. Payment Processing
- Multiple payment gateways (M-Pesa, Airtel Money, Tigo Pesa)
- Payment type selector: bill/invoice payment or energy token purchase (`token_purchase` with an `energyKwh` amount; the meter token is generated server-side only after the payment is confirmed, and may be marked `pending_issuance` when STS vending is not configured — the app displays the server's real response message and never claims a token was issued at initiation time)
- Payment history and tracking
- Balance management
- QR code-based payments ("Scan to Pay" from the Payments screen, or "QR Payment" from the Dashboard)
- Payment receipts and confirmations

### 6. Demand Response (DR)
- Enroll in DR programs
- Participate in DR events
- View compensation rates
- Track DR earnings
- Event notifications and reminders
- Real-time event status

### 7. Settings & Preferences
- User profile management
- Notification preferences (master push toggle) plus a dedicated Notification Settings screen (per-category toggles, frequency, quiet hours)
- Replay Onboarding entry (re-runs the setup wizard)
- Security settings
- App preferences

### 7a. Onboarding
- First-login routing: logged-in users whose server-side `onboardingCompleted` flag (via `trpc.onboarding.getStatus`) is false are routed to the Onboarding wizard before the main app
- Also reachable from Settings → "Replay Onboarding"

## Advanced Features

### 8. QR Scanner
**Location**: QR Payment is accessible from the Dashboard "Insights & Tools" quick-actions grid and from the Payments screen ("Scan to Pay"). QR device registration is accessible from the Dashboard "Insights & Tools" quick-actions grid ("Register Device").

**Capabilities**:
- **QR Payment Processing**
  - Scan payment QR codes
  - Automatic amount and recipient extraction
  - Secure payment confirmation
  - Payment history tracking

- **Device Registration**
  - Scan device QR codes
  - Automatic device information extraction
  - Quick registration workflow
  - Device verification

**QR Code Formats**:
```
Payment: vpp://payment?amount=1000&recipient=John&reference=INV-001
Device: vpp://device?type=solar&name=Solar Panel&capacity=5000&serial=SP123456
```

### 9. Gamification
**Location**: Accessible from the Dashboard "Insights & Tools" quick-actions grid ("Rewards")

**Features**:
- **Leaderboard**
  - Monthly rankings
  - Top 50 users display
  - User rank and points
  - Energy traded statistics
  - Current user highlighting

- **Achievements**
  - Unlockable achievements
  - Progress tracking
  - Point rewards
  - Achievement badges
  - Unlock dates and history

- **User Stats**
  - Total points earned
  - Current rank
  - User level
  - Achievement count

**Achievement Categories**:
- First Trade
- Energy Milestone (100 kWh, 500 kWh, 1000 kWh)
- DR Participation
- Payment Completion
- Device Registration
- Referral Rewards

### 10. P2P Trading
**Location**: Accessible from Trading screen or Dashboard

**Features**:
- **Browse Offers**
  - View active buy/sell offers
  - Filter by type and price
  - Accept offers instantly
  - Real-time offer updates

- **Create Offers**
  - Create buy or sell offers
  - Set quantity and price
  - Add offer descriptions
  - Manage active offers

- **My Offers**
  - View personal offers
  - Track offer status
  - Cancel active offers
  - Offer history

**Offer Management**:
- Automatic matching
- Price negotiation
- Offer expiration
- Trade confirmation

### 11. Native Share
**Location**: Available throughout the app

**Share Capabilities**:
- **Trading Opportunities**
  - Share buy/sell offers
  - Include price and quantity
  - Direct links to marketplace

- **Payment Requests**
  - Share payment details
  - Include amount and reference
  - Secure payment links

- **Device Referrals**
  - Share registration benefits
  - Referral codes
  - Device success stories

- **DR Events**
  - Share event participation
  - Compensation rates
  - Event schedules

- **Achievements**
  - Share unlocked achievements
  - Points earned
  - Leaderboard rankings

- **Earnings**
  - Share monthly/yearly earnings
  - Trading statistics
  - Success metrics

## Native Mobile Features

### 12. Push Notifications
**Status**: Planned (not yet wired). The service module exists (`src/services/pushNotifications.ts`) but is never initialized or invoked from any screen. Notification *preferences* are functional and stored server-side; actual push delivery is not wired up.

**Service**: Expo Notifications

**Notification Types**:
- **Trading Alerts**
  - Trade executed
  - Price changes
  - Market opportunities

- **Payment Notifications**
  - Payment received
  - Payment confirmed
  - Payment failed

- **DR Event Alerts**
  - Event starting soon (30 min, 5 min)
  - Event active
  - Event completed
  - Compensation received

- **System Alerts**
  - Asset offline
  - Low battery
  - System maintenance

**Notification Channels** (Android):
- Default (general notifications)
- DR Events (high priority)
- Payments (high priority)
- Alerts (max priority)

**Features**:
- Customizable notification preferences
- Quiet hours support
- Per-channel control
- Badge counts
- Sound and vibration

### 13. Biometric Authentication
**Status**: Planned (not yet wired). The service module exists (`src/services/biometricAuth.ts`) but is never initialized or invoked from any screen; no login or payment flow currently requires biometric confirmation.

**Service**: Expo Local Authentication

**Supported Methods**:
- Fingerprint (Touch ID)
- Face recognition (Face ID)
- Iris scanning (select devices)

**Protected Operations**:
- App login
- Payment confirmation
- Trade execution
- Asset management
- Settings changes

**Features**:
- Optional biometric login
- Fallback to passcode
- Per-operation authentication
- Secure credential storage

### 14. Offline Storage
**Status**: Planned (not yet wired). The service module exists (`src/services/offlineStorage.ts`) but is never initialized or invoked from any screen; there is currently no offline caching of server data.

**Service**: AsyncStorage + SQLite

**Cached Data**:
- User profile
- Asset information
- Recent trades
- Payment history
- DR event schedule

**Features**:
- Automatic sync when online
- Conflict resolution
- Data persistence
- Secure storage

### 15. Background Sync
**Status**: Planned (not yet wired). The service module exists (`src/services/syncService.ts`) but is never initialized or invoked from any screen; no periodic background synchronization currently runs.

**Service**: Custom sync service

**Sync Operations**:
- Asset telemetry updates
- Trade status updates
- Payment confirmations
- DR event notifications
- Achievement progress

**Features**:
- Periodic background sync
- Delta synchronization
- Conflict resolution
- Bandwidth optimization

## Technical Implementation

### Architecture
- **Framework**: React Native (Expo)
- **Navigation**: React Navigation 6
- **State Management**: tRPC + React Query
- **Authentication**: OAuth 2.0 + JWT
- **Storage**: AsyncStorage + Expo SecureStore
- **Notifications**: Expo Notifications
- **Camera**: Expo Camera + Barcode Scanner
- **Biometrics**: Expo Local Authentication

### API Integration
- **Backend**: tRPC API
- **Real-time**: WebSocket (planned)
- **Caching**: React Query
- **Offline**: AsyncStorage

### Security
- Secure token storage (Expo SecureStore)
- SSL/TLS encryption
- Session management
- (Planned) Biometric authentication — see Feature 13

## Installation & Setup

### Prerequisites
```bash
# Install Expo CLI
npm install -g expo-cli

# Install dependencies
cd mobile
npm install
```

### Required Packages
```json
{
  "expo": "~49.0.0",
  "expo-camera": "~13.4.0",
  "expo-barcode-scanner": "~12.5.0",
  "expo-notifications": "~0.20.0",
  "expo-local-authentication": "~13.4.0",
  "expo-secure-store": "~12.3.0",
  "@react-navigation/native": "^6.1.0",
  "@react-navigation/bottom-tabs": "^6.5.0",
  "@react-navigation/native-stack": "^6.9.0",
  "@trpc/client": "^10.0.0",
  "@trpc/react-query": "^10.0.0"
}
```

### Running the App

**Development**:
```bash
# Start Expo development server
npm start

# Run on iOS simulator
npm run ios

# Run on Android emulator
npm run android

# Run on physical device (scan QR code)
```

**Production Build**:
```bash
# Build for iOS
eas build --platform ios

# Build for Android
eas build --platform android
```

## Testing

### Unit Tests
```bash
npm test
```

### E2E Tests
```bash
# Install Detox
npm install -g detox-cli

# Run E2E tests
detox test
```

### Manual Testing Checklist
- [ ] Login/logout flow
- [ ] Asset registration and management
- [ ] Energy monitoring charts
- [ ] Trading buy/sell operations
- [ ] Payment processing (all gateways)
- [ ] DR enrollment and participation
- [ ] QR scanner (payment and device)
- [ ] Gamification leaderboard and achievements
- [ ] P2P trading (create, browse, accept offers)
- [ ] Native share functionality
- [ ] Push notifications
- [ ] Biometric authentication
- [ ] Offline mode
- [ ] Background sync

## Known Limitations

1. **QR Scanner**: Requires physical device (not available in simulator)
2. **Biometric Auth**: Requires enrolled biometrics on device
3. **Push Notifications**: Requires Expo project ID configuration
4. **Background Sync**: Limited on iOS due to platform restrictions
5. **Camera**: Requires camera permissions

## Future Enhancements

1. **Real-time Updates**: WebSocket integration for live data
2. **Offline-First**: Complete offline functionality
3. **AR Features**: Augmented reality for device placement
4. **Voice Control**: Voice commands for trading
5. **Widgets**: Home screen widgets for quick stats
6. **Apple Watch**: Companion watch app
7. **Android Wear**: Wearable support
8. **Haptic Feedback**: Enhanced tactile feedback
9. **Dark Mode**: System-wide dark theme
10. **Localization**: Multi-language support

## Support

For issues or questions:
- GitHub Issues: https://github.com/vpp-platform/mobile/issues
- Email: support@vpp-platform.com
- Documentation: https://docs.vpp-platform.com

## License

MIT License - See LICENSE file for details
