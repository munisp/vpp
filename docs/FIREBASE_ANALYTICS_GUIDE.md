# Firebase Analytics Integration Guide

Complete guide for integrating and using Firebase Analytics in the VPP Consumer Platform.

---

## Overview

Firebase Analytics provides insights into user behavior, feature usage, and business metrics. The platform tracks:

- **User Engagement:** Page views, session duration, feature usage
- **Trading Activity:** Buy/sell trades, P2P offers, trade completion rates
- **Payment Transactions:** Payment methods, success rates, revenue
- **DR Participation:** Event enrollment, completion, earnings
- **Gamification:** Achievement unlocks, leaderboard views
- **Mobile Features:** QR scans, push notifications, share actions

---

## Setup

### 1. Create Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click "Add project"
3. Enter project name: "VPP Consumer Platform"
4. Enable Google Analytics (recommended)
5. Select or create Analytics account
6. Click "Create project"

### 2. Register Web App

1. In Firebase Console, click "Add app" → Web
2. Enter app nickname: "VPP Web Platform"
3. Check "Also set up Firebase Hosting" (optional)
4. Click "Register app"
5. Copy the Firebase configuration object

### 3. Register Mobile Apps

#### iOS App

1. Click "Add app" → iOS
2. Enter iOS bundle ID: `com.vpp.consumer`
3. Enter app nickname: "VPP iOS"
4. Download `GoogleService-Info.plist`
5. Place in `/mobile/ios/` directory

#### Android App

1. Click "Add app" → Android
2. Enter Android package name: `com.vpp.consumer`
3. Enter app nickname: "VPP Android"
4. Download `google-services.json`
5. Place in `/mobile/android/app/` directory

### 4. Configure Environment Variables

Add to `.env` file (DO NOT commit):

```bash
# Firebase Web Configuration
VITE_FIREBASE_API_KEY=AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
VITE_FIREBASE_AUTH_DOMAIN=vpp-platform.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=vpp-platform
VITE_FIREBASE_STORAGE_BUCKET=vpp-platform.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789012
VITE_FIREBASE_APP_ID=1:123456789012:web:abcdef123456
VITE_FIREBASE_MEASUREMENT_ID=G-XXXXXXXXXX
```

### 5. Install Dependencies

#### Web
```bash
cd /home/ubuntu/vpp_consumer_platform
pnpm add firebase
```

#### Mobile (React Native)
```bash
cd /home/ubuntu/vpp_consumer_platform/mobile
npm install @react-native-firebase/app @react-native-firebase/analytics
```

---

## Web Integration

### Initialize Firebase

Firebase is automatically initialized in `client/src/lib/firebase.ts`. The configuration reads from environment variables.

### Track Events

Import the Analytics service:

```typescript
import { AnalyticsService } from '@/lib/firebase';
```

### Common Event Tracking

#### Page Views

```typescript
// Automatic tracking in router
import { useLocation } from 'wouter';
import { useEffect } from 'react';

function MyComponent() {
  const [location] = useLocation();
  
  useEffect(() => {
    AnalyticsService.logPageView(location);
  }, [location]);
}
```

#### User Actions

```typescript
// Button click
AnalyticsService.logUserAction('button_click', 'navigation', 'dashboard');

// Form submission
AnalyticsService.logUserAction('form_submit', 'asset_registration', 'solar_panel');
```

#### Trading Events

```typescript
// Trade created
AnalyticsService.logTradeCreated('buy', 100, 250); // 100 kWh at 250 TZS/kWh

// Trade completed
AnalyticsService.logTradeCompleted('sell', 50, 300, 'trade_123');

// Trade failed
AnalyticsService.logTradeFailed('buy', 'insufficient_balance');
```

#### Payment Events

```typescript
// Payment initiated
AnalyticsService.logPaymentInitiated('M-Pesa', 25000, 'TZS');

// Payment completed
AnalyticsService.logPaymentCompleted('M-Pesa', 25000, 'txn_abc123', 'TZS');

// Payment failed
AnalyticsService.logPaymentFailed('Airtel Money', 15000, 'network_error');
```

