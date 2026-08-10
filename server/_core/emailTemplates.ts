import { wrapEmailTemplate } from './emailService';

/**
 * Email templates for various notification types
 */

/**
 * Payment receipt email template
 */
export function paymentReceiptTemplate(data: {
  userName: string;
  amount: string;
  currency: string;
  paymentMethod: string;
  transactionId: string;
  date: string;
  description?: string;
}): string {
  const content = `
    <h2>Payment Receipt</h2>
    <p>Hello ${data.userName},</p>
    <p>Thank you for your payment. Here are the details of your transaction:</p>
    
    <div class="info-box">
      <table>
        <tr>
          <th>Amount:</th>
          <td><strong>${data.currency} ${data.amount}</strong></td>
        </tr>
        <tr>
          <th>Payment Method:</th>
          <td>${data.paymentMethod}</td>
        </tr>
        <tr>
          <th>Transaction ID:</th>
          <td>${data.transactionId}</td>
        </tr>
        <tr>
          <th>Date:</th>
          <td>${data.date}</td>
        </tr>
        ${data.description ? `
        <tr>
          <th>Description:</th>
          <td>${data.description}</td>
        </tr>
        ` : ''}
      </table>
    </div>
    
    <p>If you have any questions about this payment, please contact our support team.</p>
    <a href="https://vpp-platform.com/payments" class="button">View Payment History</a>
  `;
  
  return wrapEmailTemplate(content, 'Payment Receipt');
}

/**
 * Trade confirmation email template
 */
export function tradeConfirmationTemplate(data: {
  userName: string;
  tradeType: string;
  energy: number;
  price: string;
  status: string;
  tradeId: number;
  date: string;
}): string {
  const statusEmoji = data.status === 'executed' ? '✅' : '❌';
  const statusText = data.status === 'executed' ? 'Successfully Executed' : 'Failed';
  const statusClass = data.status === 'executed' ? 'info-box' : 'warning-box';
  
  const content = `
    <h2>${statusEmoji} Trade ${statusText}</h2>
    <p>Hello ${data.userName},</p>
    <p>Your energy trade has been ${data.status}. Here are the details:</p>
    
    <div class="${statusClass}">
      <table>
        <tr>
          <th>Trade Type:</th>
          <td><strong>${data.tradeType.toUpperCase()}</strong></td>
        </tr>
        <tr>
          <th>Energy:</th>
          <td>${(data.energy / 1000).toFixed(2)} kWh</td>
        </tr>
        <tr>
          <th>Price:</th>
          <td>₦${data.price}</td>
        </tr>
        <tr>
          <th>Status:</th>
          <td>${statusText}</td>
        </tr>
        <tr>
          <th>Trade ID:</th>
          <td>#${data.tradeId}</td>
        </tr>
        <tr>
          <th>Date:</th>
          <td>${data.date}</td>
        </tr>
      </table>
    </div>
    
    ${data.status === 'executed' ? `
      <p>The energy has been successfully traded and will be reflected in your account shortly.</p>
    ` : `
      <p>Unfortunately, your trade could not be completed. Please try again or contact support if the issue persists.</p>
    `}
    
    <a href="https://vpp-platform.com/trading" class="button">View Trading History</a>
  `;
  
  return wrapEmailTemplate(content, `Trade ${statusText}`);
}

/**
 * DR event alert email template
 */
