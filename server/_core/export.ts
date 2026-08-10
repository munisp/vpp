/**
 * Data Export Service
 * Generate PDF and CSV reports for analytics data
 */

import PDFDocument from 'pdfkit';
import { Writable } from 'stream';

/**
 * Generate CSV from data array
 */
export function generateCSV(data: any[], columns: string[]): string {
  // Header row
  const header = columns.join(',');
  
  // Data rows
  const rows = data.map(row => {
    return columns.map(col => {
      const value = row[col];
      // Escape commas and quotes
      if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value ?? '';
    }).join(',');
  });
  
  return [header, ...rows].join('\n');
}

/**
 * Generate PDF report
 */
export async function generatePDFReport(options: {
  title: string;
  subtitle?: string;
  sections: Array<{
    title: string;
    content: string | string[];
    table?: {
      headers: string[];
      rows: string[][];
    };
  }>;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 50, bottom: 50, left: 50, right: 50 },
    });

    const buffers: Buffer[] = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => {
      const pdfBuffer = Buffer.concat(buffers);
      resolve(pdfBuffer);
    });
    doc.on('error', reject);

    // Header
    doc
      .fontSize(24)
      .font('Helvetica-Bold')
      .text(options.title, { align: 'center' });

    if (options.subtitle) {
      doc
        .moveDown(0.5)
        .fontSize(12)
        .font('Helvetica')
        .text(options.subtitle, { align: 'center' });
    }

    doc.moveDown(2);

    // Sections
    for (const section of options.sections) {
      // Section title
      doc
        .fontSize(16)
        .font('Helvetica-Bold')
        .text(section.title);

      doc.moveDown(0.5);

      // Section content
      if (typeof section.content === 'string') {
        doc
          .fontSize(11)
          .font('Helvetica')
          .text(section.content);
      } else {
        section.content.forEach(line => {
          doc
            .fontSize(11)
            .font('Helvetica')
            .text(line);
        });
      }

      // Table
      if (section.table) {
        doc.moveDown(0.5);

        const tableTop = doc.y;
        const itemHeight = 25;
        const columnWidth = (doc.page.width - 100) / section.table.headers.length;

        // Table headers
        doc
          .fontSize(10)
          .font('Helvetica-Bold');

        section.table.headers.forEach((header, i) => {
          doc.text(
            header,
            50 + i * columnWidth,
            tableTop,
            {
              width: columnWidth,
              align: 'left',
            }
          );
        });

        // Table rows
        doc.font('Helvetica');

        section.table.rows.forEach((row, rowIndex) => {
          const y = tableTop + (rowIndex + 1) * itemHeight;

          // Check if we need a new page
          if (y > doc.page.height - 100) {
            doc.addPage();
          }

          row.forEach((cell, colIndex) => {
            doc.text(
              cell,
              50 + colIndex * columnWidth,
              y,
              {
                width: columnWidth,
                align: 'left',
              }
            );
          });
        });

        doc.y = tableTop + (section.table.rows.length + 1) * itemHeight;
      }

      doc.moveDown(1.5);
    }

    // Footer
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);

      doc
        .fontSize(9)
        .font('Helvetica')
        .text(
          `Page ${i + 1} of ${pages.count} • Generated on ${new Date().toLocaleDateString()}`,
          50,
          doc.page.height - 50,
          {
            align: 'center',
          }
        );
    }

    doc.end();
  });
}

/**
 * Generate revenue report PDF
 */
export async function generateRevenueReport(data: {
  startDate: Date;
  endDate: Date;
  totalRevenue: number;
  totalPayments: number;
  pendingPayments: number;
  transactions: Array<{
    date: Date;
    amount: number;
    method: string;
    status: string;
  }>;
}): Promise<Buffer> {
  return generatePDFReport({
    title: 'Revenue Report',
    subtitle: `${data.startDate.toLocaleDateString()} - ${data.endDate.toLocaleDateString()}`,
    sections: [
      {
        title: 'Summary',
        content: [
          `Total Revenue: TZS ${(data.totalRevenue / 100).toLocaleString()}`,
          `Total Payments: ${data.totalPayments}`,
          `Pending Payments: ${data.pendingPayments}`,
        ],
      },
      {
        title: 'Transaction History',
        content: 'Recent payment transactions',
        table: {
          headers: ['Date', 'Amount', 'Method', 'Status'],
          rows: data.transactions.map(t => [
            t.date.toLocaleDateString(),
            `TZS ${(t.amount / 100).toLocaleString()}`,
            t.method,
            t.status,
          ]),
        },
      },
    ],
  });
}

/**
 * Generate energy report PDF
 */
export async function generateEnergyReport(data: {
  startDate: Date;
  endDate: Date;
  totalGeneration: number;
  totalConsumption: number;
  totalTraded: number;
  dailyData: Array<{
    date: Date;
    generation: number;
    consumption: number;
    traded: number;
  }>;
}): Promise<Buffer> {
  return generatePDFReport({
    title: 'Energy Report',
    subtitle: `${data.startDate.toLocaleDateString()} - ${data.endDate.toLocaleDateString()}`,
    sections: [
      {
        title: 'Summary',
        content: [
          `Total Generation: ${(data.totalGeneration / 1000).toFixed(2)} kWh`,
          `Total Consumption: ${(data.totalConsumption / 1000).toFixed(2)} kWh`,
          `Total Energy Traded: ${(data.totalTraded / 1000).toFixed(2)} kWh`,
        ],
      },
      {
        title: 'Daily Energy Data',
        content: 'Daily generation, consumption, and trading activity',
        table: {
          headers: ['Date', 'Generation (kWh)', 'Consumption (kWh)', 'Traded (kWh)'],
          rows: data.dailyData.map(d => [
            d.date.toLocaleDateString(),
            (d.generation / 1000).toFixed(2),
            (d.consumption / 1000).toFixed(2),
            (d.traded / 1000).toFixed(2),
          ]),
        },
      },
    ],
  });
}