#### Asset Management

```typescript
// Asset registered
AnalyticsService.logAssetRegistered('solar_panel', 5000); // 5kW capacity

// Asset deleted
AnalyticsService.logAssetDeleted('battery', 'asset_456');
```

#### DR Participation

```typescript
// Enrolled in DR event
AnalyticsService.logDREventEnrolled('dr_evt_789', 'peak_shaving', 5000);

// Completed DR event
AnalyticsService.logDREventCompleted('dr_evt_789', 'peak_shaving', 4500);
```

#### Gamification

```typescript
// Achievement unlocked
AnalyticsService.logAchievementUnlocked('ach_001', 'First Trade', 100);

// Leaderboard viewed
AnalyticsService.logLeaderboardViewed('weekly');
```

#### P2P Trading

```typescript
// P2P offer created
AnalyticsService.logP2POfferCreated('sell', 200, 280);

// P2P offer accepted
AnalyticsService.logP2POfferAccepted('offer_123', 'buy', 200, 280);
```

#### Share Events

```typescript
// Content shared
AnalyticsService.logContentShared('trading_opportunity', 'whatsapp');
```

#### QR Scanner

```typescript
// QR scanned
AnalyticsService.logQRScanned('payment', true);
AnalyticsService.logQRScanned('device', false);
```

#### Push Notifications

```typescript
// Notification received
AnalyticsService.logNotificationReceived('trade_alert');

// Notification opened
AnalyticsService.logNotificationOpened('payment_confirmation');
```

#### Error Tracking

```typescript
// Log error
AnalyticsService.logError('api_error', 'Failed to fetch trades', {
  endpoint: '/api/trades',
  status: 500,
});
```

### Set User Properties

```typescript
// Set user ID (on login)
AnalyticsService.setUserId('user_123');

// Set user properties
AnalyticsService.setUserProperties({
  user_type: 'prosumer',
  asset_count: 3,
  total_capacity: 15000,
  registration_date: '2024-01-15',
  location: 'Dar es Salaam',
});
```

---

## Mobile Integration (React Native)

### Initialize Firebase

1. Install dependencies:
```bash
cd mobile
npm install @react-native-firebase/app @react-native-firebase/analytics
```

2. iOS Configuration:
```bash
cd ios
pod install
```

3. Android Configuration:
Place `google-services.json` in `android/app/`

### Track Events

```typescript
import analytics from '@react-native-firebase/analytics';

// Log event
await analytics().logEvent('trade_created', {
  trade_type: 'buy',
  quantity: 100,
  price: 250,
});

// Set user ID
await analytics().setUserId('user_123');

// Set user properties
await analytics().setUserProperties({
  user_type: 'prosumer',
  asset_count: 3,
});

// Log screen view
await analytics().logScreenView({
  screen_name: 'Dashboard',
  screen_class: 'DashboardScreen',
});
```

### Automatic Screen Tracking

```typescript
import { useEffect } from 'react';
import analytics from '@react-native-firebase/analytics';
import { useNavigation } from '@react-navigation/native';

function useAnalyticsScreenTracking() {
  const navigation = useNavigation();

  useEffect(() => {
    const unsubscribe = navigation.addListener('state', async () => {
      const currentRoute = navigation.getCurrentRoute();
      if (currentRoute) {
        await analytics().logScreenView({
          screen_name: currentRoute.name,
          screen_class: currentRoute.name,
        });
      }
    });

    return unsubscribe;
  }, [navigation]);
}
```

---

## Analytics Dashboard

### Access Firebase Console

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project
3. Click "Analytics" in left sidebar

### Key Reports

#### Overview Dashboard
- Active users (1, 7, 30 days)
- User engagement
- Revenue
- Retention

#### Events Report
- All tracked events
- Event count
- Event value
- User engagement per event

#### Conversions
- Key conversion events
- Conversion rate
- Revenue per conversion

#### User Properties
- User segments
- Property distribution
- Cohort analysis

#### Audiences
- Create user segments
- Target specific users
- Export to other Firebase services

---

## Custom Dashboards

### Create Custom Dashboard

