/* Naver Cloud CLOVA Speech Recognition adapter — Phase 6 Step 2.
 *
 * Plan: docs/plan/phase-6/PHASE_6_STEP_2_PLAN.md §5.3.
 *
 * Targets the REST short-recognition endpoint (no gRPC realtime). The
 * current frontend has no audio-buffer ingest path; this adapter is in
 * place so the first backend route that accepts Buffer audio (Phase
 * 7+ desktop app) can plug in without another adapter migration.
 *
 * Transport:
 *   - Use Node 22 global `fetch` and `AbortController` (no SDK
 *     dependency — Clova ships a Java SDK only).
 *   - Content-Type: application/octet-stream (raw audio bytes in body).
 *   - language is appended as a query param per the public API spec.
 *   - Authentication headers: X-NCP-APIGW-API-KEY-ID and
 *     X-NCP-APIGW-API-KEY (legacy naveropenapi.apigw.ntruss.com).
 *
 * Input contract:
 *   - String fixture keys throw SttUnsupportedInputError — only the
 *     mock honours those. A real recognizer needs real bytes.
 *
 * Output:
 *   - The REST short-recognition response is `{ text: string }` on
 *     success. We map that into the existing SttUtterance shape with
 *     `speaker = 'customer'` (the only role real STT can attribute
 *     today; agent/system disambiguation is a future channel-aware
 *     enhancement) and null start/end ms (REST short-recognition does
 *     not return word timings).
 *   - Empty / unrecognised text returns `value: null` to match the
 *     existing adapter contract; the usage row still records latency.
 *
 * Cost:
 *   - Tokens are not the unit for STT (per-15s audio billing). Step 2
 *     leaves both tokens and cost null; latency is the only signal we
 *     can populate reliably without a real audio-duration mapper.
 *
 * Failure:
 *   - 401/403 throw fail-fast (bad creds).
 *   - 429/5xx throw so the caller retries.
 *   - 4xx other than auth → ClovaResponseError so the route surfaces a
 *     clean validation error instead of a generic 500.
 */
import {
  type STTAdapter,
  SttUnsupportedInputError,
  type SttTranscribeOptions,
  type SttUtterance,
} from "./index.js";
import type { ProviderResult, ProviderUsage } from "../usage.js";

export const CLOVA_DEFAULT_MODEL = "clova-speech-recog-rest";
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_LANGUAGE = "Kor";

export interface ClovaAdapterConfig {
  url: string;
  clientId: string;
  clientSecret: string;
  language?: string;
  timeoutMs?: number;
  // Injected for tests so they can drive the adapter without hitting
  // the real network. Defaults to the global fetch on Node 22.
  fetchImpl?: typeof globalThis.fetch;
}

export class ClovaAuthError extends Error {
  code = "clova_auth" as const;
  constructor(message: string) {
    super(message);
    this.name = "ClovaAuthError";
  }
}

export class ClovaResponseError extends Error {
  code = "clova_response" as const;
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "ClovaResponseError";
    this.status = status;
    this.body = body;
  }
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function makeUsage(
  status: ProviderUsage["status"],
  latencyMs: number,
  providerRequestId: string | null = null,
  errorCode: string | null = null,
): ProviderUsage {
  return {
    provider: "clova",
    operation: "stt_transcribe",
    model: CLOVA_DEFAULT_MODEL,
    status,
    // Tokens are not the unit for STT (per-15s billing). Step 2 leaves
    // them null; latency is the only signal we can populate without an
    // audio-duration mapper.
    tokensIn: null,
    tokensOut: null,
    latencyMs,
    costUsdMicros: null,
    providerRequestId,
    errorCode,
  };
}

// Map the Kloser language enum into Clova's query param value. The
// short-recognition endpoint speaks ISO-like 3-char codes prefixed by
// capitalised language family (Kor, Eng, Jpn, …); we expose only the
// two the rest of the product supports right now.
function clovaLanguageFor(input: SttTranscribeOptions["language"]): string {
  return input === "en-US" ? "Eng" : DEFAULT_LANGUAGE;
}

