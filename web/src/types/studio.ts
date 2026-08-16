export type StudioWorkflow = "outfit" | "recreate" | "variants";
export type StudioNodeSource = "account" | "custom";
export type StudioJobStatus = "planning" | "queued" | "running" | "paused" | "completed" | "failed";
export type StudioShotStatus = "queued" | "running" | "success" | "failed";

export type StudioStoredImage = {
    id: string;
    name: string;
    storageKey: string;
    mimeType: string;
    width: number;
    height: number;
    bytes: number;
};

export type StudioProfile = {
    id: string;
    name: string;
    identity: StudioStoredImage;
    identityPrompt: string;
    defaultPlannerModel?: string;
    defaultImageModel?: string;
    createdAt: string;
    updatedAt: string;
};

export type StudioGeneratedImage = StudioStoredImage & {
    durationMs: number;
};

export type StudioTombstone = {
    id: string;
    updatedAt: string;
};

export type StudioShot = {
    id: string;
    index: number;
    title: string;
    prompt: string;
    pose: string;
    framing: string;
    lens: string;
    aspectRatio: string;
    resolution: "1K" | "2K" | "4K";
    modelSource: StudioNodeSource;
    model: string;
    status: StudioShotStatus;
    attempts: number;
    favorite: boolean;
    result?: StudioGeneratedImage;
    error?: string;
    updatedAt: string;
};

export type StudioJob = {
    id: string;
    sequence?: number;
    title: string;
    workflow: StudioWorkflow;
    profileId: string;
    brief: string;
    reference: StudioStoredImage;
    plannerSource: StudioNodeSource;
    plannerModel: string;
    imageSource: StudioNodeSource;
    imageModel: string;
    count: number;
    concurrency: number;
    status: StudioJobStatus;
    shots: StudioShot[];
    error?: string;
    createdAt: string;
    updatedAt: string;
};

export type StudioSettings = {
    selectedProfileId: string;
    workflow: StudioWorkflow;
    plannerSource: StudioNodeSource;
    plannerModel: string;
    imageSource: StudioNodeSource;
    imageModel: string;
    count: number;
    concurrency: number;
    aspectRatio: string;
    resolution: "1K" | "2K" | "4K";
    updatedAt: string;
};

export type StudioData = {
    profiles: StudioProfile[];
    jobs: StudioJob[];
    settings: StudioSettings;
    profileTombstones: StudioTombstone[];
    jobTombstones: StudioTombstone[];
};
