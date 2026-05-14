/* In-memory email delivery adapter for tests — Phase 7 Step 1.
 *
 * Mirrors the live Resend adapter shape without touching the network.
 * Tests configure a sequence of behaviors so a single processor tick can
 * be exercised against happy / retryable / permanent / unexpected paths.
 *
 * Captured inputs are exposed via `calls` so assertions can verify the
 * worker rendered the raw URL back into the body (i.e. decrypted the
 * sensitive payload before calling send).
 */
import { randomUUID } from "node:crypto";
import {
  type EmailDeliveryAdapter,
  type EmailDeliveryResult,
  type EmailDeliverySendInput,
  PermanentEmailDeliveryError,
  RetryableEmailDeliveryError,
} from "./index.js";

export type FakeEmailBehavior =
  | { kind: "deliver"; providerMessageId?: string }
  | { kind: "retryable"; reason?: string }
  | { kind: "permanent"; reason?: string }
  | { kind: "unexpected"; reason?: string };

export class FakeEmailDeliveryAdapter implements EmailDeliveryAdapter {
  readonly calls: EmailDeliverySendInput[] = [];
  private idx = 0;

  constructor(private readonly behaviors: FakeEmailBehavior[] = [{ kind: "deliver" }]) {}

  async send(input: EmailDeliverySendInput): Promise<EmailDeliveryResult> {
    this.calls.push(input);
    const behavior =
      this.behaviors[Math.min(this.idx, this.behaviors.length - 1)]!;
    this.idx += 1;

    switch (behavior.kind) {
      case "deliver":
        return {
          providerMessageId: behavior.providerMessageId ?? `fake-${randomUUID()}`,
        };
      case "retryable":
        throw new RetryableEmailDeliveryError(behavior.reason ?? "fake retryable");
      case "permanent":
        throw new PermanentEmailDeliveryError(behavior.reason ?? "fake permanent");
      case "unexpected": {
        const err = new Error(behavior.reason ?? "fake unexpected");
        err.name = "FakeUnexpectedError";
        throw err;
      }
    }
  }
}
