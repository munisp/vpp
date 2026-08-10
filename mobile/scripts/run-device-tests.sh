#!/bin/bash

# VPP Consumer Platform - Automated Device Testing Script
# This script automates the device testing process for iOS and Android

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "======================================"
echo "VPP Mobile App - Device Testing"
echo "======================================"
echo ""

# Check if platform is specified
if [ -z "$1" ]; then
  echo -e "${YELLOW}Usage: ./run-device-tests.sh [ios|android|both]${NC}"
  exit 1
fi

PLATFORM=$1

# Function to check if device is connected
check_device_connected() {
  if [ "$1" == "ios" ]; then
    echo "Checking for connected iOS device..."
    DEVICE_COUNT=$(xcrun xctrace list devices 2>&1 | grep -c "iPhone" || true)
    if [ "$DEVICE_COUNT" -eq 0 ]; then
      echo -e "${RED}❌ No iOS device connected${NC}"
      echo "Please connect an iOS device via USB and trust this computer"
      return 1
    fi
    echo -e "${GREEN}✓ iOS device connected${NC}"
  elif [ "$1" == "android" ]; then
    echo "Checking for connected Android device..."
    DEVICE_COUNT=$(adb devices | grep -c "device$" || true)
    if [ "$DEVICE_COUNT" -eq 0 ]; then
      echo -e "${RED}❌ No Android device connected${NC}"
      echo "Please connect an Android device via USB and enable USB debugging"
      return 1
    fi
    echo -e "${GREEN}✓ Android device connected${NC}"
  fi
  return 0
}

# Function to run iOS tests
run_ios_tests() {
  echo ""
  echo "======================================"
  echo "Running iOS Device Tests"
  echo "======================================"
  echo ""
  
  if ! check_device_connected "ios"; then
    return 1
  fi
  
  echo "Building and deploying to iOS device..."
  cd "$(dirname "$0")/.."
  
  # Check if expo is installed
  if ! command -v expo &> /dev/null; then
    echo -e "${RED}❌ Expo CLI not found${NC}"
    echo "Installing Expo CLI..."
    npm install -g expo-cli
  fi
  
  # Run on device
  echo "Launching app on iOS device..."
  expo run:ios --device
  
  echo ""
  echo -e "${GREEN}✓ iOS app deployed successfully${NC}"
  echo ""
  echo "Please perform the following manual tests:"
  echo "1. Camera & QR Scanner"
  echo "   - Test QR payment scanning"
  echo "   - Test QR device registration"
  echo "2. Haptic Feedback"
  echo "   - Test button presses"
  echo "   - Test success/error actions"
  echo "3. Native Share"
  echo "   - Test sharing trading opportunities"
  echo "   - Test sharing achievements"
  echo "4. Push Notifications"
  echo "   - Test notification permissions"
  echo "   - Send test notification"
  echo "5. Biometric Authentication"
  echo "   - Test Face ID/Touch ID login"
  echo ""
  
  return 0
}

# Function to run Android tests
run_android_tests() {
  echo ""
  echo "======================================"
  echo "Running Android Device Tests"
  echo "======================================"
  echo ""
  
  if ! check_device_connected "android"; then
    return 1
  fi
  
  echo "Building and deploying to Android device..."
  cd "$(dirname "$0")/.."
  
  # Check if expo is installed
  if ! command -v expo &> /dev/null; then
    echo -e "${RED}❌ Expo CLI not found${NC}"
    echo "Installing Expo CLI..."
    npm install -g expo-cli
  fi
  
  # Run on device
  echo "Launching app on Android device..."
  expo run:android --device
  
  echo ""
  echo -e "${GREEN}✓ Android app deployed successfully${NC}"
  echo ""
  echo "Please perform the following manual tests:"
  echo "1. Camera & QR Scanner"
  echo "   - Test QR payment scanning"
  echo "   - Test QR device registration"
  echo "2. Haptic Feedback"
  echo "   - Test button presses"
  echo "   - Test success/error actions"
  echo "3. Native Share"
  echo "   - Test sharing trading opportunities"
  echo "   - Test sharing achievements"
  echo "4. Push Notifications"
  echo "   - Test notification permissions"
  echo "   - Send test notification"
  echo "5. Biometric Authentication"
  echo "   - Test fingerprint login"
  echo ""
  
  return 0
}

