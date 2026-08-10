# Web Share API Integration Guide

## Overview

The VPP Platform integrates the Web Share API to enable native sharing capabilities on mobile and desktop devices. Users can share trading opportunities, payment requests, device referrals, DR events, and achievements directly to other apps.

## Features

### Supported Share Types

1. **Trade Opportunities** - Share energy trading offers with price and capacity details
2. **Payment Requests** - Share payment QR codes and request links
3. **Device Referrals** - Invite others to join VPP with your device setup
4. **DR Events** - Share demand response event invitations with rewards
5. **Achievements** - Celebrate milestones and gamification achievements

### Browser Support

| Browser | Desktop | Mobile | Notes |
|---------|---------|--------|-------|
| Chrome | ✅ 89+ | ✅ 61+ | Full support |
| Edge | ✅ 93+ | ✅ | Full support |
| Safari | ✅ 12.1+ | ✅ 12.2+ | Full support |
| Firefox | ❌ | ✅ 71+ | Mobile only |
| Samsung Internet | N/A | ✅ 8.2+ | Full support |

## Implementation

### Using the Hook

```typescript
import { useWebShare } from '@/hooks/useWebShare';

function MyComponent() {
  const { isSupported, isSharing, share } = useWebShare();

  const handleShare = async () => {
    const success = await share({
      title: 'Check this out!',
      text: 'Amazing content to share',
      url: 'https://vpp-platform.com/page',
    });

    if (success) {
      console.log('Shared successfully');
    }
  };

  if (!isSupported) {
    return null; // Don't show share button
  }

  return (
    <button onClick={handleShare} disabled={isSharing}>
      {isSharing ? 'Sharing...' : 'Share'}
    </button>
  );
}
```

### Using the Share Button Component

```typescript
import { ShareButton } from '@/components/ShareButton';

function MyComponent() {
  return (
    <ShareButton
      title="Trade Opportunity"
      text="Check out this solar trade!"
      url="https://vpp-platform.com/trading"
      variant="outline"
      size="default"
    />
  );
}
```

### Helper Functions

Pre-built helpers for common sharing scenarios:

```typescript
import {
  shareTradeOpportunity,
  sharePaymentRequest,
  shareDeviceReferral,
  shareDREvent,
  shareAchievement,
} from '@/hooks/useWebShare';

// Share a trade
await shareTradeOpportunity('Solar Panel', 0.15, 5000, share);

// Share a payment request
await sharePaymentRequest(100, 'John Doe', 'INV-001', share);

// Share device referral
await shareDeviceReferral('My Solar Array', 'solar', share);

// Share DR event
await shareDREvent('Peak Reduction', 50, '2024-01-15 18:00', share);

// Share achievement
await shareAchievement('Energy Saver', 'Saved 1000 kWh', share);
```

## API Reference

### useWebShare Hook

```typescript
interface UseWebShareReturn {
  isSupported: boolean;      // Whether Web Share API is available
  isSharing: boolean;         // Whether a share is in progress
  share: (data: ShareData) => Promise<boolean>;  // Share function
  canShareFiles: boolean;     // Whether file sharing is supported
}

interface ShareData {
  title?: string;   // Title of the shared content
  text?: string;    // Description text
  url?: string;     // URL to share
  files?: File[];   // Files to share (if supported)
}
```

### ShareButton Component

```typescript
interface ShareButtonProps {
  title?: string;           // Share title
  text?: string;            // Share description
  url?: string;             // Share URL
  variant?: 'default' | 'outline' | 'ghost' | 'secondary';
  size?: 'default' | 'sm' | 'lg' | 'icon';
  className?: string;       // Additional CSS classes
  showIcon?: boolean;       // Show share icon (default: true)
  showText?: boolean;       // Show button text (default: true)
}
```

## Usage Examples

### Trading Page

```typescript
import { ShareButton } from '@/components/ShareButton';
import { useWebShare, shareTradeOpportunity } from '@/hooks/useWebShare';

function TradingCard({ trade }) {
  const { share } = useWebShare();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{trade.assetType} - ${trade.price}/kWh</CardTitle>
      </CardHeader>
      <CardContent>
        <p>Capacity: {trade.quantity}kW</p>
        <ShareButton
          title={`Trade: ${trade.assetType}`}
          text={`${trade.quantity}kW at $${trade.price}/kWh`}
          url={`${window.location.origin}/trading`}
          variant="outline"
        />
      </CardContent>
    </Card>
  );
}
```

### Payment Requests

```typescript
function PaymentRequest({ amount, recipient, reference }) {
  const { share } = useWebShare();

  const handleShare = () => {
    sharePaymentRequest(amount, recipient, reference, share);
  };

  return (
    <Button onClick={handleShare}>
      Share Payment Request
    </Button>
  );
}
```

