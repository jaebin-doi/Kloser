/* Resend HTTP adapter — Phase 7 Step 1.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_1_PLAN.md §5.3.
 *
 * Calls `POST https://api.resend.com/emails` with the worker-rendered
 * body. No SDK dependency — native `fetch` is enough.
 *
 * Failure classification:
 *   - 2xx with usable `id` → success.
 *   - 2xx with missing/empty `id` → retryable (provider returned ok but
 *     no message id — likely a transient ingest glitch).
 *   - 4xx → permanent (validation / unknown recipient / auth — none of
 *     these get better with a retry).
 *   - 5xx → retryable.
 *   - network throw / fetch reject / non-JSON body on error → retryable.
 *
 * Error messages echo ONLY `status` and Resend's `name` field (e.g.
 * `validation_error`). They never echo `message` (which can include
 * recipient address), the request body (which contains the raw URL and
 * email content), or the API key.
 */
import {
  type EmailDeliveryAdapter,
  type EmailDeliveryResult,
  type EmailDeliverySendInput,
  PermanentEmailDeliveryError,
  RetryableEmailDeliveryError,
} from "./index.js";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export class ResendEmailDeliveryAdapter implements EmailDeliveryAdapter {
  constructor(private readonly endpoint: string = RESEND_ENDPOINT) {}

  async send(input: EmailDeliverySendInput): Promise<EmailDeliveryResult> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        redirect: "manual",
        headers: {
          // Authorization carries the API key. Stays in the request only.
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: input.from,
          to: input.toEmail,
          subject: input.subject,
          text: input.text,
          ...(input.html ? { html: input.html } : {}),
        }),
      });
    } catch (err) {
      // DNS, TCP, TLS, abort — all retryable. Echo only the underlying
      // error class name, never the message (which on Node prints the
      // full URL we tried to reach).
      const name = (err as Error)?.name ?? "FetchError";
      throw new RetryableEmailDeliveryError(`resend network failure (${name})`);
    }

    if (response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new RetryableEmailDeliveryError(
          `resend ${response.status} body not JSON`,
        );
      }
      const id = (body as { id?: unknown } | null)?.id;
      if (typeof id !== "string" || id.length === 0) {
        throw new RetryableEmailDeliveryError(
          `resend ${response.status} missing message id`,
        );
      }
      return { providerMessageId: id };
    }

    // Build a safe diagnostic from the error body if it's JSON. Resend
    // returns `{ name, message, statusCode }`; we use only `name` because
    // `message` may echo recipient pii or field-level user input.
    let codeName: string | undefined;
    try {
      const errBody = (await response.json()) as { name?: unknown };
      if (typeof errBody?.name === "string") codeName = errBody.name;
    } catch {
      // Non-JSON error body — drop it. The HTTP status alone is enough
      // to classify retryable vs permanent.
    }
    const tail = codeName ? `${response.status} ${codeName}` : `${response.status}`;

    if (response.status >= 500) {
      throw new RetryableEmailDeliveryError(`resend ${tail}`);
    }
    // 1xx / 3xx fall through here too. Treat as permanent (the adapter
    // does not follow redirects on POST — that would re-send the body).
    throw new PermanentEmailDeliveryError(`resend ${tail}`);
  }
}
