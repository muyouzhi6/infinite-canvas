import assert from "node:assert/strict";
import test from "node:test";

import { buildStudioGenerationReferences, buildStudioImagePrompt } from "../src/services/studio-generation.ts";
import { MAX_STUDIO_CONCURRENCY, nextStudioJobSequence, normalizeStudioJobs, normalizeStudioSettings, studioJobLabel } from "../src/services/studio-state.ts";

const now = "2026-08-16T12:00:00.000Z";

function job(overrides = {}) {
    return {
        id: "job-abcdef",
        title: "吱吱 · 照着这张仿拍",
        workflow: "recreate",
        profileId: "profile-1",
        brief: "",
        reference: {},
        plannerSource: "account",
        plannerModel: "gpt-5.6-luna",
        imageSource: "account",
        imageModel: "gemini-3.1-flash-image",
        count: 2,
        concurrency: 2,
        status: "running",
        shots: [
            { id: "shot-1", index: 0, status: "running", updatedAt: "2026-08-16T11:00:00.000Z" },
            { id: "shot-2", index: 1, status: "success", updatedAt: "2026-08-16T11:00:00.000Z" },
        ],
        createdAt: "2026-08-16T10:00:00.000Z",
        updatedAt: "2026-08-16T11:00:00.000Z",
        ...overrides,
    };
}

test("recovers interrupted jobs and preserves completed shots", () => {
    const result = normalizeStudioJobs([job()], { recoverInterrupted: true, now });
    assert.equal(result.changed, true);
    assert.equal(result.jobs[0].sequence, 1);
    assert.equal(result.jobs[0].status, "paused");
    assert.equal(result.jobs[0].shots[0].status, "queued");
    assert.equal(result.jobs[0].shots[1].status, "success");
    assert.equal(result.jobs[0].updatedAt, now);
    assert.match(result.jobs[0].error, /可从未完成镜头继续/);
});

test("preserves timestamps for metadata normalization and pre-sync recovery", () => {
    const originalUpdatedAt = "2026-08-16T11:00:00.000Z";
    const normalized = normalizeStudioJobs([job({ status: "completed", sequence: undefined, updatedAt: originalUpdatedAt })], { now });
    assert.equal(normalized.jobs[0].sequence, 1);
    assert.equal(normalized.jobs[0].updatedAt, originalUpdatedAt);

    const recovered = normalizeStudioJobs([job({ updatedAt: originalUpdatedAt })], { recoverInterrupted: true, touchRecoveredAt: false, now });
    assert.equal(recovered.jobs[0].status, "paused");
    assert.equal(recovered.jobs[0].updatedAt, originalUpdatedAt);
    assert.equal(recovered.jobs[0].shots[0].updatedAt, originalUpdatedAt);
});

test("marks an interrupted empty planning job as failed", () => {
    const result = normalizeStudioJobs([job({ status: "planning", shots: [] })], { recoverInterrupted: true, now });
    assert.equal(result.jobs[0].status, "failed");
    assert.match(result.jobs[0].error, /重新创建任务/);
});

test("assigns stable unique sequences and uses them in labels", () => {
    const jobs = [job({ id: "newer", createdAt: "2026-08-16T11:00:00.000Z", sequence: 1 }), job({ id: "older", createdAt: "2026-08-16T09:00:00.000Z", sequence: 1 })];
    const result = normalizeStudioJobs(jobs, { now });
    assert.deepEqual(
        result.jobs.map((item) => item.sequence),
        [2, 1],
    );
    assert.equal(nextStudioJobSequence(result.jobs), 3);
    assert.match(studioJobLabel(result.jobs[0]), /^#002 · /);
});

test("clamps invalid persisted and cloud concurrency values", () => {
    const result = normalizeStudioJobs([job({ count: Number.NaN, concurrency: 999 })], { now });
    assert.equal(result.jobs[0].count, 1);
    assert.equal(result.jobs[0].concurrency, MAX_STUDIO_CONCURRENCY);

    const defaults = { count: 6, concurrency: 2 };
    assert.equal(normalizeStudioSettings({ concurrency: Number.NaN }, defaults).concurrency, 2);
    assert.equal(normalizeStudioSettings({ concurrency: 99 }, defaults).concurrency, MAX_STUDIO_CONCURRENCY);
});

test("keeps workflow references out of final image generation", () => {
    const profile = {
        identity: { id: "identity-1", storageKey: "image:identity", mimeType: "image/png" },
        identityPrompt: "保留自然五官",
    };
    const references = buildStudioGenerationReferences(profile);
    assert.equal(references.length, 1);
    assert.equal(references[0].storageKey, "image:identity");
    assert.match(references[0].promptRole, /唯一人脸身份锚点/);
});

test("describes all workflows without a visible second image", () => {
    const profile = { identityPrompt: "保留自然五官" };
    const shot = { title: "镜头", prompt: "执行镜头描述", pose: "站立", framing: "中景", lens: "50mm", aspectRatio: "3:4", resolution: "4K" };
    const rules = {
        outfit: /服装参考图已经由规划模型转换/,
        recreate: /仿拍目标已经由规划模型转换/,
        variants: /满意母片已经由规划模型转换/,
    };
    for (const [workflow, rule] of Object.entries(rules)) {
        const prompt = buildStudioImagePrompt(profile, { ...job(), workflow }, shot);
        assert.match(prompt, rule);
        assert.match(prompt, /只接收图片1/);
        assert.doesNotMatch(prompt, /图片2/);
    }
});
