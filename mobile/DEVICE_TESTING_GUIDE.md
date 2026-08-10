# Mobile App - Physical Device Testing Guide

Complete guide for testing the VPP Consumer Platform mobile app on real iOS and Android devices.

## Prerequisites

### iOS Testing
- **Mac computer** with Xcode installed
- **iOS device** (iPhone/iPad) running iOS 13.0 or later
- **Apple Developer Account** (free or paid)
- **USB cable** to connect device to Mac

### Android Testing
- **Android device** running Android 5.0 (API 21) or later
- **USB cable** to connect device to computer
- **Android Studio** with SDK tools installed
- **Developer mode enabled** on Android device

---

## Setup Instructions

### 1. Install Dependencies

```bash
cd /home/ubuntu/vpp_consumer_platform/mobile
npm install
# or
yarn install
```

### 2. iOS Setup

```bash
# Install iOS dependencies
cd ios
pod install
cd ..

# Run on connected iOS device
expo run:ios --device

# Or build with EAS
eas build --profile development --platform ios
```

### 3. Android Setup

```bash
# Enable developer mode on Android device:
# Settings → About Phone → Tap "Build Number" 7 times

# Enable USB debugging:
# Settings → Developer Options → USB Debugging

# Run on connected Android device
expo run:android --device

# Or build with EAS
eas build --profile development --platform android
```

---

## Feature Testing Checklist

### 1. Camera & QR Scanner (⚠️ Physical Device Only)

**QR Payment Testing:**
- [ ] Open QR Payment screen
- [ ] Tap "Scan QR Code" button
- [ ] Grant camera permissions when prompted
- [ ] Test QR code scanning with sample payment QR:
  ```
  vpp://payment?amount=100000&recipient=Test%20Merchant&reference=INV-001
  ```
- [ ] Verify payment details display correctly
- [ ] Test payment confirmation flow
- [ ] Verify haptic feedback on scan

**QR Device Registration Testing:**
- [ ] Open QR Device Registration screen
- [ ] Tap "Scan Device QR Code" button
- [ ] Test QR code scanning with sample device QR:
  ```
  vpp://device?type=solar&name=Solar%20Panel&capacity=5000&serial=SP123456&make=SunPower&model=X22
  ```
- [ ] Verify device details display correctly
- [ ] Test device registration flow
- [ ] Verify haptic feedback on scan and registration

**Camera Permission Testing:**
- [ ] Test first-time camera permission request
- [ ] Test permission denial handling
- [ ] Test permission re-request after denial
- [ ] Verify graceful fallback when camera unavailable

### 2. Haptic Feedback (⚠️ Physical Device Only)

**Test all haptic patterns:**
- [ ] Button press (light impact)
- [ ] Success actions (notification success)
- [ ] Error actions (notification error)
- [ ] Trading complete (medium impact)
- [ ] Payment complete (success + medium impact)
- [ ] Payment failed (error + heavy impact)
- [ ] Device registered (success + medium impact)
- [ ] QR scanned (light impact)
- [ ] Pull-to-refresh (light impact)
- [ ] Offer accepted (success + light impact)
- [ ] DR event started (notification warning)
- [ ] Validation error (notification warning)

**Haptic Testing Screens:**
- [ ] Trading screen - trade button
- [ ] Payments screen - payment actions
- [ ] DR Participation - enrollment and events
- [ ] Gamification - tab switches and refresh
- [ ] P2P Trading - offer creation and acceptance
- [ ] QR Payment - scanning and payment
- [ ] QR Device Registration - scanning and registration

### 3. Native Share (⚠️ Physical Device Only)

**Share Button Testing:**
- [ ] Trading screen - share trading opportunity
- [ ] Test share to Messages/WhatsApp
- [ ] Test share to Email
- [ ] Test share to Social Media (Twitter, Facebook)
- [ ] Verify share content includes correct data
- [ ] Test share cancellation

**Share Content Verification:**
- [ ] Trading opportunity includes price and quantity
- [ ] Payment receipt includes amount and reference
- [ ] Device referral includes device type and capacity
- [ ] DR event includes event time and compensation
- [ ] Achievement includes badge name and points

### 4. Push Notifications (⚠️ Physical Device Only)

