/**
 * Export utilities for analytics data
 */

export interface ExportData {
  headers: string[];
  rows: (string | number)[][];
}

/**
 * Convert data to CSV format
 */
export function convertToCSV(data: ExportData): string {
  const { headers, rows } = data;
  
  // Escape CSV values
  const escapeCSV = (value: string | number): string => {
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  // Build CSV content
  const csvRows = [
    headers.map(escapeCSV).join(','),
    ...rows.map(row => row.map(escapeCSV).join(','))
  ];

  return csvRows.join('\n');
}

/**
 * Download CSV file
 */
export function downloadCSV(filename: string, csvContent: string): void {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  
  URL.revokeObjectURL(url);
}

/**
 * Export analytics overview to CSV
 */
export function exportOverviewCSV(data: {
  totalUsers: number;
  totalTrades: number;
  totalRevenue: string;
  totalDREvents: number;
}): void {
  const exportData: ExportData = {
    headers: ['Metric', 'Value'],
    rows: [
      ['Total Users', data.totalUsers],
      ['Total Trades', data.totalTrades],
      ['Total Revenue (₦)', data.totalRevenue],
      ['Total DR Events', data.totalDREvents],
    ],
  };

  const csv = convertToCSV(exportData);
  const filename = `vpp-overview-${new Date().toISOString().split('T')[0]}.csv`;
  downloadCSV(filename, csv);
}

/**
 * Export user growth data to CSV
 */
export function exportUserGrowthCSV(data: {
  totalUsers: number;
  activeUsers: number;
  growthRate: string;
  usersByDate: { date: string; count: number }[];
}): void {
  const exportData: ExportData = {
    headers: ['Date', 'New Users'],
    rows: data.usersByDate.map(row => [row.date, row.count]),
  };

  // Add summary at the top
  const summaryRows = [
    ['Summary', ''],
    ['Total Users', data.totalUsers],
    ['Active Users', data.activeUsers],
    ['Growth Rate (%)', data.growthRate],
    ['', ''],
    ...exportData.rows,
  ];

  const csv = convertToCSV({ headers: exportData.headers, rows: summaryRows });
  const filename = `vpp-user-growth-${new Date().toISOString().split('T')[0]}.csv`;
  downloadCSV(filename, csv);
}

/**
 * Export trading metrics to CSV
 */
export function exportTradingMetricsCSV(data: {
  totalTrades: number;
  totalEnergy: number;
  averageTradeSize: number;
  tradesByDate: { date: string; count: number; energy: number }[];
  tradesByType: { type: string; count: number; energy: number }[];
}): void {
  const exportData: ExportData = {
    headers: ['Date', 'Trades', 'Energy (kWh)'],
    rows: data.tradesByDate.map(row => [row.date, row.count, row.energy]),
  };

  // Add summary and trades by type
  const summaryRows = [
    ['Summary', '', ''],
    ['Total Trades', data.totalTrades, ''],
    ['Total Energy (kWh)', data.totalEnergy, ''],
    ['Average Trade Size (kWh)', data.averageTradeSize, ''],
    ['', '', ''],
    ['Trade Type', 'Count', 'Energy (kWh)'],
    ...data.tradesByType.map(row => [row.type, row.count, row.energy]),
    ['', '', ''],
    ['Daily Breakdown', '', ''],
    ...exportData.rows,
  ];

  const csv = convertToCSV({ headers: ['Metric', 'Value', 'Additional'], rows: summaryRows });
  const filename = `vpp-trading-metrics-${new Date().toISOString().split('T')[0]}.csv`;
  downloadCSV(filename, csv);
}

/**
 * Export revenue metrics to CSV
 */
export function exportRevenueMetricsCSV(data: {
  totalRevenue: string;
  totalPayments: number;
  averagePayment: string;
  revenueByDate: { date: string; revenue: string; count: number }[];
}): void {
  const exportData: ExportData = {
    headers: ['Date', 'Revenue (₦)', 'Payments'],
    rows: data.revenueByDate.map(row => [row.date, row.revenue, row.count]),
  };

  // Add summary at the top
  const summaryRows = [
    ['Summary', '', ''],
    ['Total Revenue (₦)', data.totalRevenue, ''],
    ['Total Payments', data.totalPayments, ''],
    ['Average Payment (₦)', data.averagePayment, ''],
    ['', '', ''],
    ...exportData.rows,
  ];

  const csv = convertToCSV({ headers: exportData.headers, rows: summaryRows });
  const filename = `vpp-revenue-metrics-${new Date().toISOString().split('T')[0]}.csv`;
  downloadCSV(filename, csv);
}

/**
 * Export top performers to CSV
 */
export function exportTopPerformersCSV(data: {
  topTraders: { userId: number; userName: string; totalTrades: number; totalEnergy: number }[];
}): void {
  const exportData: ExportData = {
    headers: ['Rank', 'User ID', 'User Name', 'Total Trades', 'Total Energy (kWh)'],
    rows: data.topTraders.map((trader, index) => [
      index + 1,
      trader.userId,
      trader.userName,
      trader.totalTrades,
      trader.totalEnergy,
    ]),
  };

  const csv = convertToCSV(exportData);
  const filename = `vpp-top-performers-${new Date().toISOString().split('T')[0]}.csv`;
  downloadCSV(filename, csv);
}

/**
 * Export comprehensive analytics report
 */
export function exportComprehensiveReport(
  overview: any,
  userGrowth: any,
  tradingMetrics: any,
  revenueMetrics: any,
  topPerformers: any,
  systemHealth: any
): void {
  const sections: string[] = [];

  // Overview section
  sections.push('=== OVERVIEW ===');
  sections.push(`Total Users,${overview.totalUsers}`);
  sections.push(`Total Trades,${overview.totalTrades}`);
  sections.push(`Total Revenue (₦),${overview.totalRevenue}`);
  sections.push(`Total DR Events,${overview.totalDREvents}`);
  sections.push('');

  // User growth section
  sections.push('=== USER GROWTH ===');
  sections.push(`Total Users,${userGrowth.totalUsers}`);
  sections.push(`Active Users,${userGrowth.activeUsers}`);
  sections.push(`Growth Rate (%),${userGrowth.growthRate}`);
  sections.push('');

  // Trading metrics section
  sections.push('=== TRADING METRICS ===');
  sections.push(`Total Trades,${tradingMetrics.totalTrades}`);
  sections.push(`Total Energy (kWh),${tradingMetrics.totalEnergy}`);
  sections.push(`Average Trade Size (kWh),${tradingMetrics.averageTradeSize}`);
  sections.push('');

  // Revenue metrics section
  sections.push('=== REVENUE METRICS ===');
  sections.push(`Total Revenue (₦),${revenueMetrics.totalRevenue}`);
  sections.push(`Total Payments,${revenueMetrics.totalPayments}`);
  sections.push(`Average Payment (₦),${revenueMetrics.averagePayment}`);
  sections.push('');

  // System health section
  sections.push('=== SYSTEM HEALTH ===');
  sections.push(`Total Assets,${systemHealth.totalAssets}`);
  sections.push(`Active Assets,${systemHealth.activeAssets}`);
  sections.push(`Asset Health Rate (%),${systemHealth.assetHealthRate}`);
  sections.push(`Recent Telemetry (24h),${systemHealth.recentTelemetry}`);
  sections.push(`Pending Trades,${systemHealth.pendingTrades}`);
  sections.push(`System Status,${systemHealth.systemStatus}`);
  sections.push('');

  // Top performers section
  sections.push('=== TOP PERFORMERS ===');
  sections.push('Rank,User ID,User Name,Total Trades,Total Energy (kWh)');
  topPerformers.topTraders.forEach((trader: any, index: number) => {
    sections.push(`${index + 1},${trader.userId},${trader.userName},${trader.totalTrades},${trader.totalEnergy}`);
  });

  const csvContent = sections.join('\n');
  const filename = `vpp-comprehensive-report-${new Date().toISOString().split('T')[0]}.csv`;
  downloadCSV(filename, csvContent);
}

/**
 * Export QR code history to CSV
 */
export function exportQRHistoryCSV(data: {
  id: number;
  operationType: string;
  paymentType: string;
  amount: string;
  currency: string;
  merchantName?: string | null;
  recipientName?: string | null;
  status: string;
  createdAt: Date;
}[]): void {
  const exportData: ExportData = {
    headers: ['ID', 'Date', 'Operation', 'Type', 'Amount', 'Currency', 'Details', 'Status'],
    rows: data.map(item => [
      item.id,
      new Date(item.createdAt).toLocaleString(),
      item.operationType,
      item.paymentType,
      item.amount,
      item.currency,
      item.merchantName || item.recipientName || 'N/A',
      item.status,
    ]),
  };

  const csv = convertToCSV(exportData);
  const filename = `qr-history-${new Date().toISOString().split('T')[0]}.csv`;
  downloadCSV(filename, csv);
}

/**
 * Export QR code history to PDF
 */
export async function exportQRHistoryPDF(data: {
  id: number;
  operationType: string;
  paymentType: string;
  amount: string;
  currency: string;
  merchantName?: string | null;
  recipientName?: string | null;
  status: string;
  createdAt: Date;
}[]): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF();
  
  // Title
  doc.setFontSize(20);
  doc.text('QR Code Transaction History', 14, 20);
  
  // Date
  doc.setFontSize(10);
  doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 30);
  
  // Summary
  doc.setFontSize(12);
  doc.text('Summary', 14, 40);
  doc.setFontSize(10);
  doc.text(`Total Transactions: ${data.length}`, 14, 48);
  
  const totalAmount = data.reduce((sum, item) => sum + parseFloat(item.amount), 0);
  doc.text(`Total Amount: ${totalAmount.toFixed(2)}`, 14, 54);
  
  // Table header
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  let y = 70;
  doc.text('Date', 14, y);
  doc.text('Type', 50, y);
  doc.text('Amount', 90, y);
  doc.text('Status', 130, y);
  doc.text('Details', 160, y);
  
  // Table rows
  doc.setFont('helvetica', 'normal');
  y += 8;
  
  for (const item of data.slice(0, 30)) { // Limit to 30 rows per page
    if (y > 270) break; // Page limit
    
    doc.text(new Date(item.createdAt).toLocaleDateString(), 14, y);
    doc.text(item.operationType, 50, y);
    doc.text(`${item.amount} ${item.currency}`, 90, y);
    doc.text(item.status, 130, y);
    doc.text(item.merchantName || item.recipientName || 'N/A', 160, y, { maxWidth: 35 });
    
    y += 8;
  }
  
  // Save PDF
  doc.save(`qr-history-${new Date().toISOString().split('T')[0]}.pdf`);
}

