# Email Notification Configuration Guide

This guide explains how to configure email notifications for the VPP Consumer Platform.

## Overview

The platform uses **Nodemailer** to send transactional emails and periodic analytics summaries. It supports any SMTP provider including Gmail, SendGrid, AWS SES, Mailgun, and more.

## Email Types

The system sends the following types of emails:

1. **Trade Confirmations** - Sent when trades are executed or fail
2. **Payment Receipts** - Sent after successful payments
3. **DR Event Alerts** - Sent when new demand response events are scheduled
4. **System Alerts** - Sent for important system notifications
5. **Welcome Emails** - Sent to new users after registration
6. **Weekly Analytics Summaries** - Sent to admins every Monday
7. **Monthly Analytics Reports** - Sent to admins on the 1st of each month

## Environment Variables

Configure the following environment variables in your deployment:

```bash
# SMTP Server Configuration
EMAIL_HOST=smtp.gmail.com              # SMTP server hostname
EMAIL_PORT=587                         # SMTP port (587 for TLS, 465 for SSL)
EMAIL_USER=your-email@gmail.com        # SMTP username/email
EMAIL_PASSWORD=your-app-password       # SMTP password or app-specific password

# Sender Information
EMAIL_FROM=noreply@vpp-platform.com    # Default sender email address
EMAIL_FROM_NAME=VPP Platform           # Default sender name
```

## Provider-Specific Setup

### Gmail

1. Enable 2-factor authentication on your Google account
2. Generate an app-specific password at https://myaccount.google.com/apppasswords
3. Use the following configuration:

```bash
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=your-16-char-app-password
```

### SendGrid

1. Create a SendGrid account at https://sendgrid.com
2. Generate an API key in Settings → API Keys
3. Use the following configuration:

```bash
EMAIL_HOST=smtp.sendgrid.net
EMAIL_PORT=587
EMAIL_USER=apikey
EMAIL_PASSWORD=your-sendgrid-api-key
EMAIL_FROM=verified-sender@yourdomain.com
```

**Note:** You must verify your sender email in SendGrid before sending emails.

### AWS SES

1. Set up AWS SES in your AWS account
2. Verify your sender email or domain
3. Create SMTP credentials in SES console
4. Use the following configuration:

```bash
EMAIL_HOST=email-smtp.us-east-1.amazonaws.com  # Replace with your region
EMAIL_PORT=587
EMAIL_USER=your-ses-smtp-username
EMAIL_PASSWORD=your-ses-smtp-password
EMAIL_FROM=verified-sender@yourdomain.com
```

### Mailgun

1. Create a Mailgun account at https://mailgun.com
2. Add and verify your domain
3. Get SMTP credentials from Settings → SMTP
4. Use the following configuration:

```bash
EMAIL_HOST=smtp.mailgun.org
EMAIL_PORT=587
EMAIL_USER=postmaster@your-domain.mailgun.org
EMAIL_PASSWORD=your-mailgun-password
```

## Testing Email Configuration

### Via Admin Dashboard

1. Log in as an admin user
2. Navigate to Admin Dashboard
3. Use the email management endpoints to test:
   - `email.verifyService` - Verify SMTP connection
   - `email.sendTestEmail` - Send a test email
   - `email.sendTestWeeklySummary` - Send test analytics summary

### Via Code

```typescript
import { verifyEmailService, sendEmail } from './server/_core/emailService';

// Verify configuration
const isValid = await verifyEmailService();
console.log('Email service valid:', isValid);

// Send test email
const result = await sendEmail({
  to: 'test@example.com',
  subject: 'Test Email',
  html: '<p>This is a test email</p>',
});
console.log('Email sent:', result.success);
```

## Scheduled Email Summaries

The platform sends periodic analytics summaries to admin users:

### Weekly Summary (Every Monday)

- Sent to all users with `role = 'admin'`
- Contains: user growth, trading activity, revenue, top trader
- Trigger manually: `trpc.email.triggerWeeklySummary.useMutation()`

### Monthly Report (1st of Each Month)

- Sent to all users with `role = 'admin'`
- Contains: comprehensive analytics, top 10 performers, DR events
- Trigger manually: `trpc.email.triggerMonthlySummary.useMutation()`

### Setting Up Cron Jobs

To automate scheduled emails, set up cron jobs on your server:

```bash
# Edit crontab
crontab -e

# Add these lines (adjust paths as needed)
# Weekly summary every Monday at 9:00 AM
0 9 * * 1 curl -X POST https://your-domain.com/api/trpc/email.triggerWeeklySummary

# Monthly report on 1st of each month at 9:00 AM
0 9 1 * * curl -X POST https://your-domain.com/api/trpc/email.triggerMonthlySummary
```

