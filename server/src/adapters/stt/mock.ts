/* STT mock adapter — Phase 5 Step 3, updated in Phase 6 Step 2.
 *
 * Phase 5 plan: docs/plan/phase-5/PHASE_5_STEP_3_ROUTES.md §1.2.
 * Phase 6 plan: docs/plan/phase-6/PHASE_6_STEP_2_PLAN.md §4.
 *
 * Deterministic: same fixture key + options always produces the same
 * utterance. Used by:
 *   - route/WS tests that drive transcript appends via the adapter
 *   - dev runs where LLM_PROVIDER=mock so a developer can hit live.html
 *     without a Clova key
 *
 * Real audio buffer input is rejected with SttUnsupportedInputError —
 * the mock is keyed only by short fixture identifiers.
 *
 * Step 6.2 change: returns ProviderResult<SttUtterance | null>. `.value`
 * is the existing utterance (or null for an unknown fixture key);
 * `.usage` carries provider='mock' / status='succeeded' even when the
 * fixture lookup misses — recording the call cost is independent of
 * whether the recognizer produced text.
 */
import {
  type STTAdapter,
  SttUnsupportedInputError,
  type SttTranscribeOptions,
  type SttUtterance,
} from "./index.js";
import type { ProviderResult, ProviderUsage } from "../usage.js";

const MOCK_STT_MODEL = "mock-stt-v1";

interface Fixture {
  speaker: "agent" | "customer" | "system";
  text: string;
  startMs: number;
  endMs: number;
  confidence: number;
}

// Stable, deterministic fixtures. Tests assert against these strings.
const FIXTURES: Record<string, Fixture> = {
  greeting: {
    speaker: "agent",
    text: "안녕하세요, Kloser 입니다.",
    startMs: 0,
    endMs: 1500,
    confidence: 0.95,
  },
  intro: {
    speaker: "customer",
    text: "안녕하세요. 신청 건으로 연락드렸습니다.",
    startMs: 1500,
    endMs: 4200,
    confidence: 0.92,
  },
  scale: {
    speaker: "customer",
    text: "저희는 직원 50명 규모이고 영업팀이 12명입니다.",
    startMs: 4200,
    endMs: 8400,
    confidence: 0.9,
  },
  needs: {
    speaker: "customer",
    text: "기존 CRM 연동도 필요합니다.",
    startMs: 8400,
    endMs: 10800,
    confidence: 0.88,
  },
  closing: {
    speaker: "agent",
    text: "다음 주 시연 일정을 잡아보겠습니다.",
    startMs: 10800,
    endMs: 13200,
    confidence: 0.94,
  },
};

function transcribeUsage(): ProviderUsage {
  // STT pricing is per-second of audio, not per-token. Mock keeps
  // tokens null and latency 0 so a future Clova adapter can populate
  // accurate fields without breaking the contract.
  return {
    provider: "mock",
    operation: "stt_transcribe",
    model: MOCK_STT_MODEL,
    status: "succeeded",
    tokensIn: null,
    tokensOut: null,
    latencyMs: 0,
    costUsdMicros: 0,
  };
}

export function createMockSttAdapter(): STTAdapter {
  return {
    provider: "mock",
    async transcribeChunk(
      audio: Buffer | string,
      _options: SttTranscribeOptions,
    ): Promise<ProviderResult<SttUtterance | null>> {
      if (typeof audio !== "string") {
        throw new SttUnsupportedInputError(
          "mock STT adapter only accepts string fixture keys, got Buffer",
        );
      }
      const fixture = FIXTURES[audio];
      if (!fixture) {
        return { value: null, usage: transcribeUsage() };
      }
      return {
        value: {
          speaker: fixture.speaker,
          text: fixture.text,
          startMs: fixture.startMs,
          endMs: fixture.endMs,
          confidence: fixture.confidence,
        },
        usage: transcribeUsage(),
      };
    },
  };
}

export const mockSttFixtures = FIXTURES;