**Notification Permission Testing:**
- [ ] Test first-time notification permission request
- [ ] Test permission denial handling
- [ ] Test permission re-request
- [ ] Verify notification settings sync

**Notification Delivery Testing:**
- [ ] Send test notification from app
- [ ] Verify notification appears in notification center
- [ ] Test notification tap to open app
- [ ] Test notification with actions (if implemented)
- [ ] Verify notification sound and vibration
- [ ] Test notification while app is:
  - [ ] In foreground
  - [ ] In background
  - [ ] Killed/closed

**Notification Channels (Android):**
- [ ] DR Events channel
- [ ] Payments channel
- [ ] Trading Alerts channel
- [ ] System Alerts channel
- [ ] Verify channel settings in Android settings

### 5. Biometric Authentication (⚠️ Physical Device Only)

**iOS Face ID Testing:**
- [ ] Test Face ID enrollment
- [ ] Test Face ID authentication success
- [ ] Test Face ID authentication failure
- [ ] Test fallback to passcode
- [ ] Verify biometric prompt UI

**Android Fingerprint Testing:**
- [ ] Test fingerprint enrollment
- [ ] Test fingerprint authentication success
- [ ] Test fingerprint authentication failure
- [ ] Test fallback to PIN
- [ ] Verify biometric prompt UI

**Biometric Use Cases:**
- [ ] Login with biometrics
- [ ] Confirm payment with biometrics
- [ ] Approve trade with biometrics
- [ ] Register device with biometrics

### 6. Offline Functionality

**Offline Data Access:**
- [ ] Enable airplane mode
- [ ] Verify cached dashboard data loads
- [ ] Verify cached asset list loads
- [ ] Verify cached transaction history loads
- [ ] Test offline indicator appears

**Offline Sync:**
- [ ] Make changes while offline (if supported)
- [ ] Re-enable network connection
- [ ] Verify data syncs automatically
- [ ] Verify sync status indicator

### 7. Performance Testing

**App Launch:**
- [ ] Cold start time < 3 seconds
- [ ] Warm start time < 1 second
- [ ] Splash screen displays correctly

**Screen Transitions:**
- [ ] Navigation animations smooth (60 FPS)
- [ ] No jank or stuttering
- [ ] Back button responsive

**Data Loading:**
- [ ] Loading indicators display promptly
- [ ] Data loads within 2 seconds on 4G
- [ ] Skeleton screens for slow connections

**Memory Usage:**
- [ ] Monitor memory usage (should stay < 200MB)
- [ ] No memory leaks after extended use
- [ ] App doesn't crash under load

### 8. Battery & Network

**Battery Consumption:**
- [ ] Monitor battery drain over 1 hour of use
- [ ] Should consume < 5% battery per hour
- [ ] Background battery usage minimal

**Network Conditions:**
- [ ] Test on 4G/LTE
- [ ] Test on 3G
- [ ] Test on WiFi
- [ ] Test network switching (WiFi ↔ Cellular)
- [ ] Test poor network conditions
- [ ] Verify retry logic for failed requests

### 9. Platform-Specific Features

**iOS Specific:**
- [ ] Test on iPhone (various models)
- [ ] Test on iPad (if supported)
- [ ] Test with Dynamic Type (accessibility)
- [ ] Test with VoiceOver (accessibility)
- [ ] Test with Dark Mode
- [ ] Test with Light Mode
- [ ] Verify safe area handling (notch devices)

**Android Specific:**
- [ ] Test on various Android versions (5.0+)
- [ ] Test on different screen sizes
- [ ] Test with TalkBack (accessibility)
- [ ] Test with system font scaling
- [ ] Test with Dark Theme
- [ ] Test with Light Theme
- [ ] Verify navigation bar handling

---

## Testing Tools

### 1. Generate Test QR Codes

Use online QR code generators to create test QR codes:

**Payment QR:**
```
vpp://payment?amount=100000&recipient=Test%20Merchant&reference=INV-001
```

**Device QR:**
```
vpp://device?type=solar&name=Solar%20Panel&capacity=5000&serial=SP123456
```

### 2. Monitor Logs

**iOS:**
```bash
# View device logs
xcrun simctl spawn booted log stream --predicate 'process == "VPPConsumer"'
```

**Android:**
```bash
# View device logs
adb logcat | grep VPPConsumer
```

