import { Connection, Client } from '@temporalio/client';

export interface TemporalConfig {
  address: string;
  namespace: string;
  tls?: {
    clientCertPath: string;
    clientKeyPath: string;
    serverRootCACertPath?: string;
    serverNameOverride?: string;
  };
}

export const temporalConfig: TemporalConfig = {
  address: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
  namespace: process.env.TEMPORAL_NAMESPACE || 'default',
  tls: process.env.TEMPORAL_TLS_ENABLED === 'true' ? {
    clientCertPath: process.env.TEMPORAL_TLS_CERT_PATH || '',
    clientKeyPath: process.env.TEMPORAL_TLS_KEY_PATH || '',
    serverRootCACertPath: process.env.TEMPORAL_TLS_CA_PATH,
    serverNameOverride: process.env.TEMPORAL_TLS_SERVER_NAME
  } : undefined
};

let temporalClient: Client | null = null;

export async function getTemporalClient(): Promise<Client> {
  if (temporalClient) {
    return temporalClient;
  }

  try {
    const connection = await Connection.connect({
      address: temporalConfig.address,
      tls: temporalConfig.tls
    });

    temporalClient = new Client({
      connection,
      namespace: temporalConfig.namespace
    });

    console.log('[Temporal] Client connected');
    return temporalClient;
  } catch (error) {
    console.error('[Temporal] Failed to connect client:', error);
    throw error;
  }
}

export async function closeTemporalClient(): Promise<void> {
  if (temporalClient) {
    temporalClient.connection.close();
    temporalClient = null;
    console.log('[Temporal] Client disconnected');
  }
}

// Workflow task queues
export const TASK_QUEUES = {
  PAYMENT_PROCESSING: 'payment-processing',
  DR_ORCHESTRATION: 'dr-orchestration',
  TRADING_EXECUTION: 'trading-execution',
  RECONCILIATION: 'reconciliation',
  NOTIFICATIONS: 'notifications',
  ANALYTICS: 'analytics'
} as const;
