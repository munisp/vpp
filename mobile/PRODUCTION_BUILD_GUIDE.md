# VPP Mobile App - Production Build Guide

Complete guide for building and submitting the VPP Consumer Platform mobile app to Apple App Store and Google Play Store using EAS Build.

## Prerequisites

### Required Accounts
- **Expo Account** - Sign up at https://expo.dev
- **Apple Developer Account** - $99/year at https://developer.apple.com
- **Google Play Console Account** - $25 one-time at https://play.google.com/console

### Required Tools
- **EAS CLI** - Install globally: `npm install -g eas-cli`
- **Expo CLI** - Install globally: `npm install -g expo-cli`
- **Node.js** - Version 16 or later
- **Git** - For version control

---

## Initial Setup

### 1. Install EAS CLI

```bash
npm install -g eas-cli
```

### 2. Login to Expo

```bash
eas login
```

Enter your Expo account credentials.

### 3. Configure EAS Build

The project already includes `eas.json` configuration. Review and update the following fields:

```json
{
  "build": {
    "production": {
      "ios": {
        "bundleIdentifier": "com.vpp.consumer",  // Update if needed
        "buildNumber": "1"  // Increment for each build
      },
      "android": {
        "applicationId": "com.vpp.consumer",  // Update if needed
        "versionCode": 1  // Increment for each build
      }
    }
  }
}
```

### 4. Update app.json

Update version and build numbers in `app.json`:

```json
{
  "expo": {
    "version": "1.0.0",
    "ios": {
      "buildNumber": "1",
      "bundleIdentifier": "com.vpp.consumer"
    },
    "android": {
      "versionCode": 1,
      "package": "com.vpp.consumer"
    }
  }
}
```

---

## iOS Production Build

### Step 1: Configure iOS Credentials

```bash
cd /home/ubuntu/vpp_consumer_platform/mobile
eas credentials
```

Select:
- Platform: **iOS**
- Profile: **production**

EAS will guide you through:
- Creating/uploading Distribution Certificate
- Creating/uploading Provisioning Profile
- Registering App Identifier

### Step 2: Build for iOS

```bash
eas build --platform ios --profile production
```

This will:
- Upload your code to EAS Build servers
- Build the iOS app (.ipa file)
- Sign the app with your credentials
- Provide a download link when complete

Build time: ~15-20 minutes

### Step 3: Download and Test

```bash
# Download the .ipa file
eas build:download --platform ios --latest

# Install on physical device via Xcode or TestFlight
```

### Step 4: Submit to App Store

#### Option A: Automatic Submission

```bash
eas submit --platform ios --latest
```

You'll need:
- Apple ID
- App-specific password
- App Store Connect App ID

#### Option B: Manual Submission

1. Download the .ipa file
2. Open **Transporter** app (Mac)
3. Drag and drop the .ipa file
4. Wait for upload to complete
5. Go to App Store Connect
6. Complete app metadata and submit for review

---

## Android Production Build

### Step 1: Configure Android Credentials

```bash
eas credentials
```

Select:
- Platform: **Android**
- Profile: **production**

EAS will guide you through:
- Creating/uploading Keystore
- Setting keystore password
- Setting key alias and password

**Important:** Save your keystore credentials securely. You'll need them for all future updates.

### Step 2: Build for Android

```bash
eas build --platform android --profile production
```

This will:
- Upload your code to EAS Build servers
- Build the Android app bundle (.aab file)
- Sign the app with your keystore
- Provide a download link when complete

Build time: ~10-15 minutes

### Step 3: Download and Test

```bash
# Download the .aab file
eas build:download --platform android --latest

# For testing, build APK instead
eas build --platform android --profile preview
```

### Step 4: Submit to Google Play

#### Option A: Automatic Submission

1. Create a service account in Google Cloud Console
2. Download the JSON key file
3. Save as `google-play-service-account.json` in mobile directory
4. Update `eas.json` with the path

```bash
eas submit --platform android --latest
```

#### Option B: Manual Submission

1. Download the .aab file
2. Go to Google Play Console
3. Select your app
4. Go to **Production** → **Create new release**
5. Upload the .aab file
6. Complete release notes and submit for review

---

## App Store Assets

### iOS App Store

Create the following assets:

#### App Icon
- **1024x1024px** - App Store icon (PNG, no transparency)

#### Screenshots (Required)
- **6.5" iPhone** (1284 x 2778 px) - iPhone 14 Pro Max
- **5.5" iPhone** (1242 x 2208 px) - iPhone 8 Plus
- **12.9" iPad Pro** (2048 x 2732 px) - iPad Pro

Minimum 3 screenshots per device type.

#### App Preview Videos (Optional)
- Up to 3 videos per device type
- 15-30 seconds each
- MP4 or MOV format

### Google Play Store

Create the following assets:

#### App Icon
- **512x512px** - High-res icon (PNG, 32-bit)

#### Feature Graphic
- **1024x500px** - Banner image (JPG or PNG)

