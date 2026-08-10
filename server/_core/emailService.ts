import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

/**
 * Email service for sending transactional and notification emails
 * Supports multiple SMTP providers (Gmail, SendGrid, AWS SES, etc.)
 */

let transporter: Transporter | null = null;

/**
 * Initialize email transporter
 * Configure via environment variables:
 * - EMAIL_HOST: SMTP server host
 * - EMAIL_PORT: SMTP server port (587 for TLS, 465 for SSL)
 * - EMAIL_USER: SMTP username/email
 * - EMAIL_PASSWORD: SMTP password/API key
 * - EMAIL_FROM: Default sender email address
 * - EMAIL_FROM_NAME: Default sender name
 */
function getTransporter(): Transporter {
  if (transporter) {
    return transporter;
  }

  const host = process.env.EMAIL_HOST;
  const port = parseInt(process.env.EMAIL_PORT || '587');
  const user = process.env.EMAIL_USER;
  const password = process.env.EMAIL_PASSWORD;

  if (!host || !user || !password) {
    const missing = [
      !host && 'EMAIL_HOST',
      !user && 'EMAIL_USER',
      !password && 'EMAIL_PASSWORD',
    ].filter(Boolean).join(', ');

    // In production there is no silent fallback: missing SMTP configuration
    // is a hard misconfiguration and must fail loudly instead of pointing at
    // a localhost dev server that cannot deliver mail.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        `[Email] SMTP is not configured in production (missing: ${missing}). ` +
        `Set EMAIL_HOST, EMAIL_USER and EMAIL_PASSWORD — refusing to fall back to a local test transporter.`
      );
    }

    console.warn(
      `[Email] SMTP not configured (missing: ${missing}). ` +
      `Falling back to localhost:1025 test transporter — emails will NOT be delivered. ` +
      `This fallback is disabled in production.`
    );
    // Return a test transporter for development only
    transporter = nodemailer.createTransport({
      host: 'localhost',
      port: 1025,
      secure: false,
      ignoreTLS: true,
    });
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // Use SSL for port 465
    auth: {
      user,
      pass: password,
    },
  });

  console.log(`[Email] Email service initialized with ${host}:${port}`);
  return transporter;
}

export interface EmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
  replyTo?: string;
  attachments?: Array<{
    filename: string;
    content?: string | Buffer;
    path?: string;
    contentType?: string;
  }>;
}

/**
 * Send an email
 */
export async function sendEmail(options: EmailOptions): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const transport = getTransporter();
    
    const fromEmail = options.from || process.env.EMAIL_FROM || 'noreply@vpp-platform.com';
    const fromName = process.env.EMAIL_FROM_NAME || 'VPP Platform';
    const from = `${fromName} <${fromEmail}>`;

    const info = await transport.sendMail({
      from,
      to: Array.isArray(options.to) ? options.to.join(', ') : options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
      replyTo: options.replyTo,
      attachments: options.attachments,
    });

    console.log(`[Email] Sent email to ${options.to}: ${options.subject} (${info.messageId})`);
    return { success: true, messageId: info.messageId };
  } catch (error: any) {
    console.error('[Email] Failed to send email:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Send email to multiple recipients (batch)
 */
export async function sendBatchEmails(
  recipients: string[],
  subject: string,
  html: string,
  text?: string
): Promise<{ success: boolean; sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  await Promise.all(
    recipients.map(async (to) => {
      const result = await sendEmail({ to, subject, html, text });
      if (result.success) {
        sent++;
      } else {
        failed++;
      }
    })
  );

  return { success: true, sent, failed };
}

/**
 * Verify email service configuration
 */
export async function verifyEmailService(): Promise<boolean> {
  try {
    const transport = getTransporter();
    await transport.verify();
    console.log('[Email] Email service verified successfully');
    return true;
  } catch (error: any) {
    console.error('[Email] Email service verification failed:', error.message);
    return false;
  }
}

/**
 * Email template wrapper
 */
export function wrapEmailTemplate(content: string, title?: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title || 'VPP Platform'}</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background-color: #f3f4f6;
      color: #1f2937;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
      background-color: #ffffff;
    }
    .header {
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      padding: 32px 24px;
      text-align: center;
    }
    .header h1 {
      margin: 0;
      color: #ffffff;
      font-size: 24px;
      font-weight: 600;
    }
    .content {
      padding: 32px 24px;
    }
    .footer {
      background-color: #f9fafb;
      padding: 24px;
      text-align: center;
      font-size: 14px;
      color: #6b7280;
      border-top: 1px solid #e5e7eb;
    }
    .button {
      display: inline-block;
      padding: 12px 24px;
      background-color: #10b981;
      color: #ffffff;
      text-decoration: none;
      border-radius: 6px;
      font-weight: 500;
      margin: 16px 0;
    }
    .button:hover {
      background-color: #059669;
    }
    .info-box {
      background-color: #f0fdf4;
      border-left: 4px solid #10b981;
      padding: 16px;
      margin: 16px 0;
      border-radius: 4px;
    }
    .warning-box {
      background-color: #fef3c7;
      border-left: 4px solid #f59e0b;
      padding: 16px;
      margin: 16px 0;
      border-radius: 4px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 16px 0;
    }
    th, td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #e5e7eb;
    }
    th {
      background-color: #f9fafb;
      font-weight: 600;
      color: #374151;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🔋 VPP Platform</h1>
    </div>
    <div class="content">
      ${content}
    </div>
    <div class="footer">
      <p>© ${new Date().getFullYear()} VPP Platform. All rights reserved.</p>
      <p>
        <a href="https://vpp-platform.com" style="color: #10b981; text-decoration: none;">Visit Platform</a> |
        <a href="https://vpp-platform.com/settings" style="color: #10b981; text-decoration: none;">Email Preferences</a> |
        <a href="https://vpp-platform.com/support" style="color: #10b981; text-decoration: none;">Support</a>
      </p>
    </div>
  </div>
</body>
</html>
  `.trim();
}