/**
 * Export referral data to PDF
 */
export async function exportReferralsPDF(data: {
  referrals: {
    id: number;
    referralCode: string;
    refereeEmail?: string | null;
    status: string;
    rewardAmount: number;
    rewardCurrency: string;
    createdAt: Date;
  }[];
  stats: {
    totalReferrals: number;
    completedReferrals: number;
    pendingReferrals: number;
    totalRewardsEarned: number;
  };
}): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF();
  
  // Title
  doc.setFontSize(20);
  doc.text('Referral Program Report', 14, 20);
  
  // Date
  doc.setFontSize(10);
  doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 30);
  
  // Summary
  doc.setFontSize(14);
  doc.text('Summary', 14, 45);
  doc.setFontSize(10);
  doc.text(`Total Referrals: ${data.stats.totalReferrals}`, 14, 53);
  doc.text(`Completed: ${data.stats.completedReferrals}`, 14, 59);
  doc.text(`Pending: ${data.stats.pendingReferrals}`, 14, 65);
  doc.text(`Total Rewards Earned: ${data.stats.totalRewardsEarned}`, 14, 71);
  
  // Table header
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  let y = 90;
  doc.text('Code', 14, y);
  doc.text('Referee', 60, y);
  doc.text('Status', 110, y);
  doc.text('Reward', 140, y);
  doc.text('Date', 170, y);
  
  // Table rows
  doc.setFont('helvetica', 'normal');
  y += 8;
  
  for (const ref of data.referrals.slice(0, 25)) { // Limit to 25 rows per page
    if (y > 270) break; // Page limit
    
    doc.text(ref.referralCode, 14, y);
    doc.text(ref.refereeEmail || 'N/A', 60, y, { maxWidth: 45 });
    doc.text(ref.status, 110, y);
    doc.text(`${ref.rewardAmount}`, 140, y);
    doc.text(new Date(ref.createdAt).toLocaleDateString(), 170, y);
    
    y += 8;
  }
  
  // Save PDF
  doc.save(`referrals-${new Date().toISOString().split('T')[0]}.pdf`);
}

