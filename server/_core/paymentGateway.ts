/**
 * Payment Gateway Integration Service
 * Handles M-Pesa, Airtel Money, and Tigo Pesa payment processing.
 *
 * All gateway calls are REAL. If a gateway is not configured via environment
 * variables the corresponding function throws a *_NOT_CONFIGURED error and
 * NEVER returns a fabricated success response.
 */

import axios from 'axios';

// Payment gateway credentials — no defaults: missing config must fail loudly.
const MPESA_BASE_URL = process.env.MPESA_BASE_URL || '';
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY || '';
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET || '';
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE || '';
const MPESA_PASSKEY = process.env.MPESA_PASSKEY || '';
const MPESA_CALLBACK_URL = process.env.MPESA_CALLBACK_URL || '';

const AIRTEL_BASE_URL = process.env.AIRTEL_BASE_URL || '';
const AIRTEL_CLIENT_ID = process.env.AIRTEL_CLIENT_ID || '';
const AIRTEL_CLIENT_SECRET = process.env.AIRTEL_CLIENT_SECRET || '';
const AIRTEL_CALLBACK_URL = process.env.AIRTEL_CALLBACK_URL || '';
const AIRTEL_COUNTRY = process.env.AIRTEL_COUNTRY || 'TZ';
const AIRTEL_CURRENCY = process.env.AIRTEL_CURRENCY || 'TZS';

const TIGO_BASE_URL = process.env.TIGO_BASE_URL || '';
const TIGO_API_KEY = process.env.TIGO_API_KEY || '';
const TIGO_MERCHANT_CODE = process.env.TIGO_MERCHANT_CODE || '';
const TIGO_CALLBACK_URL = process.env.TIGO_CALLBACK_URL || '';

export interface PaymentRequest {
  amount: number; // in cents
  phoneNumber: string;
  accountReference: string;
  description: string;
}

export interface PaymentResponse {
  success: boolean;
  transactionId?: string;
  checkoutRequestId?: string;
  message: string;
  error?: string;
}

function requireMpesaConfig(): void {
  if (
    !MPESA_BASE_URL ||
    !MPESA_CONSUMER_KEY ||
    !MPESA_CONSUMER_SECRET ||
    !MPESA_SHORTCODE ||
    !MPESA_PASSKEY ||
    !MPESA_CALLBACK_URL
  ) {
    throw new Error('MPESA_NOT_CONFIGURED');
  }
}

function requireAirtelConfig(): void {
  if (!AIRTEL_BASE_URL || !AIRTEL_CLIENT_ID || !AIRTEL_CLIENT_SECRET || !AIRTEL_CALLBACK_URL) {
    throw new Error('AIRTEL_NOT_CONFIGURED');
  }
}

function requireTigoConfig(): void {
  if (!TIGO_BASE_URL || !TIGO_API_KEY || !TIGO_MERCHANT_CODE || !TIGO_CALLBACK_URL) {
    throw new Error('TIGO_NOT_CONFIGURED');
  }
}

/**
 * Convert an internal cents amount to the major currency unit the mobile-money
 * APIs charge in. TZS/NGN mobile money has no sub-unit, so a fractional amount
 * cannot be charged exactly: rounding it would debit the customer a different
 * amount than the one recorded in `payments.amount` and would surface later as
 * a reconciliation discrepancy. Such amounts are rejected instead.
 */
export function toGatewayMajorUnits(amountCents: number): number {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`GATEWAY_AMOUNT_INVALID: ${amountCents} is not a positive integer amount in cents`);
  }
  if (amountCents % 100 !== 0) {
    throw new Error(
      `GATEWAY_AMOUNT_NOT_REPRESENTABLE: ${amountCents} cents cannot be charged exactly; ` +
        'mobile money settles in whole currency units'
    );
  }
  return amountCents / 100;
}

/** M-Pesa Daraja timestamp format: YYYYMMDDHHmmss */
function mpesaTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

