/* Phase 5 Step 3 — adapter mock unit tests.
 *
 * Plan: docs/plan/phase-5/PHASE_5_STEP_3_ROUTES.md §1, §5.1.
 *
 * Pure unit coverage of the mock STT / LLM / Embedding adapters. No
 * Fastify boot, no DB. The real provider clients are not wired in this
 * step (plan §1.1), so the resolver branch for non-mock providers
 * intentionally throws.
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

// ============================================================
//                          STT MOCK
// ============================================================

test("mock STT returns the deterministic fixture for a known key", async () => {
    const stt = createMockSttAdapter();
    const u = await stt.transcribeChunk("greeting", {
        language: "ko-KR",
        sessionId: "test-1",
    });
    assert.ok(u);
    assert.equal(u.speaker, mockSttFixtures.greeting.speaker);
    assert.equal(u.text, mockSttFixtures.greeting.text);
    assert.equal(u.confidence, mockSttFixtures.greeting.confidence);
});

test("mock STT returns null for an unknown fixture key", async () => {
    const stt = createMockSttAdapter();
    const u = await stt.transcribeChunk("not-a-key", {
        language: "ko-KR",
        sessionId: "test-2",
    });
    assert.equal(u, null);
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
    const summary = await llm.summarizeCall({ transcript: "" });
    assert.equal(summary.summary, null);
    assert.equal(summary.needs, null);
    assert.equal(summary.issues, null);
    assert.equal(summary.sentiment, null);
});

test("mock LLM summarizeCall derives sentiment + summary from transcript", async () => {
    const llm = createMockLlmAdapter();
    const a = await llm.summarizeCall({
        transcript: "고객이 CRM 연동 시연을 요청했습니다. 계약 의사가 있습니다.",
    });
    assert.equal(a.sentiment, "positive");
    assert.ok(a.summary && a.summary.length > 0);
    assert.equal(a.needs, "CRM 연동 / 시연 일정 협의");

    const b = await llm.summarizeCall({
        transcript: "고객이 취소 요청을 했고 강한 불만을 표출했습니다.",
    });
    assert.equal(b.sentiment, "negative");
    assert.equal(b.issues, "고객 측 우려 확인");

    const c = await llm.summarizeCall({ transcript: "안녕" });
    assert.equal(c.sentiment, "cautious");
});

test("mock LLM suggestForUtterance respects group_seq / at_ms and emits at least direction", async () => {
    const llm = createMockLlmAdapter();
    const suggestions = await llm.suggestForUtterance({
        transcript: "고객사 CRM 연동을 위한 시연 일정을 잡고 싶습니다.",
        groupSeq: 3,
        atMs: 8400,
    });
    assert.ok(suggestions.length >= 2);
    for (const s of suggestions) {
        assert.equal(s.group_seq, 3);
        assert.equal(s.at_ms, 8400);
    }
    assert.ok(suggestions.some((s) => s.type === "direction"));
    assert.ok(suggestions.some((s) => s.type === "script"));
    assert.ok(suggestions.some((s) => s.type === "next"));
});

// ============================================================
//                        EMBEDDING MOCK
// ============================================================

test("mock embedding produces a length-1536 unit vector", async () => {
    const adapter = createMockEmbeddingAdapter();
    const v = await adapter.embed("회사 가이드 본문");
    assert.equal(v.length, 1536);
    let sumSq = 0;
    for (const x of v) sumSq += x * x;
    assert.ok(Math.abs(sumSq - 1) < 1e-6, `not L2-normalised: ${sumSq}`);
});

test("mock embedding is deterministic across calls", async () => {
    const adapter = createMockEmbeddingAdapter();
    const a = await adapter.embed("동일 입력");
    const b = await adapter.embed("동일 입력");
    for (let i = 0; i < 1536; i++) {
        assert.equal(a[i], b[i]);
    }
});

test("mock embedding embedBatch returns one vector per input", async () => {
    const adapter = createMockEmbeddingAdapter();
    const vs = await adapter.embedBatch(["one", "two", "three"]);
    assert.equal(vs.length, 3);
    for (const v of vs) assert.equal(v.length, 1536);
});

// ============================================================
//                          RESOLVERS
// ============================================================

test("resolveXxxAdapter defaults to mock when no env var is set", () => {
    const prevStt = process.env.STT_PROVIDER;
    const prevLlm = process.env.LLM_PROVIDER;
    const prevEmb = process.env.EMBEDDING_PROVIDER;
    try {
        delete process.env.STT_PROVIDER;
        delete process.env.LLM_PROVIDER;
        delete process.env.EMBEDDING_PROVIDER;
        const stt = resolveSttAdapter();
        const llm = resolveLlmAdapter();
        const emb = resolveEmbeddingAdapter();
        assert.equal(stt.provider, "mock");
        assert.equal(llm.provider, "mock");
        assert.equal(emb.provider, "mock");
        assert.equal(emb.dimensions, 1536);
    } finally {
        if (prevStt !== undefined) process.env.STT_PROVIDER = prevStt;
        if (prevLlm !== undefined) process.env.LLM_PROVIDER = prevLlm;
        if (prevEmb !== undefined) process.env.EMBEDDING_PROVIDER = prevEmb;
    }
});

test("resolveSttAdapter throws when STT_PROVIDER is unknown", () => {
    const prev = process.env.STT_PROVIDER;
    try {
        process.env.STT_PROVIDER = "clova";
        assert.throws(() => resolveSttAdapter(), /not implemented/);
    } finally {
        if (prev !== undefined) process.env.STT_PROVIDER = prev;
        else delete process.env.STT_PROVIDER;
    }
});
