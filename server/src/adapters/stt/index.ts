/* STT adapter interface — Phase 5 Step 3, extended in Phase 6 Step 2.
 *
 * Phase 5 plan: docs/plan/phase-5/PHASE_5_STEP_3_ROUTES.md §1.2.
 * Phase 6 plan: docs/plan/phase-6/PHASE_6_STEP_2_PLAN.md §4.
 *
 * Step 3 wired only the interface and a deterministic mock. Step 6.2
 * keeps mock as the default but wraps the return value in
 * ProviderResult so latency / cost can flow to llm_usage_log when the
 * Clova real client lands in a follow-up commit.
 *
 * SttUtterance.text is what we persist into transcripts.text. Speaker
 * mirrors the TranscriptSpeaker enum so callers can hand the value
 * straight to transcriptsRepo.appendForCallInCurrentOrg without
 * remapping.
 */

export type SttSpeaker = "agent" | "customer" | "system";

export interface SttUtterance {
  speaker: SttSpeaker;
  text: string;
  startMs: number | null;
  endMs: number | null;
  confidence: number | null;
}

export interface SttTranscribeOptions {
  language: "ko-KR" | "en-US";
  sessionId: string;
}

export type SttProvider = "clova" | "whisper" | "mock";

import type { ProviderResult } from "../usage.js";

export interface STTAdapter {
  provider: SttProvider;
  // The dev/test path uses a `string` fixture key; a real adapter
  // accepts the audio Buffer. Adapters that cannot honor a fixture key
  // (real providers) should reject with a typed error.
  //
  // Returns ProviderResult so callers can record usage even when the
  // utterance value is null (Phase 6 Step 2 §4).
  transcribeChunk(
    audio: Buffer | string,
    options: SttTranscribeOptions,
  ): Promise<ProviderResult<SttUtterance | null>>;
}

export class SttUnsupportedInputError extends Error {
  code = "stt_unsupported_input" as const;
  constructor(message: string) {
    super(message);
    this.name = "SttUnsupportedInputError";
  }
}