async function getMpesaAccessToken(): Promise<string> {
  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
  const tokenResponse = await axios.get(
    `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  const token = tokenResponse.data?.access_token;
  if (!token) {
    throw new Error('M-Pesa OAuth response did not include an access_token');
  }
  return token;
}

async function getAirtelAccessToken(): Promise<string> {
  const authResponse = await axios.post(`${AIRTEL_BASE_URL}/auth/oauth2/token`, {
    client_id: AIRTEL_CLIENT_ID,
    client_secret: AIRTEL_CLIENT_SECRET,
    grant_type: 'client_credentials',
  });
  const token = authResponse.data?.access_token;
  if (!token) {
    throw new Error('Airtel OAuth response did not include an access_token');
  }
  return token;
}

/**
 * M-Pesa STK Push Payment
 * Initiates a payment request to the customer's phone.
 * Throws Error('MPESA_NOT_CONFIGURED') when credentials are missing.
 */
export async function initiateMpesaPayment(request: PaymentRequest): Promise<PaymentResponse> {
  requireMpesaConfig();
  try {
    const accessToken = await getMpesaAccessToken();

    const timestamp = mpesaTimestamp();
    const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');

    const stkResponse = await axios.post(
      `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: toGatewayMajorUnits(request.amount),
        PartyA: request.phoneNumber,
        PartyB: MPESA_SHORTCODE,
        PhoneNumber: request.phoneNumber,
        CallBackURL: MPESA_CALLBACK_URL,
        AccountReference: request.accountReference,
        TransactionDesc: request.description,
      },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const data = stkResponse.data;
    if (String(data?.ResponseCode) !== '0') {
      return {
        success: false,
        message: data?.CustomerMessage || data?.ResponseDescription || 'M-Pesa rejected the STK push request',
        error: data?.ResponseDescription,
      };
    }

    return {
      success: true,
      checkoutRequestId: data.CheckoutRequestID,
      transactionId: data.MerchantRequestID,
      message: data.CustomerMessage || 'Payment request sent to customer phone',
    };
  } catch (error: any) {
    console.error('[M-Pesa] Payment error:', error?.response?.data || error.message);
    return {
      success: false,
      message: 'Failed to initiate M-Pesa payment',
      error: error?.response?.data?.errorMessage || error.message,
    };
  }
}

/**
 * Airtel Money Payment
 * Initiates payment via Airtel Money Africa API.
 * Throws Error('AIRTEL_NOT_CONFIGURED') when credentials are missing.
 */
export async function initiateAirtelPayment(request: PaymentRequest): Promise<PaymentResponse> {
  requireAirtelConfig();
  try {
    const accessToken = await getAirtelAccessToken();

    const paymentResponse = await axios.post(
      `${AIRTEL_BASE_URL}/merchant/v1/payments/`,
      {
        reference: request.accountReference,
        subscriber: {
          country: AIRTEL_COUNTRY,
          currency: AIRTEL_CURRENCY,
          msisdn: request.phoneNumber.replace(/^\+/, ''),
        },
        transaction: {
          amount: toGatewayMajorUnits(request.amount),
          country: AIRTEL_COUNTRY,
          currency: AIRTEL_CURRENCY,
          id: request.accountReference,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'X-Country': AIRTEL_COUNTRY,
          'X-Currency': AIRTEL_CURRENCY,
          'Content-Type': 'application/json',
        },
      }
    );

    const data = paymentResponse.data;
    const txn = data?.data?.transaction;
    if (!data?.status?.success) {
      return {
        success: false,
        message: data?.status?.message || 'Airtel Money rejected the payment request',
        error: data?.status?.message,
      };
    }

    return {
      success: true,
      transactionId: txn?.airtel_money_id || txn?.id,
      message: data?.status?.message || 'Payment initiated successfully',
    };
  } catch (error: any) {
    console.error('[Airtel Money] Payment error:', error?.response?.data || error.message);
    return {
      success: false,
      message: 'Failed to initiate Airtel Money payment',
      error: error?.response?.data?.status?.message || error.message,
    };
  }
}

/**
 * Tigo Pesa Payment
 * Initiates payment via Tigo Pesa API.
 * Throws Error('TIGO_NOT_CONFIGURED') when credentials are missing.
 */
