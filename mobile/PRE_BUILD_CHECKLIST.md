# Pre-Build Verification Checklist

Complete this checklist before building production apps for iOS and Android.

---

## Code Quality

### TypeScript
- [ ] No TypeScript errors (`tsc --noEmit`)
- [ ] No ESLint errors (`eslint . --ext .ts,.tsx`)
- [ ] All imports resolved correctly
- [ ] No unused variables or imports
- [ ] Proper type definitions for all functions

### Code Review
- [ ] All features implemented and tested
- [ ] No debug code or console.logs in production
- [ ] No hardcoded credentials or API keys
- [ ] Proper error handling throughout
- [ ] Code follows project conventions

---

## Configuration

### App Configuration
- [ ] App name correct in `app.json`
- [ ] Bundle ID/Package name correct
- [ ] Version number updated
- [ ] Build number incremented
- [ ] App icon configured (1024x1024)
- [ ] Splash screen configured

### Environment Variables
- [ ] All required env vars set
- [ ] Firebase configuration added
- [ ] API endpoints correct for production
- [ ] VAPID keys configured
- [ ] No development URLs in production

### Permissions
- [ ] Camera permission configured
- [ ] Notification permission configured
- [ ] Location permission configured (if needed)
- [ ] Biometric permission configured
- [ ] All permissions have usage descriptions

---

## Dependencies

### Package Management
- [ ] All dependencies up to date
- [ ] No security vulnerabilities (`npm audit`)
- [ ] Lock file committed
- [ ] No unnecessary dependencies
- [ ] Native dependencies linked properly

### iOS Specific
- [ ] Pods installed (`cd ios && pod install`)
- [ ] GoogleService-Info.plist in place
- [ ] Signing certificates configured
- [ ] Provisioning profiles valid

### Android Specific
- [ ] google-services.json in place
- [ ] Keystore configured
- [ ] Signing config in build.gradle
- [ ] ProGuard rules configured (if enabled)

---

## Features Testing

### Core Features
- [ ] Dashboard loads correctly
- [ ] Asset registration works
- [ ] Energy monitoring displays data
- [ ] Trading functionality works
- [ ] Payment processing successful
- [ ] DR participation functional
- [ ] Gamification features work
- [ ] P2P trading operational

### Native Features
- [ ] Camera QR scanner works
- [ ] Haptic feedback functional
- [ ] Native share works
- [ ] Push notifications received
- [ ] Biometric auth works
- [ ] Offline mode functional

### User Experience
- [ ] App launches quickly
- [ ] No crashes or freezes
- [ ] Smooth animations
- [ ] Proper loading states
- [ ] Error messages clear
- [ ] Navigation intuitive

---

## Performance

### App Performance
- [ ] App size under 50MB (uncompressed)
- [ ] Launch time under 3 seconds
- [ ] No memory leaks
- [ ] Smooth scrolling (60fps)
- [ ] Battery usage acceptable

### Network Performance
- [ ] API calls optimized
- [ ] Images compressed
- [ ] Caching implemented
- [ ] Offline support works
- [ ] Network errors handled

---

## Security

### Data Security
- [ ] Sensitive data encrypted
- [ ] Secure storage used
- [ ] No data leaks
- [ ] HTTPS enforced
- [ ] Certificate pinning (if required)

### Authentication
- [ ] OAuth flow secure
- [ ] Tokens stored securely
- [ ] Session management proper
- [ ] Biometric auth secure
- [ ] Logout clears data

### API Security
- [ ] API keys not exposed
- [ ] Request signing implemented
- [ ] Rate limiting handled
- [ ] Input validation proper
- [ ] XSS/CSRF protection

---

## Compliance

### Privacy
- [ ] Privacy policy included
- [ ] Data collection disclosed
- [ ] User consent obtained
- [ ] GDPR compliant
- [ ] CCPA compliant

### App Store Guidelines
- [ ] iOS Human Interface Guidelines followed
- [ ] Android Material Design followed
- [ ] No prohibited content
- [ ] Age rating appropriate
- [ ] Metadata accurate

---

## Documentation

### User Documentation
- [ ] README updated
- [ ] User guide available
- [ ] Feature documentation complete
- [ ] FAQ created
- [ ] Support contact provided