1. In Firebase Console → Analytics → Custom Dashboards
2. Click "Create Dashboard"
3. Add cards for key metrics

### Recommended Cards

#### Trading Metrics
- Total trades (event: `trade_completed`)
- Trade volume (sum of `total_value`)
- Average trade size
- Trade success rate

#### Payment Metrics
- Total payments (event: `payment_completed`)
- Revenue (sum of `amount`)
- Payment method distribution
- Payment success rate

#### DR Participation
- Active DR participants
- Total DR events completed
- Average earnings per event
- DR completion rate

#### Gamification
- Total achievements unlocked
- Active leaderboard viewers
- Average points per user

#### Mobile Engagement
- QR scan success rate
- Push notification open rate
- Share action count
- Biometric auth usage

---

## Event Parameters

### Standard Parameters

Firebase automatically tracks:
- `user_id`: User identifier
- `timestamp`: Event time
- `platform`: web, ios, android
- `app_version`: App version
- `device_model`: Device model
- `os_version`: OS version
- `country`: User country
- `language`: User language

### Custom Parameters

Add custom parameters to events:

```typescript
AnalyticsService.logEvent('custom_event', {
  // Standard parameters
  value: 100,
  currency: 'TZS',
  
  // Custom parameters
  feature_name: 'auto_trading',
  user_segment: 'premium',
  experiment_variant: 'A',
});
```

### Parameter Limits

- **Event name:** 40 characters max
- **Parameter name:** 40 characters max
- **Parameter value:** 100 characters max (strings)
- **Parameters per event:** 25 max

---

## Best Practices

### Event Naming

✅ **Good:**
- `trade_created`
- `payment_completed`
- `dr_event_enrolled`

❌ **Bad:**
- `TradeCreated`
- `payment-completed`
- `DR Event Enrolled`

**Rules:**
- Use lowercase
- Use underscores, not spaces or hyphens
- Be descriptive but concise
- Use past tense for completed actions

### Event Parameters

✅ **Good:**
```typescript
{
  trade_type: 'buy',
  quantity: 100,
  price: 250,
  total_value: 25000,
}
```

❌ **Bad:**
```typescript
{
  type: 'b',
  q: 100,
  p: 250,
  val: 25000,
}
```

**Rules:**
- Use descriptive names
- Use consistent naming across events
- Include relevant context
- Avoid abbreviations

### User Privacy

- ✅ Hash or anonymize PII (email, phone)
- ✅ Get user consent before tracking
- ✅ Provide opt-out mechanism
- ✅ Follow GDPR/CCPA guidelines
- ❌ Don't track sensitive data (passwords, payment details)
- ❌ Don't track children without parental consent

### Performance

- ✅ Track important events only
- ✅ Batch events when possible
- ✅ Use async tracking
- ❌ Don't track every user action
- ❌ Don't block UI for analytics

---

## Debugging

### Enable Debug Mode

#### Web
```typescript
// In development
if (import.meta.env.DEV) {
  window['GA_DEBUG'] = true;
}
```

#### iOS
```bash
# Run with debug mode
xcrun simctl spawn booted log stream --predicate 'subsystem contains "com.google.firebase"'
```

#### Android
```bash
# Enable debug mode
adb shell setprop debug.firebase.analytics.app com.vpp.consumer

# View logs
adb logcat -v time -s FA
```

### DebugView

1. Go to Firebase Console → Analytics → DebugView
2. Enable debug mode on device
3. View real-time events

### Common Issues

**Issue:** Events not appearing in Firebase Console

**Solutions:**
1. Check internet connection
2. Wait 24 hours for data processing
3. Use DebugView for real-time validation
4. Verify Firebase configuration
5. Check event name/parameter limits

**Issue:** User properties not updating

**Solutions:**
1. Verify property names (no spaces)
2. Check value types (string, number, boolean)
3. Wait for data processing
4. Verify user ID is set

---

## Data Export

### BigQuery Export

1. Go to Firebase Console → Project Settings → Integrations
2. Click "Link" next to BigQuery
3. Select dataset location
4. Enable daily export