### 3. Network Debugging

**iOS:**
- Use Charles Proxy or Proxyman
- Configure proxy on device: Settings → WiFi → Configure Proxy

**Android:**
- Use Charles Proxy or HTTP Toolkit
- Configure proxy on device: Settings → WiFi → Modify Network → Proxy

### 4. Performance Profiling

**iOS:**
- Use Xcode Instruments (Time Profiler, Allocations)
- Product → Profile in Xcode

**Android:**
- Use Android Studio Profiler
- View → Tool Windows → Profiler

---

## Common Issues & Troubleshooting

### Camera Not Working

**iOS:**
- Verify `NSCameraUsageDescription` in `Info.plist`
- Check camera permissions: Settings → Privacy → Camera
- Restart app after granting permissions

**Android:**
- Verify `CAMERA` permission in `AndroidManifest.xml`
- Check camera permissions: Settings → Apps → VPP Consumer → Permissions
- Restart app after granting permissions

### Haptic Feedback Not Working

**iOS:**
- Haptics only work on iPhone 7 and later
- Verify device supports Taptic Engine
- Check Settings → Sounds & Haptics → System Haptics

**Android:**
- Verify device supports vibration
- Check Settings → Sound → Vibration
- Some devices have weak vibration motors

### Push Notifications Not Received

**iOS:**
- Verify APNs certificate is valid
- Check notification permissions: Settings → Notifications → VPP Consumer
- Verify device has internet connection
- Check Firebase Cloud Messaging configuration

**Android:**
- Verify FCM configuration is correct
- Check notification permissions: Settings → Apps → VPP Consumer → Notifications
- Verify device has Google Play Services
- Check battery optimization settings

### Biometric Authentication Fails

**iOS:**
- Verify Face ID/Touch ID is set up: Settings → Face ID & Passcode
- Check biometric enrollment
- Try re-enrolling biometrics

**Android:**
- Verify fingerprint is set up: Settings → Security → Fingerprint
- Check biometric enrollment
- Try re-enrolling fingerprint

### App Crashes on Launch

**iOS:**
- Check Xcode console for crash logs
- Verify all dependencies are installed (`pod install`)
- Clean build folder: Product → Clean Build Folder

**Android:**
- Check Android Studio Logcat for crash logs
- Verify all dependencies are installed
- Clean and rebuild: Build → Clean Project

---

## Test Report Template

### Device Information
- **Device Model:** _____________
- **OS Version:** _____________
- **App Version:** _____________
- **Test Date:** _____________

### Test Results

| Feature | Status | Notes |
|---------|--------|-------|
| QR Scanner | ⬜ Pass ⬜ Fail | |
| Haptic Feedback | ⬜ Pass ⬜ Fail | |
| Native Share | ⬜ Pass ⬜ Fail | |
| Push Notifications | ⬜ Pass ⬜ Fail | |
| Biometric Auth | ⬜ Pass ⬜ Fail | |
| Offline Mode | ⬜ Pass ⬜ Fail | |
| Performance | ⬜ Pass ⬜ Fail | |
| Battery Usage | ⬜ Pass ⬜ Fail | |

### Issues Found

1. **Issue:** _____________
   - **Severity:** ⬜ Critical ⬜ High ⬜ Medium ⬜ Low
   - **Steps to Reproduce:** _____________
   - **Expected:** _____________
   - **Actual:** _____________

### Overall Assessment

⬜ **Ready for Production**
⬜ **Needs Minor Fixes**
⬜ **Needs Major Fixes**

---

## Next Steps

After completing device testing:

1. **Document all issues** found during testing
2. **Prioritize fixes** based on severity
3. **Create bug tickets** for development team
4. **Retest** after fixes are implemented
5. **Prepare for beta testing** with real users
6. **Submit to app stores** when ready

---

## Resources

- [Expo Camera Documentation](https://docs.expo.dev/versions/latest/sdk/camera/)
- [Expo Haptics Documentation](https://docs.expo.dev/versions/latest/sdk/haptics/)
- [Expo Notifications Documentation](https://docs.expo.dev/versions/latest/sdk/notifications/)
- [React Native Share Documentation](https://reactnative.dev/docs/share)
- [iOS Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/)
- [Android Material Design Guidelines](https://material.io/design)
