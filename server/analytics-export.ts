/**
 * Analytics Export Service
 * Handles exporting analytics data to CSV and Excel formats
 */

export interface ExportData {
  headers: string[];
  rows: any[][];
}

export class AnalyticsExportService {
  /**
   * Convert data to CSV format
   */
  static toCSV(data: ExportData): string {
    const { headers, rows } = data;
    
    // Escape CSV values
    const escapeCSV = (value: any): string => {
      if (value === null || value === undefined) return '';
      const str = String(value);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    // Build CSV
    const csvLines: string[] = [];
    csvLines.push(headers.map(escapeCSV).join(','));
    
    for (const row of rows) {
      csvLines.push(row.map(escapeCSV).join(','));
    }

    return csvLines.join('\n');
  }

  /**
   * Export payment metrics to CSV
   */
  static exportPaymentMetricsCSV(metrics: {
    totalRevenue: number;
    totalTransactions: number;
    successRate: number;
    averageTransactionValue: number;
    gatewayBreakdown: Array<{ gateway: string; count: number; revenue: number }>;
    dailyRevenue: Array<{ date: string; revenue: number; transactions: number }>;
  }): string {
    const rows: any[][] = [];

    // Summary section
    rows.push(['Payment Metrics Summary', '']);
    rows.push(['Total Revenue (TZS)', (metrics.totalRevenue / 100).toFixed(2)]);
    rows.push(['Total Transactions', metrics.totalTransactions]);
    rows.push(['Success Rate (%)', metrics.successRate.toFixed(2)]);
    rows.push([]);

    // By Gateway section
    rows.push(['Gateway Breakdown', '']);
    rows.push(['Gateway', 'Transactions', 'Revenue (TZS)']);
    for (const item of metrics.gatewayBreakdown) {
      rows.push([
        item.gateway.toUpperCase(),
        item.count,
        (item.revenue / 100).toFixed(2),
      ]);
    }
    rows.push([]);

    // Daily Revenue section
    rows.push(['Daily Revenue', '']);
    rows.push(['Date', 'Revenue (TZS)', 'Transactions']);
    for (const item of metrics.dailyRevenue) {
      rows.push([
        item.date,
        (item.revenue / 100).toFixed(2),
        item.transactions,
      ]);
    }

    return this.toCSV({
      headers: ['Metric', 'Value', 'Additional'],
      rows,
    });
  }

  /**
   * Export DR event metrics to CSV
   */
  static exportDRMetricsCSV(metrics: {
    totalEvents: number;
    totalParticipants: number;
    totalReduction: number;
    totalCompensation: number;
    performanceOverTime: Array<{
      date: string;
      events: number;
      participants: number;
      reduction: number;
    }>;
  }): string {
    const rows: any[][] = [];

    // Summary section
    rows.push(['DR Event Metrics Summary', '']);
    rows.push(['Total Events', metrics.totalEvents]);
    rows.push(['Total Participants', metrics.totalParticipants]);
    rows.push(['Total Reduction (kW)', metrics.totalReduction.toFixed(2)]);
    rows.push(['Total Compensation (TZS)', (metrics.totalCompensation / 100).toFixed(2)]);
    rows.push([]);

    // Performance Over Time section
    rows.push(['Performance Over Time', '']);
    rows.push(['Date', 'Events', 'Participants', 'Reduction (kW)']);
    for (const item of metrics.performanceOverTime) {
      rows.push([
        item.date,
        item.events,
        item.participants,
        item.reduction.toFixed(2),
      ]);
    }

    return this.toCSV({
      headers: ['Metric', 'Value', 'Additional', 'Extra'],
      rows,
    });
  }

  /**
   * Export forecasting metrics to CSV
   */
  static exportForecastingMetricsCSV(metrics: {
    totalForecasts: number;
    avgAccuracy: number;
    byStatus: Array<{ status: string; count: number }>;
  }): string {
    const rows: any[][] = [];

    // Summary section
    rows.push(['Forecasting Metrics Summary', '']);
    rows.push(['Total Forecasts', metrics.totalForecasts]);
    rows.push(['Average Accuracy (%)', metrics.avgAccuracy.toFixed(2)]);
    rows.push([]);

    // By Status section
    rows.push(['Forecast Status Breakdown', '']);
    rows.push(['Status', 'Count']);
    for (const item of metrics.byStatus) {
      rows.push([item.status.toUpperCase(), item.count]);
    }

    return this.toCSV({
      headers: ['Metric', 'Value'],
      rows,
    });
  }

  /**
   * Export system KPIs to CSV
   */
  static exportSystemKPIsCSV(kpis: {
    totalUsers: number;
    totalRevenue: number;
    totalEnergyTraded: number;
    drParticipationRate: number;
  }): string {
    const rows: any[][] = [];

    rows.push(['System KPIs', '']);
    rows.push(['Total Users', kpis.totalUsers]);
    rows.push(['Total Revenue (TZS)', (kpis.totalRevenue / 100).toFixed(2)]);
    rows.push(['Total Energy Traded (kWh)', kpis.totalEnergyTraded.toFixed(2)]);
    rows.push(['DR Participation Rate (%)', kpis.drParticipationRate.toFixed(2)]);

    return this.toCSV({
      headers: ['Metric', 'Value'],
      rows,
    });
  }

  /**
   * Generate comprehensive analytics report
   */
  static generateComprehensiveReport(data: {
    kpis: any;
    paymentMetrics: any;
    drMetrics: any;
    forecastingMetrics: any;
    dateRange: { start: string; end: string };
  }): string {
    const sections: string[] = [];

    // Header
    sections.push('VPP Platform Analytics Report');
    sections.push(`Generated: ${new Date().toLocaleString()}`);
    sections.push(`Period: ${data.dateRange.start} to ${data.dateRange.end}`);
    sections.push('');
    sections.push('');

    // System KPIs
    sections.push(this.exportSystemKPIsCSV(data.kpis));
    sections.push('');
    sections.push('');

    // Payment Metrics
    sections.push(this.exportPaymentMetricsCSV(data.paymentMetrics));
    sections.push('');
    sections.push('');

    // DR Metrics
    sections.push(this.exportDRMetricsCSV(data.drMetrics));
    sections.push('');
    sections.push('');

    // Forecasting Metrics
    sections.push(this.exportForecastingMetricsCSV(data.forecastingMetrics));

    return sections.join('\n');
  }
}
