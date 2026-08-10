/**
 * Middleware Integration Layer
 * Connects VPP Consumer Platform to NextGen VPP Platform middleware
 */

import { kafkaPublisher } from './kafka-publisher';
import { temporalClient, type PaymentWorkflowInput, type DREventWorkflowInput } from './temporal-client';
import { redisCache, CacheKeys } from './redis-cache';
import { keycloakAuth, keycloakProtect, type KeycloakUser } from './keycloak-auth';

// Re-export
export { kafkaPublisher };
export { temporalClient, type PaymentWorkflowInput, type DREventWorkflowInput };
export { redisCache, CacheKeys };
export { keycloakAuth, keycloakProtect, type KeycloakUser };

// Integration health check
export async function checkMiddlewareHealth() {
  const health = {
    kafka: false,
    temporal: false,
    redis: false,
    keycloak: false,
    timestamp: new Date().toISOString()
  };

  try {
    health.kafka = await kafkaPublisher.isHealthy();
  } catch (error) {
    console.error('[Health] Kafka check failed:', error);
  }

  try {
    health.temporal = await temporalClient.isHealthy();
  } catch (error) {
    console.error('[Health] Temporal check failed:', error);
  }

  try {
    health.redis = await redisCache.isHealthy();
  } catch (error) {
    console.error('[Health] Redis check failed:', error);
  }

  try {
    health.keycloak = await keycloakAuth.isHealthy();
  } catch (error) {
    console.error('[Health] Keycloak check failed:', error);
  }

  return health;
}

// Initialize all middleware connections
export async function initializeMiddleware() {
  console.log('[Middleware] Initializing integration layer...');

  try {
    // Connect Redis
    await redisCache.connect();
    console.log('[Middleware] Redis connected');
  } catch (error) {
    console.error('[Middleware] Redis initialization failed:', error);
  }

  try {
    // Connect Kafka
    await kafkaPublisher.connect();
    console.log('[Middleware] Kafka connected');
  } catch (error) {
    console.error('[Middleware] Kafka initialization failed:', error);
  }

  console.log('[Middleware] Integration layer initialized');
}

// Graceful shutdown
export async function shutdownMiddleware() {
  console.log('[Middleware] Shutting down integration layer...');

  try {
    await kafkaPublisher.disconnect();
    console.log('[Middleware] Kafka disconnected');
  } catch (error) {
    console.error('[Middleware] Kafka shutdown failed:', error);
  }

  try {
    await redisCache.disconnect();
    console.log('[Middleware] Redis disconnected');
  } catch (error) {
    console.error('[Middleware] Redis shutdown failed:', error);
  }

  console.log('[Middleware] Integration layer shut down');
}
