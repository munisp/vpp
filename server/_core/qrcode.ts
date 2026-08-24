import QRCode from "qrcode";
import crypto from "crypto";

/**
 * QR Code Payment Service
 * 
 * Provides QR code generation and parsing for payment processing.
 * Supports multiple payment types: merchant payments, P2P transfers, bill payments, and token purchases.
 */

export interface QRPaymentData {
  type: "merchant" | "p2p" | "bill" | "token";
  amount: number;
  currency: "NGN" | "TZS" | "USD";
  merchantId?: string;
  merchantName?: string;
  recipientId?: string;
  recipientName?: string;
  billId?: string;
  billType?: string;
  reference?: string;
  description?: string;
  expiresAt?: Date;
  /** User the QR code was issued to; the signature only attests this issuer. */
  issuedByUserId?: number;
}

/** Signed envelope actually encoded in the QR image. */
interface SignedQRPayload {
  v: 1;
  data: QRPaymentData;
  signature: string;
}

/**
 * HMAC key for QR payloads. Absence is fatal: an unsigned payment QR code is
 * fully attacker-controllable (amount, recipient, bill), so there is no safe
 * fallback to emit or accept one.
 */
function getQRSigningSecret(): string {
  const secret = process.env.QR_SIGNING_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "QR_SIGNING_SECRET must be set to at least 32 characters to sign and verify payment QR codes"
    );
  }
  return secret;
}

/**
 * Whether this deployment can sign a payment QR code at all. Callers use it to
 * refuse the feature with a reason instead of failing inside the encoder.
 */
export function qrSigningConfigured(): boolean {
  const secret = process.env.QR_SIGNING_SECRET;
  return typeof secret === "string" && secret.length >= 32;
}

function canonicalize(data: QRPaymentData): string {
  const normalized: Record<string, unknown> = {
    ...data,
    expiresAt: data.expiresAt ? new Date(data.expiresAt).toISOString() : undefined,
  };
  const keys = Object.keys(normalized)
    .filter((key) => normalized[key] !== undefined)
    .sort();
  return JSON.stringify(keys.map((key) => [key, normalized[key]]));
}

function signPaymentData(data: QRPaymentData): string {
  return crypto.createHmac("sha256", getQRSigningSecret()).update(canonicalize(data)).digest("hex");
}

function buildSignedPayload(data: QRPaymentData): string {
  const payload: SignedQRPayload = { v: 1, data, signature: signPaymentData(data) };
  return JSON.stringify(payload);
}

export interface QRCodeOptions {
  size?: number;
  errorCorrectionLevel?: "L" | "M" | "Q" | "H";
  margin?: number;
  color?: {
    dark?: string;
    light?: string;
  };
}

/**
 * Generate a QR code for payment
 * 
 * @param paymentData - Payment information to encode
 * @param options - QR code generation options
 * @returns Base64-encoded QR code image
 */
export async function generatePaymentQRCode(
  paymentData: QRPaymentData,
  options: QRCodeOptions = {}
): Promise<string> {
  return (await generateSignedPaymentQRCode(paymentData, options)).image;
}

/**
 * The image and the payload encoded in it. The payload is what a scanner reads
 * and what `parsePaymentQRCode` verifies, so a caller that needs to record,
 * re-present or verify the code it just issued has to be given it — deriving a
 * payload of its own would store something no scanner would ever produce.
 */
export interface SignedPaymentQRCode {
  image: string;
  payload: string;
  reference: string;
  expiresAt: Date;
}

