# EAS Build Credentials Setup Guide

Complete guide for setting up app signing credentials for iOS and Android production builds using EAS Build.

---

## Prerequisites

- **EAS CLI** installed: `npm install -g eas-cli`
- **Expo account** with appropriate permissions
- **Apple Developer Account** ($99/year) for iOS
- **Google Play Console Account** ($25 one-time) for Android

---

## iOS Credentials Setup

### Step 1: Login to EAS

```bash
cd /home/ubuntu/vpp_consumer_platform/mobile
eas login
```

Enter your Expo account credentials.

### Step 2: Configure iOS Credentials

```bash
eas credentials
```

Select:
- **Platform:** iOS
- **Profile:** production

### Step 3: Choose Credential Management Option

EAS will present several options:

#### Option A: Let EAS Manage Everything (Recommended)

This is the easiest option. EAS will:
- Create a Distribution Certificate
- Create a Provisioning Profile
- Register your App Identifier
- Store everything securely

Select: **"Set up a new iOS Distribution Certificate"**

EAS will guide you through:
1. Connecting to your Apple Developer account
2. Creating the certificate
3. Creating the provisioning profile
4. Registering the bundle identifier

#### Option B: Use Existing Credentials

If you already have credentials:

1. Select **"Use existing Distribution Certificate"**
2. Provide the certificate (.p12 file)
3. Provide the certificate password
4. Provide the provisioning profile (.mobileprovision file)

#### Option C: Manual Setup