export function drEventAlertTemplate(data: {
  userName: string;
  eventName: string;
  startTime: string;
  endTime: string;
  reductionTarget: number;
  incentive: string;
  eventId: number;
}): string {
  const content = `
    <h2>⚡ Demand Response Event Alert</h2>
    <p>Hello ${data.userName},</p>
    <p>A new demand response event has been scheduled. Your participation is requested:</p>
    
    <div class="info-box">
      <h3 style="margin-top: 0;">${data.eventName}</h3>
      <table>
        <tr>
          <th>Start Time:</th>
          <td>${data.startTime}</td>
        </tr>
        <tr>
          <th>End Time:</th>
          <td>${data.endTime}</td>
        </tr>
        <tr>
          <th>Reduction Target:</th>
          <td>${(data.reductionTarget / 1000).toFixed(2)} kWh</td>
        </tr>
        <tr>
          <th>Incentive:</th>
          <td><strong>₦${data.incentive}</strong></td>
        </tr>
        <tr>
          <th>Event ID:</th>
          <td>#${data.eventId}</td>
        </tr>
      </table>
    </div>
    
    <p>By participating in this event, you'll help balance the grid and earn incentives. Please prepare your assets for the scheduled time.</p>
    
    <a href="https://vpp-platform.com/demand-response" class="button">View Event Details</a>
  `;
  
  return wrapEmailTemplate(content, 'DR Event Alert');
}

/**
 * System alert email template
 */
export function systemAlertTemplate(data: {
  userName: string;
  alertType: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  actionUrl?: string;
  actionText?: string;
}): string {
  const severityEmoji = {
    info: 'ℹ️',
    warning: '⚠️',
    critical: '🚨',
  }[data.severity];
  
  const severityClass = {
    info: 'info-box',
    warning: 'warning-box',
    critical: 'warning-box',
  }[data.severity];
  
  const content = `
    <h2>${severityEmoji} ${data.title}</h2>
    <p>Hello ${data.userName},</p>
    
    <div class="${severityClass}">
      <p><strong>Alert Type:</strong> ${data.alertType.toUpperCase()}</p>
      <p>${data.message}</p>
    </div>
    
    ${data.severity === 'critical' ? `
      <p style="color: #dc2626; font-weight: 600;">This is a critical alert that requires immediate attention.</p>
    ` : ''}
    
    ${data.actionUrl && data.actionText ? `
      <a href="${data.actionUrl}" class="button">${data.actionText}</a>
    ` : ''}
    
    <p>If you have any questions, please contact our support team.</p>
  `;
  
  return wrapEmailTemplate(content, data.title);
}

/**
 * Weekly analytics summary email template (for admins)
 */
export function weeklyAnalyticsSummaryTemplate(data: {
  adminName: string;
  weekStart: string;
  weekEnd: string;
  totalUsers: number;
  newUsers: number;
  totalTrades: number;
  totalEnergy: number;
  totalRevenue: string;
  topTrader: { name: string; energy: number };
}): string {
  const content = `
    <h2>📊 Weekly Analytics Summary</h2>
    <p>Hello ${data.adminName},</p>
    <p>Here's your weekly platform performance summary for <strong>${data.weekStart}</strong> to <strong>${data.weekEnd}</strong>:</p>
    
    <h3>User Metrics</h3>
    <div class="info-box">
      <table>
        <tr>
          <th>Total Users:</th>
          <td>${data.totalUsers}</td>
        </tr>
        <tr>
          <th>New Users This Week:</th>
          <td><strong>+${data.newUsers}</strong></td>
        </tr>
      </table>
    </div>
    
    <h3>Trading Activity</h3>
    <div class="info-box">
      <table>
        <tr>
          <th>Total Trades:</th>
          <td>${data.totalTrades}</td>
        </tr>
        <tr>
          <th>Energy Traded:</th>
          <td>${(data.totalEnergy / 1000).toFixed(2)} kWh</td>
        </tr>
        <tr>
          <th>Top Trader:</th>
          <td>${data.topTrader.name} (${(data.topTrader.energy / 1000).toFixed(2)} kWh)</td>
        </tr>
      </table>
    </div>
    
    <h3>Revenue</h3>
    <div class="info-box">
      <table>
        <tr>
          <th>Total Revenue:</th>
          <td><strong>₦${data.totalRevenue}</strong></td>
        </tr>
      </table>
    </div>
    
    <a href="https://vpp-platform.com/admin/analytics-dashboard" class="button">View Full Analytics</a>
    
    <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">
      This is an automated weekly summary. You can adjust your email preferences in the admin settings.
    </p>
  `;
  
  return wrapEmailTemplate(content, 'Weekly Analytics Summary');
}

