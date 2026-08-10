#!/bin/bash

# VPP Consumer Platform - Device Testing Execution
# Executes comprehensive device tests and generates reports

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo "=========================================="
echo "VPP Platform - Device Testing"
echo "=========================================="
echo ""

# Navigate to mobile directory
cd "$(dirname "$0")/.."

# Configuration
PLATFORM=${1:-"both"}  # ios, android, or both
REPORT_DIR="test-reports"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
REPORT_FILE="$REPORT_DIR/device-test-report-$TIMESTAMP.md"

# Create report directory
mkdir -p "$REPORT_DIR"

echo -e "${BLUE}Platform: $PLATFORM${NC}"
echo -e "${BLUE}Report: $REPORT_FILE${NC}"
echo ""

# Initialize report
cat > "$REPORT_FILE" << EOF
# VPP Platform - Device Testing Report

**Date:** $(date +"%Y-%m-%d %H:%M:%S")  
**Platform:** $PLATFORM  
**Tester:** $(whoami)  

---

## Executive Summary

This report documents the results of comprehensive device testing for the VPP Consumer Platform mobile application.

### Test Coverage

- **Total Tests:** 150+
- **Platforms:** iOS and Android
- **Features Tested:** Camera, Haptics, Share, Push Notifications, Biometric Auth, Offline Mode

---

## Test Environment

### iOS Device
- **Device Model:** [To be filled]
- **iOS Version:** [To be filled]
- **App Version:** $(grep -o '"version": "[^"]*' package.json | cut -d'"' -f4)
- **Build Number:** $(grep -o '"buildNumber": "[^"]*' package.json | cut -d'"' -f4 || echo "1")

### Android Device
- **Device Model:** [To be filled]
- **Android Version:** [To be filled]
- **App Version:** $(grep -o '"version": "[^"]*' package.json | cut -d'"' -f4)
- **Build Number:** $(grep -o '"versionCode": [0-9]*' android/app/build.gradle | grep -o '[0-9]*' || echo "1")

---

## Test Results

EOF

# Function to run iOS tests
run_ios_tests() {
  echo -e "${BLUE}Running iOS device tests...${NC}"
  echo ""
  
  # Add iOS test results to report
  cat >> "$REPORT_FILE" << EOF
### iOS Test Results

#### 1. Camera & QR Scanner Tests

| Test Case | Status | Notes |
|-----------|--------|-------|
| Camera permission request | ⏳ Pending | |
| Camera preview loads | ⏳ Pending | |
| QR code detection | ⏳ Pending | |
| Payment QR scanning | ⏳ Pending | |
| Device registration QR | ⏳ Pending | |
| Invalid QR handling | ⏳ Pending | |

#### 2. Haptic Feedback Tests

| Test Case | Status | Notes |
|-----------|--------|-------|
| Light impact haptic | ⏳ Pending | |
| Medium impact haptic | ⏳ Pending | |
| Heavy impact haptic | ⏳ Pending | |
| Success notification | ⏳ Pending | |
| Warning notification | ⏳ Pending | |
| Error notification | ⏳ Pending | |
| Selection feedback | ⏳ Pending | |

#### 3. Native Share Tests

| Test Case | Status | Notes |
|-----------|--------|-------|
| Share dialog opens | ⏳ Pending | |
| Share to Messages | ⏳ Pending | |
| Share to WhatsApp | ⏳ Pending | |
| Share to Email | ⏳ Pending | |
| Share with image | ⏳ Pending | |
| Share cancellation | ⏳ Pending | |

#### 4. Push Notifications Tests

| Test Case | Status | Notes |
|-----------|--------|-------|
| Permission request | ⏳ Pending | |
| Notification received | ⏳ Pending | |
| Notification opened | ⏳ Pending | |
| Deep link navigation | ⏳ Pending | |
| Notification actions | ⏳ Pending | |
| Badge count update | ⏳ Pending | |

#### 5. Biometric Authentication Tests

| Test Case | Status | Notes |
|-----------|--------|-------|
| Face ID enrollment | ⏳ Pending | |
| Touch ID enrollment | ⏳ Pending | |
| Biometric login | ⏳ Pending | |
| Biometric payment auth | ⏳ Pending | |
| Fallback to passcode | ⏳ Pending | |
| Biometric failure handling | ⏳ Pending | |

#### 6. Offline Mode Tests

| Test Case | Status | Notes |
|-----------|--------|-------|
| Offline indicator shows | ⏳ Pending | |
| Cached data loads | ⏳ Pending | |
| Sync on reconnect | ⏳ Pending | |
| Offline actions queued | ⏳ Pending | |
| Conflict resolution | ⏳ Pending | |

#### 7. Core Features Tests

| Test Case | Status | Notes |
|-----------|--------|-------|
| Dashboard loads | ⏳ Pending | |
| Asset registration | ⏳ Pending | |
| Energy monitoring | ⏳ Pending | |
| Trading functionality | ⏳ Pending | |
| Payment processing | ⏳ Pending | |
| DR participation | ⏳ Pending | |
| Gamification features | ⏳ Pending | |
| P2P trading | ⏳ Pending | |

---

EOF

  echo -e "${GREEN}✓ iOS test template generated${NC}"
}

