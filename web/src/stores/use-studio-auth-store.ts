import { create } from "zustand";

export type StudioAccountUser = {
    id: number;
    username: string;
    displayName: string;
    group: string;
    quota?: number;
    usedQuota?: number;
};

export type StudioAccountToken = {
    id: number;
    name: string;
    key: string;
};

type StudioAuthStore = {
    user: StudioAccountUser | null;
    accessToken: string;
    accessExpiresAt: number;
    sessionId: string;
    apiToken: StudioAccountToken | null;
    models: string[];
    status: "idle" | "loading" | "ready" | "anonymous" | "error";
    error: string;
    setSession: (value: Partial<Pick<StudioAuthStore, "user" | "accessToken" | "accessExpiresAt" | "sessionId" | "apiToken" | "models" | "status" | "error">>) => void;
    reset: () => void;
};

const emptyState = {
    user: null,
    accessToken: "",
    accessExpiresAt: 0,
    sessionId: "",
    apiToken: null,
    models: [],
    status: "idle" as const,
    error: "",
};

export const useStudioAuthStore = create<StudioAuthStore>()((set) => ({
    ...emptyState,
    setSession: (value) => set(value),
    reset: () => set({ ...emptyState, status: "anonymous" }),
}));