#### Screenshots (Required)
- **Phone:** 1080 x 1920 px minimum
- **7" Tablet:** 1200 x 1920 px minimum
- **10" Tablet:** 1920 x 1200 px minimum

Minimum 2 screenshots, maximum 8 per device type.

#### Promo Video (Optional)
- YouTube video URL

---

## App Metadata

### iOS App Store

Complete in **App Store Connect**:

- **App Name:** VPP Consumer Platform
- **Subtitle:** Manage your solar energy and earn rewards
- **Description:**
  ```
  Join the Virtual Power Plant and start earning from your solar energy. 
  The VPP Consumer Platform helps you:
  
  • Monitor real-time energy generation and consumption
  • Trade energy with the grid and other consumers
  • Participate in demand response programs
  • Manage payments via mobile money
  • Track earnings and rewards
  • Register and monitor your solar assets
  
  Features:
  - Real-time energy monitoring with live charts
  - Automatic and manual energy trading
  - Peer-to-peer energy marketplace
  - Demand response event participation
  - Mobile money payments (M-Pesa, Airtel Money, Tigo Pesa)
  - Push notifications for trading and DR events
  - Biometric authentication (Face ID/Touch ID)
  - Offline mode with data synchronization
  - QR code scanning for quick payments and device registration
  
  Start earning from your solar energy today!
  ```

- **Keywords:** solar, energy, VPP, trading, demand response, renewable
- **Support URL:** https://vpp-platform.com/support
- **Privacy Policy URL:** https://vpp-platform.com/privacy
- **Category:** Utilities
- **Age Rating:** 4+

### Google Play Store

Complete in **Google Play Console**:

- **App Name:** VPP Consumer Platform
- **Short Description:** (80 chars max)
  ```
  Manage solar energy, trade power, and earn rewards with VPP Consumer Platform
  ```

- **Full Description:** (4000 chars max)
  ```
  Join the Virtual Power Plant and start earning from your solar energy. 
  The VPP Consumer Platform helps you monitor, trade, and optimize your 
  renewable energy assets.
  
  KEY FEATURES:
  
  ⚡ Real-Time Energy Monitoring
  • Track generation and consumption with live charts
  • Monitor battery charge/discharge rates
  • View grid import/export status
  • Get instant alerts for system issues
  
  💰 Energy Trading
  • Automatic trading with smart algorithms
  • Manual trading for maximum control
  • Peer-to-peer energy marketplace
  • Competitive pricing and instant settlements
  
  📊 Demand Response Programs
  • Participate in grid load reduction events
  • Earn compensation for reducing consumption
  • Flexible participation options
  • Real-time event notifications
  
  💳 Mobile Money Integration
  • M-Pesa payments
  • Airtel Money support
  • Tigo Pesa integration
  • Instant payment confirmations
  
  🔐 Security & Privacy
  • Biometric authentication (fingerprint/face)
  • Secure payment processing
  • End-to-end encryption
  • Privacy-focused design
  
  📱 Mobile-First Experience
  • Offline mode with data sync
  • Push notifications
  • QR code scanning
  • Native share functionality
  • Haptic feedback
  
  🏆 Gamification & Rewards
  • Achievement badges
  • Leaderboard rankings
  • Monthly rewards
  • Performance tracking
  
  WHY CHOOSE VPP CONSUMER PLATFORM?
  
  • Maximize earnings from your solar investment
  • Contribute to grid stability
  • Reduce energy costs
  • Support renewable energy adoption
  • Join a community of solar prosumers
  
  REQUIREMENTS:
  
  • Solar panels or battery storage system
  • Smart meter or energy monitoring device
  • Internet connection
  • Mobile money account (for payments)
  
  SUPPORT:
  
  Need help? Contact our support team at support@vpp-platform.com
  Visit https://vpp-platform.com for more information
  
  Start earning from your solar energy today!
  ```

- **Category:** Tools
- **Content Rating:** Everyone
- **Privacy Policy URL:** https://vpp-platform.com/privacy

---

## Version Management

### Incrementing Versions

For each new release, increment version numbers:

#### iOS
```json
// app.json
{
  "expo": {
    "version": "1.0.1",  // Semantic version
    "ios": {
      "buildNumber": "2"  // Integer, increment by 1
    }
  }
}

// eas.json
{
  "build": {
    "production": {
      "ios": {
        "buildNumber": "2"
      }
    }
  }
}
```

#### Android
```json
// app.json
{
  "expo": {
    "version": "1.0.1",  // Semantic version
    "android": {
      "versionCode": 2  // Integer, increment by 1
    }
  }
}

// eas.json
{
  "build": {
    "production": {
      "android": {
        "versionCode": 2
      }
    }
  }
}
```

### Semantic Versioning

Follow semantic versioning (MAJOR.MINOR.PATCH):

- **MAJOR** (1.x.x) - Breaking changes
- **MINOR** (x.1.x) - New features, backwards compatible
- **PATCH** (x.x.1) - Bug fixes, backwards compatible

Examples:
- `1.0.0` - Initial release
- `1.0.1` - Bug fix release
- `1.1.0` - New feature release
- `2.0.0` - Major update with breaking changes

