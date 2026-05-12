/* STT adapter interface — Phase 5 Step 3.
 *
 * Plan: docs/plan/phase-5/PHASE_5_STEP_3_ROUTES.md §1.2.
 *
 * Step 3 wires only the interface and a deterministic mock. The Clova
 * client lives in a follow-up commit (Phase 5 e2e or Phase 6 — see
 * master plan §2 decision 1).
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

export interface STTAdapter {
  provider: SttProvider;
  // The dev/test path uses a `string` fixture key; a real adapter
  // accepts the audio Buffer. Adapters that cannot honor a fixture key
  // (real providers) should reject with a typed error.
  transcribeChunk(
    audio: Buffer | string,
    options: SttTranscribeOptions,
  ): Promise<SttUtterance | null>;
}

export class SttUnsupportedInputError extends Error {
  code = "stt_unsupported_input" as const;
  constructor(message: string) {
    super(message);
    this.name = "SttUnsupportedInputError";
  }
}