### Developer Documentation
- [ ] Setup instructions clear
- [ ] API documentation complete
- [ ] Architecture documented
- [ ] Deployment guide ready
- [ ] Troubleshooting guide available

---

## App Store Preparation

### iOS App Store
- [ ] App Store Connect account ready
- [ ] App created in App Store Connect
- [ ] Screenshots prepared (all sizes)
- [ ] App description written
- [ ] Keywords optimized
- [ ] Privacy policy URL provided
- [ ] Support URL provided
- [ ] Marketing URL provided (optional)
- [ ] App review information complete

### Google Play Store
- [ ] Google Play Console account ready
- [ ] App created in Play Console
- [ ] Screenshots prepared (all sizes)
- [ ] Feature graphic created
- [ ] App description written
- [ ] Keywords optimized
- [ ] Privacy policy URL provided
- [ ] Content rating completed
- [ ] Pricing & distribution set

---

## Build Preparation

### iOS Build
- [ ] Xcode version correct (latest stable)
- [ ] iOS deployment target set (iOS 13+)
- [ ] Signing & Capabilities configured
- [ ] Archive scheme set to Release
- [ ] Bitcode enabled (if required)
- [ ] App Thinning enabled

### Android Build
- [ ] Android SDK version correct
- [ ] minSdkVersion set (21+)
- [ ] targetSdkVersion set (latest)
- [ ] Build type set to release
- [ ] ProGuard/R8 configured
- [ ] APK/AAB format selected (AAB for Play Store)

---

## Testing

### Manual Testing
- [ ] Tested on iOS device
- [ ] Tested on Android device
- [ ] Tested on multiple screen sizes
- [ ] Tested on different OS versions
- [ ] Tested with poor network
- [ ] Tested in offline mode

### Automated Testing
- [ ] Unit tests passing
- [ ] Integration tests passing
- [ ] E2E tests passing (if available)
- [ ] Performance tests passing
- [ ] Security tests passing

---

## Release Notes

### Version Information
- [ ] Version number: ___________
- [ ] Build number: ___________
- [ ] Release date: ___________

### What's New
- [ ] New features listed
- [ ] Bug fixes listed
- [ ] Improvements listed
- [ ] Breaking changes noted (if any)

### Known Issues
- [ ] Known issues documented
- [ ] Workarounds provided
- [ ] Fix timeline communicated

---

## Backup & Rollback

### Backup
- [ ] Code committed to Git
- [ ] Tags created for release
- [ ] Previous version backed up
- [ ] Database schema backed up
- [ ] Configuration backed up

### Rollback Plan
- [ ] Rollback procedure documented
- [ ] Previous version available
- [ ] Rollback tested
- [ ] Communication plan ready

---

## Post-Build Verification

### Build Verification
- [ ] Build completed successfully
- [ ] No build warnings
- [ ] App size acceptable
- [ ] All assets included
- [ ] Signing correct

### Installation Testing
- [ ] App installs successfully
- [ ] App launches correctly
- [ ] No crashes on launch
- [ ] All features work
- [ ] Performance acceptable

---

## Submission Checklist

### iOS Submission
- [ ] Build uploaded to App Store Connect
- [ ] Build processed successfully
- [ ] TestFlight testing complete
- [ ] App review information complete
- [ ] Submit for review clicked

### Android Submission
- [ ] Build uploaded to Play Console
- [ ] Internal testing complete
- [ ] Closed testing complete (optional)
- [ ] Open testing complete (optional)
- [ ] Production release created

---

## Final Checks

- [ ] All checklist items completed
- [ ] Team reviewed and approved
- [ ] Stakeholders notified
- [ ] Support team prepared
- [ ] Monitoring configured
- [ ] Ready for production release

---

## Sign-off

**Developer:** _____________________ Date: __________

**QA Lead:** _____________________ Date: __________

**Project Manager:** _____________________ Date: __________

**Technical Lead:** _____________________ Date: __________

---

**Notes:**

_Add any additional notes or comments here._

---

**Checklist Version:** 1.0  
**Last Updated:** $(date +"%Y-%m-%d")
