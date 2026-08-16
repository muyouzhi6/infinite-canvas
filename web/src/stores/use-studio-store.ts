import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { localForageStorage } from "@/lib/localforage-storage";
import type { StudioData, StudioJob, StudioProfile, StudioSettings, StudioShot } from "@/types/studio";

type StudioStore = StudioData & {
    hydrated: boolean;
    ownerUserId: number | null;
    upsertProfile: (profile: StudioProfile) => void;
    removeProfile: (id: string) => void;
    addJob: (job: StudioJob) => void;
    updateJob: (id: string, patch: Partial<Omit<StudioJob, "id" | "createdAt">>) => void;
    updateShot: (jobId: string, shotId: string, patch: Partial<Omit<StudioShot, "id" | "index">>) => void;
    removeJob: (id: string) => void;
    updateSettings: (patch: Partial<Omit<StudioSettings, "updatedAt">>) => void;
    bindAccountOwner: (userId: number) => void;
    replaceStudioData: (data: StudioData) => void;
};

const defaultSettings: StudioSettings = {
    selectedProfileId: "",
    workflow: "outfit",
    plannerSource: "account",
    plannerModel: "",
    imageSource: "account",
    imageModel: "",
    count: 6,
    concurrency: 2,
    aspectRatio: "3:4",
    resolution: "4K",
    updatedAt: new Date(0).toISOString(),
};

function addTombstone(items: StudioStore["profileTombstones"], id: string, updatedAt: string) {
    return [{ id, updatedAt }, ...items.filter((item) => item.id !== id)];
}

const studioStorage: PersistStorage<StudioStore> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        return value ? (JSON.parse(value) as StorageValue<StudioStore>) : null;
    },
    setItem: (name, value) => localForageStorage.setItem(name, JSON.stringify(value)),
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useStudioStore = create<StudioStore>()(
    persist(
        (set) => ({
            hydrated: false,
            ownerUserId: null,
            profiles: [],
            jobs: [],
            settings: defaultSettings,
            profileTombstones: [],
            jobTombstones: [],
            upsertProfile: (profile) =>
                set((state) => {
                    const exists = state.profiles.some((item) => item.id === profile.id);
                    return {
                        profiles: exists ? state.profiles.map((item) => (item.id === profile.id ? profile : item)) : [profile, ...state.profiles],
                        profileTombstones: state.profileTombstones.filter((item) => item.id !== profile.id),
                        settings: state.settings.selectedProfileId ? state.settings : { ...state.settings, selectedProfileId: profile.id, updatedAt: new Date().toISOString() },
                    };
                }),
            removeProfile: (id) =>
                set((state) => {
                    const updatedAt = new Date().toISOString();
                    const profiles = state.profiles.filter((item) => item.id !== id);
                    return {
                        profiles,
                        profileTombstones: addTombstone(state.profileTombstones, id, updatedAt),
                        settings: state.settings.selectedProfileId === id ? { ...state.settings, selectedProfileId: profiles[0]?.id || "", updatedAt } : state.settings,
                    };
                }),
            addJob: (job) => set((state) => ({ jobs: [job, ...state.jobs], jobTombstones: state.jobTombstones.filter((item) => item.id !== job.id) })),
            updateJob: (id, patch) =>
                set((state) => ({
                    jobs: state.jobs.map((job) => (job.id === id ? { ...job, ...patch, updatedAt: new Date().toISOString() } : job)),
                })),
            updateShot: (jobId, shotId, patch) =>
                set((state) => ({
                    jobs: state.jobs.map((job) =>
                        job.id === jobId
                            ? {
                                  ...job,
                                  updatedAt: new Date().toISOString(),
                                  shots: job.shots.map((shot) => (shot.id === shotId ? { ...shot, ...patch, updatedAt: new Date().toISOString() } : shot)),
                              }
                            : job,
                    ),
                })),
            removeJob: (id) =>
                set((state) => {
                    const updatedAt = new Date().toISOString();
                    return { jobs: state.jobs.filter((item) => item.id !== id), jobTombstones: addTombstone(state.jobTombstones, id, updatedAt) };
                }),
            updateSettings: (patch) => set((state) => ({ settings: { ...state.settings, ...patch, updatedAt: new Date().toISOString() } })),
            bindAccountOwner: (userId) =>
                set((state) => {
                    if (!state.ownerUserId || state.ownerUserId === userId) return { ownerUserId: userId };
                    return {
                        ownerUserId: userId,
                        profiles: [],
                        jobs: [],
                        settings: { ...defaultSettings, updatedAt: new Date().toISOString() },
                        profileTombstones: [],
                        jobTombstones: [],
                    };
                }),
            replaceStudioData: (data) =>
                set({
                    profiles: data.profiles,
                    jobs: data.jobs,
                    settings: data.settings,
                    profileTombstones: data.profileTombstones,
                    jobTombstones: data.jobTombstones,
                }),
        }),
        {
            name: "infinite-canvas:studio_store",
            storage: studioStorage,
            partialize: (state) =>
                ({
                    ownerUserId: state.ownerUserId,
                    profiles: state.profiles,
                    jobs: state.jobs,
                    settings: state.settings,
                    profileTombstones: state.profileTombstones,
                    jobTombstones: state.jobTombstones,
                }) as StorageValue<StudioStore>["state"],
            merge: (persisted, current) => {
                const value = (persisted || {}) as Partial<StudioStore>;
                return {
                    ...current,
                    ownerUserId: Number.isInteger(value.ownerUserId) ? value.ownerUserId! : null,
                    profiles: Array.isArray(value.profiles) ? value.profiles : [],
                    jobs: Array.isArray(value.jobs) ? value.jobs : [],
                    settings: { ...defaultSettings, ...(value.settings || {}) },
                    profileTombstones: Array.isArray(value.profileTombstones) ? value.profileTombstones : [],
                    jobTombstones: Array.isArray(value.jobTombstones) ? value.jobTombstones : [],
                };
            },
            onRehydrateStorage: () => () => useStudioStore.setState({ hydrated: true }),
        },
    ),
);

export function studioDataSnapshot(): StudioData {
    const { profiles, jobs, settings, profileTombstones, jobTombstones } = useStudioStore.getState();
    return { profiles, jobs, settings, profileTombstones, jobTombstones };
}

export async function waitForStudioHydration() {
    if (useStudioStore.persist.hasHydrated()) return;
    await new Promise<void>((resolve) => {
        const unsubscribe = useStudioStore.persist.onFinishHydration(() => {
            unsubscribe();
            resolve();
        });
        if (useStudioStore.persist.hasHydrated()) {
            unsubscribe();
            resolve();
        }
    });
}