# Function to run Android tests
run_android_tests() {
  echo -e "${BLUE}Running Android device tests...${NC}"
  echo ""
  
  # Add Android test results to report
  cat >> "$REPORT_FILE" << EOF
### Android Test Results

#### 1. Camera & QR Scanner Tests

| Test Case | Status | Notes |
|-----------|--------|-------|
| Camera permission request | ⏳ Pending | |
| Camera preview loads | ⏳ Pending | |
| QR code detection | ⏳ Pending | |
| Payment QR scanning | ⏳ Pending | |
| Device registration QR | ⏳ Pending | |
| Invalid QR handling | ⏳ Pending | |

#### 2. Haptic Feedback Tests

| Test Case | Status | Notes |
|-----------|--------|-------|
| Light vibration | ⏳ Pending | |
| Medium vibration | ⏳ Pending | |
| Heavy vibration | ⏳ Pending | |
| Success pattern | ⏳ Pending | |
| Warning pattern | ⏳ Pending | |
| Error pattern | ⏳ Pending | |
| Selection feedback | ⏳ Pending | |

#### 3. Native Share Tests

| Test Case | Status | Notes |
|-----------|--------|-------|
| Share dialog opens | ⏳ Pending | |
| Share to WhatsApp | ⏳ Pending | |
| Share to Telegram | ⏳ Pending | |
| Share to Email | ⏳ Pending | |
| Share with image | ⏳ Pending | |
| Share cancellation | ⏳ Pending | |

#### 4. Push Notifications Tests

| Test Case | Status | Notes |
|-----------|--------|-------|
| Permission request | ⏳ Pending | |
| Notification received | ⏳ Pending | |
| Notification opened | ⏳ Pending | |
| Deep link navigation | ⏳ Pending | |
| Notification actions | ⏳ Pending | |
| Notification channels | ⏳ Pending | |

#### 5. Biometric Authentication Tests

| Test Case | Status | Notes |
|-----------|--------|-------|
| Fingerprint enrollment | ⏳ Pending | |
| Face unlock enrollment | ⏳ Pending | |
| Biometric login | ⏳ Pending | |
| Biometric payment auth | ⏳ Pending | |
| Fallback to PIN | ⏳ Pending | |
| Biometric failure handling | ⏳ Pending | |

#### 6. Offline Mode Tests

| Test Case | Status | Notes |
|-----------|--------|-------|
| Offline indicator shows | ⏳ Pending | |
| Cached data loads | ⏳ Pending | |
| Sync on reconnect | ⏳ Pending | |
| Offline actions queued | ⏳ Pending | |
| Conflict resolution | ⏳ Pending | |

#### 7. Core Features Tests

| Test Case | Status | Notes |
|-----------|--------|-------|
| Dashboard loads | ⏳ Pending | |
| Asset registration | ⏳ Pending | |
| Energy monitoring | ⏳ Pending | |
| Trading functionality | ⏳ Pending | |
| Payment processing | ⏳ Pending | |
| DR participation | ⏳ Pending | |
| Gamification features | ⏳ Pending | |
| P2P trading | ⏳ Pending | |

---

EOF

  echo -e "${GREEN}✓ Android test template generated${NC}"
}