1. Go to [Apple Developer Portal](https://developer.apple.com/account/)
2. Create a Distribution Certificate:
   - Certificates, Identifiers & Profiles → Certificates → +
   - Select "iOS Distribution (App Store and Ad Hoc)"
   - Generate CSR on your Mac (Keychain Access)
   - Upload CSR and download certificate
   - Export as .p12 with password

3. Register App Identifier:
   - Identifiers → App IDs → +
   - Bundle ID: `com.vpp.consumer`
   - Capabilities: Push Notifications, Sign in with Apple (if needed)

4. Create Provisioning Profile:
   - Profiles → Distribution → +
   - Select "App Store"
   - Select your App ID
   - Select your Distribution Certificate
   - Download the profile

5. Upload to EAS:
   ```bash
   eas credentials
   ```
   - Select "Upload existing credentials"
   - Provide certificate (.p12) and password
   - Provide provisioning profile (.mobileprovision)

### Step 4: Verify iOS Credentials

```bash
eas credentials --platform ios
```

You should see:
- ✓ Distribution Certificate
- ✓ Provisioning Profile
- ✓ App Identifier registered

### Step 5: Update eas.json

Ensure your `eas.json` has the correct bundle identifier:

```json
{
  "build": {
    "production": {
      "ios": {
        "bundleIdentifier": "com.vpp.consumer",
        "buildNumber": "1"
      }
    }
  }
}
```

---

## Android Credentials Setup

### Step 1: Configure Android Credentials

```bash
eas credentials
```

Select:
- **Platform:** Android
- **Profile:** production

### Step 2: Choose Keystore Management Option

#### Option A: Let EAS Generate Keystore (Recommended for New Apps)

This is the easiest option. EAS will:
- Generate a new keystore
- Store it securely
- Use it for all future builds

Select: **"Generate new keystore"**

EAS will ask for:
- **Keystore password** (choose a strong password)
- **Key alias** (e.g., "vpp-consumer-key")
- **Key password** (can be same as keystore password)

**IMPORTANT:** Save these credentials securely. You'll need them for all future updates.

#### Option B: Use Existing Keystore

If you already have a keystore:

1. Select **"Upload existing keystore"**
2. Provide the keystore file (.jks or .keystore)
3. Provide the keystore password
4. Provide the key alias
5. Provide the key password

#### Option C: Manual Keystore Generation

1. Generate keystore manually:
   ```bash
   keytool -genkeypair -v \
     -storetype PKCS12 \
     -keystore vpp-consumer.keystore \
     -alias vpp-consumer-key \
     -keyalg RSA \
     -keysize 2048 \
     -validity 10000
   ```

2. Answer the prompts:
   - Keystore password: (choose strong password)
   - Key password: (can be same as keystore)
   - First and last name: VPP Platform
   - Organizational unit: Engineering
   - Organization: VPP Consumer Platform
   - City: Dar es Salaam
   - State: Tanzania
   - Country code: TZ

3. Upload to EAS:
   ```bash
   eas credentials
   ```
   - Select "Upload existing keystore"
   - Provide keystore file
   - Provide passwords and alias

### Step 3: Verify Android Credentials

```bash
eas credentials --platform android
```

You should see:
- ✓ Keystore
- ✓ Key alias
- ✓ Keystore password (hidden)
- ✓ Key password (hidden)

### Step 4: Update eas.json

Ensure your `eas.json` has the correct package name:

```json
{
  "build": {
    "production": {
      "android": {
        "applicationId": "com.vpp.consumer",
        "versionCode": 1
      }
    }
  }
}
```

---

## Credential Backup

### iOS Credentials Backup

1. Download credentials:
   ```bash
   eas credentials --platform ios
   ```
   Select "Download credentials"

2. Store securely:
   - Distribution Certificate (.p12)
   - Provisioning Profile (.mobileprovision)
   - Certificate password

3. Backup locations:
   - Password manager (1Password, LastPass)
   - Encrypted cloud storage
   - Secure company vault

### Android Credentials Backup

1. Download keystore:
   ```bash
   eas credentials --platform android
   ```
   Select "Download keystore"

2. Store securely:
   - Keystore file (.keystore or .jks)
   - Keystore password
   - Key alias
   - Key password

3. Backup locations:
   - Password manager
   - Encrypted cloud storage
   - Secure company vault
   - Multiple physical locations

**CRITICAL:** If you lose your Android keystore, you cannot update your app. You'll need to publish a new app with a different package name.

---

## Environment Variables

### iOS Environment Variables

Add to your `.env` file (DO NOT commit to Git):

```bash
# iOS Signing
APPLE_ID=your-apple-id@example.com
APPLE_TEAM_ID=XXXXXXXXXX
APPLE_APP_ID=1234567890

# App Store Connect API (optional, for automated submission)
APPLE_KEY_ID=XXXXXXXXXX
APPLE_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
APPLE_KEY_CONTENT=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----
```

### Android Environment Variables

Add to your `.env` file (DO NOT commit to Git):

```bash
# Android Signing
ANDROID_KEYSTORE_PASSWORD=your-keystore-password
ANDROID_KEY_ALIAS=vpp-consumer-key
ANDROID_KEY_PASSWORD=your-key-password

# Google Play Service Account (optional, for automated submission)
GOOGLE_PLAY_SERVICE_ACCOUNT_KEY_PATH=./google-play-service-account.json
```

---

## Testing Credentials

### Test iOS Build

```bash
eas build --platform ios --profile production --no-wait
```

Check build logs for:
- ✓ Certificate found
- ✓ Provisioning profile found
- ✓ Code signing successful

### Test Android Build

```bash
eas build --platform android --profile production --no-wait
```

Check build logs for:
- ✓ Keystore found
- ✓ Signing configuration applied
- ✓ APK/AAB signed successfully

---

## Troubleshooting

### iOS Issues

**Issue:** "No valid code signing identity found"
```
Solution:
1. Run: eas credentials --platform ios
2. Select "Remove all credentials"
3. Run: eas credentials again
4. Select "Set up a new iOS Distribution Certificate"
```

**Issue:** "Provisioning profile doesn't include signing certificate"
```
Solution:
1. Regenerate provisioning profile
2. Ensure certificate is selected in profile
3. Re-download and upload to EAS
```

**Issue:** "Bundle identifier mismatch"
```
Solution:
1. Check app.json: "ios.bundleIdentifier"
2. Check eas.json: "ios.bundleIdentifier"
3. Check Apple Developer Portal: App ID
4. Ensure all three match exactly
```

### Android Issues

**Issue:** "Keystore password incorrect"
```
Solution:
1. Verify password is correct
2. Re-upload keystore with correct password
3. If password lost, must generate new keystore (new app)
```

**Issue:** "Key alias not found"
```
Solution:
1. List aliases: keytool -list -keystore your-keystore.jks
2. Use correct alias name
3. Re-upload with correct alias
```

**Issue:** "Package name mismatch"
```
Solution:
1. Check app.json: "android.package"
2. Check eas.json: "android.applicationId"
3. Check Google Play Console: Package name
4. Ensure all three match exactly
```

---

## Security Best Practices

### General
- ✅ Never commit credentials to Git
- ✅ Use `.gitignore` for credential files
- ✅ Use EAS Secrets for sensitive data
- ✅ Enable 2FA on all accounts
- ✅ Use strong, unique passwords
- ✅ Rotate credentials periodically
- ✅ Limit access to credentials
- ✅ Monitor credential usage

### iOS Specific
- ✅ Revoke old certificates when creating new ones
- ✅ Review provisioning profiles regularly
- ✅ Remove unused devices from profiles
- ✅ Use App Store Connect API keys for automation

### Android Specific
- ✅ Backup keystore in multiple locations
- ✅ Use strong keystore passwords (20+ characters)
- ✅ Never share keystore publicly
- ✅ Use Google Play App Signing (recommended)

---

## Google Play App Signing (Recommended)

Google Play App Signing provides additional security and flexibility:

### Benefits
- Google manages your app signing key
- You can reset your upload key if compromised
- Optimized APKs for different devices
- Easier key management

### Setup

1. **First Build:**
   - Build and upload your first APK/AAB to Google Play Console
   - Google will prompt you to enroll in App Signing

2. **Enroll:**
   - Select "Continue" to let Google manage your app signing key
   - Google generates a new app signing key
   - Your upload key is used only for uploads

3. **Download Certificates:**
   - Download the app signing certificate
   - Store it securely for reference

4. **Future Builds:**
   - Continue using your upload key (keystore)
   - Google signs the final APK with the app signing key

### Migration (Existing App)

If you already have an app published:

1. Go to Google Play Console → Setup → App signing
2. Select "Use Google Play App Signing"
3. Upload your existing keystore (becomes upload key)
4. Google generates new app signing key
5. Update your app with new upload key

---

## Credential Rotation

### When to Rotate

- Security breach or suspected compromise
- Employee departure with credential access
- Compliance requirements
- Regular security audits (annually)

### iOS Rotation

1. Revoke old certificate in Apple Developer Portal
2. Generate new certificate
3. Create new provisioning profile
4. Upload to EAS
5. Test build with new credentials
6. Update backup storage

### Android Rotation

**Upload Key Rotation (with Google Play App Signing):**
1. Generate new keystore
2. Request upload key reset in Google Play Console
3. Upload new public certificate
4. Update EAS credentials
5. Test build

**App Signing Key Rotation (complex, avoid if possible):**
- Contact Google Play support
- Requires strong justification
- May take several weeks

---

## Quick Reference

### Check Current Credentials

```bash
# iOS
eas credentials --platform ios

# Android
eas credentials --platform android
```

### Remove Credentials

```bash
# iOS
eas credentials --platform ios
# Select "Remove all credentials"

# Android
eas credentials --platform android
# Select "Remove keystore"
```

### Download Credentials

```bash
# iOS
eas credentials --platform ios
# Select "Download credentials"

# Android
eas credentials --platform android
# Select "Download keystore"
```

### Upload Credentials

```bash
# iOS
eas credentials --platform ios
# Select "Upload existing credentials"

# Android
eas credentials --platform android
# Select "Upload existing keystore"
```

---

## Support

- **EAS Build Docs:** https://docs.expo.dev/build/introduction/
- **iOS Code Signing:** https://docs.expo.dev/app-signing/app-credentials/
- **Android App Signing:** https://docs.expo.dev/app-signing/android-credentials/
- **Expo Forums:** https://forums.expo.dev/
- **Apple Developer Support:** https://developer.apple.com/support/
- **Google Play Support:** https://support.google.com/googleplay/android-developer/

---

## Checklist

### iOS Setup
- [ ] EAS CLI installed
- [ ] Logged into EAS
- [ ] Apple Developer account active
- [ ] Distribution certificate created
- [ ] Provisioning profile created
- [ ] App identifier registered
- [ ] Bundle ID matches in all configs
- [ ] Credentials uploaded to EAS
- [ ] Test build successful
- [ ] Credentials backed up securely

### Android Setup
- [ ] EAS CLI installed
- [ ] Logged into EAS
- [ ] Google Play Console account active
- [ ] Keystore generated
- [ ] Keystore password saved
- [ ] Key alias saved
- [ ] Key password saved
- [ ] Package name matches in all configs
- [ ] Credentials uploaded to EAS
- [ ] Test build successful
- [ ] Keystore backed up in multiple locations
- [ ] Google Play App Signing enrolled (recommended)

---

**Ready to set up credentials?** Run `eas credentials` to start!
