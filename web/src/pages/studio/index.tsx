import { Camera, Check, Cloud, Download, Heart, ImagePlus, LoaderCircle, LogIn, Pause, Pencil, Play, Plus, RefreshCw, RotateCcw, Shirt, Sparkles, Trash2, Upload, UserRound } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Drawer, Empty, Image, Input, InputNumber, Modal, Pagination, Progress, Segmented, Select, Tag, Tooltip } from "antd";
import { saveAs } from "file-saver";
import { nanoid } from "nanoid";

import { ModelPicker } from "@/components/model-picker";
import { Turnstile } from "@/components/turnstile";
import {
    buildStudioNodeConfig,
    bootstrapPaidAccount,
    completePaidAccount2FA,
    disconnectPaidAccount,
    loadPaidSiteLoginStatus,
    loginPaidAccount,
    PAID_GEMINI_CHANNEL_ID,
    PAID_OPENAI_CHANNEL_ID,
    type PaidSiteLoginStatus,
} from "@/services/api/studio-account";
import { requestEdit } from "@/services/api/image";
import { deleteStoredImages, getImageBlob, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { cancelScheduledStudioCloudSync, scheduleStudioCloudSync, syncStudioCloudWithRecovery } from "@/services/studio-cloud";
import { buildStudioGenerationReferences, buildStudioImagePrompt } from "@/services/studio-generation";
import { planStudioShots } from "@/services/studio-planner";
import { MAX_STUDIO_CONCURRENCY, nextStudioJobSequence, studioJobLabel } from "@/services/studio-state";
import { guessCapability, resolveModelForCapability, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useStudioAuthStore } from "@/stores/use-studio-auth-store";
import { useStudioStore } from "@/stores/use-studio-store";
import type { StudioJob, StudioNodeSource, StudioProfile, StudioShot, StudioStoredImage, StudioWorkflow } from "@/types/studio";

const workflowOptions = [
    { value: "outfit", label: "换装拍摄", icon: <Shirt className="size-4" /> },
    { value: "recreate", label: "严格仿拍", icon: <Camera className="size-4" /> },
    { value: "variants", label: "成片变体", icon: <RefreshCw className="size-4" /> },
];
const workflowMeta: Record<StudioWorkflow, { title: string; reference: string; hint: string; placeholder: string }> = {
    outfit: {
        title: "穿上这套衣服",
        reference: "服装参考",
        hint: "只提取服装版型、材质、颜色和穿法，不复制参考图人物与背景。",
        placeholder: "例如：城市夜景，轻松自然，避免夸张动作；希望有 2 张近景、3 张全身。",
    },
    recreate: {
        title: "照着这张仿拍",
        reference: "仿拍目标",
        hint: "姿势、服装、场景、表情、光线与氛围都严格跟随目标图，人物脸换成预设人物。",
        placeholder: "可补充不能改变的细节；留空则按目标图严格复现。",
    },
    variants: {
        title: "从满意成片抽卡",
        reference: "满意母片",
        hint: "保留母片的核心造型与摄影语言，批量产生有价值的表情、动作和景别变化。",
        placeholder: "例如：用于抖音选片，保留服装与场景，多做自然抓拍和半身近景。",
    },
};
const ratioOptions = ["3:4", "4:5", "9:16", "1:1", "2:3", "16:9", "4:3"].map((value) => ({ value, label: value }));
const resolutionOptions = ["1K", "2K", "4K"].map((value) => ({ value, label: value }));
const PAGE_SIZE = 12;

function preferredAccountModel(models: string[], capability: "text" | "image") {
    const preferred = capability === "text" ? "gpt-5.6-luna" : "gemini-3.1-flash-image";
    return models.find((model) => model === preferred) || models.find((model) => guessCapability(model) === capability) || "";
}

export default function StudioPage() {
    const { message, modal } = App.useApp();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const abortRef = useRef<AbortController | null>(null);
    const operationJobIdRef = useRef("");
    const effectiveConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const profiles = useStudioStore((state) => state.profiles);
    const jobs = useStudioStore((state) => state.jobs);
    const settings = useStudioStore((state) => state.settings);
    const upsertProfile = useStudioStore((state) => state.upsertProfile);
    const removeProfile = useStudioStore((state) => state.removeProfile);
    const addJob = useStudioStore((state) => state.addJob);
    const updateJob = useStudioStore((state) => state.updateJob);
    const updateShot = useStudioStore((state) => state.updateShot);
    const removeJob = useStudioStore((state) => state.removeJob);
    const updateSettings = useStudioStore((state) => state.updateSettings);
    const auth = useStudioAuthStore();
    const [reference, setReference] = useState<StudioStoredImage | null>(null);
    const [brief, setBrief] = useState("");
    const [activeJobId, setActiveJobId] = useState("");
    const [runningJobId, setRunningJobId] = useState("");
    const [planning, setPlanning] = useState(false);
    const [page, setPage] = useState(1);
    const [profileOpen, setProfileOpen] = useState(false);
    const [editingProfile, setEditingProfile] = useState<StudioProfile | null>(null);
    const [loginOpen, setLoginOpen] = useState(false);
    const [shotEditor, setShotEditor] = useState<{ jobId: string; shotId: string } | null>(null);
    const [syncing, setSyncing] = useState(false);

    const selectedProfile = profiles.find((profile) => profile.id === settings.selectedProfileId) || profiles[0] || null;
    const activeJob = jobs.find((job) => job.id === activeJobId) || jobs[0] || null;
    const meta = workflowMeta[settings.workflow];
    const customConfig = useMemo(() => withoutPaidChannels(effectiveConfig), [effectiveConfig]);
    const accountTextModels = auth.models.filter((model) => guessCapability(model) === "text");
    const accountImageModels = auth.models.filter((model) => guessCapability(model) === "image");
    const visibleShots = activeJob?.shots.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) || [];
    const completedCount = activeJob?.shots.filter((shot) => shot.status === "success").length || 0;
    const failedCount = activeJob?.shots.filter((shot) => shot.status === "failed").length || 0;
    const canStart = Boolean(selectedProfile && reference && settings.plannerModel && settings.imageModel && !planning && !runningJobId);

    useEffect(() => {
        if (import.meta.env.DEV && !import.meta.env.VITE_PAID_DASHBOARD_BASE) {
            useStudioAuthStore.getState().reset();
            return;
        }
        void bootstrapPaidAccount().then((connected) => {
            if (!connected) return;
            void syncStudioCloudWithRecovery().catch(() => undefined);
        });
    }, []);

    useEffect(() => {
        if (!profiles.length || settings.selectedProfileId) return;
        updateSettings({ selectedProfileId: profiles[0].id });
    }, [profiles, settings.selectedProfileId, updateSettings]);

    useEffect(() => {
        if (auth.status !== "ready") return;
        const plannerModel =
            settings.plannerSource === "account"
                ? accountTextModels.includes(settings.plannerModel)
                    ? settings.plannerModel
                    : preferredAccountModel(accountTextModels, "text")
                : settings.plannerModel || resolveModelForCapability(customConfig, undefined, "text");
        const imageModel =
            settings.imageSource === "account"
                ? accountImageModels.includes(settings.imageModel)
                    ? settings.imageModel
                    : preferredAccountModel(accountImageModels, "image")
                : settings.imageModel || resolveModelForCapability(customConfig, undefined, "image");
        if (plannerModel !== settings.plannerModel || imageModel !== settings.imageModel) updateSettings({ plannerModel, imageModel });
    }, [accountImageModels, accountTextModels, auth.status, customConfig, settings.imageModel, settings.imageSource, settings.plannerModel, settings.plannerSource, updateSettings]);

    useEffect(() => {
        if (auth.status === "ready" && settings.updatedAt !== new Date(0).toISOString()) scheduleStudioCloudSync();
    }, [auth.status, settings.updatedAt]);

    useEffect(() => {
        if (activeJob && page > Math.max(1, Math.ceil(activeJob.shots.length / PAGE_SIZE))) setPage(1);
    }, [activeJob, page]);

    const syncSoon = () => {
        if (auth.status === "ready") scheduleStudioCloudSync((error) => message.error(error.message));
    };

    const uploadReference = async (file?: File) => {
        if (!file || !file.type.startsWith("image/")) return;
        try {
            setReference(await storeImage(file));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "参考图上传失败");
        }
    };

    const validateNodeConfig = (source: StudioNodeSource, model: string, capability: "text" | "image") => {
        if (source === "account") {
            if (auth.status !== "ready" || !auth.apiToken) {
                setLoginOpen(true);
                throw new Error("请先登录付费站账号");
            }
            return;
        }
        const config = buildStudioNodeConfig(effectiveConfig, source, model, capability);
        if (!isAiConfigReady(config, model)) {
            openConfigDialog(false, "channels");
            throw new Error("请先完成自定义渠道配置");
        }
    };

    const planAndRun = async () => {
        if (!selectedProfile || !reference) return;
        if (operationJobIdRef.current) return message.warning("已有拍摄任务正在运行");
        try {
            validateNodeConfig(settings.plannerSource, settings.plannerModel, "text");
            validateNodeConfig(settings.imageSource, settings.imageModel, "image");
        } catch (error) {
            message.warning(error instanceof Error ? error.message : "模型配置不可用");
            return;
        }
        const now = new Date().toISOString();
        const job: StudioJob = {
            id: nanoid(),
            sequence: nextStudioJobSequence(jobs),
            title: `${selectedProfile.name} · ${meta.title}`,
            workflow: settings.workflow,
            profileId: selectedProfile.id,
            brief: brief.trim(),
            reference,
            plannerSource: settings.plannerSource,
            plannerModel: settings.plannerModel,
            imageSource: settings.imageSource,
            imageModel: settings.imageModel,
            count: settings.count,
            concurrency: settings.concurrency,
            status: "planning",
            shots: [],
            createdAt: now,
            updatedAt: now,
        };
        operationJobIdRef.current = job.id;
        addJob(job);
        setActiveJobId(job.id);
        setPlanning(true);
        setPage(1);
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            const plannerConfig = buildStudioNodeConfig(effectiveConfig, settings.plannerSource, settings.plannerModel, "text");
            const shots = await planStudioShots({
                config: plannerConfig,
                workflow: settings.workflow,
                brief,
                count: settings.count,
                aspectRatio: settings.aspectRatio,
                resolution: settings.resolution,
                reference,
                modelSource: settings.imageSource,
                imageModel: settings.imageModel,
                signal: controller.signal,
            });
            updateJob(job.id, { shots, status: "queued", error: undefined });
            setPlanning(false);
            await runJob({ ...job, shots, status: "queued" }, undefined, true);
        } catch (error) {
            const stopped = controller.signal.aborted;
            updateJob(job.id, { status: stopped ? "paused" : "failed", error: stopped ? "已停止" : error instanceof Error ? error.message : "规划失败" });
            setPlanning(false);
            if (!stopped) message.error(error instanceof Error ? error.message : "拍摄规划失败");
            syncSoon();
        } finally {
            if (operationJobIdRef.current === job.id) operationJobIdRef.current = "";
            abortRef.current = null;
        }
    };

    const runJob = async (job: StudioJob, onlyShotIds?: Set<string>, reuseOperation = false) => {
        if (operationJobIdRef.current && !(reuseOperation && operationJobIdRef.current === job.id)) {
            message.warning("已有拍摄任务正在运行");
            return;
        }
        operationJobIdRef.current = job.id;
        const profile = useStudioStore.getState().profiles.find((item) => item.id === job.profileId);
        if (!profile) {
            message.error("任务使用的人物预设已不存在");
            operationJobIdRef.current = "";
            return;
        }
        const queue = job.shots.filter((shot) => (onlyShotIds ? onlyShotIds.has(shot.id) : shot.status !== "success"));
        if (!queue.length) {
            operationJobIdRef.current = "";
            return;
        }
        const controller = abortRef.current || new AbortController();
        abortRef.current = controller;
        setRunningJobId(job.id);
        updateJob(job.id, { status: "running", error: undefined });
        let cursor = 0;
        const worker = async () => {
            while (!controller.signal.aborted && cursor < queue.length) {
                const shot = queue[cursor++];
                await runShot(job, profile, shot, controller.signal);
            }
        };
        try {
            const concurrency = Math.max(1, Math.min(MAX_STUDIO_CONCURRENCY, Math.floor(job.concurrency || 1)));
            await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
            const current = useStudioStore.getState().jobs.find((item) => item.id === job.id);
            if (current) {
                const remaining = current.shots.some((shot) => shot.status === "queued" || shot.status === "running");
                const anyFailed = current.shots.some((shot) => shot.status === "failed");
                updateJob(job.id, { status: controller.signal.aborted || remaining ? "paused" : anyFailed ? "failed" : "completed" });
            }
        } finally {
            if (operationJobIdRef.current === job.id) operationJobIdRef.current = "";
            setRunningJobId("");
            abortRef.current = null;
            syncSoon();
        }
    };

    const runShot = async (job: StudioJob, profile: StudioProfile, shot: StudioShot, signal: AbortSignal) => {
        updateShot(job.id, shot.id, { status: "running", attempts: shot.attempts + 1, error: undefined });
        const startedAt = performance.now();
        try {
            const config = buildStudioNodeConfig(effectiveConfig, shot.modelSource, shot.model, "image", { aspectRatio: shot.aspectRatio, resolution: shot.resolution });
            const references = buildStudioGenerationReferences(profile);
            const result = await requestEdit(config, buildStudioImagePrompt(profile, job, shot), references, undefined, { signal });
            if (!result[0]?.dataUrl) throw new Error("模型没有返回图片");
            const stored = await storeImageData(result[0].dataUrl, `${job.title}-${shot.index + 1}.png`);
            if (signal.aborted) {
                await deleteStoredImages([stored.storageKey]);
                updateShot(job.id, shot.id, { status: "queued", error: undefined });
                return;
            }
            updateShot(job.id, shot.id, { status: "success", result: { ...stored, durationMs: performance.now() - startedAt }, error: undefined });
            syncSoon();
        } catch (error) {
            if (signal.aborted) {
                updateShot(job.id, shot.id, { status: "queued", error: undefined });
                return;
            }
            updateShot(job.id, shot.id, { status: "failed", error: error instanceof Error ? error.message : "生成失败" });
        }
    };

    const stop = () => abortRef.current?.abort();

    const continueJob = async (job: StudioJob) => {
        try {
            validateNodeConfig(job.plannerSource, job.plannerModel, "text");
            validateNodeConfig(job.imageSource, job.imageModel, "image");
            await runJob(job);
        } catch (error) {
            message.warning(error instanceof Error ? error.message : "模型配置不可用");
        }
    };

    const retryShot = async (job: StudioJob, shot: StudioShot) => {
        await runJob(job, new Set([shot.id]));
    };

    const manualSync = async () => {
        if (auth.status !== "ready") return setLoginOpen(true);
        setSyncing(true);
        try {
            const result = await syncStudioCloudWithRecovery();
            message.success(`云同步完成：上传 ${result.uploaded}，下载 ${result.downloaded}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "云同步失败");
        } finally {
            setSyncing(false);
        }
    };

    const openNewProfile = () => {
        setEditingProfile(null);
        setProfileOpen(true);
    };

    const deleteUnreferencedImages = async (candidates: string[]) => {
        const state = useStudioStore.getState();
        const retained = new Set<string>();
        state.profiles.forEach((item) => retained.add(item.identity.storageKey));
        state.jobs.forEach((item) => {
            retained.add(item.reference.storageKey);
            item.shots.forEach((shot) => shot.result?.storageKey && retained.add(shot.result.storageKey));
        });
        if (reference?.storageKey) retained.add(reference.storageKey);
        await deleteStoredImages(candidates.filter((key) => !retained.has(key)));
    };

    const deleteProfile = (profile: StudioProfile) => {
        if (operationJobIdRef.current) return message.warning("请先停止当前拍摄任务");
        modal.confirm({
            title: `删除人物预设“${profile.name}”？`,
            content: "历史成片仍会保留，但相关旧任务将不能再次生成。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                removeProfile(profile.id);
                await deleteUnreferencedImages([profile.identity.storageKey]);
                syncSoon();
            },
        });
    };

    return (
        <div className="studio-page h-full overflow-y-auto bg-background text-foreground">
            <header className="sticky top-0 z-30 border-b border-stone-200/80 bg-background/95 backdrop-blur dark:border-stone-800">
                <div className="mx-auto flex h-14 max-w-[1500px] items-center justify-between gap-3 px-3 sm:px-5">
                    <div className="flex min-w-0 items-center gap-2.5">
                        <Camera className="size-5 shrink-0" />
                        <div className="min-w-0">
                            <h1 className="truncate text-base font-semibold sm:text-lg">人物影棚</h1>
                            <p className="hidden text-xs text-stone-500 sm:block">人物一致性 · 批量拍摄 · 跨端选片</p>
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                        <Tooltip title="同步预设与成片">
                            <Button type="text" icon={syncing ? <LoaderCircle className="size-4 animate-spin" /> : <Cloud className="size-4" />} onClick={() => void manualSync()} aria-label="云同步" />
                        </Tooltip>
                        <Button
                            type="text"
                            icon={auth.status === "ready" ? <Check className="size-4" /> : <LogIn className="size-4" />}
                            onClick={() => setLoginOpen(true)}
                            aria-label={auth.status === "ready" ? `付费站账号：${auth.user?.displayName || "已连接"}` : "登录付费站"}
                            title={auth.status === "ready" ? `付费站账号：${auth.user?.displayName || "已连接"}` : "登录付费站"}
                        >
                            <span className="hidden sm:inline">{auth.user?.displayName || "登录付费站"}</span>
                        </Button>
                    </div>
                </div>
            </header>

            <main className="mx-auto grid max-w-[1500px] gap-5 px-3 pb-[calc(88px+env(safe-area-inset-bottom))] pt-4 sm:px-5 lg:h-[calc(100%-56px)] lg:grid-cols-[390px_minmax(0,1fr)] lg:overflow-hidden lg:pb-5">
                <section className="thin-scrollbar space-y-5 lg:min-h-0 lg:overflow-y-auto lg:pr-2">
                    <Segmented
                        block
                        value={settings.workflow}
                        options={workflowOptions}
                        onChange={(value) => {
                            updateSettings({ workflow: value as StudioWorkflow });
                            setReference(null);
                        }}
                    />

                    <div className="border-b border-stone-200 pb-5 dark:border-stone-800">
                        <div className="mb-2 flex items-center justify-between gap-3">
                            <label className="text-sm font-semibold">人物预设</label>
                            <Button type="text" size="small" icon={<Plus className="size-4" />} onClick={openNewProfile}>
                                新建
                            </Button>
                        </div>
                        {profiles.length ? (
                            <div className="flex gap-2 overflow-x-auto pb-1">
                                {profiles.map((profile) => (
                                    <ProfileChip
                                        key={profile.id}
                                        profile={profile}
                                        selected={profile.id === selectedProfile?.id}
                                        onSelect={() => updateSettings({ selectedProfileId: profile.id })}
                                        onEdit={() => {
                                            setEditingProfile(profile);
                                            setProfileOpen(true);
                                        }}
                                        onDelete={() => deleteProfile(profile)}
                                    />
                                ))}
                            </div>
                        ) : (
                            <button type="button" className="flex w-full items-center gap-3 border border-dashed border-stone-300 p-3 text-left dark:border-stone-700" onClick={openNewProfile}>
                                <span className="grid size-11 shrink-0 place-items-center bg-stone-100 dark:bg-stone-900">
                                    <UserRound className="size-5" />
                                </span>
                                <span>
                                    <strong className="block text-sm">先建立人物预设</strong>
                                    <span className="text-xs text-stone-500">固定一张清晰正脸，只锁定身份。</span>
                                </span>
                            </button>
                        )}
                    </div>

                    <div className="border-b border-stone-200 pb-5 dark:border-stone-800">
                        <div className="mb-2">
                            <h2 className="text-lg font-semibold">{meta.title}</h2>
                            <p className="mt-1 text-xs leading-5 text-stone-500">{meta.hint}</p>
                        </div>
                        <ReferenceUpload image={reference} label={meta.reference} onClick={() => fileInputRef.current?.click()} onClear={() => setReference(null)} />
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(event) => {
                                void uploadReference(event.target.files?.[0]);
                                event.target.value = "";
                            }}
                        />
                    </div>

                    <div className="space-y-4 border-b border-stone-200 pb-5 dark:border-stone-800">
                        <label className="block">
                            <span className="mb-1.5 block text-sm font-semibold">补充要求</span>
                            <Input.TextArea value={brief} onChange={(event) => setBrief(event.target.value)} autoSize={{ minRows: 3, maxRows: 6 }} placeholder={meta.placeholder} />
                        </label>
                        <NodeModelControl
                            title="LLM 规划节点"
                            capability="text"
                            source={settings.plannerSource}
                            model={settings.plannerModel}
                            accountReady={auth.status === "ready"}
                            accountModels={accountTextModels}
                            customConfig={customConfig}
                            onSourceChange={(plannerSource) => updateSettings({ plannerSource, plannerModel: plannerSource === "account" ? preferredAccountModel(accountTextModels, "text") : resolveModelForCapability(customConfig, undefined, "text") })}
                            onModelChange={(plannerModel) => updateSettings({ plannerModel })}
                            onLogin={() => setLoginOpen(true)}
                            onConfig={() => openConfigDialog(false, "channels")}
                        />
                        <NodeModelControl
                            title="图像生成节点"
                            capability="image"
                            source={settings.imageSource}
                            model={settings.imageModel}
                            accountReady={auth.status === "ready"}
                            accountModels={accountImageModels}
                            customConfig={customConfig}
                            onSourceChange={(imageSource) => updateSettings({ imageSource, imageModel: imageSource === "account" ? preferredAccountModel(accountImageModels, "image") : resolveModelForCapability(customConfig, undefined, "image") })}
                            onModelChange={(imageModel) => updateSettings({ imageModel })}
                            onLogin={() => setLoginOpen(true)}
                            onConfig={() => openConfigDialog(false, "channels")}
                        />
                        <div className="grid grid-cols-2 gap-3">
                            <label>
                                <span className="mb-1.5 block text-xs font-medium text-stone-500">默认画幅</span>
                                <Select className="w-full" value={settings.aspectRatio} options={ratioOptions} onChange={(aspectRatio) => updateSettings({ aspectRatio })} />
                            </label>
                            <label>
                                <span className="mb-1.5 block text-xs font-medium text-stone-500">默认分辨率</span>
                                <Select className="w-full" value={settings.resolution} options={resolutionOptions} onChange={(resolution) => updateSettings({ resolution })} />
                            </label>
                            <label>
                                <span className="mb-1.5 block text-xs font-medium text-stone-500">出图数量</span>
                                <InputNumber className="w-full" min={1} max={60} value={settings.count} onChange={(count) => updateSettings({ count: count || 1 })} />
                            </label>
                            <label>
                                <span className="mb-1.5 block text-xs font-medium text-stone-500">并发数</span>
                                <InputNumber className="w-full" min={1} max={MAX_STUDIO_CONCURRENCY} value={settings.concurrency} onChange={(concurrency) => updateSettings({ concurrency: concurrency || 1 })} />
                            </label>
                        </div>
                    </div>
                </section>

                <section className="thin-scrollbar min-w-0 lg:min-h-0 lg:overflow-y-auto lg:pl-1">
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0">
                            <h2 className="truncate text-xl font-semibold">{activeJob ? studioJobLabel(activeJob) : "拍摄结果"}</h2>
                            {activeJob ? (
                                <p className="mt-1 text-xs text-stone-500">
                                    {completedCount}/{activeJob.shots.length} 完成{failedCount ? ` · ${failedCount} 失败` : ""}
                                </p>
                            ) : (
                                <p className="mt-1 text-xs text-stone-500">完成规划后，每个镜头都能单独调整再生成。</p>
                            )}
                        </div>
                        <div className="flex items-center gap-2">
                            {jobs.length ? (
                                <Select
                                    className="w-36 sm:w-52"
                                    value={activeJob?.id}
                                    options={jobs.map((job) => ({ value: job.id, label: studioJobLabel(job) }))}
                                    onChange={(id) => {
                                        setActiveJobId(id);
                                        setPage(1);
                                    }}
                                />
                            ) : null}
                            {activeJob && activeJob.shots.some((shot) => shot.status !== "success") && (activeJob.status === "paused" || activeJob.status === "failed") && !runningJobId ? (
                                <Button icon={<Play className="size-4" />} onClick={() => void continueJob(activeJob)}>
                                    继续
                                </Button>
                            ) : null}
                            {activeJob && runningJobId === activeJob.id ? (
                                <Button danger icon={<Pause className="size-4" />} onClick={stop}>
                                    停止
                                </Button>
                            ) : null}
                        </div>
                    </div>
                    {activeJob?.shots.length ? (
                        <>
                            <Progress percent={Math.round((completedCount / activeJob.shots.length) * 100)} status={activeJob.status === "failed" ? "exception" : activeJob.status === "completed" ? "success" : "active"} showInfo={false} className="mb-4" />
                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                                {visibleShots.map((shot) => (
                                    <ShotCard
                                        key={shot.id}
                                        shot={shot}
                                        running={runningJobId === activeJob.id}
                                        onEdit={() => setShotEditor({ jobId: activeJob.id, shotId: shot.id })}
                                        onRetry={() => void retryShot(activeJob, shot)}
                                        onFavorite={() => {
                                            updateShot(activeJob.id, shot.id, { favorite: !shot.favorite });
                                            syncSoon();
                                        }}
                                        onDownload={() => void downloadShot(shot)}
                                        onVariant={() => {
                                            if (!shot.result) return;
                                            setReference(shot.result);
                                            updateSettings({ workflow: "variants" });
                                            window.setTimeout(() => document.querySelector(".studio-page")?.scrollTo({ top: 0, behavior: "smooth" }), 0);
                                        }}
                                    />
                                ))}
                            </div>
                            {activeJob.shots.length > PAGE_SIZE ? (
                                <div className="mt-6 flex justify-center">
                                    <Pagination current={page} pageSize={PAGE_SIZE} total={activeJob.shots.length} showSizeChanger={false} onChange={setPage} />
                                </div>
                            ) : null}
                            <div className="mt-6 flex justify-end">
                                <Button
                                    type="text"
                                    danger
                                    icon={<Trash2 className="size-4" />}
                                    disabled={runningJobId === activeJob.id || activeJob.status === "planning"}
                                    onClick={() => {
                                        const storageKeys = [activeJob.reference.storageKey, ...activeJob.shots.flatMap((shot) => (shot.result?.storageKey ? [shot.result.storageKey] : []))];
                                        removeJob(activeJob.id);
                                        setActiveJobId("");
                                        void deleteUnreferencedImages(storageKeys).finally(syncSoon);
                                    }}
                                >
                                    删除本次任务
                                </Button>
                            </div>
                        </>
                    ) : activeJob?.status === "planning" ? (
                        <div className="grid min-h-[420px] place-items-center border border-dashed border-stone-300 dark:border-stone-700">
                            <div className="text-center">
                                <LoaderCircle className="mx-auto mb-3 size-7 animate-spin" />
                                <p className="font-medium">LLM 正在拆解拍摄方案</p>
                                <p className="mt-1 text-xs text-stone-500">镜头规划完成后会自动开始出图</p>
                            </div>
                        </div>
                    ) : (
                        <div className="grid min-h-[420px] place-items-center border border-dashed border-stone-300 px-6 text-center dark:border-stone-700">
                            <div>
                                <ImagePlus className="mx-auto mb-3 size-10 text-stone-400" />
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选好人物与参考图，开始第一组拍摄" />
                            </div>
                        </div>
                    )}
                </section>
            </main>

            <div className="fixed inset-x-0 bottom-0 z-40 border-t border-stone-200 bg-background/95 px-3 pb-[calc(10px+env(safe-area-inset-bottom))] pt-2 backdrop-blur dark:border-stone-800 lg:absolute lg:left-auto lg:right-5 lg:w-[360px] lg:border-0 lg:bg-transparent lg:p-0 lg:pb-5">
                <Button
                    type={planning || runningJobId ? "default" : "primary"}
                    danger={Boolean(planning || runningJobId)}
                    size="large"
                    block
                    icon={planning || runningJobId ? <Pause className="size-4" /> : <Sparkles className="size-4" />}
                    disabled={!canStart && !planning && !runningJobId}
                    onClick={() => (planning || runningJobId ? stop() : void planAndRun())}
                >
                    {planning || runningJobId ? "停止本次任务" : `规划并生成 ${settings.count} 张`}
                </Button>
            </div>

            <ProfileModal
                open={profileOpen}
                profile={editingProfile}
                onClose={() => setProfileOpen(false)}
                onSave={(profile) => {
                    upsertProfile(profile);
                    updateSettings({ selectedProfileId: profile.id });
                    setProfileOpen(false);
                    syncSoon();
                }}
            />
            <AccountModal
                open={loginOpen}
                busy={Boolean(operationJobIdRef.current) || syncing}
                onClose={() => setLoginOpen(false)}
                onConnected={() => {
                    setLoginOpen(false);
                    void manualSync();
                }}
            />
            <ShotEditorDrawer
                value={
                    shotEditor
                        ? useStudioStore
                              .getState()
                              .jobs.find((job) => job.id === shotEditor.jobId)
                              ?.shots.find((shot) => shot.id === shotEditor.shotId) || null
                        : null
                }
                open={Boolean(shotEditor)}
                accountModels={accountImageModels}
                customConfig={customConfig}
                onClose={() => setShotEditor(null)}
                onSave={(patch) => {
                    if (!shotEditor) return;
                    updateShot(shotEditor.jobId, shotEditor.shotId, patch);
                    setShotEditor(null);
                    syncSoon();
                }}
            />
        </div>
    );
}

function withoutPaidChannels(config: AiConfig): AiConfig {
    const channels = config.channels.filter((channel) => channel.id !== PAID_OPENAI_CHANNEL_ID && channel.id !== PAID_GEMINI_CHANNEL_ID);
    return { ...config, channels, models: channels.flatMap((channel) => channel.models.map((model) => `${channel.id}::${model.name}`)) };
}

async function storeImage(file: Blob & { name?: string }): Promise<StudioStoredImage> {
    const stored = await uploadImage(file);
    return { id: nanoid(), name: file.name || "reference.png", storageKey: stored.storageKey, mimeType: stored.mimeType, width: stored.width, height: stored.height, bytes: stored.bytes };
}

async function storeImageData(dataUrl: string, name: string) {
    const stored = await uploadImage(dataUrl);
    return { id: nanoid(), name, storageKey: stored.storageKey, mimeType: stored.mimeType, width: stored.width, height: stored.height, bytes: stored.bytes };
}

async function downloadShot(shot: StudioShot) {
    if (!shot.result) return;
    const blob = await getImageBlob(shot.result.storageKey);
    if (blob) saveAs(blob, `${String(shot.index + 1).padStart(2, "0")}-${shot.title}.${extensionForMime(blob.type)}`);
}

function extensionForMime(mimeType: string) {
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    return "png";
}

function useResolvedImage(storageKey?: string) {
    const [url, setUrl] = useState("");
    useEffect(() => {
        let active = true;
        void resolveImageUrl(storageKey).then((value) => active && setUrl(value));
        return () => {
            active = false;
        };
    }, [storageKey]);
    return url;
}

function ProfileChip({ profile, selected, onSelect, onEdit, onDelete }: { profile: StudioProfile; selected: boolean; onSelect: () => void; onEdit: () => void; onDelete: () => void }) {
    const url = useResolvedImage(profile.identity.storageKey);
    return (
        <div className={`group relative flex min-w-36 items-center gap-2 border px-2 py-2 ${selected ? "border-stone-900 dark:border-stone-100" : "border-stone-200 dark:border-stone-800"}`}>
            <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onSelect}>
                {url ? (
                    <img src={url} alt="" className="size-9 shrink-0 object-cover" />
                ) : (
                    <span className="grid size-9 shrink-0 place-items-center bg-stone-100 dark:bg-stone-900">
                        <UserRound className="size-4" />
                    </span>
                )}
                <span className="truncate text-sm font-medium">{profile.name}</span>
            </button>
            <Tooltip title="编辑">
                <button type="button" className="grid size-7 shrink-0 place-items-center" onClick={onEdit}>
                    <Pencil className="size-3.5" />
                </button>
            </Tooltip>
            <Tooltip title="删除">
                <button type="button" className="grid size-7 shrink-0 place-items-center text-red-500" onClick={onDelete}>
                    <Trash2 className="size-3.5" />
                </button>
            </Tooltip>
        </div>
    );
}

function ReferenceUpload({ image, label, onClick, onClear }: { image: StudioStoredImage | null; label: string; onClick: () => void; onClear: () => void }) {
    const url = useResolvedImage(image?.storageKey);
    return image ? (
        <div className="flex items-center gap-3 border border-stone-200 p-2 dark:border-stone-800">
            {url ? (
                <img src={url} alt={label} className="size-20 shrink-0 object-cover" />
            ) : (
                <span className="grid size-20 shrink-0 place-items-center bg-stone-100 dark:bg-stone-900">
                    <LoaderCircle className="size-5 animate-spin" />
                </span>
            )}
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{image.name}</p>
                <p className="mt-1 text-xs text-stone-500">
                    {image.width} × {image.height}
                </p>
            </div>
            <Button type="text" icon={<RefreshCw className="size-4" />} onClick={onClick} aria-label="替换参考图" />
            <Button type="text" danger icon={<Trash2 className="size-4" />} onClick={onClear} aria-label="移除参考图" />
        </div>
    ) : (
        <button type="button" className="flex min-h-28 w-full flex-col items-center justify-center gap-2 border border-dashed border-stone-300 text-sm transition hover:border-stone-500 dark:border-stone-700" onClick={onClick}>
            <Upload className="size-5" />
            <span>上传{label}</span>
            <span className="text-xs text-stone-500">支持 iPhone 相册与文件</span>
        </button>
    );
}

function NodeModelControl({
    title,
    capability,
    source,
    model,
    accountReady,
    accountModels,
    customConfig,
    onSourceChange,
    onModelChange,
    onLogin,
    onConfig,
}: {
    title: string;
    capability: "text" | "image";
    source: StudioNodeSource;
    model: string;
    accountReady: boolean;
    accountModels: string[];
    customConfig: AiConfig;
    onSourceChange: (source: StudioNodeSource) => void;
    onModelChange: (model: string) => void;
    onLogin: () => void;
    onConfig: () => void;
}) {
    return (
        <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">{title}</span>
                <Segmented
                    size="small"
                    value={source}
                    options={[
                        { value: "account", label: "付费站" },
                        { value: "custom", label: "自定义" },
                    ]}
                    onChange={(value) => onSourceChange(value as StudioNodeSource)}
                />
            </div>
            {source === "account" ? (
                accountReady ? (
                    <Select showSearch optionFilterProp="label" className="w-full" value={model || undefined} options={accountModels.map((value) => ({ value, label: value }))} onChange={onModelChange} placeholder="选择账号模型" />
                ) : (
                    <Button block icon={<LogIn className="size-4" />} onClick={onLogin}>
                        登录后选择账号模型
                    </Button>
                )
            ) : (
                <ModelPicker config={customConfig} value={model} onChange={onModelChange} capability={capability} fullWidth onMissingConfig={onConfig} />
            )}
        </div>
    );
}

function ShotCard({ shot, running, onEdit, onRetry, onFavorite, onDownload, onVariant }: { shot: StudioShot; running: boolean; onEdit: () => void; onRetry: () => void; onFavorite: () => void; onDownload: () => void; onVariant: () => void }) {
    const url = useResolvedImage(shot.result?.storageKey);
    return (
        <article className="overflow-hidden border border-stone-200 bg-card dark:border-stone-800">
            <div className="relative aspect-[3/4] bg-stone-100 dark:bg-stone-900">
                {shot.status === "success" && url ? (
                    <Image src={url} alt={shot.title} rootClassName="size-full" className="size-full object-cover" />
                ) : (
                    <div className="absolute inset-0 grid place-items-center p-5 text-center">
                        {shot.status === "running" ? (
                            <div>
                                <LoaderCircle className="mx-auto mb-2 size-6 animate-spin" />
                                <span className="text-sm">正在生成</span>
                            </div>
                        ) : shot.status === "failed" ? (
                            <div>
                                <p className="text-sm font-medium text-red-500">生成失败</p>
                                <p className="mt-2 line-clamp-4 text-xs text-stone-500">{shot.error}</p>
                                <Button className="mt-3" size="small" danger icon={<RotateCcw className="size-3.5" />} disabled={running} onClick={onRetry}>
                                    重试
                                </Button>
                            </div>
                        ) : (
                            <div>
                                <Camera className="mx-auto mb-2 size-6 text-stone-400" />
                                <span className="text-sm text-stone-500">等待拍摄</span>
                            </div>
                        )}
                    </div>
                )}
                <div className="absolute left-2 top-2 flex gap-1">
                    <Tag className="m-0">#{shot.index + 1}</Tag>
                    <Tag className="m-0">
                        {shot.aspectRatio} · {shot.resolution}
                    </Tag>
                </div>
                {shot.status === "success" ? (
                    <button type="button" className={`absolute right-2 top-2 grid size-9 place-items-center bg-black/60 text-white ${shot.favorite ? "text-red-400" : ""}`} onClick={onFavorite} aria-label="收藏">
                        <Heart className={`size-4 ${shot.favorite ? "fill-current" : ""}`} />
                    </button>
                ) : null}
            </div>
            <div className="space-y-2 p-3">
                <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                        <h3 className="truncate text-sm font-semibold">{shot.title}</h3>
                        <p className="mt-0.5 truncate text-xs text-stone-500">
                            {shot.framing} · {shot.lens} · {shot.model}
                        </p>
                    </div>
                    <Button type="text" size="small" icon={<Pencil className="size-3.5" />} onClick={onEdit} aria-label="编辑镜头" />
                </div>
                {shot.status === "success" ? (
                    <div className="grid grid-cols-3 gap-1">
                        <Tooltip title="下载">
                            <Button size="small" type="text" icon={<Download className="size-3.5" />} onClick={onDownload} />
                        </Tooltip>
                        <Tooltip title="作为母片继续做变体">
                            <Button size="small" type="text" icon={<RefreshCw className="size-3.5" />} onClick={onVariant} />
                        </Tooltip>
                        <Tooltip title="重新生成">
                            <Button size="small" type="text" icon={<RotateCcw className="size-3.5" />} disabled={running} onClick={onRetry} />
                        </Tooltip>
                    </div>
                ) : null}
            </div>
        </article>
    );
}

function ProfileModal({ open, profile, onClose, onSave }: { open: boolean; profile: StudioProfile | null; onClose: () => void; onSave: (profile: StudioProfile) => void }) {
    const { message } = App.useApp();
    const [name, setName] = useState("");
    const [prompt, setPrompt] = useState("");
    const [identity, setIdentity] = useState<StudioStoredImage | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (!open) return;
        setName(profile?.name || "");
        setPrompt(profile?.identityPrompt || "");
        setIdentity(profile?.identity || null);
    }, [open, profile]);
    const save = () => {
        if (!name.trim() || !identity) return message.warning("请填写名称并上传清晰正脸照");
        const now = new Date().toISOString();
        onSave({
            id: profile?.id || nanoid(),
            name: name.trim(),
            identity,
            identityPrompt: prompt.trim(),
            defaultPlannerModel: profile?.defaultPlannerModel,
            defaultImageModel: profile?.defaultImageModel,
            createdAt: profile?.createdAt || now,
            updatedAt: now,
        });
    };
    return (
        <Modal title={profile ? "编辑人物预设" : "新建人物预设"} open={open} onCancel={onClose} onOk={save} okText="保存" cancelText="取消">
            <div className="space-y-4 pt-2">
                <label className="block">
                    <span className="mb-1.5 block text-sm font-medium">名称</span>
                    <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：我的默认形象" />
                </label>
                <div>
                    <span className="mb-1.5 block text-sm font-medium">人脸参考照</span>
                    <ReferenceUpload image={identity} label="清晰正脸照" onClick={() => inputRef.current?.click()} onClear={() => setIdentity(null)} />
                    <input
                        ref={inputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file)
                                void storeImage(file)
                                    .then(setIdentity)
                                    .catch((error) => message.error(error.message));
                            event.target.value = "";
                        }}
                    />
                </div>
                <label className="block">
                    <span className="mb-1.5 block text-sm font-medium">人物补充约束</span>
                    <Input.TextArea value={prompt} onChange={(event) => setPrompt(event.target.value)} autoSize={{ minRows: 3, maxRows: 6 }} placeholder="可写发型、妆容、年龄感等稳定特征；不要写服装、姿势或场景。" />
                </label>
            </div>
        </Modal>
    );
}

function AccountModal({ open, busy, onClose, onConnected }: { open: boolean; busy: boolean; onClose: () => void; onConnected: () => void }) {
    const { message } = App.useApp();
    const auth = useStudioAuthStore();
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [flowToken, setFlowToken] = useState("");
    const [code, setCode] = useState("");
    const [loading, setLoading] = useState(false);
    const [loginStatus, setLoginStatus] = useState<PaidSiteLoginStatus | null>(null);
    const [statusLoading, setStatusLoading] = useState(false);
    const [statusError, setStatusError] = useState("");
    const [turnstileToken, setTurnstileToken] = useState("");
    const [turnstileError, setTurnstileError] = useState("");
    const [turnstileKey, setTurnstileKey] = useState(0);
    const statusRequestRef = useRef(0);
    const turnstileEnabled = Boolean(loginStatus?.turnstileCheck && loginStatus.turnstileSiteKey);
    const canLogin = Boolean(username.trim() && password && loginStatus?.passwordLoginEnabled && !statusLoading && !statusError && (!turnstileEnabled || turnstileToken));

    const refreshLoginStatus = async () => {
        const requestId = ++statusRequestRef.current;
        setStatusLoading(true);
        setStatusError("");
        try {
            const status = await loadPaidSiteLoginStatus();
            if (requestId === statusRequestRef.current) setLoginStatus(status);
        } catch (error) {
            if (requestId !== statusRequestRef.current) return;
            setLoginStatus(null);
            setStatusError(error instanceof Error ? error.message : "无法读取付费站登录状态");
        } finally {
            if (requestId === statusRequestRef.current) setStatusLoading(false);
        }
    };

    const resetTurnstile = () => {
        setTurnstileToken("");
        setTurnstileError("");
        setTurnstileKey((current) => current + 1);
    };

    useEffect(() => {
        if (open) {
            void refreshLoginStatus();
            return;
        }
        statusRequestRef.current += 1;
        setPassword("");
        setFlowToken("");
        setCode("");
        setLoginStatus(null);
        setStatusError("");
        setTurnstileToken("");
        setTurnstileError("");
    }, [open]);

    const login = async () => {
        if (!canLogin) return;
        const submittedTurnstileToken = turnstileToken;
        if (turnstileEnabled) resetTurnstile();
        setLoading(true);
        try {
            const result = await loginPaidAccount(username.trim(), password, submittedTurnstileToken);
            if (!result.ready) return setFlowToken(result.flowToken);
            message.success("付费站账号已连接");
            onConnected();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "登录失败");
        } finally {
            setLoading(false);
        }
    };
    const verify = async () => {
        setLoading(true);
        try {
            await completePaidAccount2FA(flowToken, code);
            message.success("两步验证通过");
            onConnected();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "验证失败");
        } finally {
            setLoading(false);
        }
    };
    return (
        <Modal title="付费站账号" open={open} onCancel={onClose} footer={null} width={420}>
            {auth.status === "ready" && auth.user ? (
                <div className="space-y-4 pt-2">
                    <div className="flex items-center gap-3 border border-stone-200 p-3 dark:border-stone-800">
                        <span className="grid size-11 place-items-center bg-stone-100 dark:bg-stone-900">
                            <UserRound className="size-5" />
                        </span>
                        <div className="min-w-0">
                            <p className="truncate font-semibold">{auth.user.displayName}</p>
                            <p className="text-xs text-stone-500">{auth.models.length} 个可用模型 · 专用 Key 已就绪</p>
                        </div>
                        <Check className="ml-auto size-5 text-green-600" />
                    </div>
                    <Button
                        block
                        disabled={busy}
                        onClick={() => {
                            cancelScheduledStudioCloudSync();
                            disconnectPaidAccount();
                            message.success("已断开影棚账号");
                        }}
                    >
                        {busy ? "任务或同步进行中" : "断开影棚账号"}
                    </Button>
                </div>
            ) : flowToken ? (
                <div className="space-y-4 pt-2">
                    <p className="text-sm text-stone-500">输入身份验证器中的 6 位验证码。</p>
                    <Input value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" maxLength={8} placeholder="两步验证码" />
                    <Button type="primary" block loading={loading} onClick={() => void verify()}>
                        完成验证
                    </Button>
                </div>
            ) : (
                <div className="space-y-4 pt-2">
                    <p className="text-sm leading-6 text-stone-500">使用付费站的同一账号登录。影棚会读取该账号可用模型，并自动创建一个专用 API Key。</p>
                    <Input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" placeholder="用户名" />
                    <Input.Password value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" placeholder="密码" onPressEnter={() => canLogin && void login()} />
                    {statusLoading ? (
                        <div className="flex min-h-[65px] items-center justify-center gap-2 text-xs text-stone-500">
                            <LoaderCircle className="size-4 animate-spin" />
                            正在读取安全设置
                        </div>
                    ) : statusError ? (
                        <div className="flex min-h-[65px] items-center justify-between gap-3 border border-red-200 bg-red-50 px-3 text-xs text-red-700 dark:border-red-950 dark:bg-red-950/30 dark:text-red-300">
                            <span className="min-w-0 break-words">{statusError}</span>
                            <Button size="small" type="text" icon={<RotateCcw className="size-3.5" />} onClick={() => void refreshLoginStatus()} aria-label="重新加载安全设置" />
                        </div>
                    ) : turnstileEnabled && loginStatus ? (
                        <div className="w-full max-w-full">
                            <Turnstile
                                siteKey={loginStatus.turnstileSiteKey}
                                refreshKey={turnstileKey}
                                onVerify={(token) => {
                                    setTurnstileToken(token);
                                    setTurnstileError("");
                                }}
                                onExpire={() => setTurnstileToken("")}
                                onError={() => {
                                    setTurnstileToken("");
                                    setTurnstileError("安全验证加载失败");
                                }}
                            />
                            {turnstileError ? (
                                <Button className="mt-2" size="small" block icon={<RotateCcw className="size-3.5" />} onClick={resetTurnstile}>
                                    重新加载安全验证
                                </Button>
                            ) : null}
                        </div>
                    ) : loginStatus && !loginStatus.passwordLoginEnabled ? (
                        <p className="text-center text-sm text-stone-500">付费站当前未开放密码登录。</p>
                    ) : null}
                    <Button type="primary" block loading={loading} disabled={!canLogin} icon={<LogIn className="size-4" />} onClick={() => void login()}>
                        登录并连接
                    </Button>
                    <a className="block text-center text-sm" href="/login?redirect=/studio/">
                        前往付费站使用其他登录方式
                    </a>
                </div>
            )}
        </Modal>
    );
}

function ShotEditorDrawer({ value, open, accountModels, customConfig, onClose, onSave }: { value: StudioShot | null; open: boolean; accountModels: string[]; customConfig: AiConfig; onClose: () => void; onSave: (patch: Partial<StudioShot>) => void }) {
    const [draft, setDraft] = useState<StudioShot | null>(null);
    useEffect(() => setDraft(value), [value]);
    return (
        <Drawer
            title="编辑单个镜头节点"
            placement="right"
            size={420}
            open={open}
            onClose={onClose}
            extra={
                <Button type="primary" size="small" disabled={!draft} onClick={() => draft && onSave(draft)}>
                    保存
                </Button>
            }
        >
            {draft ? (
                <div className="space-y-4">
                    <label className="block">
                        <span className="mb-1.5 block text-sm font-medium">镜头名称</span>
                        <Input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
                    </label>
                    <label className="block">
                        <span className="mb-1.5 block text-sm font-medium">执行提示词</span>
                        <Input.TextArea value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} autoSize={{ minRows: 6, maxRows: 12 }} />
                    </label>
                    <NodeModelControl
                        title="本镜头图像模型"
                        capability="image"
                        source={draft.modelSource}
                        model={draft.model}
                        accountReady={Boolean(accountModels.length)}
                        accountModels={accountModels}
                        customConfig={customConfig}
                        onSourceChange={(modelSource) => setDraft({ ...draft, modelSource, model: modelSource === "account" ? preferredAccountModel(accountModels, "image") : resolveModelForCapability(customConfig, undefined, "image") })}
                        onModelChange={(model) => setDraft({ ...draft, model })}
                        onLogin={onClose}
                        onConfig={onClose}
                    />
                    <div className="grid grid-cols-2 gap-3">
                        <label>
                            <span className="mb-1.5 block text-xs text-stone-500">画幅</span>
                            <Select className="w-full" value={draft.aspectRatio} options={ratioOptions} onChange={(aspectRatio) => setDraft({ ...draft, aspectRatio })} />
                        </label>
                        <label>
                            <span className="mb-1.5 block text-xs text-stone-500">分辨率</span>
                            <Select className="w-full" value={draft.resolution} options={resolutionOptions} onChange={(resolution) => setDraft({ ...draft, resolution })} />
                        </label>
                    </div>
                </div>
            ) : null}
        </Drawer>
    );
}
