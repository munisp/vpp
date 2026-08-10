/**
 * VPP Platform Database Seeding Script
 * 
 * Seeds the database with sample data for testing and demonstration
 * Run with: npx tsx scripts/seed-database.ts
 */

import { getDb } from '../server/db';
import {
  users,
  assets,
  telemetry,
  tradingOrders,
  invoices,
  payments,
  paymentMethods,
  alerts,
  demandResponseEvents,
  drParticipants,
} from '../drizzle/schema';

async function seed() {
  console.log('🌱 Starting database seeding...\n');
  
  const db = await getDb();
  if (!db) {
    console.error('❌ Database not available');
    process.exit(1);
  }

  try {
    // 1. Create sample users
    console.log('👥 Creating sample users...');
    const sampleUsers = [
      {
        openId: 'demo-user-1',
        name: 'John Doe',
        email: 'john@example.com',
        loginMethod: 'email',
        role: 'user' as const,
      },
      {
        openId: 'demo-user-2',
        name: 'Jane Smith',
        email: 'jane@example.com',
        loginMethod: 'email',
        role: 'user' as const,
      },
      {
        openId: 'demo-admin',
        name: 'Admin User',
        email: 'admin@vpp.com',
        loginMethod: 'email',
        role: 'admin' as const,
      },
    ];

    for (const user of sampleUsers) {
      await db.insert(users).values(user).onDuplicateKeyUpdate({
        set: { name: user.name, email: user.email },
      });
    }
    console.log('✓ Created 3 sample users\n');

    // Get user IDs
    const userList = await db.select().from(users).where();
    const userId1 = userList.find(u => u.openId === 'demo-user-1')?.id || 1;
    const userId2 = userList.find(u => u.openId === 'demo-user-2')?.id || 2;

    // 2. Create sample assets
    console.log('⚡ Creating sample assets...');
    const sampleAssets = [
      {
        userId: userId1,
        assetType: 'solar_panel' as const,
        manufacturer: 'SunPower',
        model: 'X-Series',
        capacity: 5000,
        installationDate: new Date('2023-01-15'),
        status: 'active' as const,
        location: 'Rooftop',
      },
      {
        userId: userId1,
        assetType: 'battery' as const,
        manufacturer: 'Tesla',
        model: 'Powerwall 2',
        capacity: 13500,
        installationDate: new Date('2023-01-15'),
        status: 'active' as const,
        location: 'Garage',
      },
      {
        userId: userId2,
        assetType: 'solar_panel' as const,
        manufacturer: 'LG',
        model: 'NeON 2',
        capacity: 3500,
        installationDate: new Date('2023-03-20'),
        status: 'active' as const,
        location: 'Rooftop',
      },
    ];

    for (const asset of sampleAssets) {
      await db.insert(assets).values(asset);
    }
    console.log('✓ Created 3 sample assets\n');

    // Get asset IDs
    const assetList = await db.select().from(assets).where();
    const assetId1 = assetList[0]?.id || 1;

    // 3. Create sample telemetry data
    console.log('📊 Creating sample telemetry data...');
    const now = new Date();
    const telemetryData = [];
    
    for (let i = 0; i < 24; i++) {
      const timestamp = new Date(now.getTime() - i * 60 * 60 * 1000); // Last 24 hours
      telemetryData.push({
        assetId: assetId1,
        timestamp,
        power: Math.floor(Math.random() * 3000) + 1000,
        energy: Math.floor(Math.random() * 5000) + 2000,
        voltage: 230 + Math.random() * 10,
        current: 10 + Math.random() * 5,
        frequency: 50,
        temperature: 25 + Math.random() * 10,
      });
    }

    for (const data of telemetryData) {
      await db.insert(telemetry).values(data);
    }
    console.log('✓ Created 24 telemetry records\n');

    // 4. Create sample trading orders
    console.log('💹 Creating sample trading orders...');
    const sampleOrders = [
      {
        userId: userId1,
        orderType: 'sell' as const,
        energyAmount: 100,
        pricePerKwh: 15,
        status: 'completed' as const,
        tradingMode: 'automatic' as const,
      },
      {
        userId: userId2,
        orderType: 'buy' as const,
        energyAmount: 50,
        pricePerKwh: 16,
        status: 'pending' as const,
        tradingMode: 'manual' as const,
      },
    ];

    for (const order of sampleOrders) {
      await db.insert(tradingOrders).values(order);
    }
    console.log('✓ Created 2 trading orders\n');

    // 5. Create sample invoices
    console.log('🧾 Creating sample invoices...');
    const sampleInvoices = [
      {
        userId: userId1,
        invoiceNumber: 'INV-2024-001',
        amount: 15000,
        dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        status: 'paid' as const,
        description: 'Energy consumption - January 2024',
      },
      {
        userId: userId2,
        invoiceNumber: 'INV-2024-002',
        amount: 8500,
        dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        status: 'pending' as const,
        description: 'Energy consumption - January 2024',
      },
    ];

    for (const invoice of sampleInvoices) {
      await db.insert(invoices).values(invoice);
    }
    console.log('✓ Created 2 invoices\n');

    // Get invoice IDs
    const invoiceList = await db.select().from(invoices).where();
    const invoiceId1 = invoiceList[0]?.id || 1;

    // 6. Create sample payments
    console.log('💳 Creating sample payments...');
    const samplePayments = [
      {
        userId: userId1,
        invoiceId: invoiceId1,
        amount: 15000,
        paymentMethod: 'mpesa' as const,
        status: 'completed' as const,
        transactionId: 'MPESA-' + Date.now(),
      },
    ];

    for (const payment of samplePayments) {
      await db.insert(payments).values(payment);
    }
    console.log('✓ Created 1 payment\n');

    // 7. Create sample payment methods
    console.log('💰 Creating sample payment methods...');
    const sampleMethods = [
      {
        userId: userId1,
        methodType: 'mpesa' as const,
        phoneNumber: '+255712345678',
        isDefault: true,
      },
      {
        userId: userId2,
        methodType: 'airtel_money' as const,
        phoneNumber: '+255787654321',
        isDefault: true,
      },
    ];

    for (const method of sampleMethods) {
      await db.insert(paymentMethods).values(method);
    }
    console.log('✓ Created 2 payment methods\n');

    // 8. Create sample alerts
    console.log('🔔 Creating sample alerts...');
    const sampleAlerts = [
      {
        userId: userId1,
        alertType: 'system' as const,
        severity: 'info' as const,
        title: 'Welcome to VPP Platform',
        message: 'Your account has been successfully created. Start by registering your energy assets.',
        isRead: true,
      },
      {
        userId: userId1,
        alertType: 'payment' as const,
        severity: 'success' as const,
        title: 'Payment Successful',
        message: 'Your payment of TZS 15,000 has been processed successfully.',
        isRead: false,
      },
      {
        userId: userId2,
        alertType: 'trading' as const,
        severity: 'warning' as const,
        title: 'Low Energy Price',
        message: 'Current market price is below your target. Consider adjusting your trading strategy.',
        isRead: false,
      },
    ];

    for (const alert of sampleAlerts) {
      await db.insert(alerts).values(alert);
    }
    console.log('✓ Created 3 alerts\n');

    // 9. Create sample demand response events
    console.log('⚡ Creating sample demand response events...');
    const adminUser = userList.find(u => u.role === 'admin');
    if (adminUser) {
      const sampleDREvents = [
        {
          operatorId: adminUser.id,
          eventName: 'Peak Hour Reduction',
          eventType: 'peak_shaving' as const,
          targetReduction: 500,
          startTime: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000), // 2 days from now
          endTime: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000), // 2 hours duration
          compensationRate: 50,
          status: 'scheduled' as const,
          description: 'Reduce load during evening peak hours',
        },
        {
          operatorId: adminUser.id,
          eventName: 'Emergency Load Shed',
          eventType: 'emergency' as const,
          targetReduction: 1000,
          startTime: new Date(Date.now() - 24 * 60 * 60 * 1000), // Yesterday
          endTime: new Date(Date.now() - 22 * 60 * 60 * 1000),
          compensationRate: 75,
          status: 'completed' as const,
          actualReduction: 950,
          description: 'Emergency grid stabilization',
        },
      ];

      for (const event of sampleDREvents) {
        await db.insert(demandResponseEvents).values(event);
      }
      console.log('✓ Created 2 DR events\n');
    }

    // 10. Create sample DR participants
    console.log('👥 Creating sample DR participants...');
    const sampleParticipants = [
      {
        userId: userId1,
        autoOptIn: true,
        minCompensation: 40,
        maxReduction: 200,
        status: 'active' as const,
      },
      {
        userId: userId2,
        autoOptIn: false,
        minCompensation: 50,
        maxReduction: 150,
        status: 'active' as const,
      },
    ];

    for (const participant of sampleParticipants) {
      await db.insert(drParticipants).values(participant);
    }
    console.log('✓ Created 2 DR participants\n');

    console.log('✅ Database seeding completed successfully!\n');
    console.log('Summary:');
    console.log('  - 3 users (2 regular, 1 admin)');
    console.log('  - 3 assets (2 solar panels, 1 battery)');
    console.log('  - 24 telemetry records');
    console.log('  - 2 trading orders');
    console.log('  - 2 invoices');
    console.log('  - 1 payment');
    console.log('  - 2 payment methods');
    console.log('  - 3 alerts');
    console.log('  - 2 DR events');
    console.log('  - 2 DR participants');
    console.log('');
    console.log('Test credentials:');
    console.log('  User: john@example.com (openId: demo-user-1)');
    console.log('  User: jane@example.com (openId: demo-user-2)');
    console.log('  Admin: admin@vpp.com (openId: demo-admin)');

  } catch (error) {
    console.error('❌ Seeding failed:', error);
    process.exit(1);
  }
}

// Run seeding
seed().catch(console.error);