/**
 * Export referral data to CSV
 */
export function exportReferralsCSV(data: {
  referrals: {
    id: number;
    referralCode: string;
    refereeEmail?: string | null;
    status: string;
    rewardAmount: number;
    rewardCurrency: string;
    createdAt: Date;
  }[];
  stats: {
    totalReferrals: number;
    completedReferrals: number;
    pendingReferrals: number;
    totalRewardsEarned: number;
  };
}): void {
  const summaryRows = [
    ['=== REFERRAL SUMMARY ===', '', '', '', '', ''],
    ['Total Referrals', data.stats.totalReferrals, '', '', '', ''],
    ['Completed', data.stats.completedReferrals, '', '', '', ''],
    ['Pending', data.stats.pendingReferrals, '', '', '', ''],
    ['Total Rewards Earned', data.stats.totalRewardsEarned, '', '', '', ''],
    ['', '', '', '', '', ''],
    ['=== REFERRAL DETAILS ===', '', '', '', '', ''],
  ];

  const detailRows = data.referrals.map(ref => [
    ref.id,
    ref.referralCode,
    ref.refereeEmail || 'N/A',
    ref.status,
    ref.rewardAmount,
    ref.rewardCurrency,
    new Date(ref.createdAt).toLocaleString(),
  ]);

  const exportData: ExportData = {
    headers: ['ID', 'Code', 'Referee', 'Status', 'Reward', 'Currency', 'Date'],
    rows: [...summaryRows, ...detailRows],
  };

  const csv = convertToCSV(exportData);
  const filename = `referrals-${new Date().toISOString().split('T')[0]}.csv`;
  downloadCSV(filename, csv);
}