/**
 * Monthly analytics summary email template (for admins)
 */
export function monthlyAnalyticsSummaryTemplate(data: {
  adminName: string;
  month: string;
  year: number;
  totalUsers: number;
  newUsers: number;
  activeUsers: number;
  totalTrades: number;
  totalEnergy: number;
  totalRevenue: string;
  totalDREvents: number;
  topPerformers: Array<{ name: string; energy: number }>;
}): string {
  const content = `
    <h2>📈 Monthly Analytics Report</h2>
    <p>Hello ${data.adminName},</p>
    <p>Here's your comprehensive platform performance report for <strong>${data.month} ${data.year}</strong>:</p>
    
    <h3>User Growth</h3>
    <div class="info-box">
      <table>
        <tr>
          <th>Total Users:</th>
          <td>${data.totalUsers}</td>
        </tr>
        <tr>
          <th>New Users This Month:</th>
          <td><strong>+${data.newUsers}</strong></td>
        </tr>
        <tr>
          <th>Active Users:</th>
          <td>${data.activeUsers}</td>
        </tr>
      </table>
    </div>
    
    <h3>Trading Performance</h3>
    <div class="info-box">
      <table>
        <tr>
          <th>Total Trades:</th>
          <td>${data.totalTrades}</td>
        </tr>
        <tr>
          <th>Energy Traded:</th>
          <td>${(data.totalEnergy / 1000).toFixed(2)} kWh</td>
        </tr>
        <tr>
          <th>Average Trade Size:</th>
          <td>${data.totalTrades > 0 ? ((data.totalEnergy / data.totalTrades) / 1000).toFixed(2) : 0} kWh</td>
        </tr>
      </table>
    </div>
    
    <h3>Revenue & DR Events</h3>
    <div class="info-box">
      <table>
        <tr>
          <th>Total Revenue:</th>
          <td><strong>₦${data.totalRevenue}</strong></td>
        </tr>
        <tr>
          <th>DR Events:</th>
          <td>${data.totalDREvents}</td>
        </tr>
      </table>
    </div>
    
    <h3>Top Performers</h3>
    <table>
      <thead>
        <tr>
          <th>Rank</th>
          <th>User</th>
          <th>Energy Traded</th>
        </tr>
      </thead>
      <tbody>
        ${data.topPerformers.slice(0, 5).map((performer, index) => `
          <tr>
            <td>${index + 1}</td>
            <td>${performer.name}</td>
            <td>${(performer.energy / 1000).toFixed(2)} kWh</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    
    <a href="https://vpp-platform.com/admin/analytics-dashboard" class="button">View Full Analytics</a>
    
    <p style="color: #6b7280; font-size: 14px; margin-top: 24px;">
      This is an automated monthly summary. You can adjust your email preferences in the admin settings.
    </p>
  `;
  
  return wrapEmailTemplate(content, 'Monthly Analytics Report');
}

/**
 * Welcome email template for new users
 */
export function welcomeEmailTemplate(data: {
  userName: string;
  loginUrl: string;
}): string {
  const content = `
    <h2>Welcome to VPP Platform! 🎉</h2>
    <p>Hello ${data.userName},</p>
    <p>Thank you for joining VPP Platform. We're excited to have you as part of our virtual power plant community!</p>
    
    <div class="info-box">
      <h3 style="margin-top: 0;">Get Started:</h3>
      <ol style="margin: 0; padding-left: 20px;">
        <li>Register your energy assets (solar panels, batteries)</li>
        <li>Set up your payment preferences</li>
        <li>Configure your trading settings</li>
        <li>Start earning from your energy!</li>
      </ol>
    </div>
    
    <a href="${data.loginUrl}" class="button">Go to Dashboard</a>
    
    <p>If you have any questions, our support team is here to help.</p>
  `;
  
  return wrapEmailTemplate(content, 'Welcome to VPP Platform');
}