### Device Referrals

```typescript
function DeviceCard({ device }) {
  const { share } = useWebShare();

  const handleShare = () => {
    shareDeviceReferral(device.name, device.type, share);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{device.name}</CardTitle>
      </CardHeader>
      <CardActions>
        <ShareButton
          title={`Join VPP with ${device.name}`}
          text={`Earning from ${device.type} energy`}
          url={`${window.location.origin}/assets`}
        />
      </CardActions>
    </Card>
  );
}
```

## Best Practices

### 1. Check Support Before Rendering

Always check if the Web Share API is supported before showing share buttons:

```typescript
const { isSupported } = useWebShare();

if (!isSupported) {
  return null; // Or show alternative sharing options
}
```

### 2. Handle User Cancellation

Users can cancel the share dialog. Don't treat this as an error:

```typescript
const success = await share(data);
if (success) {
  // Share completed
} else {
  // User cancelled or error occurred
  // Don't show error toast for cancellation
}
```

### 3. Provide Meaningful Content

Include descriptive titles and text:

```typescript
// ❌ Bad
await share({ url: 'https://example.com' });

// ✅ Good
await share({
  title: 'Solar Trade Opportunity',
  text: 'Check out this 5kW solar panel trade at $0.15/kWh',
  url: 'https://example.com/trading/123',
});
```

### 4. Use Absolute URLs

Always use absolute URLs for sharing:

```typescript
// ❌ Bad
url: '/trading'

// ✅ Good
url: `${window.location.origin}/trading`
```

### 5. Test on Mobile Devices

The Web Share API works best on mobile. Always test on:
- iOS Safari
- Android Chrome
- Android Samsung Internet

### 6. Provide Fallbacks

For unsupported browsers, provide alternative sharing methods:

```typescript
if (!isSupported) {
  return <CopyLinkButton url={url} />;
}
```

## Security Considerations

### 1. URL Validation

Always validate and sanitize URLs before sharing:

```typescript
const shareUrl = new URL(data.url);
if (shareUrl.origin !== window.location.origin) {
  console.warn('External URL sharing blocked');
  return false;
}
```

### 2. Sensitive Data

Never share sensitive information in share text:

```typescript
// ❌ Bad - Exposes user ID
text: `User #${userId} shared this`

// ✅ Good - Generic text
text: 'Check out this trade opportunity'
```

### 3. Rate Limiting

Implement rate limiting for share actions to prevent abuse:

```typescript
let lastShareTime = 0;
const SHARE_COOLDOWN = 2000; // 2 seconds

const handleShare = async () => {
  const now = Date.now();
  if (now - lastShareTime < SHARE_COOLDOWN) {
    toast.error('Please wait before sharing again');
    return;
  }
  lastShareTime = now;
  await share(data);
};
```

## Troubleshooting

### Share Button Not Appearing

**Problem:** Share button doesn't render on desktop Chrome

**Solution:** Web Share API support varies. Check `isSupported`:

```typescript
const { isSupported } = useWebShare();
console.log('Share supported:', isSupported);
```

### Share Fails Silently

**Problem:** Share function returns false without error

**Solution:** User likely cancelled. This is normal behavior:

```typescript
const success = await share(data);
if (!success) {
  // User cancelled - don't show error
}
```

### Files Not Sharing

**Problem:** File sharing doesn't work

**Solution:** Check `canShareFiles` and browser support:

```typescript
const { canShareFiles } = useWebShare();
if (!canShareFiles) {
  console.log('File sharing not supported');
}
```

### HTTPS Required

**Problem:** Share API not available on HTTP

**Solution:** Web Share API requires HTTPS (except localhost):

- Use HTTPS in production
- Localhost works for development
- Test on real HTTPS domain

## Analytics

Track share events for insights:

```typescript
const handleShare = async () => {
  const success = await share(data);
  if (success) {
    // Track successful share
    analytics.track('content_shared', {
      type: 'trade_opportunity',
      method: 'web_share_api',
    });
  }
};
```

## Future Enhancements

Planned features:

1. **File Sharing** - Share QR code images and documents
2. **Share Targets** - Register app as share target
3. **Share Analytics** - Track share conversion rates
4. **Custom Share UI** - Fallback UI for unsupported browsers
5. **Deep Links** - Share deep links to specific app sections

## Resources

- [Web Share API - MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Share_API)
- [Can I Use - Web Share API](https://caniuse.com/web-share)
- [Web Share API Specification](https://w3c.github.io/web-share/)
- [Web Share Target API](https://web.dev/web-share-target/)

## Support

For issues or questions:
- Check browser console for errors
- Verify HTTPS is enabled
- Test on supported browsers
- Contact support@vpp-platform.com

---

*Last updated: November 2024*