export async function generateSignedPaymentQRCode(
  paymentData: QRPaymentData,
  options: QRCodeOptions = {}
): Promise<SignedPaymentQRCode> {
  // Read the key before the try: a deployment with no signing key is refusing
  // to issue payment codes, which is a different thing from a code that could
  // not be rendered, and the caller has to be able to tell them apart.
  getQRSigningSecret();
  const reference = paymentData.reference || generatePaymentReference();
  const expiresAt = paymentData.expiresAt
    ? new Date(paymentData.expiresAt)
    : new Date(Date.now() + 15 * 60 * 1000);
  try {
    const data: QRPaymentData = { ...paymentData, reference, expiresAt };

    const payload = buildSignedPayload(data);

    // Generate QR code with options
    const qrOptions = {
      errorCorrectionLevel: options.errorCorrectionLevel || "M",
      type: "image/png" as const,
      quality: 0.92,
      margin: options.margin || 1,
      width: options.size || 300,
      color: {
        dark: options.color?.dark || "#000000",
        light: options.color?.light || "#FFFFFF",
      },
    };

    // Generate QR code as base64 data URL
    const qrCodeDataURL = await QRCode.toDataURL(payload, qrOptions);

    return { image: qrCodeDataURL, payload, reference, expiresAt };
  } catch (error) {
    console.error("[QRCode] Failed to generate QR code:", error);
    throw new Error("Failed to generate payment QR code");
  }
}

/**
 * Generate a QR code as a buffer (for server-side storage)
 * 
 * @param paymentData - Payment information to encode
 * @param options - QR code generation options
 * @returns Buffer containing PNG image data
 */
export async function generatePaymentQRCodeBuffer(
  paymentData: QRPaymentData,
  options: QRCodeOptions = {}
): Promise<Buffer> {
  getQRSigningSecret();
  try {
    const data: QRPaymentData = {
      ...paymentData,
      reference: paymentData.reference || generatePaymentReference(),
      expiresAt: paymentData.expiresAt || new Date(Date.now() + 15 * 60 * 1000),
    };

    const payload = buildSignedPayload(data);

    const qrOptions = {
      errorCorrectionLevel: options.errorCorrectionLevel || "M",
      type: "png" as const,
      margin: options.margin || 1,
      width: options.size || 300,
      color: {
        dark: options.color?.dark || "#000000",
        light: options.color?.light || "#FFFFFF",
      },
    };

    const buffer = await QRCode.toBuffer(payload, qrOptions);
    return buffer;
  } catch (error) {
    console.error("[QRCode] Failed to generate QR code buffer:", error);
    throw new Error("Failed to generate payment QR code buffer");
  }
}

/**
 * Parse QR code payment data from scanned string
 * 
 * @param qrData - Scanned QR code data (JSON string)
 * @returns Parsed payment data
 */
export function parsePaymentQRCode(qrData: string): QRPaymentData {
  try {
    const envelope = JSON.parse(qrData) as Partial<SignedQRPayload>;

    if (envelope?.v !== 1 || !envelope.data || typeof envelope.signature !== "string") {
      throw new Error("Invalid QR code: not a signed payment payload");
    }

    const data = envelope.data;
    const expected = Buffer.from(signPaymentData(data), "hex");
    const provided = Buffer.from(envelope.signature, "hex");

    if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
      throw new Error("Invalid QR code: signature verification failed");
    }

    // Validate required fields
    if (!data.type || !data.amount || !data.currency) {
      throw new Error("Invalid QR code: missing required fields");
    }

    // Validate payment type
    if (!["merchant", "p2p", "bill", "token"].includes(data.type)) {
      throw new Error("Invalid QR code: unknown payment type");
    }

    // Validate currency
    if (!["NGN", "TZS", "USD"].includes(data.currency)) {
      throw new Error("Invalid QR code: unsupported currency");
    }

    // Check expiration
    if (data.expiresAt) {
      const expiryDate = new Date(data.expiresAt);
      if (expiryDate < new Date()) {
        throw new Error("QR code has expired");
      }
    }

    return data;
  } catch (error) {
    console.error("[QRCode] Failed to parse QR code:", error);
    throw new Error(
      error instanceof Error ? error.message : "Failed to parse payment QR code"
    );
  }
}

/**
 * Validate QR code payment data
 * 
 * @param data - Payment data to validate
 * @returns True if valid, throws error otherwise
 */
