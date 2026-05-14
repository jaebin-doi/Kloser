/* EmailDeliveryAdapter interface — Phase 7 Step 1.
 *
 * Plan: docs/plan/phase-7/PHASE_7_STEP_1_PLAN.md §5.3.
 *
 * This adapter is the bridge between the email delivery worker and the
 * outbound email provider (Resend in this phase). It is distinct from
 * `services/email.ts → EmailProvider`: that interface decides how an
 * outbox row is INSERTed (dev archive vs. encrypted pending row). This
 * interface only handles the actual outbound HTTP call once the worker
 * leases a pending row.
 *
 * Failure model:
 *   - Success → return `{ providerMessageId }`.
 *   - 4xx HTTP / structurally invalid recipient / quota exceeded →
 *     throw `PermanentEmailDeliveryError`. Worker dead-letters without
 *     retry.
 *   - 5xx HTTP / network failure / unexpected response shape →
 *     throw `RetryableEmailDeliveryError`. Worker schedules retry with
 *     exponential backoff up to KLOSER_EMAIL_MAX_ATTEMPTS.
 *
 * Error policy: every thrown message includes ONLY non-sensitive
 * identifiers (HTTP status, provider error code). Adapters MUST NOT
 * echo RESEND_API_KEY, raw token values, raw URLs, recipient pii, or
 * the request body in error messages.
 */

export interface EmailDeliveryAdapter {
  send(input: EmailDeliverySendInput): Promise<EmailDeliveryResult>;
}

export interface EmailDeliverySendInput {
  toEmail: string;
  subject: string;
  text: string;
  html?: string | null;
  from: string;
  apiKey: string;
}

export interface EmailDeliveryResult {
  providerMessageId: string;
}

export class RetryableEmailDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableEmailDeliveryError";
  }
}

export class PermanentEmailDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentEmailDeliveryError";
  }
}

export { ResendEmailDeliveryAdapter } from "./resend.js";
export { FakeEmailDeliveryAdapter } from "./fake.js";