---

## Build Commands Reference

### Development Builds

```bash
# iOS development build
eas build --platform ios --profile development

# Android development build
eas build --platform android --profile development

# Both platforms
eas build --platform all --profile development
```

### Preview Builds

```bash
# iOS preview (TestFlight)
eas build --platform ios --profile preview

# Android preview (APK)
eas build --platform android --profile preview
```

### Production Builds

```bash
# iOS production
eas build --platform ios --profile production

# Android production
eas build --platform android --profile production

# Both platforms
eas build --platform all --profile production
```

### Submit to Stores

```bash
# Submit latest iOS build
eas submit --platform ios --latest

# Submit latest Android build
eas submit --platform android --latest

# Submit specific build
eas submit --platform ios --id <build-id>
```

### Check Build Status

```bash
# List all builds
eas build:list

# View specific build
eas build:view <build-id>

# Download build
eas build:download --platform ios --latest
```

---

## Troubleshooting

### iOS Build Failures

**Issue:** Code signing error
```
Solution: Run `eas credentials` and regenerate certificates
```

**Issue:** Bundle identifier mismatch
```
Solution: Ensure bundle ID matches in app.json, eas.json, and App Store Connect
```

**Issue:** Provisioning profile invalid
```
Solution: Regenerate provisioning profile with `eas credentials`
```

### Android Build Failures

**Issue:** Keystore error
```
Solution: Run `eas credentials` and regenerate keystore
```

**Issue:** Gradle build failure
```
Solution: Check build logs, may need to update dependencies
```

**Issue:** Application ID mismatch
```
Solution: Ensure package name matches in app.json, eas.json, and Google Play Console
```

### Common Issues

**Issue:** Build takes too long
```
Solution: Use `--no-wait` flag to queue build and check later
```

**Issue:** Out of build credits
```
Solution: Upgrade Expo plan or wait for monthly reset
```

**Issue:** Environment variables not set
```
Solution: Add secrets with `eas secret:create` or use .env files
```

---

## CI/CD Integration

### GitHub Actions

Create `.github/workflows/eas-build.yml`:

```yaml
name: EAS Build

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - uses: actions/setup-node@v3
        with:
          node-version: 18
          
      - name: Setup Expo
        uses: expo/expo-github-action@v8
        with:
          expo-version: latest
          eas-version: latest
          token: ${{ secrets.EXPO_TOKEN }}
          
      - name: Install dependencies
        run: cd mobile && npm install
        
      - name: Build iOS
        run: cd mobile && eas build --platform ios --profile production --non-interactive --no-wait
        
      - name: Build Android
        run: cd mobile && eas build --platform android --profile production --non-interactive --no-wait
```

---

## Best Practices

### Before Building

1. ✅ Test thoroughly on physical devices
2. ✅ Update version numbers
3. ✅ Update changelog
4. ✅ Review app metadata
5. ✅ Prepare screenshots and assets
6. ✅ Test payment flows
7. ✅ Verify API endpoints
8. ✅ Check environment variables

### After Building

1. ✅ Download and test the build
2. ✅ Verify all features work
3. ✅ Test on multiple devices
4. ✅ Check crash reports
5. ✅ Monitor analytics
6. ✅ Respond to user feedback
7. ✅ Plan next release

### Security

1. 🔒 Never commit credentials to Git
2. 🔒 Use EAS Secrets for sensitive data
3. 🔒 Keep keystore backups secure
4. 🔒 Use strong passwords
5. 🔒 Enable 2FA on all accounts
6. 🔒 Review permissions regularly
7. 🔒 Monitor security alerts

---

## Resources

- **EAS Build Documentation:** https://docs.expo.dev/build/introduction/
- **App Store Review Guidelines:** https://developer.apple.com/app-store/review/guidelines/
- **Google Play Policy:** https://play.google.com/about/developer-content-policy/
- **Expo Forums:** https://forums.expo.dev/
- **EAS Build Status:** https://status.expo.dev/

---

## Support

For build issues:
- Check EAS Build logs
- Visit Expo Forums
- Contact Expo support

For app review issues:
- Apple: https://developer.apple.com/contact/
- Google: https://support.google.com/googleplay/android-developer/

---

## Quick Start Checklist

- [ ] Install EAS CLI: `npm install -g eas-cli`
- [ ] Login to Expo: `eas login`
- [ ] Configure credentials: `eas credentials`
- [ ] Update version numbers in app.json
- [ ] Build iOS: `eas build --platform ios --profile production`
- [ ] Build Android: `eas build --platform android --profile production`
- [ ] Test builds on physical devices
- [ ] Prepare app store assets (icons, screenshots)
- [ ] Complete app metadata (descriptions, keywords)
- [ ] Submit iOS: `eas submit --platform ios --latest`
- [ ] Submit Android: `eas submit --platform android --latest`
- [ ] Monitor review status in App Store Connect and Google Play Console
- [ ] Respond to any review feedback
- [ ] Celebrate launch! 🎉

---

**Ready to build?** Run `eas build --platform all --profile production` to start!
