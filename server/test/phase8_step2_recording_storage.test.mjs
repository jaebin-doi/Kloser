/* Phase 8 Step 2 — recording storage adapter tests.
 *
 * Plan: docs/plan/phase-8/PHASE_8_STEP_2_PLAN.md §7.
 *
 * The adapter boundary owns object-storage operations. The tests prove
 *
 *   (a) the local provider runs purely on the filesystem (no network,
 *       no real S3) and refuses path traversal in object keys.
 *   (b) the resolver picks the right adapter for each
 *       RECORDING_STORAGE_PROVIDER env value, defaults to local in
 *       dev/test, and fails fast for unknown / missing provider env.
 *   (c) s3 / minio config validation enumerates missing keys by NAME
 *       without echoing values, and the sentinel adapter throws a
 *       stable not_implemented code on method calls (Step 3 lands the
 *       real client).
 *   (d) signed-URL TTLs are bounded and rejected outside [1, 900].
 *   (e) errors never include secrets, bucket, object key, body bytes,
 *       or signed URL contents.
 *
 * No network. All tests run on temp filesystem paths and on stubbed
 * env objects passed into resolveRecordingStorageAdapter.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    RecordingStorageConfigError,
    RecordingStorageInputError,
    RecordingStorageOperationError,
    RECORDING_UPLOAD_TTL_DEFAULT_SECONDS,
    RECORDING_READ_TTL_DEFAULT_SECONDS,
    RECORDING_URL_TTL_MAX_SECONDS,
    buildRecordingObjectKey,
    createLocalRecordingStorageAdapter,
    readS3CompatibleConfigFromEnv,
    resolveRecordingStorageAdapter,
} from "../src/adapters/recordingStorage.ts";

// ============================================================ //
// Helpers
// ============================================================ //

async function makeTempRoot() {
    return mkdtemp(path.join(tmpdir(), "kloser-recording-test-"));
}

async function withTempLocal(test) {
    const root = await makeTempRoot();
    const adapter = createLocalRecordingStorageAdapter({
        rootDir: root,
        publicBaseUrl: null,
        // Freeze the clock at a known instant so URL `expires` is stable
        // and the test can assert exact values.
        now: () => 1_700_000_000_000,
    });
    try {
        await test(adapter, root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

const SECRETS = [
    "AKIAFAKEACCESSKEY",
    "fake-secret-access-key-shhh",
    "endpoint.invalid",
    "very-secret-bucket",
];

function assertNoLeakage(message, extras = []) {
    const lower = String(message ?? "").toLowerCase();
    for (const needle of [...SECRETS, ...extras]) {
        assert.equal(
            lower.includes(needle.toLowerCase()),
            false,
            `error message must not echo sensitive value '${needle}', got: ${message}`,
        );
    }
}

// ============================================================ //
// 1. buildRecordingObjectKey contract
// ============================================================ //

test("buildRecordingObjectKey produces a deterministic, traversal-free key", () => {
    const key = buildRecordingObjectKey({
        orgId: "11111111-1111-1111-1111-111111111111",
        callId: "22222222-2222-2222-2222-222222222222",
        recordingId: "33333333-3333-3333-3333-333333333333",
        contentType: "audio/webm",
        now: new Date("2026-05-19T01:02:03.456Z"),
    });
    assert.equal(
        key,
        "orgs/11111111-1111-1111-1111-111111111111/calls/22222222-2222-2222-2222-222222222222/recordings/33333333-3333-3333-3333-333333333333/20260519T010203456Z-original.webm",
    );
});

test("buildRecordingObjectKey rejects non-uuid org/call/recording ids", () => {
    assert.throws(
        () =>
            buildRecordingObjectKey({
                orgId: "../traversal",
                callId: "22222222-2222-2222-2222-222222222222",
                recordingId: "33333333-3333-3333-3333-333333333333",
                contentType: "audio/webm",
                now: new Date(),
            }),
        (err) => err instanceof RecordingStorageInputError,
    );
});

// ============================================================ //
// 2. Local provider round-trip
// ============================================================ //

test("local putObject → file exists; deleteObject removes it; both report safe sizes", async () => {
    await withTempLocal(async (adapter, root) => {
        const body = Buffer.from("hello-recording-bytes");
        const objectKey = "tenant-org/call-1/recording-1.webm";
        const result = await adapter.putObject({
            bucket: null,
            objectKey,
            contentType: "audio/webm",
            body,
        });
        assert.equal(result.sizeBytes, body.length);
        assert.equal(result.checksumSha256.length, 64);
        assert.ok(/^[0-9a-f]+$/.test(result.checksumSha256));

        const absolute = path.join(root, objectKey);
        const fs = await stat(absolute);
        assert.equal(fs.size, body.length);

        await adapter.deleteObject({ bucket: null, objectKey });
        await assert.rejects(
            adapter.deleteObject({ bucket: null, objectKey }),
            (err) =>
                err instanceof RecordingStorageOperationError &&
                err.code === "storage_object_not_found",
        );
    });
});

test("local putObject rejects checksum mismatch and never leaks the bytes", async () => {
    await withTempLocal(async (adapter) => {
        await assert.rejects(
            adapter.putObject({
                bucket: null,
                objectKey: "a/b/c.webm",
                contentType: "audio/webm",
                body: Buffer.from("plain"),
                checksumSha256: "0".repeat(64),
            }),
            (err) => {
                if (
                    !(err instanceof RecordingStorageInputError) ||
                    err.code !== "checksum_mismatch"
                ) {
                    return false;
                }
                assertNoLeakage(err.message, ["plain"]);
                return true;
            },
        );
    });
});

test("local 0-byte object writes successfully", async () => {
    await withTempLocal(async (adapter) => {
        const result = await adapter.putObject({
            bucket: null,
            objectKey: "empty/file.webm",
            contentType: "audio/webm",
            body: Buffer.alloc(0),
        });
        assert.equal(result.sizeBytes, 0);
        assert.equal(result.checksumSha256.length, 64);
    });
});

// ============================================================ //
// 3. Path traversal protection
// ============================================================ //

test("local provider rejects path-traversal object keys before any filesystem write", async () => {
    await withTempLocal(async (adapter) => {
        for (const key of [
            "../escape.webm",
            "a/../../escape.webm",
            "/absolute/escape.webm",
            "C:\\windows\\drive.webm",
            "back\\slash.webm",
            "a%2e%2e/b",
            "double//slash.webm",
            "control\u0001char.webm",
        ]) {
            await assert.rejects(
                adapter.putObject({
                    bucket: null,
                    objectKey: key,
                    contentType: "audio/webm",
                    body: Buffer.from("x"),
                }),
                (err) => {
                    if (!(err instanceof RecordingStorageInputError)) {
                        return false;
                    }
                    assertNoLeakage(err.message, [key]);
                    return true;
                },
                `key '${key}' should have been rejected`,
            );
        }
    });
});

// ============================================================ //
// 4. Local signed URLs
// ============================================================ //

test("local createUploadUrl / createReadUrl emit bounded URLs with correct method", async () => {
    // Use a real clock for this test so we can assert expiresAt is in
    // the future. The frozen-clock variant lives elsewhere.
    const root = await makeTempRoot();
    try {
        const adapter = createLocalRecordingStorageAdapter({
            rootDir: root,
            publicBaseUrl: null,
        });
        const objectKey = "tenant/call/recording.webm";
        const before = Date.now();
        const upload = await adapter.createUploadUrl({
            bucket: null,
            objectKey,
            contentType: "audio/webm",
            expiresInSeconds: RECORDING_UPLOAD_TTL_DEFAULT_SECONDS,
        });
        assert.equal(upload.method, "PUT");
        assert.equal(upload.headers["Content-Type"], "audio/webm");
        assert.ok(upload.expiresAt instanceof Date);
        assert.ok(upload.expiresAt.getTime() >= before);
        assert.ok(
            upload.url.startsWith("http://localhost.invalid/recordings/"),
            `unexpected upload url: ${upload.url}`,
        );

        const read = await adapter.createReadUrl({
            bucket: null,
            objectKey,
            expiresInSeconds: RECORDING_READ_TTL_DEFAULT_SECONDS,
        });
        assert.equal(read.method, "GET");
        assert.deepEqual(read.headers, {});
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("signed URL TTL out-of-range is rejected", async () => {
    await withTempLocal(async (adapter) => {
        await assert.rejects(
            adapter.createReadUrl({
                bucket: null,
                objectKey: "k.webm",
                expiresInSeconds: 0,
            }),
            (err) =>
                err instanceof RecordingStorageInputError &&
                err.code === "ttl_invalid",
        );
        await assert.rejects(
            adapter.createReadUrl({
                bucket: null,
                objectKey: "k.webm",
                expiresInSeconds: RECORDING_URL_TTL_MAX_SECONDS + 1,
            }),
            (err) =>
                err instanceof RecordingStorageInputError &&
                err.code === "ttl_too_long",
        );
    });
});

// ============================================================ //
// 5. Resolver — default + explicit local + unknown
// ============================================================ //

test("resolver defaults to local when provider env is unset (non-production)", () => {
    const adapter = resolveRecordingStorageAdapter({
        env: { NODE_ENV: "test", RECORDING_STORAGE_LOCAL_ROOT: ".tmp-root" },
    });
    assert.equal(adapter.provider, "local");
});

test("resolver returns local when RECORDING_STORAGE_PROVIDER=local", () => {
    const adapter = resolveRecordingStorageAdapter({
        env: {
            NODE_ENV: "test",
            RECORDING_STORAGE_PROVIDER: "local",
            RECORDING_STORAGE_LOCAL_ROOT: ".tmp-root",
        },
    });
    assert.equal(adapter.provider, "local");
});

test("resolver throws on unknown provider WITHOUT echoing the raw value", () => {
    const evilValue = "AKIAFAKEACCESSKEY";
    assert.throws(
        () =>
            resolveRecordingStorageAdapter({
                env: {
                    NODE_ENV: "test",
                    RECORDING_STORAGE_PROVIDER: evilValue,
                },
            }),
        (err) => {
            if (
                !(err instanceof RecordingStorageConfigError) ||
                err.code !== "provider_unknown"
            ) {
                return false;
            }
            assertNoLeakage(err.message, [evilValue]);
            assert.ok(
                err.message.includes("local") &&
                    err.message.includes("s3") &&
                    err.message.includes("minio"),
                "unknown provider error must list supported values",
            );
            return true;
        },
    );
});

test("resolver fails fast in production when provider env is unset", () => {
    assert.throws(
        () =>
            resolveRecordingStorageAdapter({
                env: { NODE_ENV: "production" },
            }),
        (err) =>
            err instanceof RecordingStorageConfigError &&
            err.code === "missing_env",
    );
});

// ============================================================ //
// 6. s3 / minio env validation
// ============================================================ //

const FULL_S3_ENV = {
    NODE_ENV: "test",
    RECORDING_STORAGE_PROVIDER: "s3",
    RECORDING_STORAGE_BUCKET: "very-secret-bucket",
    RECORDING_STORAGE_REGION: "us-east-1",
    RECORDING_STORAGE_ACCESS_KEY_ID: "AKIAFAKEACCESSKEY",
    RECORDING_STORAGE_SECRET_ACCESS_KEY: "fake-secret-access-key-shhh",
};

const FULL_MINIO_ENV = {
    NODE_ENV: "test",
    RECORDING_STORAGE_PROVIDER: "minio",
    RECORDING_STORAGE_BUCKET: "very-secret-bucket",
    RECORDING_STORAGE_REGION: "us-east-1",
    RECORDING_STORAGE_ENDPOINT: "endpoint.invalid",
    RECORDING_STORAGE_ACCESS_KEY_ID: "AKIAFAKEACCESSKEY",
    RECORDING_STORAGE_SECRET_ACCESS_KEY: "fake-secret-access-key-shhh",
};

test("s3 with complete env returns sentinel adapter whose methods throw not_implemented_step_2", async () => {
    const adapter = resolveRecordingStorageAdapter({ env: FULL_S3_ENV });
    assert.equal(adapter.provider, "s3");

    for (const call of [
        () =>
            adapter.createReadUrl({
                bucket: "x",
                objectKey: "k",
                expiresInSeconds: 60,
            }),
        () =>
            adapter.createUploadUrl({
                bucket: "x",
                objectKey: "k",
                contentType: "audio/webm",
                expiresInSeconds: 60,
            }),
        () =>
            adapter.putObject({
                bucket: "x",
                objectKey: "k",
                contentType: "audio/webm",
                body: Buffer.from("x"),
            }),
        () => adapter.deleteObject({ bucket: "x", objectKey: "k" }),
    ]) {
        await assert.rejects(call, (err) => {
            if (
                !(err instanceof RecordingStorageOperationError) ||
                err.code !== "not_implemented_step_2"
            ) {
                return false;
            }
            assertNoLeakage(err.message);
            return true;
        });
    }
});

test("s3 missing required env enumerates ALL missing keys by NAME only", () => {
    const env = {
        NODE_ENV: "test",
        RECORDING_STORAGE_PROVIDER: "s3",
        RECORDING_STORAGE_REGION: "us-east-1",
        // bucket + access key + secret missing
    };
    assert.throws(
        () => resolveRecordingStorageAdapter({ env }),
        (err) => {
            if (
                !(err instanceof RecordingStorageConfigError) ||
                err.code !== "missing_env"
            ) {
                return false;
            }
            for (const expected of [
                "RECORDING_STORAGE_BUCKET",
                "RECORDING_STORAGE_ACCESS_KEY_ID",
                "RECORDING_STORAGE_SECRET_ACCESS_KEY",
            ]) {
                assert.ok(
                    err.message.includes(expected),
                    `expected '${expected}' in: ${err.message}`,
                );
            }
            // No values leaked.
            assertNoLeakage(err.message);
            return true;
        },
    );
});

test("minio requires RECORDING_STORAGE_ENDPOINT in addition to the s3 base", () => {
    const env = { ...FULL_S3_ENV, RECORDING_STORAGE_PROVIDER: "minio" };
    assert.throws(
        () => resolveRecordingStorageAdapter({ env }),
        (err) =>
            err instanceof RecordingStorageConfigError &&
            err.code === "missing_env" &&
            err.message.includes("RECORDING_STORAGE_ENDPOINT"),
    );
});

test("readS3CompatibleConfigFromEnv exposes force-path-style with provider-aware defaults", () => {
    const s3 = readS3CompatibleConfigFromEnv("s3", FULL_S3_ENV);
    assert.equal(s3.forcePathStyle, false);

    const minio = readS3CompatibleConfigFromEnv("minio", FULL_MINIO_ENV);
    assert.equal(minio.forcePathStyle, true);

    const explicit = readS3CompatibleConfigFromEnv("s3", {
        ...FULL_S3_ENV,
        RECORDING_STORAGE_FORCE_PATH_STYLE: "true",
    });
    assert.equal(explicit.forcePathStyle, true);
});

// ============================================================ //
// 7. Default TTLs are inside the cap
// ============================================================ //

test("TTL constants form a coherent default/max policy (defaults < max)", () => {
    assert.ok(RECORDING_UPLOAD_TTL_DEFAULT_SECONDS > 0);
    assert.ok(RECORDING_READ_TTL_DEFAULT_SECONDS > 0);
    assert.ok(RECORDING_UPLOAD_TTL_DEFAULT_SECONDS <= RECORDING_URL_TTL_MAX_SECONDS);
    assert.ok(RECORDING_READ_TTL_DEFAULT_SECONDS <= RECORDING_URL_TTL_MAX_SECONDS);
});
