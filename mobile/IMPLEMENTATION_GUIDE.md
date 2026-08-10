# Mobile App Implementation Guide

## Camera, Share, and Haptic Feedback Features

This guide covers the implementation of camera-based QR scanning, native sharing, and haptic feedback features in the VPP Platform mobile app.

## Table of Contents

1. [Camera & QR Scanner](#camera--qr-scanner)
2. [Native Share Integration](#native-share-integration)
3. [Haptic Feedback](#haptic-feedback)
4. [Testing Guide](#testing-guide)
5. [Troubleshooting](#troubleshooting)

---

## Camera & QR Scanner

### Dependencies

```json
{
  "expo-camera": "~14.0.5",
  "expo-barcode-scanner": "~12.9.2"
}
```

### Permissions

**iOS** (`app.json`):
```json
{
  "ios": {
    "infoPlist": {
      "NSCameraUsageDescription": "This app uses the camera to scan QR codes for payments and device registration."
    }
  }
}
```

**Android** (`app.json`):
```json
{
  "android": {
    "permissions": ["CAMERA"]
  }
}
```

### Components

#### QRScanner Component
Location: `mobile/src/components/QRScanner.tsx`

**Features**:
- Camera permission handling
- Real-time barcode scanning
- Automatic data parsing
- Error handling
- Camera controls (torch, flip)

**Usage**:
```tsx
import QRScanner from '../components/QRScanner';

<QRScanner
  onScan={(data) => {
    console.log('QR Data:', data);
    // Handle scanned data
  }}
  onError={(error) => {
    console.error('Scan error:', error);
  }}
/>
```

#### QR Payment Screen
Location: `mobile/src/screens/QRPaymentScreen.tsx`

**QR Code Format**:
```
vpp://payment?amount=1000&recipient=John&reference=INV-001
```

**Data Extraction**:
- `amount`: Payment amount in cents
- `recipient`: Recipient name or ID
- `reference`: Optional payment reference

#### QR Device Registration Screen
Location: `mobile/src/screens/QRDeviceRegistrationScreen.tsx`

**QR Code Format**:
```
vpp://device?type=solar&name=Solar Panel&capacity=5000&serial=SP123456
```

**Data Extraction**:
- `type`: Device type (solar, battery, etc.)
- `name`: Device name
- `capacity`: Device capacity in watts
- `serial`: Device serial number

### Navigation

Access QR screens via:
```tsx
navigation.navigate('QRPayment');
navigation.navigate('QRDeviceRegistration');
```

### Testing

**Simulator Limitations**:
- Camera not available in iOS Simulator
- Camera not available in Android Emulator
- **Must test on physical devices**

**Test QR Codes**:
Generate test QR codes at: https://www.qr-code-generator.com/

Example payment QR:
```
vpp://payment?amount=5000&recipient=TestUser&reference=TEST001
```

Example device QR:
```
vpp://device?type=solar&name=Test Panel&capacity=3000&serial=TEST123
```

---

## Native Share Integration

### Dependencies

```json
{
  "react-native": "0.73.2"  // Share API built-in
}
```

### ShareService

Location: `mobile/src/services/shareService.ts`

**Available Methods**:

1. **shareTradingOpportunity(type, quantity, price)**
   - Share buy/sell energy offers
   - Includes price and quantity
   - Returns boolean (success/failure)

2. **sharePaymentRequest(amount, recipient, reference?)**
   - Share payment details
   - Includes amount and recipient
   - Optional reference number

3. **shareDeviceReferral(deviceType, benefits)**
   - Share device registration benefits
   - Includes device type and benefit list
   - Encourages referrals

4. **shareDREvent(eventName, compensationRate, startTime)**
   - Share DR event participation
   - Includes event details and compensation
   - Promotes DR program

5. **shareAchievement(name, description, points)**
   - Share unlocked achievements
   - Includes achievement details and points
   - Gamification feature

6. **shareEarnings(totalEarnings, period)**
   - Share earnings summary
   - Includes total amount and period
   - Success story sharing

7. **shareAppReferral(referralCode?)**
   - Share app invitation
   - Optional referral code
   - User acquisition

8. **shareP2POffer(type, quantity, pricePerKwh, description?)**
   - Share P2P trading offers
   - Includes offer details
   - P2P marketplace promotion

### ShareButton Component

Location: `mobile/src/components/ShareButton.tsx`

**Props**:
```tsx
interface ShareButtonProps {
  onPress: () => Promise<boolean>;
  label?: string;
  icon?: string;
  variant?: 'primary' | 'secondary' | 'icon';
  size?: 'small' | 'medium' | 'large';
}
```

**Variants**:
- `primary`: Filled button with green background
- `secondary`: Outlined button with green border
- `icon`: Icon-only circular button

**Usage Example**:
```tsx
import ShareButton from '../components/ShareButton';
import { ShareService } from '../services/shareService';

<ShareButton
  variant="icon"
  size="small"
  onPress={() => ShareService.shareTradingOpportunity('sell', 10, 5000)}
/>
```

### Integration Examples

**Trading Screen**:
```tsx
<ShareButton
  variant="icon"
  size="small"
  onPress={() => ShareService.shareTradingOpportunity(
    activeTab,
    parseInt(quantity) || 10,
    parseInt(price) || currentMarketPrice
  )}
/>
```

**Gamification Screen**:
```tsx
<ShareButton
  variant="secondary"
  label="Share Achievement"
  onPress={() => ShareService.shareAchievement(
    achievement.name,
    achievement.description,
    achievement.points
  )}
/>
```

### Platform Differences

**iOS**:
- Native share sheet
- Supports URL parameter
- System-wide share targets

**Android**:
- Native share intent
- System-wide share targets
- No URL parameter support

---

## Haptic Feedback

### Dependencies

```json
{
  "expo-haptics": "~12.8.1"
}
```

### Permissions

**Android** (`app.json`):
```json
{
  "android": {
    "permissions": ["VIBRATE"]
  }
}
```

**iOS**: No additional permissions required

### HapticService

Location: `mobile/src/services/hapticService.ts`

**Impact Feedback**:
- `light()`: Subtle interactions (button taps, toggles)
- `medium()`: Standard interactions (confirmations, submissions)
- `heavy()`: Significant interactions (deletions, errors)

**Notification Feedback**:
- `success()`: Successful actions (trades, payments)
- `warning()`: Warnings and cautions
- `error()`: Errors and failures

**Selection Feedback**:
- `selection()`: Scrolling through values (pickers, sliders)

**Convenience Methods**:
```tsx
// Button interactions
HapticService.buttonPress()

// Trading
HapticService.tradeExecuted()

// Payments
HapticService.paymentCompleted()
HapticService.paymentFailed()

// Device management
HapticService.deviceRegistered()

// DR events
HapticService.drEventStarted()

// Gamification
HapticService.achievementUnlocked()

// QR scanning
HapticService.qrScanned()

// UI interactions
HapticService.toggleSwitch()
HapticService.pullToRefresh()
HapticService.shareAction()

// Biometric auth
HapticService.biometricSuccess()
HapticService.biometricFailed()

// Form validation
HapticService.validationError()
```

### Integration Examples

**Button with Haptic Feedback**:
```tsx
import { HapticService } from '../services/hapticService';

const handlePress = async () => {
  await HapticService.buttonPress();
  // Perform action
};

<TouchableOpacity onPress={handlePress}>
  <Text>Press Me</Text>
</TouchableOpacity>
```

**Trade Execution with Feedback**:
```tsx
const createTradeMutation = trpc.trading.createTrade.useMutation({
  onSuccess: async () => {
    await HapticService.tradeExecuted();
    Alert.alert('Success', 'Trade created successfully');
  },
  onError: async (error) => {
    await HapticService.error();
    Alert.alert('Error', error.message);
  },
});
```

**Form Validation with Feedback**:
```tsx
const handleSubmit = async () => {
  if (!isValid) {
    await HapticService.validationError();
    Alert.alert('Error', 'Please fill all fields');
    return;
  }
  
  await HapticService.buttonPress();
  // Submit form
};
```

### Best Practices

1. **Use Appropriate Intensity**:
   - Light: Frequent interactions
   - Medium: Important actions
   - Heavy: Critical actions only

2. **Don't Overuse**:
   - Not every interaction needs feedback
   - Focus on meaningful moments
   - Consider user preferences

3. **Pair with Visual Feedback**:
   - Haptics enhance, don't replace visuals
   - Use together for best UX
   - Ensure accessibility

4. **Handle Errors Gracefully**:
   - Service includes error handling
   - Falls back silently on unsupported devices
   - No app crashes from haptic failures

---

## Testing Guide

### Camera & QR Scanner

**Physical Device Required**:
1. Build app for physical device:
   ```bash
   expo run:ios --device
   # or
   expo run:android --device
   ```

2. Grant camera permissions when prompted

3. Test QR payment scanning:
   - Generate test payment QR code
   - Open QR Payment screen
   - Scan code
   - Verify data extraction
   - Confirm payment flow

4. Test QR device registration:
   - Generate test device QR code
   - Open QR Device Registration screen
   - Scan code
   - Verify data extraction
   - Confirm registration flow

**Test Checklist**:
- [ ] Camera permission request
- [ ] Camera permission denial handling
- [ ] QR code detection
- [ ] Data parsing (payment)
- [ ] Data parsing (device)
- [ ] Error handling (invalid QR)
- [ ] Torch/flashlight toggle
- [ ] Camera flip (front/back)
- [ ] Cancel/close functionality

### Native Share

**Test on Both Platforms**:
1. iOS Simulator or Device
2. Android Emulator or Device

**Test Scenarios**:
- [ ] Share trading opportunity
- [ ] Share payment request
- [ ] Share device referral
- [ ] Share DR event
- [ ] Share achievement
- [ ] Share earnings
- [ ] Share app referral
- [ ] Share P2P offer

**Verification**:
- Share sheet/intent appears
- Message content is correct
- Links work (if applicable)
- Share completes successfully
- App returns to normal state

### Haptic Feedback

**Physical Device Required**:
- Haptics don't work in simulators/emulators
- Must test on real iOS/Android devices

**Test Scenarios**:
- [ ] Button press (light)
- [ ] Trade execution (success)
- [ ] Payment completion (success)
- [ ] Payment failure (error)
- [ ] Form validation error (error)
- [ ] Achievement unlock (double success)
- [ ] QR scan (medium)
- [ ] Toggle switch (light)
- [ ] Delete action (heavy)

**Verification**:
- Appropriate intensity for action
- Timing feels natural
- No lag or delay
- Works on both platforms
- Graceful fallback on unsupported devices

---

## Troubleshooting

### Camera Issues

**Problem**: Camera not working in simulator
**Solution**: Must use physical device for camera features

**Problem**: Camera permission denied
**Solution**: 
- iOS: Settings > Privacy > Camera > VPP Consumer
- Android: Settings > Apps > VPP Consumer > Permissions > Camera

**Problem**: QR code not scanning
**Solution**:
- Ensure good lighting
- Hold steady for 2-3 seconds
- Check QR code format matches expected pattern
- Verify barcode scanner is initialized

### Share Issues

**Problem**: Share sheet not appearing
**Solution**:
- Check platform compatibility
- Verify Share API is available
- Test with simple message first

**Problem**: Share fails silently
**Solution**:
- Check error logs
- Verify message content is valid
- Test on different apps (Messages, Email, etc.)

### Haptic Issues

**Problem**: No haptic feedback
**Solution**:
- Must use physical device
- Check device vibration settings
- Verify haptic permissions (Android)
- Test with simple haptic first

**Problem**: Haptics too strong/weak
**Solution**:
- Adjust intensity level (light/medium/heavy)
- Consider device capabilities
- Test on multiple devices

---

## Installation

### Install Dependencies

```bash
cd mobile
npm install
```

### iOS Setup

```bash
cd ios
pod install
cd ..
```

### Android Setup

No additional setup required. Permissions are configured in `app.json`.

### Run on Device

**iOS**:
```bash
expo run:ios --device
```

**Android**:
```bash
expo run:android --device
```

---

## Additional Resources

- [Expo Camera Documentation](https://docs.expo.dev/versions/latest/sdk/camera/)
- [Expo Barcode Scanner Documentation](https://docs.expo.dev/versions/latest/sdk/bar-code-scanner/)
- [React Native Share API](https://reactnative.dev/docs/share)
- [Expo Haptics Documentation](https://docs.expo.dev/versions/latest/sdk/haptics/)

---

## Support

For issues or questions:
- GitHub Issues: https://github.com/vpp-platform/mobile/issues
- Email: support@vpp-platform.com
- Documentation: https://docs.vpp-platform.com