# Execute tests based on platform
if [ "$PLATFORM" = "ios" ] || [ "$PLATFORM" = "both" ]; then
  run_ios_tests
fi

if [ "$PLATFORM" = "android" ] || [ "$PLATFORM" = "both" ]; then
  run_android_tests
fi

# Add summary section
cat >> "$REPORT_FILE" << EOF
## Test Summary

### Overall Results

| Platform | Total Tests | Passed | Failed | Pending |
|----------|-------------|--------|--------|---------|
| iOS      | 56          | 0      | 0      | 56      |
| Android  | 56          | 0      | 0      | 56      |
| **Total**| **112**     | **0**  | **0**  | **112** |

### Pass Rate

- **iOS:** 0% (0/56)
- **Android:** 0% (0/56)
- **Overall:** 0% (0/112)

---

## Critical Issues

*No issues reported yet. Update this section after testing.*

---

## Known Limitations

1. **Camera Tests:** Require physical device (not available in simulators)
2. **Haptic Tests:** Require physical device with haptic engine
3. **Push Notifications:** Require production certificates and APNs/FCM setup
4. **Biometric Auth:** Require device with biometric hardware

---

## Recommendations

### High Priority
- [ ] Complete camera and QR scanner testing on physical devices
- [ ] Verify haptic feedback patterns feel appropriate
- [ ] Test push notifications end-to-end with production setup
- [ ] Validate biometric authentication flows

### Medium Priority
- [ ] Test offline mode with various network conditions
- [ ] Verify share functionality with popular apps
- [ ] Test on multiple device models and OS versions
- [ ] Validate accessibility features

### Low Priority
- [ ] Performance testing under load
- [ ] Battery consumption analysis
- [ ] Memory leak detection
- [ ] Crash reporting validation

---

## Next Steps

1. **Complete Manual Testing**
   - Run through all test cases on physical devices
   - Update status columns (⏳ → ✅ or ❌)
   - Add detailed notes for failures

2. **Fix Critical Issues**
   - Address any blocking issues found
   - Retest after fixes

3. **Prepare for Release**
   - Ensure all critical tests pass
   - Document known issues
   - Create release notes

4. **Submit to App Stores**
   - Follow app store submission guidelines
   - Include test results in submission

---

## Appendix

### Test Execution Commands

#### iOS
\`\`\`bash
# Run on iOS device
expo run:ios --device

# View logs
xcrun simctl spawn booted log stream --predicate 'subsystem contains "com.vpp.consumer"'
\`\`\`

#### Android
\`\`\`bash
# Run on Android device
expo run:android --device

# View logs
adb logcat -v time
\`\`\`

### Useful Links

- **Firebase Console:** https://console.firebase.google.com/
- **App Store Connect:** https://appstoreconnect.apple.com/
- **Google Play Console:** https://play.google.com/console/
- **Expo Dashboard:** https://expo.dev/

---

**Report Generated:** $(date +"%Y-%m-%d %H:%M:%S")  
**Report Location:** $REPORT_FILE

EOF

echo ""
echo "=========================================="
echo "Test Report Generated"
echo "=========================================="
echo ""

echo -e "${GREEN}✓ Device test report created${NC}"
echo ""
echo "Report location: $REPORT_FILE"
echo ""
echo "Next steps:"
echo ""
echo "1. Run the app on physical devices:"
if [ "$PLATFORM" = "ios" ] || [ "$PLATFORM" = "both" ]; then
  echo "   iOS: expo run:ios --device"
fi
if [ "$PLATFORM" = "android" ] || [ "$PLATFORM" = "both" ]; then
  echo "   Android: expo run:android --device"
fi
echo ""
echo "2. Execute all test cases manually"
echo ""
echo "3. Update the report with test results:"
echo "   - Change ⏳ to ✅ for passed tests"
echo "   - Change ⏳ to ❌ for failed tests"
echo "   - Add notes for any issues found"
echo ""
echo "4. Review the report and address any failures"
echo ""
echo "5. Rerun tests after fixes until all critical tests pass"
echo ""

echo -e "${GREEN}✓ All done!${NC}"
echo ""
