# VAPID Keys Setup for Push Notifications

## Generated VAPID Keys

**IMPORTANT:** These keys are for development/testing only. Generate new keys for production deployment.

### Public Key
```
BHp1W3pCt-6VO3GVBIn-6rbu1_DfiQFzFQLtYWoySUXsQ0OHGz5uuhpEayTCDVJIyxLO6OaIxRW904_W_OmgcRE
```

### Private Key
```
HAwmx4AzefsRJ_oyaDlO6p0SkQqCLbvbhiOq1C0C7ZI
```

## Environment Variables Configuration

Add these environment variables to your deployment:

### Backend (Server-side)
```bash
VAPID_PUBLIC_KEY=BHp1W3pCt-6VO3GVBIn-6rbu1_DfiQFzFQLtYWoySUXsQ0OHGz5uuhpEayTCDVJIyxLO6OaIxRW904_W_OmgcRE
VAPID_PRIVATE_KEY=HAwmx4AzefsRJ_oyaDlO6p0SkQqCLbvbhiOq1C0C7ZI
VAPID_SUBJECT=mailto:admin@vpp-platform.com
```

### Frontend (Client-side)
```bash
VITE_VAPID_PUBLIC_KEY=BHp1W3pCt-6VO3GVBIn-6rbu1_DfiQFzFQLtYWoySUXsQ0OHGz5uuhpEayTCDVJIyxLO6OaIxRW904_W_OmgcRE
```

## Setup Instructions

### 1. Add to Manus Management UI

1. Open the Manus Management Dashboard
2. Navigate to **Settings** → **Secrets**
3. Add the following secrets:
   - `VAPID_PUBLIC_KEY`: (public key above)
   - `VAPID_PRIVATE_KEY`: (private key above)
   - `VAPID_SUBJECT`: `mailto:your-email@domain.com`
   - `VITE_VAPID_PUBLIC_KEY`: (same as public key)

### 2. Verify Configuration

After adding the environment variables, restart the application and verify:

```bash
# Check if VAPID keys are loaded
curl http://localhost:3000/api/trpc/notifications.getVapidPublicKey

# Should return:
# {"result":{"data":"BHp1W3pCt-6VO3GVBIn-6rbu1_DfiQFzFQLtYWoySUXsQ0OHGz5uuhpEayTCDVJIyxLO6OaIxRW904_W_OmgcRE"}}
```

### 3. Test Push Notifications

1. Navigate to `/notifications` in the application
2. Click "Enable Push Notifications"
3. Grant permission when prompted
4. Click "Send Test Notification"
5. You should receive a test notification

## Production Deployment

### Generate New Keys for Production

**NEVER use development keys in production.** Generate new keys:

```bash
npx web-push generate-vapid-keys
```

### Security Best Practices

1. **Keep Private Key Secret**: Never commit the private key to version control
2. **Use Secrets Manager**: Store keys in AWS Secrets Manager, HashiCorp Vault, or similar
3. **Rotate Keys**: Generate new keys periodically (every 6-12 months)
4. **Monitor Usage**: Track notification delivery rates and errors
5. **Set Subject**: Use a valid mailto: or https: URL for VAPID subject

### Subject Configuration

The VAPID subject should be either:
- `mailto:admin@yourdomain.com` (recommended)
- `https://yourdomain.com`

This allows push services to contact you if there are issues.

## Troubleshooting

### Notifications Not Working

1. **Check Browser Support**: Ensure the browser supports Web Push API
2. **Verify HTTPS**: Push notifications require HTTPS (except localhost)
3. **Check Permissions**: Ensure notification permissions are granted
4. **Validate Keys**: Ensure VAPID keys are correctly configured
5. **Check Console**: Look for errors in browser and server console

### Common Errors

#### "No VAPID keys configured"
- Add VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to environment variables

#### "Invalid VAPID public key"
- Ensure the public key is base64url encoded
- Verify no extra spaces or newlines

#### "Push subscription failed"
- Check if service worker is registered
- Verify HTTPS is enabled
- Check browser notification permissions

## Testing on Different Devices

### Desktop Browsers
- **Chrome/Edge**: Full support
- **Firefox**: Full support
- **Safari**: Supported on macOS 16.4+

### Mobile Browsers
- **Chrome Android**: Full support
- **Firefox Android**: Full support
- **Safari iOS**: Supported on iOS 16.4+
- **Samsung Internet**: Full support

### Testing Checklist

- [ ] Test on Chrome desktop
- [ ] Test on Firefox desktop
- [ ] Test on Safari desktop (macOS 16.4+)
- [ ] Test on Chrome Android
- [ ] Test on Safari iOS (16.4+)
- [ ] Test notification while app is open
- [ ] Test notification while app is closed
- [ ] Test notification while device is locked
- [ ] Test unsubscribe functionality
- [ ] Test re-subscribe functionality

## Monitoring

### Metrics to Track

1. **Subscription Rate**: % of users who enable notifications
2. **Delivery Rate**: % of notifications successfully delivered
3. **Click-Through Rate**: % of notifications clicked
4. **Unsubscribe Rate**: % of users who disable notifications
5. **Error Rate**: % of failed notification sends

### Logging

The notification system logs:
- Subscription events
- Notification sends
- Delivery failures
- Unsubscribe events

Check logs in:
- Server console output
- Application logs directory
- Cloud logging service (if configured)

## Additional Resources

- [Web Push Protocol](https://datatracker.ietf.org/doc/html/rfc8030)
- [VAPID Specification](https://datatracker.ietf.org/doc/html/rfc8292)
- [MDN Web Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
- [web-push Library](https://github.com/web-push-libs/web-push)