Alternatively, use a Node.js scheduler like `node-cron`:

```typescript
import cron from 'node-cron';
import { sendWeeklyAnalyticsSummary, sendMonthlyAnalyticsSummary } from './server/_core/scheduledEmails';

// Weekly summary every Monday at 9:00 AM
cron.schedule('0 9 * * 1', async () => {
  await sendWeeklyAnalyticsSummary();
});

// Monthly report on 1st of each month at 9:00 AM
cron.schedule('0 9 1 * *', async () => {
  await sendMonthlyAnalyticsSummary();
});
```

## Email Templates

All email templates are located in `server/_core/emailTemplates.ts`. They use responsive HTML design with:

- Mobile-friendly layout
- Platform branding (green gradient header)
- Consistent styling
- Clear call-to-action buttons
- Footer with links to platform and settings

### Customizing Templates

To customize email templates:

1. Edit `server/_core/emailTemplates.ts`
2. Modify the HTML structure and styling
3. Update the `wrapEmailTemplate` function in `server/_core/emailService.ts` for global changes

## User Email Preferences

Users can control which emails they receive via notification preferences:

1. Navigate to Settings → Notification Preferences
2. Toggle email notifications for different types:
   - Trade confirmations
   - Payment receipts
   - DR event alerts
   - System alerts
3. Set weekly/monthly summary preferences (admin only)

Email preferences are stored in the `notification_preferences` table and checked before sending emails.

## Troubleshooting

### Emails Not Sending

1. **Verify environment variables are set correctly**
   ```bash
   echo $EMAIL_HOST
   echo $EMAIL_USER
   ```

2. **Check SMTP connection**
   ```typescript
   const isValid = await verifyEmailService();
   ```

3. **Check server logs for errors**
   ```bash
   tail -f /var/log/vpp-platform.log | grep Email
   ```

4. **Common issues:**
   - Incorrect password or API key
   - Firewall blocking SMTP ports (587, 465)
   - Sender email not verified (SendGrid, AWS SES)
   - Gmail blocking "less secure apps" (use app password)

### Emails Going to Spam

1. **Set up SPF, DKIM, and DMARC records** for your domain
2. **Use a verified sender domain** (not @gmail.com for production)
3. **Warm up your sending domain** gradually
4. **Monitor bounce rates** and remove invalid emails

### Testing in Development

For local development without SMTP credentials:

1. Use **Mailhog** or **MailDev** for local SMTP testing:
   ```bash
   docker run -d -p 1025:1025 -p 8025:8025 mailhog/mailhog
   ```

2. Configure environment:
   ```bash
   EMAIL_HOST=localhost
   EMAIL_PORT=1025
   ```

3. View emails at http://localhost:8025

## Security Best Practices

1. **Never commit SMTP credentials** to version control
2. **Use app-specific passwords** for Gmail
3. **Rotate API keys** regularly
4. **Use environment variables** for all sensitive data
5. **Enable TLS/SSL** for SMTP connections
6. **Limit email sending rate** to avoid being flagged as spam
7. **Validate email addresses** before sending

## Rate Limits

Be aware of provider rate limits:

- **Gmail**: 500 emails/day, 100 emails/batch
- **SendGrid Free**: 100 emails/day
- **SendGrid Paid**: Varies by plan
- **AWS SES**: 1 email/second (sandbox), higher in production
- **Mailgun Free**: 5,000 emails/month

For high-volume sending, consider using a dedicated email service provider.

## Support

For issues with email configuration:

1. Check the [Nodemailer documentation](https://nodemailer.com)
2. Review provider-specific setup guides
3. Contact your email provider's support
4. Check VPP Platform logs for error messages

## API Reference

### Email Service Functions

```typescript
// Send a single email
sendEmail(options: EmailOptions): Promise<{ success: boolean; messageId?: string; error?: string }>

// Send batch emails
sendBatchEmails(recipients: string[], subject: string, html: string, text?: string): Promise<{ success: boolean; sent: number; failed: number }>

// Verify email service
verifyEmailService(): Promise<boolean>

// Wrap content in email template
wrapEmailTemplate(content: string, title?: string): string
```

### tRPC Email Endpoints (Admin Only)

```typescript
// Verify email service configuration
trpc.email.verifyService.useMutation()

// Send test email
trpc.email.sendTestEmail.useMutation({ to, subject, message })

// Send test weekly summary
trpc.email.sendTestWeeklySummary.useMutation()

// Trigger weekly summary for all admins
trpc.email.triggerWeeklySummary.useMutation()

// Trigger monthly summary for all admins
trpc.email.triggerMonthlySummary.useMutation()

// Send welcome email to a user
trpc.email.sendWelcomeEmail.useMutation({ userId })
```
