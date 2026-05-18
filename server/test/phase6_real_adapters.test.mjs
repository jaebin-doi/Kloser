/* Phase 6 Step 2 — real-provider adapter unit tests.
 *
 * Plan: docs/plan/phase-6/PHASE_6_STEP_2_PLAN.md §5, §8.2.
 *
 * The Anthropic and OpenAI clients are concrete SDK wrappers — exercising
 * them end-to-end requires a paid API key, so they are tested under the
 * `E2E_ALLOW_REAL_PROVIDERS=1` env gate only. The default test suite
 * (CI / pre-commit) MUST make zero outbound HTTP requests.
 *
 * The Clova STT adapter, by contrast, is a thin fetch wrapper. We test
 * it here by injecting a stub `fetchImpl` so the contract is verified
 * (headers, body, lang param, auth fail-fast, empty-text→null mapping)
 * without ever leaving the process.
 *
 * Real provider contract tests live below the opt-in gate. They will
 * exercise the official SDKs against real Anthropic / OpenAI endpoints
 * when keys are present.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createClovaSttAdapter, ClovaAuthError, ClovaResponseError } from "../src/adapters/stt/clova.js";
import { SttUnsupportedInputError } from "../src/adapters/stt/index.js";
import { createOpenAIEmbeddingAdapter } from "../src/adapters/embedding/openai.js";
import { EmbeddingDimensionError } from "../src/adapters/embedding/index.js";
import { createAnthropicLlmAdapter } from "../src/adapters/llm/anthropic.js";

const STUB_URL = "https://example.test/recog/v1/stt";
const STUB_ID = "stub-client-id";
const STUB_SECRET = "stub-client-secret";

// Build a minimal Response-like object that the adapter can `await
// .json()` / `await .text()` on. Mirrors the global fetch return type.
function jsonResponse(status, body) {
    const text = JSON.stringify(body);
    return new Response(text, {
        status,
        headers: { "content-type": "application/json" },
    });
}
function textResponse(status, body) {
    return new Response(body, {
        status,
        headers: { "content-type": "text/plain" },
    });
}

// ============================================================
//                       CLOVA STT (stubbed fetch)
// ============================================================

test("Clova adapter rejects string fixture keys with SttUnsupportedInputError", async () => {
    const stt = createClovaSttAdapter({
        url: STUB_URL,
        clientId: STUB_ID,
        clientSecret: STUB_SECRET,
        fetchImpl: async () => jsonResponse(200, { text: "ignored" }),
    });
    await assert.rejects(
        stt.transcribeChunk("greeting", {
            language: "ko-KR",
            sessionId: "test",
        }),
        (err) => err instanceof SttUnsupportedInputError,
    );
});

test("Clova adapter posts audio bytes with NCP headers + lang query param", async () => {
    let seenUrl;
    let seenHeaders;
    let seenBodyLength;
    const stt = createClovaSttAdapter({
        url: STUB_URL,
        clientId: STUB_ID,
        clientSecret: STUB_SECRET,
        async fetchImpl(url, init) {
            seenUrl = url;
            seenHeaders = init.headers;
            const buf = init.body;
            seenBodyLength = Buffer.isBuffer(buf) ? buf.length : -1;
            return jsonResponse(200, { text: "안녕하세요." });
        },
    });
    const audio = Buffer.from([1, 2, 3, 4, 5]);
    const result = await stt.transcribeChunk(audio, {
        language: "ko-KR",
        sessionId: "test",
    });
    assert.ok(result);
    assert.equal(result.value?.text, "안녕하세요.");
    assert.equal(result.value?.speaker, "customer");
    assert.equal(result.value?.startMs, null);
    assert.equal(result.value?.confidence, null);
    assert.equal(result.usage.provider, "clova");
    assert.equal(result.usage.operation, "stt_transcribe");
    assert.equal(result.usage.status, "succeeded");
    assert.equal(result.usage.tokensIn, null, "STT is per-second, not per-token");
    assert.equal(result.usage.tokensOut, null);
    assert.ok(seenUrl.includes("lang=Kor"), `lang query param missing: ${seenUrl}`);
    assert.equal(seenHeaders["X-NCP-APIGW-API-KEY-ID"], STUB_ID);
    assert.equal(seenHeaders["X-NCP-APIGW-API-KEY"], STUB_SECRET);
    assert.equal(seenHeaders["Content-Type"], "application/octet-stream");
    assert.equal(seenBodyLength, 5);
});

test("Clova adapter maps en-US to Eng lang query param", async () => {
    let seenUrl;
    const stt = createClovaSttAdapter({
        url: STUB_URL,
        clientId: STUB_ID,
        clientSecret: STUB_SECRET,
        async fetchImpl(url) {
            seenUrl = url;
            return jsonResponse(200, { text: "ok" });
        },
    });
    await stt.transcribeChunk(Buffer.from([0]), {
        language: "en-US",
        sessionId: "test",
    });
    assert.ok(seenUrl.includes("lang=Eng"), `lang query param wrong: ${seenUrl}`);
});

test("Clova adapter returns null value for empty text result but still records usage", async () => {
    const stt = createClovaSttAdapter({
        url: STUB_URL,
        clientId: STUB_ID,
        clientSecret: STUB_SECRET,
        async fetchImpl() {
            return jsonResponse(200, { text: "   " }); // whitespace-only
        },
    });
    const result = await stt.transcribeChunk(Buffer.from([0]), {
        language: "ko-KR",
        sessionId: "test",
    });
    assert.equal(result.value, null);
    assert.equal(result.usage.status, "succeeded");
    // Phase 7 Step 5 — Clova has no audio-duration field in the usage
    // envelope, so the pricing helper deliberately returns null with an
    // 'unsupported_unit' marker. This contract belongs to the Clova
    // adapter and stays locked until an audio ingest surface lands.
    assert.equal(result.usage.costUsdMicros, null);
    assert.equal(result.usage.metadata?.cost_status, "unsupported_unit");
});

test("Clova adapter throws ClovaAuthError on 401 (bad credentials)", async () => {
    const stt = createClovaSttAdapter({
        url: STUB_URL,
        clientId: STUB_ID,
        clientSecret: STUB_SECRET,
        async fetchImpl() {
            return textResponse(401, "invalid key");
        },
    });
    await assert.rejects(
        stt.transcribeChunk(Buffer.from([0]), {
            language: "ko-KR",
            sessionId: "test",
        }),
        (err) => err instanceof ClovaAuthError,
    );
});

test("Clova adapter throws ClovaResponseError on non-2xx other than 401/403", async () => {
    const stt = createClovaSttAdapter({
        url: STUB_URL,
        clientId: STUB_ID,
        clientSecret: STUB_SECRET,
        async fetchImpl() {
            return textResponse(500, "server failure");
        },
    });
    await assert.rejects(
        stt.transcribeChunk(Buffer.from([0]), {
            language: "ko-KR",
            sessionId: "test",
        }),
        (err) =>
            err instanceof ClovaResponseError &&
            err.status === 500 &&
            err.body.includes("server failure"),
    );
});

// ============================================================
//             OpenAI Embedding adapter (constructor guards)
// ============================================================

test("OpenAI embedding factory rejects empty apiKey", () => {
    assert.throws(
        () =>
            createOpenAIEmbeddingAdapter({
                apiKey: "",
                model: "text-embedding-3-small",
            }),
        /apiKey is required/,
    );
});

test("OpenAI embedding factory rejects non-1536 dimensions at construction", () => {
    assert.throws(
        () =>
            createOpenAIEmbeddingAdapter({
                apiKey: "sk-test-not-used",
                dimensions: 768,
            }),
        (err) => err instanceof EmbeddingDimensionError,
    );
});

test("OpenAI embedding adapter constructs and exposes dimensions=1536", () => {
    const adapter = createOpenAIEmbeddingAdapter({
        apiKey: "sk-test-not-used",
    });
    assert.equal(adapter.provider, "openai");
    assert.equal(adapter.dimensions, 1536);
});

// ============================================================
//             Anthropic LLM adapter (constructor guards)
// ============================================================

test("Anthropic adapter factory rejects empty apiKey", () => {
    assert.throws(
        () => createAnthropicLlmAdapter({ apiKey: "" }),
        /apiKey is required/,
    );
});

test("Anthropic adapter constructs and reports provider='anthropic'", () => {
    const llm = createAnthropicLlmAdapter({
        apiKey: "sk-ant-test-not-used",
    });
    assert.equal(llm.provider, "anthropic");
});

// ============================================================
//   Phase 7 Step 5 — cost helper wiring (no network)
// ============================================================
//
// The adapter's empty-transcript / empty-batch branches return a
// 'skipped' ProviderUsage without ever calling the SDK. That is the
// only no-network path through `makeUsage`, so it gives us a free
// integration check that the Phase 7 Step 5 cost helper is wired to
// the adapter envelope.
//
// Network-driven paths (real Messages / Embedding API responses) are
// exercised by the opt-in E2E_ALLOW_REAL_PROVIDERS tests further below
// and by `phase7_step5_llm_pricing.test.mjs` for the calculator itself.

test("Anthropic adapter skip path → cost=0 + pricing_verified_on metadata (Step 5 wiring)", async () => {
    const llm = createAnthropicLlmAdapter({
        apiKey: "sk-ant-test-not-used",
        model: "claude-sonnet-4-5",
    });
    const result = await llm.summarizeCall({ transcript: "" });
    assert.equal(result.usage.provider, "anthropic");
    assert.equal(result.usage.status, "skipped");
    assert.equal(result.usage.costUsdMicros, 0);
    assert.equal(result.usage.metadata?.pricing_verified_on, "2026-05-18");
});

test("Anthropic adapter unknown-model skip path → cost null + cost_status='unknown_model'", async () => {
    const llm = createAnthropicLlmAdapter({
        apiKey: "sk-ant-test-not-used",
        // A model not in the price map — adapter must still record the
        // usage row, just with cost=null and an `unknown_model` marker.
        model: "claude-future-model-9000",
    });
    const result = await llm.summarizeCall({ transcript: "" });
    assert.equal(result.usage.status, "skipped");
    assert.equal(result.usage.costUsdMicros, null);
    assert.equal(result.usage.metadata?.cost_status, "unknown_model");
});

test("OpenAI embedding skip path → cost=0 + pricing_verified_on metadata (Step 5 wiring)", async () => {
    const emb = createOpenAIEmbeddingAdapter({
        apiKey: "sk-test-not-used",
        model: "text-embedding-3-small",
    });
    const result = await emb.embedBatch([]);
    assert.equal(result.usage.provider, "openai");
    assert.equal(result.usage.status, "skipped");
    assert.equal(result.usage.costUsdMicros, 0);
    assert.equal(result.usage.metadata?.pricing_verified_on, "2026-05-18");
});

test("OpenAI embedding unknown-model skip path → cost null + cost_status='unknown_model'", async () => {
    const emb = createOpenAIEmbeddingAdapter({
        apiKey: "sk-test-not-used",
        model: "text-embedding-9-future",
    });
    const result = await emb.embedBatch([]);
    assert.equal(result.usage.status, "skipped");
    assert.equal(result.usage.costUsdMicros, null);
    assert.equal(result.usage.metadata?.cost_status, "unknown_model");
});

// ============================================================
//             Opt-in real-network contract tests
// ============================================================
// These run only when both:
//   - E2E_ALLOW_REAL_PROVIDERS=1 (operator opt-in)
//   - The provider's API key env is set
// PR / CI gates default to skipping; the body still exercises the adapter
// end-to-end when local credentials are present.

const realProvidersEnabled =
    process.env.E2E_ALLOW_REAL_PROVIDERS === "1" ||
    process.env.E2E_ALLOW_REAL_PROVIDERS === "true";

test(
    "Anthropic adapter end-to-end summarizeCall (opt-in)",
    { skip: !(realProvidersEnabled && process.env.ANTHROPIC_API_KEY) },
    async () => {
        const llm = createAnthropicLlmAdapter({
            apiKey: process.env.ANTHROPIC_API_KEY,
        });
        const result = await llm.summarizeCall({
            transcript:
                "고객사 CRM 연동을 위한 시연 일정을 잡고 싶습니다. 다음 주 화요일 가능합니다.",
        });
        assert.ok(result.value);
        assert.equal(result.usage.provider, "anthropic");
        assert.equal(result.usage.status, "succeeded");
        assert.ok((result.usage.tokensIn ?? 0) > 0);
        assert.ok((result.usage.tokensOut ?? 0) > 0);
        // Phase 7 Step 5 — real Anthropic response with a known-default
        // model name must surface a non-null cost. If a future SDK
        // response returns a different alias / dated snapshot, the
        // calculator drops to `unknown_model`, in which case the cost
        // is null and the metadata marker explains why.
        if (result.usage.costUsdMicros === null) {
            assert.equal(
                result.usage.metadata?.cost_status,
                "unknown_model",
                "real Anthropic call returned a model id the price map doesn't recognise",
            );
        } else {
            assert.ok(
                result.usage.costUsdMicros > 0,
                "real Anthropic call should compute a positive cost",
            );
            assert.equal(
                result.usage.metadata?.pricing_verified_on,
                "2026-05-18",
            );
        }
    },
);

test(
    "OpenAI embedding adapter end-to-end embed (opt-in)",
    { skip: !(realProvidersEnabled && process.env.OPENAI_API_KEY) },
    async () => {
        const emb = createOpenAIEmbeddingAdapter({
            apiKey: process.env.OPENAI_API_KEY,
        });
        const result = await emb.embed("회사 가이드 본문 샘플");
        assert.equal(result.value.length, 1536);
        assert.equal(result.usage.provider, "openai");
        assert.equal(result.usage.status, "succeeded");
        assert.ok((result.usage.tokensIn ?? 0) > 0);
        // Same Step 5 cost assertion as the Anthropic e2e test above.
        if (result.usage.costUsdMicros === null) {
            assert.equal(
                result.usage.metadata?.cost_status,
                "unknown_model",
                "real OpenAI embedding returned a model id the price map doesn't recognise",
            );
        } else {
            assert.ok(
                result.usage.costUsdMicros > 0,
                "real OpenAI embedding should compute a positive cost",
            );
            assert.equal(
                result.usage.metadata?.pricing_verified_on,
                "2026-05-18",
            );
        }
    },
);

test(
    "Clova STT adapter end-to-end transcribeChunk (opt-in)",
    {
        skip:
            !realProvidersEnabled ||
            !process.env.CLOVA_CLIENT_ID ||
            !process.env.CLOVA_CLIENT_SECRET ||
            !process.env.CLOVA_STT_URL ||
            !process.env.CLOVA_E2E_AUDIO_PATH,
    },
    async () => {
        // The operator running this test is expected to supply a tiny
        // WAV/PCM Buffer via CLOVA_E2E_AUDIO_PATH (absolute path).
        const audioPath = process.env.CLOVA_E2E_AUDIO_PATH;
        const fs = await import("node:fs/promises");
        const audio = await fs.readFile(audioPath);
        const stt = createClovaSttAdapter({
            url: process.env.CLOVA_STT_URL,
            clientId: process.env.CLOVA_CLIENT_ID,
            clientSecret: process.env.CLOVA_CLIENT_SECRET,
        });
        const result = await stt.transcribeChunk(audio, {
            language: "ko-KR",
            sessionId: "real-provider-smoke",
        });
        assert.equal(result.usage.provider, "clova");
        assert.equal(result.usage.status, "succeeded");
    },
);
