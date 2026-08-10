/**
 * Notification Service
 * 
 * Handles multi-channel notifications:
 * - Email notifications
 * - SMS notifications (via Africa's Talking)
 * - Push notifications (web push)
 */

export interface EmailNotification {
  to: string;
  subject: string;
  body?: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    content: Buffer | string;
    contentType?: string;
  }>;
}

export interface SMSNotification {
  to: string; // Phone number in international format (+255...)
  message: string;
}

export interface PushNotification {
  userId: number;
  title: string;
  body: string;
  icon?: string;
  data?: Record<string, any>;
}

/**
 * Send email notification
 * In production, integrate with SendGrid, AWS SES, or similar
 */
export async function sendEmail(notification: EmailNotification): Promise<boolean> {
  try {
    // Demo mode: Log email instead of sending
    console.log('[Email] Sending email notification:', {
      to: notification.to,
      subject: notification.subject,
      preview: notification.body?.substring(0, 100) || notification.html?.substring(0, 100) || 'No content',
    });

    // In production, uncomment and configure:
    /*
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{
          to: [{ email: notification.to }],
        }],
        from: { email: process.env.FROM_EMAIL || 'noreply@vpp.com' },
        subject: notification.subject,
        content: [{
          type: notification.html ? 'text/html' : 'text/plain',
          value: notification.html || notification.body,
        }],
      }),
    });

    return response.ok;
    */

    return true;
  } catch (error) {
    console.error('[Email] Failed to send email:', error);
    return false;
  }
}

/**
 * Send SMS notification via Africa's Talking
 */
export async function sendSMS(notification: SMSNotification): Promise<boolean> {
  try {
    // Demo mode: Log SMS instead of sending
    console.log('[SMS] Sending SMS notification:', {
      to: notification.to,
      message: notification.message,
    });

    // In production, uncomment and configure:
    /*
    const apiKey = process.env.AFRICAS_TALKING_API_KEY;
    const username = process.env.AFRICAS_TALKING_USERNAME;

    if (!apiKey || !username) {
      throw new Error('Africa\'s Talking credentials not configured');
    }

    const response = await fetch('https://api.africastalking.com/version1/messaging', {
      method: 'POST',
      headers: {
        'apiKey': apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: new URLSearchParams({
        username,
        to: notification.to,
        message: notification.message,
      }),
    });

    const data = await response.json();
    return data.SMSMessageData?.Recipients?.[0]?.status === 'Success';
    */

    return true;
  } catch (error) {
    console.error('[SMS] Failed to send SMS:', error);
    return false;
  }
}

/**
 * Send push notification
 * Uses Web Push API for browser notifications
 */
export async function sendPushNotification(notification: PushNotification): Promise<boolean> {
  try {
    // Demo mode: Log push notification
    console.log('[Push] Sending push notification:', {
      userId: notification.userId,
      title: notification.title,
      body: notification.body,
    });

    // In production, integrate with web-push library:
    /*
    const webpush = require('web-push');
    
    webpush.setVapidDetails(
      'mailto:admin@vpp.com',
      process.env.VAPID_PUBLIC_KEY!,
      process.env.VAPID_PRIVATE_KEY!
    );

    // Get user's push subscription from database
    const subscription = await getUserPushSubscription(notification.userId);
    
    if (subscription) {
      await webpush.sendNotification(subscription, JSON.stringify({
        title: notification.title,
        body: notification.body,
        icon: notification.icon || '/logo.png',
        data: notification.data,
      }));
    }
    */

    return true;
  } catch (error) {
    console.error('[Push] Failed to send push notification:', error);
    return false;
  }
}

/**
 * Notification Templates
 */