export function createClovaSttAdapter(config: ClovaAdapterConfig): STTAdapter {
  if (!config.url || config.url.trim() === "") {
    throw new Error("createClovaSttAdapter: url is required");
  }
  if (!config.clientId || config.clientId.trim() === "") {
    throw new Error("createClovaSttAdapter: clientId is required");
  }
  if (!config.clientSecret || config.clientSecret.trim() === "") {
    throw new Error("createClovaSttAdapter: clientSecret is required");
  }
  const baseUrl = config.url;
  const baseLanguage = config.language ?? DEFAULT_LANGUAGE;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error(
      "createClovaSttAdapter: global fetch is unavailable; pass `fetchImpl` explicitly (Node 22+ required).",
    );
  }

  return {
    provider: "clova",
    async transcribeChunk(
      audio: Buffer | string,
      options: SttTranscribeOptions,
    ): Promise<ProviderResult<SttUtterance | null>> {
      if (typeof audio === "string") {
        throw new SttUnsupportedInputError(
          "Clova STT adapter requires a Buffer of raw audio bytes; got a string fixture key. The mock adapter is the one keyed by fixture strings.",
        );
      }
      const requestedLanguage = options?.language
        ? clovaLanguageFor(options.language)
        : baseLanguage;
      // The endpoint takes `lang` (per public REST docs). The trailing
      // slash is intentional; some gateway routes 308 without it.
      const url = `${baseUrl}?lang=${encodeURIComponent(requestedLanguage)}`;

      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      const start = Date.now();
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-NCP-APIGW-API-KEY-ID": config.clientId,
            "X-NCP-APIGW-API-KEY": config.clientSecret,
          },
          // Buffer is assignable to BodyInit at runtime.
          body: audio as unknown as BodyInit,
          signal: abort.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const latency = Date.now() - start;

      if (response.status === 401 || response.status === 403) {
        // Fail-fast on bad creds. A misconfigured prod boot should not
        // silently drop transcripts.
        const body = await safeReadBody(response);
        throw new ClovaAuthError(
          `Clova rejected credentials (HTTP ${response.status}): ${body}`,
        );
      }
      if (!response.ok) {
        const body = await safeReadBody(response);
        throw new ClovaResponseError(
          `Clova HTTP ${response.status}`,
          response.status,
          body,
        );
      }

      let parsed: { text?: string };
      try {
        parsed = (await response.json()) as { text?: string };
      } catch (err) {
        const body = await safeReadBody(response);
        throw new ClovaResponseError(
          `Clova response was not JSON: ${(err as Error).message}`,
          response.status,
          body,
        );
      }
      const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
      if (!text) {
        return { value: null, usage: makeUsage("succeeded", latency) };
      }
      const utterance: SttUtterance = {
        speaker: "customer",
        text,
        // Short-recognition does not return per-word timestamps.
        startMs: null,
        endMs: null,
        confidence: null,
      };
      return { value: utterance, usage: makeUsage("succeeded", latency) };
    },
  };
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

export function createClovaSttAdapterFromEnv(): STTAdapter {
  const url = (process.env.CLOVA_STT_URL ?? "").trim();
  const clientId = (process.env.CLOVA_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.CLOVA_CLIENT_SECRET ?? "").trim();
  const missing: string[] = [];
  if (!url) missing.push("CLOVA_STT_URL");
  if (!clientId) missing.push("CLOVA_CLIENT_ID");
  if (!clientSecret) missing.push("CLOVA_CLIENT_SECRET");
  if (missing.length > 0) {
    throw new Error(
      `STT_PROVIDER=clova but required env is empty: ${missing.join(", ")}. Set them or revert to STT_PROVIDER=mock.`,
    );
  }
  return createClovaSttAdapter({
    url,
    clientId,
    clientSecret,
    language: (process.env.CLOVA_STT_LANGUAGE ?? "").trim() || DEFAULT_LANGUAGE,
    timeoutMs: envNumber("CLOVA_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
  });
}