# Function to capture device logs
capture_logs() {
  echo ""
  echo "======================================"
  echo "Capturing Device Logs"
  echo "======================================"
  echo ""
  
  TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
  LOG_DIR="$(dirname "$0")/../test-logs"
  mkdir -p "$LOG_DIR"
  
  if [ "$1" == "ios" ]; then
    echo "Capturing iOS logs..."
    LOG_FILE="$LOG_DIR/ios_test_${TIMESTAMP}.log"
    xcrun simctl spawn booted log stream --predicate 'process == "VPPConsumer"' > "$LOG_FILE" 2>&1 &
    LOG_PID=$!
    echo -e "${GREEN}✓ iOS logs being captured to: $LOG_FILE${NC}"
    echo "Press Ctrl+C to stop log capture"
    wait $LOG_PID
  elif [ "$1" == "android" ]; then
    echo "Capturing Android logs..."
    LOG_FILE="$LOG_DIR/android_test_${TIMESTAMP}.log"
    adb logcat | grep VPPConsumer > "$LOG_FILE" 2>&1 &
    LOG_PID=$!
    echo -e "${GREEN}✓ Android logs being captured to: $LOG_FILE${NC}"
    echo "Press Ctrl+C to stop log capture"
    wait $LOG_PID
  fi
}

# Function to generate test report
generate_test_report() {
  echo ""
  echo "======================================"
  echo "Generating Test Report"
  echo "======================================"
  echo ""
  
  TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
  REPORT_DIR="$(dirname "$0")/../test-reports"
  mkdir -p "$REPORT_DIR"
  REPORT_FILE="$REPORT_DIR/test_report_${TIMESTAMP}.md"
  
  cat > "$REPORT_FILE" << EOF
# VPP Mobile App - Device Test Report

**Date:** $(date +"%Y-%m-%d %H:%M:%S")
**Platform:** $PLATFORM
**Tester:** $(whoami)

## Device Information

### iOS Device
- **Model:** _____________
- **OS Version:** _____________
- **Test Status:** ⬜ Pass ⬜ Fail

### Android Device
- **Model:** _____________
- **OS Version:** _____________
- **Test Status:** ⬜ Pass ⬜ Fail

## Test Results

### 1. Camera & QR Scanner
- [ ] QR payment scanning works
- [ ] QR device registration works
- [ ] Camera permissions granted
- [ ] Haptic feedback on scan

**Notes:** _____________

### 2. Haptic Feedback
- [ ] Button press haptics
- [ ] Success action haptics
- [ ] Error action haptics
- [ ] Trading complete haptics
- [ ] Payment complete haptics

**Notes:** _____________

### 3. Native Share
- [ ] Share trading opportunities
- [ ] Share payment receipts
- [ ] Share achievements
- [ ] Share DR events
- [ ] Share P2P offers

**Notes:** _____________

### 4. Push Notifications
- [ ] Notification permissions granted
- [ ] Test notification received
- [ ] Notification tap opens app
- [ ] Notification sound/vibration works

**Notes:** _____________

### 5. Biometric Authentication
- [ ] Face ID/Touch ID/Fingerprint works
- [ ] Biometric prompt displays correctly
- [ ] Fallback to passcode works

**Notes:** _____________

### 6. Offline Functionality
- [ ] Cached data loads offline
- [ ] Offline indicator appears
- [ ] Data syncs when online

**Notes:** _____________

### 7. Performance
- [ ] App launch time < 3 seconds
- [ ] Smooth animations (60 FPS)
- [ ] No crashes or freezes

**Notes:** _____________

## Issues Found

1. **Issue:** _____________
   - **Severity:** ⬜ Critical ⬜ High ⬜ Medium ⬜ Low
   - **Steps to Reproduce:** _____________
   - **Expected:** _____________
   - **Actual:** _____________

## Overall Assessment

⬜ **Ready for Production**
⬜ **Needs Minor Fixes**
⬜ **Needs Major Fixes**

## Next Steps

_____________

EOF

  echo -e "${GREEN}✓ Test report template generated: $REPORT_FILE${NC}"
  echo "Please fill in the test results and submit the report"
}

# Main execution
case $PLATFORM in
  ios)
    run_ios_tests
    generate_test_report
    ;;
  android)
    run_android_tests
    generate_test_report
    ;;
  both)
    run_ios_tests
    echo ""
    run_android_tests
    generate_test_report
    ;;
  *)
    echo -e "${RED}Invalid platform: $PLATFORM${NC}"
    echo "Usage: ./run-device-tests.sh [ios|android|both]"
    exit 1
    ;;
esac

echo ""
echo "======================================"
echo "Device Testing Complete!"
echo "======================================"
echo ""
echo "Next steps:"
echo "1. Complete manual testing using the checklist above"
echo "2. Fill in the test report at: test-reports/"
echo "3. Review logs at: test-logs/"
echo "4. Report any issues found"
echo ""