export function getPaymentSuccessEmail(params: {
  userName: string;
  amount: number;
  transactionId: string;
  paymentMethod: string;
}): EmailNotification {
  return {
    to: '', // Will be filled by caller
    subject: 'Payment Successful - VPP Platform',
    body: `Dear ${params.userName},

Your payment of TZS ${(params.amount / 100).toFixed(2)} has been successfully processed.

Payment Details:
- Amount: TZS ${(params.amount / 100).toFixed(2)}
- Payment Method: ${params.paymentMethod}
- Transaction ID: ${params.transactionId}
- Date: ${new Date().toLocaleString()}

Thank you for using VPP Platform!

Best regards,
VPP Team`,
    html: `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #16a34a; color: white; padding: 20px; text-align: center; }
    .content { background: #f9f9f9; padding: 20px; }
    .details { background: white; padding: 15px; margin: 15px 0; border-left: 4px solid #16a34a; }
    .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Payment Successful</h1>
    </div>
    <div class="content">
      <p>Dear ${params.userName},</p>
      <p>Your payment has been successfully processed.</p>
      <div class="details">
        <p><strong>Amount:</strong> TZS ${(params.amount / 100).toFixed(2)}</p>
        <p><strong>Payment Method:</strong> ${params.paymentMethod}</p>
        <p><strong>Transaction ID:</strong> ${params.transactionId}</p>
        <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
      </div>
      <p>Thank you for using VPP Platform!</p>
    </div>
    <div class="footer">
      <p>© ${new Date().getFullYear()} VPP Platform. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
    `,
  };
}

export function getTokenGeneratedEmail(params: {
  userName: string;
  tokenCode: string;
  energyKwh: number;
  amount: number;
}): EmailNotification {
  return {
    to: '', // Will be filled by caller
    subject: 'Your Prepaid Token - VPP Platform',
    body: `Dear ${params.userName},

Your prepaid electricity token has been generated successfully!

Token Code: ${params.tokenCode}
Energy: ${params.energyKwh} kWh
Amount Paid: TZS ${(params.amount / 100).toFixed(2)}

To use your token:
1. Enter the token code on your meter
2. Press the confirm button
3. Your meter will be credited with ${params.energyKwh} kWh

Please keep this token code safe. It is valid for one year.

Best regards,
VPP Team`,
    html: `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #16a34a; color: white; padding: 20px; text-align: center; }
    .content { background: #f9f9f9; padding: 20px; }
    .token { background: white; padding: 20px; margin: 20px 0; text-align: center; border: 2px dashed #16a34a; }
    .token-code { font-size: 24px; font-weight: bold; color: #16a34a; letter-spacing: 2px; }
    .details { background: white; padding: 15px; margin: 15px 0; }
    .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Your Prepaid Token</h1>
    </div>
    <div class="content">
      <p>Dear ${params.userName},</p>
      <p>Your prepaid electricity token has been generated successfully!</p>
      <div class="token">
        <p style="margin: 0; color: #666;">Your Token Code</p>
        <p class="token-code">${params.tokenCode}</p>
      </div>
      <div class="details">
        <p><strong>Energy:</strong> ${params.energyKwh} kWh</p>
        <p><strong>Amount Paid:</strong> TZS ${(params.amount / 100).toFixed(2)}</p>
      </div>
      <h3>How to Use Your Token:</h3>
      <ol>
        <li>Enter the token code on your meter</li>
        <li>Press the confirm button</li>
        <li>Your meter will be credited with ${params.energyKwh} kWh</li>
      </ol>
      <p><strong>Note:</strong> Please keep this token code safe. It is valid for one year.</p>
    </div>
    <div class="footer">
      <p>© ${new Date().getFullYear()} VPP Platform. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
    `,
  };
}

export function getTokenGeneratedSMS(params: {
  tokenCode: string;
  energyKwh: number;
}): SMSNotification {
  return {
    to: '', // Will be filled by caller
    message: `VPP Token: ${params.tokenCode}. Energy: ${params.energyKwh} kWh. Enter this code on your meter to load credit. Valid for 1 year.`,
  };
}

export function getPaymentSuccessPush(params: {
  amount: number;
  transactionId: string;
}): PushNotification {
  return {
    userId: 0, // Will be filled by caller
    title: 'Payment Successful',
    body: `Your payment of TZS ${(params.amount / 100).toFixed(2)} has been processed successfully.`,
    icon: '/logo.png',
    data: {
      type: 'payment_success',
      transactionId: params.transactionId,
    },
  };
}

export function getTokenGeneratedPush(params: {
  tokenCode: string;
  energyKwh: number;
}): PushNotification {
  return {
    userId: 0, // Will be filled by caller
    title: 'Token Generated',
    body: `Your prepaid token (${params.energyKwh} kWh) is ready: ${params.tokenCode}`,
    icon: '/logo.png',
    data: {
      type: 'token_generated',
      tokenCode: params.tokenCode,
    },
  };
}
