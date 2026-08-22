/**
 * Which payment gateway environment this deployment transacts in.
 *
 * The environment decides whether real money moves, so it is a deployment
 * property and never a request parameter: a client that could ask for
 * "sandbox" would get gateway-confirmed payments that never debited anyone.
 */

export type GatewayEnvironment = 'sandbox' | 'production';

export function resolveGatewayEnvironment(): GatewayEnvironment {
  const configured = process.env.PAYMENT_GATEWAY_ENVIRONMENT?.trim().toLowerCase();

  if (configured === 'sandbox' || configured === 'production') {
    if (process.env.NODE_ENV === 'production' && configured === 'sandbox') {
      throw new Error(
        'PAYMENT_GATEWAY_ENVIRONMENT=sandbox is not allowed with NODE_ENV=production: ' +
          'sandbox payments are never settled with real money.'
      );
    }
    return configured;
  }

  if (configured) {
    throw new Error(
      `PAYMENT_GATEWAY_ENVIRONMENT must be "sandbox" or "production", got "${configured}".`
    );
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'PAYMENT_GATEWAY_ENVIRONMENT must be set explicitly when NODE_ENV=production.'
    );
  }

  return 'sandbox';
}
