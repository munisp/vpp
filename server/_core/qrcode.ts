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
  try {
    // Add timestamp and reference if not provided
    const data: QRPaymentData = {
      ...paymentData,
      reference: paymentData.reference || generatePaymentReference(),
      expiresAt: paymentData.expiresAt || new Date(Date.now() + 15 * 60 * 1000), // 15 minutes default
    };

    // Encode payment data as JSON
    const payload = JSON.stringify(data);

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

    return qrCodeDataURL;
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
  try {
    const data: QRPaymentData = {
      ...paymentData,
      reference: paymentData.reference || generatePaymentReference(),
      expiresAt: paymentData.expiresAt || new Date(Date.now() + 15 * 60 * 1000),
    };

    const payload = JSON.stringify(data);

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
    const data = JSON.parse(qrData) as QRPaymentData;

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
