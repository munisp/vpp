import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ENV } from "./_core/env";

type StorageConfig = {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  forcePathStyle: boolean;
  signedUrlTtlSeconds: number;
};

let client: S3Client | null = null;
let clientFingerprint = "";

function getStorageConfig(): StorageConfig {
  const {
    s3Endpoint: endpoint,
    s3Region: region,
    s3AccessKey: accessKeyId,
    s3SecretKey: secretAccessKey,
    s3Bucket: bucket,
    s3ForcePathStyle: forcePathStyle,
    s3SignedUrlTtlSeconds: signedUrlTtlSeconds,
  } = ENV;

  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      "Object storage is not configured. Set S3_ENDPOINT, S3_ACCESS_KEY, " +
        "S3_SECRET_KEY, and S3_BUCKET."
    );
  }
  if (!Number.isInteger(signedUrlTtlSeconds) || signedUrlTtlSeconds < 1 || signedUrlTtlSeconds > 3600) {
    throw new Error("S3_SIGNED_URL_TTL_SECONDS must be an integer from 1 to 3600.");
  }

  return { endpoint, region, accessKeyId, secretAccessKey, bucket, forcePathStyle, signedUrlTtlSeconds };
}

function getClient(config: StorageConfig): S3Client {
  const fingerprint = `${config.endpoint}|${config.region}|${config.accessKeyId}|${config.forcePathStyle}`;
  if (!client || clientFingerprint !== fingerprint) {
    client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    clientFingerprint = fingerprint;
  }
  return client;
}

function normalizeKey(relKey: string): string {
  const key = relKey.replace(/^\/+/, "");
  if (!key || key.split("/").some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error("Storage key must be a non-empty relative path without dot segments.");
  }
  return key;
}

async function presignedDownloadUrl(config: StorageConfig, key: string): Promise<string> {
  return getSignedUrl(
    getClient(config),
    new GetObjectCommand({ Bucket: config.bucket, Key: key }),
    { expiresIn: config.signedUrlTtlSeconds }
  );
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  const config = getStorageConfig();
  const key = normalizeKey(relKey);

  await getClient(config).send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: data,
      ContentType: contentType,
    })
  );

  return { key, url: await presignedDownloadUrl(config, key) };
}

export async function storageGet(relKey: string): Promise<{ key: string; url: string }> {
  const config = getStorageConfig();
  const key = normalizeKey(relKey);
  return { key, url: await presignedDownloadUrl(config, key) };
}

export const __storageTestables = { normalizeKey };