export function validatePaymentData(data: QRPaymentData): boolean {
  // Validate amount
  if (data.amount <= 0) {
    throw new Error("Invalid amount: must be greater than 0");
  }

  // Validate merchant payment
  if (data.type === "merchant") {
    if (!data.merchantId || !data.merchantName) {
      throw new Error("Merchant payment requires merchantId and merchantName");
    }
  }

  // Validate P2P payment
  if (data.type === "p2p") {
    if (!data.recipientId || !data.recipientName) {
      throw new Error("P2P payment requires recipientId and recipientName");
    }
  }

  // Validate bill payment
  if (data.type === "bill") {
    if (!data.billId || !data.billType) {
      throw new Error("Bill payment requires billId and billType");
    }
  }

  // Validate expiration
  if (data.expiresAt) {
    const expiryDate = new Date(data.expiresAt);
    if (expiryDate < new Date()) {
      throw new Error("Payment has expired");
    }
  }

  return true;
}

/**
 * Generate a unique payment reference
 * 
 * @returns Payment reference string
 */
export function generatePaymentReference(): string {
  const timestamp = Date.now().toString(36);
  const randomPart = crypto.randomBytes(6).toString("hex");
  return `QR-${timestamp}-${randomPart}`.toUpperCase();
}

/**
 * Create merchant QR code data
 * 
 * @param merchantId - Merchant ID
 * @param merchantName - Merchant name
 * @param amount - Payment amount
 * @param currency - Currency code
 * @param description - Payment description
 * @returns QR payment data
 */
export function createMerchantPayment(
  merchantId: string,
  merchantName: string,
  amount: number,
  currency: "NGN" | "TZS" | "USD",
  description?: string
): QRPaymentData {
  return {
    type: "merchant",
    merchantId,
    merchantName,
    amount,
    currency,
    description,
    reference: generatePaymentReference(),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
  };
}

/**
 * Create P2P transfer QR code data
 * 
 * @param recipientId - Recipient user ID
 * @param recipientName - Recipient name
 * @param amount - Transfer amount
 * @param currency - Currency code
 * @param description - Transfer description
 * @returns QR payment data
 */
export function createP2PPayment(
  recipientId: string,
  recipientName: string,
  amount: number,
  currency: "NGN" | "TZS" | "USD",
  description?: string
): QRPaymentData {
  return {
    type: "p2p",
    recipientId,
    recipientName,
    amount,
    currency,
    description,
    reference: generatePaymentReference(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 minutes
  };
}

/**
 * Create bill payment QR code data
 * 
 * @param billId - Bill ID
 * @param billType - Type of bill (electricity, water, etc.)
 * @param amount - Payment amount
 * @param currency - Currency code
 * @param description - Bill description
 * @returns QR payment data
 */
export function createBillPayment(
  billId: string,
  billType: string,
  amount: number,
  currency: "NGN" | "TZS" | "USD",
  description?: string
): QRPaymentData {
  return {
    type: "bill",
    billId,
    billType,
    amount,
    currency,
    description,
    reference: generatePaymentReference(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
  };
}

/**
 * Create token purchase QR code data
 * 
 * @param amount - Purchase amount
 * @param currency - Currency code
 * @param description - Purchase description
 * @returns QR payment data
 */
export function createTokenPurchase(
  amount: number,
  currency: "NGN" | "TZS" | "USD",
  description?: string
): QRPaymentData {
  return {
    type: "token",
    amount,
    currency,
    description: description || "Energy token purchase",
    reference: generatePaymentReference(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
  };
}

/**
 * Health check for QR code service
 * 
 * @returns Service status
 */
export async function healthCheck(): Promise<{
  status: "healthy" | "degraded" | "unhealthy";
  message: string;
}> {
  try {
    // Test QR code generation
    const testData: QRPaymentData = {
      type: "token",
      amount: 100,
      currency: "NGN",
      reference: "TEST",
    };

    await generatePaymentQRCode(testData, { size: 100 });

    return {
      status: "healthy",
      message: "QR code service operational",
    };
  } catch (error) {
    return {
      status: "unhealthy",
      message: `Service unhealthy: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}
