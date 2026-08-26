import crypto from "node:crypto";
import { storagePut } from "server/storage";
import { ENV } from "./env";

export type GenerateImageOptions = {
  prompt: string;
  originalImages?: Array<{
    url?: string;
    b64Json?: string;
    mimeType?: string;
  }>;
};

export type GenerateImageResponse = { url?: string };

type ImagesResponse = {
  data?: Array<{ b64_json?: string; revised_prompt?: string }>;
};

function imageGenerationUrl(): string {
  if (!ENV.imageGenerationBaseUrl) {
    throw new Error("IMAGE_GENERATION_BASE_URL is not configured");
  }
  if (!ENV.imageGenerationApiKey) {
    throw new Error("IMAGE_GENERATION_API_KEY is not configured");
  }
  if (!ENV.imageGenerationModel) {
    throw new Error("IMAGE_GENERATION_MODEL is not configured");
  }
  return new URL("v1/images/generations", `${ENV.imageGenerationBaseUrl}/`).toString();
}

/**
 * Generate an image through an explicitly configured OpenAI-compatible service
 * and store the returned bytes in the platform's S3-compatible object store.
 * Image editing is not enabled until the selected provider's compatible editing
 * endpoint and file-validation contract are separately implemented.
 */
export async function generateImage(options: GenerateImageOptions): Promise<GenerateImageResponse> {
  if (!options.prompt.trim()) {
    throw new Error("Image-generation prompt is required");
  }
  if (options.originalImages?.length) {
    throw new Error(
      "Image editing is not configured for the standalone image-generation service."
    );
  }

  const response = await fetch(imageGenerationUrl(), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${ENV.imageGenerationApiKey}`,
    },
    body: JSON.stringify({
      model: ENV.imageGenerationModel,
      prompt: options.prompt,
      response_format: "b64_json",
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Image generation failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`
    );
  }

  const result = (await response.json()) as ImagesResponse;
  const b64Json = result.data?.[0]?.b64_json;
  if (!b64Json) {
    throw new Error("Image generation service returned no base64 image data.");
  }

  const buffer = Buffer.from(b64Json, "base64");
  if (buffer.length === 0) {
    throw new Error("Image generation service returned an empty image.");
  }

  const { url } = await storagePut(
    `generated/${Date.now()}-${crypto.randomUUID()}.png`,
    buffer,
    "image/png"
  );
  return { url };
}
