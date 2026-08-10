/**
 * Notification Service
 * 
 * Handles multi-channel notifications:
 * - Email notifications (delegated to the real SMTP emailService)
 * - SMS notifications (via Africa's Talking)
 * - Push notifications (delegated to the real web-push implementation)
 */

import axios from 'axios';
import { sendEmail as sendSmtpEmail } from './emailService';
import { sendPushNotification as sendWebPush } from './sendNotification';

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
 * Send email notification via the configured SMTP transporter (emailService).
 * Returns the real delivery result — false on failure, never a fake true.
 */
export async function sendEmail(notification: EmailNotification): Promise<boolean> {
  try {
    const html = notification.html || (notification.body ? `<p>${notification.body.replace(/\n/g, '<br>')}</p>` : '');
    if (!html && !notification.body) {
      console.error('[Email] Refusing to send email with no content:', notification.subject);
      return false;
    }

    const result = await sendSmtpEmail({
      to: notification.to,
      subject: notification.subject,
      html,
      text: notification.body,
      attachments: notification.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
    });

    if (!result.success) {
      console.error('[Email] Delivery failed:', result.error);
    }
    return result.success;
  } catch (error) {
    console.error('[Email] Failed to send email:', error);
    return false;
  }
}

/**
 * Send SMS notification via Africa's Talking.
 * Missing configuration or delivery failure returns false with a loud
 * warning (callers are fire-and-forget, so we do not throw).
 */
export async function sendSMS(notification: SMSNotification): Promise<boolean> {
  const apiKey = process.env.AT_API_KEY;
  const username = process.env.AT_USERNAME;
  const baseUrl = process.env.AT_BASE_URL || 'https://api.africastalking.com';

  if (!apiKey || !username) {
    console.warn('[SMS] Africa\'s Talking not configured (AT_API_KEY/AT_USERNAME missing). SMS NOT sent to', notification.to);
    return false;
  }

  try {
    const response = await axios.post(
      `${baseUrl}/version1/messaging`,
      new URLSearchParams({
        username,
        to: notification.to,
        message: notification.message,
      }).toString(),
      {
        headers: {
          apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
      }
    );

    const recipients = response.data?.SMSMessageData?.Recipients;
    if (!Array.isArray(recipients) || recipients.length === 0) {
      console.error('[SMS] Africa\'s Talking returned no recipients:', response.data);
      return false;
    }

    const failed = recipients.filter((r: any) => r?.status !== 'Success');
    if (failed.length > 0) {
      console.error('[SMS] Delivery failed for some recipients:', failed);
      return false;
    }

    return true;
  } catch (error: any) {
    console.error('[SMS] Failed to send SMS:', error?.response?.data || error.message || error);
    return false;
  }
}

/**
 * Send push notification
 * Delegates to the real web-push implementation (sendNotification.ts),
 * which looks up the user's stored push subscriptions and delivers via
 * the Web Push protocol. Returns false loudly on delivery failure.
 */
export async function sendPushNotification(notification: PushNotification): Promise<boolean> {
  try {
    const result = await sendWebPush(
      notification.userId,
      {
        title: notification.title,
        body: notification.body,
        icon: notification.icon,
        data: notification.data,
      }
    );

    if (!result.success || result.errors > 0) {
      console.error('[Push] Push delivery failed or partial:', result);
      return false;
    }
    if (result.sentCount === 0) {
      console.warn('[Push] No active push subscriptions accepted the notification for user', notification.userId);
      return false;
    }
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
