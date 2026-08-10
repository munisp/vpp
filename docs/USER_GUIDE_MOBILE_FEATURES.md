# VPP Platform Mobile Features User Guide

## Table of Contents

1. [Push Notifications](#push-notifications)
2. [QR Code Scanner](#qr-code-scanner)
3. [Progressive Web App (PWA)](#progressive-web-app-pwa)
4. [Biometric Authentication](#biometric-authentication)
5. [Offline Mode](#offline-mode)
6. [Troubleshooting](#troubleshooting)

---

## Push Notifications

Stay updated with real-time alerts for trading, payments, and demand response events.

### Enabling Push Notifications

1. Navigate to **Settings** → **Notifications** or visit `/notifications`
2. Click the toggle next to "Enable Push Notifications"
3. Grant permission when your browser asks
4. You're all set! You'll now receive notifications

### Notification Types

The platform sends notifications for:

- **Trading Alerts**: Price changes, trade confirmations, market updates
- **Payment Notifications**: Payment confirmations, billing updates, transaction alerts
- **Demand Response Events**: DR event invitations, participation confirmations, rewards
- **System Alerts**: Device status, maintenance notifications, important updates

### Managing Notification Preferences

1. Go to **Notifications** page
2. Toggle individual notification types on/off
3. Changes are saved automatically
4. You can disable all notifications using the main toggle

### Testing Notifications

To verify notifications are working:

1. Go to **Notifications** page
2. Ensure notifications are enabled
3. Click "Send Test Notification"
4. You should receive a test notification immediately

### Disabling Notifications

**Temporarily:**
1. Go to **Notifications** page
2. Toggle off "Enable Push Notifications"

**Permanently:**
1. Open browser settings
2. Find site permissions for VPP Platform
3. Block notifications

### Multi-Device Support

- Notifications work across all your devices
- Enable on each device separately
- View active device count in Notifications settings
- Notifications sync automatically

---

## QR Code Scanner

Quickly process payments and register devices using your camera.

### QR Payment

**How to Make a Payment:**

1. Navigate to **Payments** → **QR Payment** or visit `/qr-payment`
2. Click "Scan QR Code"
3. Grant camera permission if prompted
4. Point your camera at the payment QR code
5. Review payment details
6. Click "Confirm Payment"

**Supported QR Codes:**
- VPP payment codes from other users
- Merchant payment codes
- Invoice QR codes
- Energy trading payment codes

**Security Tips:**
- Always verify the payment amount before confirming
- Check the recipient name matches who you're paying
- QR payments are processed immediately and cannot be reversed
- Never scan QR codes from untrusted sources

### QR Device Registration

**How to Register a Device:**

1. Navigate to **Assets** → **QR Registration** or visit `/qr-device`
2. Click "Scan Device QR Code"
3. Grant camera permission if prompted
4. Point your camera at the device QR code (usually on the device label)
5. Review and edit device details if needed
6. Click "Register Device"
7. Wait for admin approval

**Supported Devices:**
- Solar panels with QR identification
- Battery storage systems
- Smart inverters
- IoT energy meters

**After Registration:**
- Your device will be marked as "Pending"
- An administrator will verify and approve your device
- You'll receive a notification when approved
- Approved devices can participate in trading and DR programs

### Camera Permissions

**Granting Permission:**
- Click "Allow" when prompted
- Permission is required only once per device
- You can revoke permission in browser settings

**Troubleshooting Camera Access:**
- Ensure HTTPS is enabled (required for camera access)
- Check browser permissions for VPP Platform
- Try refreshing the page
- Restart your browser if issues persist

---

## Progressive Web App (PWA)

Install the VPP Platform as an app on your device for a native-like experience.

### Installing the App

**On Desktop (Chrome/Edge):**
1. Look for the install icon in the address bar
2. Click "Install VPP Platform"
3. The app will open in its own window
4. Access from your desktop or start menu

**On Mobile (Chrome/Safari):**
1. Tap the share/menu button
2. Select "Add to Home Screen"
3. Tap "Add"
4. The app icon appears on your home screen

**Benefits of Installing:**
- Faster loading times
- Works offline
- Native-like experience
- Push notifications even when closed
- No browser UI clutter

### Offline Mode

The PWA works offline for many features:

**Available Offline:**
- View your assets and devices
- Check trading history
- Review payment history
- View demand response events
- Access settings

**Requires Internet:**
- Making new trades
- Processing payments
- Registering new devices
- Receiving real-time updates

**Offline Indicator:**
- A notification appears when you go offline
- Data syncs automatically when back online
- Unsaved changes are preserved

### App Updates

The app updates automatically:
- Updates download in the background
- You'll see a notification when an update is ready
- Click "Reload" to apply the update
- No manual updates needed

---

## Biometric Authentication

Use your fingerprint or face to log in quickly and securely.

### Setting Up Biometric Login

1. Navigate to **Settings** → **Security**
2. Click "Enable Biometric Authentication"
3. Follow the prompts to register your biometric
4. Your device will ask for fingerprint/face scan
5. Biometric login is now enabled

### Using Biometric Login

1. Open the VPP Platform
2. Click "Login with Biometrics"
3. Authenticate with your fingerprint or face
4. You're logged in!

### Supported Methods

- **Touch ID** (Mac, iPhone, iPad)
- **Face ID** (iPhone, iPad)
- **Windows Hello** (Windows 10/11)
- **Fingerprint sensors** (Android, laptops)

### Security

- Biometric data never leaves your device
- Stored securely in your device's secure enclave
- Cannot be accessed by the platform or third parties
- You can disable anytime in settings

### Disabling Biometric Login

1. Go to **Settings** → **Security**
2. Click "Disable Biometric Authentication"
3. Confirm the action
4. You'll need to use password login again

---

## Troubleshooting

### Push Notifications Not Working

**Check these:**
1. Notifications are enabled in app settings
2. Browser notifications are allowed
3. Device notifications are not in Do Not Disturb mode
4. HTTPS is enabled (required for notifications)
5. Service worker is registered (check browser console)

**Still not working?**
- Try unsubscribing and re-subscribing
- Clear browser cache and reload
- Check browser notification settings
- Contact support if issue persists

### QR Scanner Not Working

**Common issues:**
1. Camera permission not granted
2. Poor lighting conditions
3. QR code is damaged or unclear
4. Wrong QR code format

**Solutions:**
- Grant camera permission in browser settings
- Improve lighting or move to brighter area
- Clean camera lens
- Hold device steady
- Try scanning from different angle
- Ensure QR code is fully visible in frame

### App Not Installing

**Desktop:**
- Ensure you're using Chrome or Edge
- Check if app is already installed
- Try clearing browser cache
- Reload the page

**Mobile:**
- Ensure you're using Chrome (Android) or Safari (iOS)
- Check device storage space
- Try from browser menu instead of prompt
- Restart browser and try again

### Offline Mode Issues

**Data not syncing:**
- Check internet connection
- Reload the app
- Clear browser cache
- Check if service worker is active

**Features not working offline:**
- Some features require internet
- Check the "Available Offline" list above
- Ensure service worker is installed
- Try reinstalling the PWA

### Biometric Authentication Issues

**Not available:**
- Check if device supports biometrics
- Ensure biometrics are set up in device settings
- Use a supported browser (Chrome, Edge, Safari)
- HTTPS is required

**Authentication failing:**
- Re-register your biometric
- Check device biometric settings
- Try using password login instead
- Contact support if issue persists

---

## Support

Need help? We're here for you:

- **In-App Help**: Click the help icon in the app
- **Email**: support@vpp-platform.com
- **Documentation**: Visit our knowledge base
- **Community**: Join our user forum

---

## Privacy & Security

### Data Collection

We collect:
- Push notification subscriptions
- Device information (for multi-device support)
- Usage analytics (anonymous)

We do NOT collect:
- Biometric data (stays on your device)
- Camera images (processed locally)
- Personal browsing data

### Data Storage

- All data encrypted in transit (HTTPS)
- Push subscriptions stored securely
- Biometric data never leaves your device
- You can delete your data anytime

### Permissions

We request:
- **Notifications**: To send you alerts
- **Camera**: For QR code scanning only
- **Storage**: For offline functionality

You can revoke permissions anytime in browser settings.

---

## Tips & Best Practices

### Notifications

- Enable only the notification types you need
- Test notifications after enabling
- Check notification settings if you stop receiving alerts
- Use Do Not Disturb mode during sleep hours

### QR Scanner

- Ensure good lighting for best results
- Hold device steady while scanning
- Keep QR code flat and fully visible
- Clean camera lens regularly

### PWA

- Install the app for best experience
- Update regularly for new features
- Use offline mode when traveling
- Clear cache if experiencing issues

### Security

- Enable biometric login for convenience
- Never share your login credentials
- Log out on shared devices
- Review active devices regularly

---

*Last updated: November 2024*