### Benefits
- SQL queries on raw data
- Custom analysis
- Integration with data warehouse
- Historical data access

### Example Query

```sql
SELECT
  event_name,
  COUNT(*) as event_count,
  SUM(event_params.value.int_value) as total_value
FROM
  `project.analytics_dataset.events_*`
WHERE
  _TABLE_SUFFIX BETWEEN '20240101' AND '20240131'
  AND event_name = 'trade_completed'
GROUP BY
  event_name
ORDER BY
  event_count DESC
```

---

## Compliance

### GDPR Compliance

- ✅ Get explicit consent before tracking
- ✅ Provide privacy policy
- ✅ Allow users to opt out
- ✅ Delete user data on request
- ✅ Anonymize IP addresses

### CCPA Compliance

- ✅ Disclose data collection practices
- ✅ Allow users to opt out of sale
- ✅ Provide "Do Not Sell" option
- ✅ Delete user data on request

### Implementation

```typescript
// Check consent before initializing
const hasConsent = localStorage.getItem('analytics_consent') === 'true';

if (hasConsent) {
  initializeFirebase();
} else {
  // Show consent dialog
}

// Opt out
function optOutAnalytics() {
  localStorage.setItem('analytics_consent', 'false');
  // Disable analytics
  if (analytics) {
    analytics.setAnalyticsCollectionEnabled(false);
  }
}
```

---

## Testing

### Unit Tests

```typescript
import { AnalyticsService } from '@/lib/firebase';

// Mock Firebase
jest.mock('firebase/analytics', () => ({
  getAnalytics: jest.fn(),
  logEvent: jest.fn(),
}));

describe('AnalyticsService', () => {
  it('should log trade created event', () => {
    AnalyticsService.logTradeCreated('buy', 100, 250);
    
    expect(logEvent).toHaveBeenCalledWith(
      expect.anything(),
      'trade_created',
      {
        trade_type: 'buy',
        quantity: 100,
        price: 250,
        total_value: 25000,
      }
    );
  });
});
```

### Integration Tests

```typescript
// Test event tracking in components
import { render, fireEvent } from '@testing-library/react';
import { AnalyticsService } from '@/lib/firebase';

jest.spyOn(AnalyticsService, 'logUserAction');

test('tracks button click', () => {
  const { getByText } = render(<TradeButton />);
  
  fireEvent.click(getByText('Buy Energy'));
  
  expect(AnalyticsService.logUserAction).toHaveBeenCalledWith(
    'button_click',
    'trading',
    'buy_energy'
  );
});
```

---

## Support

- **Firebase Docs:** https://firebase.google.com/docs/analytics
- **Firebase Console:** https://console.firebase.google.com/
- **Stack Overflow:** https://stackoverflow.com/questions/tagged/firebase-analytics
- **Firebase Support:** https://firebase.google.com/support

---

## Checklist

### Setup
- [ ] Firebase project created
- [ ] Web app registered
- [ ] iOS app registered (if applicable)
- [ ] Android app registered (if applicable)
- [ ] Environment variables configured
- [ ] Dependencies installed
- [ ] Firebase initialized

### Implementation
- [ ] Page view tracking implemented
- [ ] User action tracking implemented
- [ ] Trading events tracked
- [ ] Payment events tracked
- [ ] DR participation tracked
- [ ] Gamification events tracked
- [ ] Mobile features tracked
- [ ] Error tracking implemented
- [ ] User properties set

### Testing
- [ ] Debug mode enabled
- [ ] Events visible in DebugView
- [ ] Events appearing in Analytics Console
- [ ] User properties updating correctly
- [ ] Custom parameters working

### Compliance
- [ ] Privacy policy updated
- [ ] Consent mechanism implemented
- [ ] Opt-out functionality added
- [ ] GDPR compliance verified
- [ ] CCPA compliance verified

### Monitoring
- [ ] Custom dashboard created
- [ ] Key metrics defined
- [ ] Alerts configured
- [ ] BigQuery export enabled (optional)
- [ ] Regular review scheduled

---

**Ready to track analytics?** Initialize Firebase and start logging events!
