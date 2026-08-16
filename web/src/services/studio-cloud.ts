import { getImageBlob, setImageBlob } from "@/services/image-storage";
import { paidAccountFetch } from "@/services/api/studio-account";
import { studioDataSnapshot, useStudioStore, waitForStudioHydration } from "@/stores/use-studio-store";
import type { StudioData, StudioJob, StudioProfile, StudioTombstone } from "@/types/studio";

type StudioCloudManifest = {
    app: "personal-image-studio";
    version: 1;
    updatedAt: string;
    data: StudioData;
};

export type StudioCloudResult = {
    uploaded: number;
    downloaded: number;
    syncedAt: string;
};

const cloudBase = `${String(import.meta.env.BASE_URL || "/").replace(/\/+$/, "")}/cloud`;
let scheduledTimer: ReturnType<typeof setTimeout> | null = null;
let activeSync: Promise<StudioCloudResult> | null = null;
let activeSyncOwnerId: number | null = null;

function cloudPath(path: string) {
    return `${cloudBase}${path}`;
}

function mergeByUpdatedAt<T extends { id: string; updatedAt: string }>(local: T[], remote: T[]) {
    const merged = new Map<string, T>();
    for (const item of [...local, ...remote]) {
        const current = merged.get(item.id);
        if (!current || timestamp(item.updatedAt) >= timestamp(current.updatedAt)) merged.set(item.id, item);
    }
    return Array.from(merged.values()).sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt));
}

function timestamp(value: string | undefined) {
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : 0;
}

function mergeStudioData(local: StudioData, remote: StudioData): StudioData {
    const profileTombstones = mergeByUpdatedAt<StudioTombstone>(local.profileTombstones, remote.profileTombstones || []);
    const jobTombstones = mergeByUpdatedAt<StudioTombstone>(local.jobTombstones, remote.jobTombstones || []);
    const deletedProfiles = new Map(profileTombstones.map((item) => [item.id, timestamp(item.updatedAt)]));
    const deletedJobs = new Map(jobTombstones.map((item) => [item.id, timestamp(item.updatedAt)]));
    const profiles = mergeByUpdatedAt<StudioProfile>(local.profiles, remote.profiles || []).filter((item) => timestamp(item.updatedAt) > (deletedProfiles.get(item.id) || 0));
    const jobs = mergeByUpdatedAt<StudioJob>(local.jobs, remote.jobs || []).filter((item) => timestamp(item.updatedAt) > (deletedJobs.get(item.id) || 0));
    const remoteSettings = remote.settings || local.settings;
    const settings = timestamp(remoteSettings.updatedAt) > timestamp(local.settings.updatedAt) ? remoteSettings : local.settings;
    return { profiles, jobs, settings, profileTombstones, jobTombstones };
}

function collectStorageKeys(data: StudioData) {
    const keys = new Set<string>();
    data.profiles.forEach((profile) => keys.add(profile.identity.storageKey));
    data.jobs.forEach((job) => {
        keys.add(job.reference.storageKey);
        job.shots.forEach((shot) => {
            if (shot.result?.storageKey) keys.add(shot.result.storageKey);
        });
    });
    return Array.from(keys).filter((key) => key.startsWith("image:"));
}

async function mapConcurrent<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
    let cursor = 0;
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (cursor < items.length) {
                const index = cursor++;
                await worker(items[index]);
            }
        }),
    );
}

async function readRemoteState(ownerUserId: number) {
    const response = await paidAccountFetch(cloudPath("/state"), {}, true, ownerUserId);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`读取云端数据失败 (${response.status})`);
    const manifest = (await response.json()) as StudioCloudManifest;
    if (manifest.app !== "personal-image-studio" || manifest.version !== 1 || !manifest.data) throw new Error("云端影棚数据格式不受支持");
    return manifest;
}

function requireSyncOwner(ownerUserId: number) {
    if (useStudioStore.getState().ownerUserId !== ownerUserId) throw new Error("影棚数据所属账号已切换，请重新同步");
}

async function syncNow(ownerUserId: number): Promise<StudioCloudResult> {
    await waitForStudioHydration();
    requireSyncOwner(ownerUserId);
    const local = studioDataSnapshot();
    const remote = await readRemoteState(ownerUserId);
    requireSyncOwner(ownerUserId);
    const merged = remote ? mergeStudioData(local, remote.data) : local;
    let uploaded = 0;
    let downloaded = 0;
    await mapConcurrent(collectStorageKeys(merged), 3, async (storageKey) => {
        const localBlob = await getImageBlob(storageKey);
        const encodedKey = encodeURIComponent(storageKey);
        if (!localBlob) {
            const response = await paidAccountFetch(cloudPath(`/files/${encodedKey}`), {}, true, ownerUserId);
            if (response.status === 404) return;
            if (!response.ok) throw new Error(`下载媒体失败 (${response.status})`);
            await setImageBlob(storageKey, await response.blob());
            downloaded += 1;
            return;
        }
        const exists = await paidAccountFetch(cloudPath(`/files/${encodedKey}`), { method: "HEAD" }, true, ownerUserId);
        if (exists.ok) return;
        if (exists.status !== 404) throw new Error(`检查云端媒体失败 (${exists.status})`);
        const upload = await paidAccountFetch(cloudPath(`/files/${encodedKey}`), { method: "PUT", headers: { "Content-Type": localBlob.type || "application/octet-stream" }, body: localBlob }, true, ownerUserId);
        if (!upload.ok) throw new Error(`上传媒体失败 (${upload.status})`);
        uploaded += 1;
    });
    requireSyncOwner(ownerUserId);
    useStudioStore.getState().replaceStudioData(merged);
    const syncedAt = new Date().toISOString();
    const save = await paidAccountFetch(cloudPath("/state"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app: "personal-image-studio", version: 1, updatedAt: syncedAt, data: merged } satisfies StudioCloudManifest),
    }, true, ownerUserId);
    if (!save.ok) throw new Error(`保存云端数据失败 (${save.status})`);
    return { uploaded, downloaded, syncedAt };
}

export function syncStudioCloud(): Promise<StudioCloudResult> {
    const ownerUserId = useStudioStore.getState().ownerUserId;
    if (!ownerUserId) return Promise.reject(new Error("请先登录付费站账号"));
    if (activeSync && activeSyncOwnerId !== ownerUserId) return activeSync.catch(() => undefined).then(() => syncStudioCloud());
    if (!activeSync) {
        activeSyncOwnerId = ownerUserId;
        activeSync = syncNow(ownerUserId).finally(() => {
            activeSync = null;
            activeSyncOwnerId = null;
        });
    }
    return activeSync;
}

export function scheduleStudioCloudSync(onError?: (error: Error) => void) {
    if (scheduledTimer) clearTimeout(scheduledTimer);
    scheduledTimer = setTimeout(() => {
        scheduledTimer = null;
        void syncStudioCloud().catch((error) => onError?.(error instanceof Error ? error : new Error("云同步失败")));
    }, 1500);
}

export function cancelScheduledStudioCloudSync() {
    if (scheduledTimer) clearTimeout(scheduledTimer);
    scheduledTimer = null;
}
