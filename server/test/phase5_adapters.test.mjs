/* Phase 5 Step 3 — adapter mock unit tests, extended in Phase 6 Step 2.
 *
 * Phase 5 plan: docs/plan/phase-5/PHASE_5_STEP_3_ROUTES.md §1, §5.1.
 * Phase 6 plan: docs/plan/phase-6/PHASE_6_STEP_2_PLAN.md §4, §8.2.
 *
 * Pure unit coverage of the mock STT / LLM / Embedding adapters. No
 * Fastify boot, no DB. Step 6.2 added the ProviderResult envelope, so
 * every adapter method now returns `{ value, usage }`. The domain
 * payload assertions are unchanged; new cases assert the usage shape
 * (provider='mock', deterministic model strings, status='succeeded',
 * cost=0) so downstream services/llmUsage can rely on the contract.
 *
 * Real provider clients are not wired in this step (plan §1.1 / §5),
 * so the resolver branch for non-mock providers intentionally throws.
 * Default test runs make zero real network calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockSttAdapter, mockSttFixtures } from "../src/adapters/stt/mock.js";
import { SttUnsupportedInputError } from "../src/adapters/stt/index.js";
import { createMockLlmAdapter } from "../src/adapters/llm/mock.js";
import { createMockEmbeddingAdapter } from "../src/adapters/embedding/mock.js";
import {
    resolveSttAdapter,
    resolveLlmAdapter,
    resolveEmbeddingAdapter,
} from "../src/adapters/index.js";

function assertMockUsage(usage, expectedOperation) {
    assert.ok(usage, "expected ProviderResult.usage to be present");
    assert.equal(usage.provider, "mock");
    assert.equal(usage.operation, expectedOperation);
    assert.equal(usage.status, "succeeded");
    assert.equal(typeof usage.model, "string");
    assert.ok(usage.model.length > 0, "usage.model must be a non-empty string");
    // Mock cost is always 0 — real providers populate this from SDK pricing.
    assert.equal(usage.costUsdMicros, 0);
}

// ============================================================
//                          STT MOCK
// ============================================================

test("mock STT returns the deterministic fixture for a known key", async () => {
    const stt = createMockSttAdapter();
    const r = await stt.transcribeChunk("greeting", {
        language: "ko-KR",
        sessionId: "test-1",
    });
    assert.ok(r);
    const u = r.value;
    assert.ok(u);
    assert.equal(u.speaker, mockSttFixtures.greeting.speaker);
    assert.equal(u.text, mockSttFixtures.greeting.text);
    assert.equal(u.confidence, mockSttFixtures.greeting.confidence);
    assertMockUsage(r.usage, "stt_transcribe");
});

test("mock STT returns null value for an unknown fixture key but still records usage", async () => {
    const stt = createMockSttAdapter();
    const r = await stt.transcribeChunk("not-a-key", {
        language: "ko-KR",
        sessionId: "test-2",
    });
    assert.equal(r.value, null);
    assertMockUsage(r.usage, "stt_transcribe");
});

test("mock STT rejects a Buffer payload with SttUnsupportedInputError", async () => {
    const stt = createMockSttAdapter();
    await assert.rejects(
        stt.transcribeChunk(Buffer.from([0, 1, 2]), {
            language: "ko-KR",
            sessionId: "test-3",
        }),
        (err) => err instanceof SttUnsupportedInputError,
    );
});

// ============================================================
//                          LLM MOCK
// ============================================================

test("mock LLM summarizeCall returns null fields for empty transcript", async () => {
    const llm = createMockLlmAdapter();
    const r = await llm.summarizeCall({ transcript: "" });
    assert.equal(r.value.summary, null);
    assert.equal(r.value.needs, null);
    assert.equal(r.value.issues, null);
    assert.equal(r.value.sentiment, null);
    assertMockUsage(r.usage, "call_summary");
});

test("mock LLM summarizeCall derives sentiment + summary from transcript", async () => {
    const llm = createMockLlmAdapter();
    const a = (await llm.summarizeCall({
        transcript: "고객이 CRM 연동 시연을 요청했습니다. 계약 의사가 있습니다.",
    })).value;
    assert.equal(a.sentiment, "positive");
    assert.ok(a.summary && a.summary.length > 0);
    assert.equal(a.needs, "CRM 연동 / 시연 일정 협의");

    const b = (await llm.summarizeCall({
        transcript: "고객이 취소 요청을 했고 강한 불만을 표출했습니다.",
    })).value;
    assert.equal(b.sentiment, "negative");
    assert.equal(b.issues, "고객 측 우려 확인");

    const c = (await llm.summarizeCall({ transcript: "안녕" })).value;
    assert.equal(c.sentiment, "cautious");
});

test("mock LLM summarizeCall usage envelope carries deterministic model + tokens", async () => {
    const llm = createMockLlmAdapter();
    const r = await llm.summarizeCall({
        transcript: "고객사 CRM 연동 시연 요청",
    });
    assertMockUsage(r.usage, "call_summary");
    // Deterministic: same transcript → same tokensIn. Real providers
    // populate from SDK; mock uses chars/4 ≈ tokens approximation.
    assert.ok(
        r.usage.tokensIn !== null && r.usage.tokensIn > 0,
        "tokensIn must be a positive integer for a non-empty transcript",
    );
});

test("mock LLM suggestForUtterance respects group_seq / at_ms and emits at least direction", async () => {
    const llm = createMockLlmAdapter();
    const r = await llm.suggestForUtterance({
        transcript: "고객사 CRM 연동을 위한 시연 일정을 잡고 싶습니다.",
        groupSeq: 3,
        atMs: 8400,
    });
    const suggestions = r.value;
    assert.ok(suggestions.length >= 2);
    for (const s of suggestions) {
        assert.equal(s.group_seq, 3);
        assert.equal(s.at_ms, 8400);
    }
    assert.ok(suggestions.some((s) => s.type === "direction"));
    assert.ok(suggestions.some((s) => s.type === "script"));
    assert.ok(suggestions.some((s) => s.type === "next"));
    assertMockUsage(r.usage, "call_suggestion");
});

test("mock LLM suggestForUtterance returns empty value for empty transcript with usage logged", async () => {
    const llm = createMockLlmAdapter();
    const r = await llm.suggestForUtterance({
        transcript: "",
        groupSeq: 0,
        atMs: 0,
    });
    assert.deepEqual(r.value, []);
    assertMockUsage(r.usage, "call_suggestion");
});

// ============================================================
//                        EMBEDDING MOCK
// ============================================================

test("mock embedding produces a length-1536 unit vector", async () => {
    const adapter = createMockEmbeddingAdapter();
    const r = await adapter.embed("회사 가이드 본문");
    const v = r.value;
    assert.equal(v.length, 1536);
    let sumSq = 0;
    for (const x of v) sumSq += x * x;
    assert.ok(Math.abs(sumSq - 1) < 1e-6, `not L2-normalised: ${sumSq}`);
    assertMockUsage(r.usage, "knowledge_embedding");
});

test("mock embedding is deterministic across calls", async () => {
    const adapter = createMockEmbeddingAdapter();
    const a = (await adapter.embed("동일 입력")).value;
    const b = (await adapter.embed("동일 입력")).value;
    for (let i = 0; i < 1536; i++) {
        assert.equal(a[i], b[i]);
    }
});

test("mock embedding embedBatch returns one vector per input + single usage row", async () => {
    const adapter = createMockEmbeddingAdapter();
    const r = await adapter.embedBatch(["one", "two", "three"]);
    assert.equal(r.value.length, 3);
    for (const v of r.value) assert.equal(v.length, 1536);
    // embedBatch reports one usage envelope for the whole batch — real
    // APIs charge per call, not per input text.
    assertMockUsage(r.usage, "knowledge_embedding");
});

// ============================================================
//                          RESOLVERS
// ============================================================

// Helper: scope env mutations to a single test case so the rest of the
// suite (and other test files run in the same process) is unaffected.
function withEnv(vars, fn) {
    const prev = {};
    for (const k of Object.keys(vars)) prev[k] = process.env[k];
    try {
        for (const [k, v] of Object.entries(vars)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        return fn();
    } finally {
        for (const [k, v] of Object.entries(prev)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

test("resolveXxxAdapter defaults to mock when no env var is set", () => {
    withEnv(
        {
            STT_PROVIDER: undefined,
            LLM_PROVIDER: undefined,
            EMBEDDING_PROVIDER: undefined,
        },
        () => {
            const stt = resolveSttAdapter();
            const llm = resolveLlmAdapter();
            const emb = resolveEmbeddingAdapter();
            assert.equal(stt.provider, "mock");
            assert.equal(llm.provider, "mock");
            assert.equal(emb.provider, "mock");
            assert.equal(emb.dimensions, 1536);
        },
    );
});

test("resolveXxxAdapter treats empty string the same as unset (mock default)", () => {
    withEnv(
        { STT_PROVIDER: "", LLM_PROVIDER: "", EMBEDDING_PROVIDER: "" },
        () => {
            assert.equal(resolveSttAdapter().provider, "mock");
            assert.equal(resolveLlmAdapter().provider, "mock");
            assert.equal(resolveEmbeddingAdapter().provider, "mock");
        },
    );
});

test("resolveSttAdapter throws on an unknown provider value", () => {
    withEnv({ STT_PROVIDER: "whisper-cloud" }, () => {
        assert.throws(() => resolveSttAdapter(), /not implemented/);
    });
});

test("resolveLlmAdapter throws on an unknown provider value", () => {
    withEnv({ LLM_PROVIDER: "gemini" }, () => {
        assert.throws(() => resolveLlmAdapter(), /not implemented/);
    });
});

test("resolveEmbeddingAdapter throws on an unknown provider value", () => {
    withEnv({ EMBEDDING_PROVIDER: "voyage" }, () => {
        assert.throws(() => resolveEmbeddingAdapter(), /not implemented/);
    });
});

// ============================================================
//                     Real-provider fail-fast
// ============================================================

test("resolveLlmAdapter throws when LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is missing", () => {
    withEnv(
        { LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: undefined },
        () => {
            assert.throws(
                () => resolveLlmAdapter(),
                /ANTHROPIC_API_KEY/,
            );
        },
    );
});

test("resolveLlmAdapter throws when LLM_PROVIDER=anthropic and ANTHROPIC_API_KEY is whitespace", () => {
    withEnv(
        { LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "   " },
        () => {
            assert.throws(() => resolveLlmAdapter(), /ANTHROPIC_API_KEY/);
        },
    );
});

test("resolveEmbeddingAdapter throws when EMBEDDING_PROVIDER=openai but OPENAI_API_KEY is missing", () => {
    withEnv(
        { EMBEDDING_PROVIDER: "openai", OPENAI_API_KEY: undefined },
        () => {
            assert.throws(() => resolveEmbeddingAdapter(), /OPENAI_API_KEY/);
        },
    );
});

test("resolveSttAdapter throws when STT_PROVIDER=clova but any of CLOVA_* env is missing", () => {
    withEnv(
        {
            STT_PROVIDER: "clova",
            CLOVA_STT_URL: "https://example.test/recog/v1/stt",
            CLOVA_CLIENT_ID: "client-id",
            CLOVA_CLIENT_SECRET: undefined,
        },
        () => {
            assert.throws(() => resolveSttAdapter(), /CLOVA_CLIENT_SECRET/);
        },
    );
});

test("resolveSttAdapter throws and names every missing CLOVA_* env", () => {
    withEnv(
        {
            STT_PROVIDER: "clova",
            CLOVA_STT_URL: undefined,
            CLOVA_CLIENT_ID: undefined,
            CLOVA_CLIENT_SECRET: undefined,
        },
        () => {
            try {
                resolveSttAdapter();
                assert.fail("expected resolver to throw");
            } catch (err) {
                assert.match(err.message, /CLOVA_STT_URL/);
                assert.match(err.message, /CLOVA_CLIENT_ID/);
                assert.match(err.message, /CLOVA_CLIENT_SECRET/);
            }
        },
    );
});

// ============================================================
//             Real-provider construction (no network)
// ============================================================
// These tests instantiate the real-provider adapter classes with stub
// credentials and assert the `provider` property comes back tagged
// correctly. They do NOT call .summarizeCall / .embed / .transcribeChunk,
// so no outbound HTTP requests fire. Real network behaviour is gated by
// E2E_ALLOW_REAL_PROVIDERS=1 in a future opt-in contract test.

test("Anthropic adapter constructs from env with stub key (no network call)", () => {
    withEnv(
        {
            LLM_PROVIDER: "anthropic",
            ANTHROPIC_API_KEY: "sk-ant-test-noop-never-sent",
        },
        () => {
            const llm = resolveLlmAdapter();
            assert.equal(llm.provider, "anthropic");
        },
    );
});

test("OpenAI embedding adapter constructs from env with stub key (no network call)", () => {
    withEnv(
        {
            EMBEDDING_PROVIDER: "openai",
            OPENAI_API_KEY: "sk-test-noop-never-sent",
        },
        () => {
            const emb = resolveEmbeddingAdapter();
            assert.equal(emb.provider, "openai");
            assert.equal(emb.dimensions, 1536);
        },
    );
});

test("Clova STT adapter constructs from env with stub credentials (no network call)", () => {
    withEnv(
        {
            STT_PROVIDER: "clova",
            CLOVA_STT_URL: "https://example.test/recog/v1/stt",
            CLOVA_CLIENT_ID: "client-id",
            CLOVA_CLIENT_SECRET: "client-secret",
        },
        () => {
            const stt = resolveSttAdapter();
            assert.equal(stt.provider, "clova");
        },
    );
});
