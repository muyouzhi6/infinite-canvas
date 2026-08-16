import type { StudioJob, StudioSettings } from "@/types/studio";

export const MAX_STUDIO_CONCURRENCY = 20;

type NormalizeStudioJobsOptions = {
    recoverInterrupted?: boolean;
    now?: string;
    touchRecoveredAt?: boolean;
};

function validSequence(value: number | undefined) {
    return Number.isInteger(value) && value! > 0;
}

export function boundedStudioInteger(value: unknown, fallback: number, maximum: number) {
    const number = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
    return Math.max(1, Math.min(maximum, number));
}

export function normalizeStudioSettings(value: Partial<StudioSettings> | undefined, defaults: StudioSettings): StudioSettings {
    return {
        ...defaults,
        ...(value || {}),
        count: boundedStudioInteger(value?.count, defaults.count, 60),
        concurrency: boundedStudioInteger(value?.concurrency, defaults.concurrency, MAX_STUDIO_CONCURRENCY),
    };
}

export function nextStudioJobSequence(jobs: StudioJob[]) {
    return jobs.reduce((highest, job) => (validSequence(job.sequence) ? Math.max(highest, job.sequence!) : highest), 0) + 1;
}

export function studioJobLabel(job: StudioJob) {
    const sequence = validSequence(job.sequence) ? String(job.sequence).padStart(3, "0") : job.id.slice(0, 6).toUpperCase();
    return `#${sequence} · ${job.title}`;
}

export function normalizeStudioJobs(jobs: StudioJob[], options: NormalizeStudioJobsOptions = {}) {
    const now = options.now || new Date().toISOString();
    const usedSequences = new Set<number>();
    let nextSequence = 1;
    let changed = false;

    const normalizedById = new Map<string, StudioJob>();
    const chronological = [...jobs].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    for (const job of chronological) {
        let sequence = job.sequence;
        if (!validSequence(sequence) || usedSequences.has(sequence!)) {
            while (usedSequences.has(nextSequence)) nextSequence += 1;
            sequence = nextSequence;
            changed = true;
        }
        usedSequences.add(sequence!);
        nextSequence = Math.max(nextSequence, sequence! + 1);

        let status = job.status;
        let error = job.error;
        let shots = job.shots;
        let recoveredInterrupted = false;
        if (options.recoverInterrupted && job.status === "planning" && job.shots.length === 0) {
            status = "failed";
            error = "上次拍摄规划因页面关闭而中断，请重新创建任务";
            recoveredInterrupted = true;
        } else if (options.recoverInterrupted && (job.status === "planning" || job.status === "queued" || job.status === "running")) {
            status = "paused";
            error = "上次执行已中断，可从未完成镜头继续";
            shots = job.shots.map((shot) => (shot.status === "running" ? { ...shot, status: "queued" as const, error: undefined, updatedAt: options.touchRecoveredAt === false ? shot.updatedAt : now } : shot));
            recoveredInterrupted = true;
        }

        const count = boundedStudioInteger(job.count, 1, 60);
        const concurrency = boundedStudioInteger(job.concurrency, 1, MAX_STUDIO_CONCURRENCY);
        const jobChanged = sequence !== job.sequence || status !== job.status || error !== job.error || shots !== job.shots || count !== job.count || concurrency !== job.concurrency;
        if (jobChanged) changed = true;
        const updatedAt = recoveredInterrupted && options.touchRecoveredAt !== false ? now : job.updatedAt;
        normalizedById.set(job.id, jobChanged ? { ...job, sequence, count, concurrency, status, error, shots, updatedAt } : job);
    }

    return {
        changed,
        jobs: jobs.map((job) => normalizedById.get(job.id) || job),
    };
}