export async function initiateTigoPesaPayment(request: PaymentRequest): Promise<PaymentResponse> {
  requireTigoConfig();
  try {
    const paymentResponse = await axios.post(
      `${TIGO_BASE_URL}/v1/payments/requests`,
      {
        MerchantCode: TIGO_MERCHANT_CODE,
        MerchantReference: request.accountReference,
        Amount: toGatewayMajorUnits(request.amount),
        Currency: 'TZS',
        CustomerMSISDN: request.phoneNumber.replace(/^\+/, ''),
        Description: request.description,
        CallbackURL: TIGO_CALLBACK_URL,
      },
      {
        headers: {
          'X-API-Key': TIGO_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    const data = paymentResponse.data;

    // A 2xx response is not an accepted payment: Tigo reports rejection in the
    // body. Only an explicit accepted/success status counts as initiated.
    const status = String(data?.Status || data?.status || '').toUpperCase();
    const transactionId = data?.TransactionID || data?.transactionId || data?.id;
    const accepted =
      ['SUCCESS', 'COMPLETED', 'PENDING', 'ACCEPTED', 'INITIATED'].includes(status) ||
      (status === '' && Boolean(transactionId));

    if (!accepted || !transactionId) {
      return {
        success: false,
        message: data?.Message || data?.message || 'Tigo Pesa rejected the payment request',
        error: data?.Message || data?.message || `Unexpected Tigo Pesa status: ${status || 'none'}`,
      };
    }

    return {
      success: true,
      transactionId,
      message: data?.Message || 'Payment initiated successfully',
    };
  } catch (error: any) {
    console.error('[Tigo Pesa] Payment error:', error?.response?.data || error.message);
    return {
      success: false,
      message: 'Failed to initiate Tigo Pesa payment',
      error: error?.response?.data?.Message || error.message,
    };
  }
}

/**
 * Verify payment status
 * Queries the real gateway status APIs. Only explicit gateway success codes
 * map to 'completed'. Any gateway/network/configuration error returns
 * 'pending' — never a fabricated 'completed'.
 */
export async function verifyPaymentStatus(
  transactionId: string,
  provider: 'mpesa' | 'airtel_money' | 'tigo_pesa'
): Promise<{ status: 'pending' | 'completed' | 'failed'; message: string }> {
  try {
    switch (provider) {
      case 'mpesa':
        return await verifyMpesaStatus(transactionId);
      case 'airtel_money':
        return await verifyAirtelStatus(transactionId);
      case 'tigo_pesa':
        return await verifyTigoStatus(transactionId);
      default:
        console.error(`[Payment] Unknown provider for verification: ${provider}`);
        return { status: 'pending', message: `Unknown payment provider: ${provider}` };
    }
  } catch (error: any) {
    console.error(`[${provider}] Verification error:`, error?.response?.data || error.message);
    return {
      status: 'pending',
      message: `Payment status could not be verified (${error.message})`,
    };
  }
}

async function verifyMpesaStatus(
  checkoutRequestId: string
): Promise<{ status: 'pending' | 'completed' | 'failed'; message: string }> {
  if (!MPESA_BASE_URL || !MPESA_CONSUMER_KEY || !MPESA_CONSUMER_SECRET || !MPESA_SHORTCODE || !MPESA_PASSKEY) {
    console.error('[M-Pesa] Cannot verify status: gateway not configured');
    return { status: 'pending', message: 'M-Pesa gateway not configured' };
  }

  const accessToken = await getMpesaAccessToken();
  const timestamp = mpesaTimestamp();
  const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');

  const response = await axios.post(
    `${MPESA_BASE_URL}/mpesa/stkpushquery/v1/query`,
    {
      BusinessShortCode: MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  const resultCode = String(response.data?.ResultCode ?? '');
  const resultDesc = response.data?.ResultDesc || 'Unknown result';

  if (resultCode === '0') {
    return { status: 'completed', message: resultDesc };
  }
  if (resultCode === '1032') {
    // 1032 = request cancelled by the subscriber
    return { status: 'failed', message: resultDesc };
  }
  return { status: 'pending', message: resultDesc };
}

async function verifyAirtelStatus(
  transactionId: string
): Promise<{ status: 'pending' | 'completed' | 'failed'; message: string }> {
  if (!AIRTEL_BASE_URL || !AIRTEL_CLIENT_ID || !AIRTEL_CLIENT_SECRET) {
    console.error('[Airtel Money] Cannot verify status: gateway not configured');
    return { status: 'pending', message: 'Airtel Money gateway not configured' };
  }

  const accessToken = await getAirtelAccessToken();
  const response = await axios.get(
    `${AIRTEL_BASE_URL}/standard/v1/payments/${encodeURIComponent(transactionId)}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Country': AIRTEL_COUNTRY,
        'X-Currency': AIRTEL_CURRENCY,
      },
    }
  );

  const txnStatus = String(response.data?.data?.transaction?.status || '').toUpperCase();
  const message = response.data?.data?.transaction?.message || response.data?.status?.message || 'Unknown result';

  if (txnStatus === 'TS') {
    return { status: 'completed', message };
  }
  if (txnStatus === 'TF') {
    return { status: 'failed', message };
  }
  return { status: 'pending', message };
}

async function verifyTigoStatus(
  transactionId: string
): Promise<{ status: 'pending' | 'completed' | 'failed'; message: string }> {
  if (!TIGO_BASE_URL || !TIGO_API_KEY) {
    console.error('[Tigo Pesa] Cannot verify status: gateway not configured');
    return { status: 'pending', message: 'Tigo Pesa gateway not configured' };
  }

  const response = await axios.get(
    `${TIGO_BASE_URL}/v1/payments/requests/${encodeURIComponent(transactionId)}`,
    { headers: { 'X-API-Key': TIGO_API_KEY } }
  );

  const txnStatus = String(
    response.data?.Status || response.data?.status || response.data?.TransactionStatus || ''
  ).toUpperCase();
  const message = response.data?.Message || response.data?.message || 'Unknown result';

  if (txnStatus === 'SUCCESS' || txnStatus === 'COMPLETED') {
    return { status: 'completed', message };
  }
  if (txnStatus === 'FAILED' || txnStatus === 'CANCELLED' || txnStatus === 'REJECTED') {
    return { status: 'failed', message };
  }
  return { status: 'pending', message };
}

/**
 * Generate STS prepaid electricity token
 *
 * Real STS (IEC 62055-41) token generation requires a certified STS vending
 * system / HSM with the utility's vending keys. This codebase has no such
 * integration, so this function FAILS LOUDLY instead of fabricating a token.
 * Callers must integrate a certified STS vending provider and are expected to
 * catch this error and mark the token as 'pending_issuance'.
 */
export function generateSTSToken(_energyKwh: number, _amount: number): string {
  throw new Error('STS_VENDING_NOT_CONFIGURED');
}
