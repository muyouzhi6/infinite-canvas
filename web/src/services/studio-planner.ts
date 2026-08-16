import { nanoid } from "nanoid";

import { requestImageQuestion, type AiTextMessage } from "@/services/api/image";
import { imageToDataUrl } from "@/services/image-storage";
import type { AiConfig } from "@/stores/use-config-store";
import type { StudioJob, StudioProfile, StudioShot, StudioStoredImage, StudioWorkflow } from "@/types/studio";

type PlannedShot = {
    title?: unknown;
    prompt?: unknown;
    pose?: unknown;
    framing?: unknown;
    lens?: unknown;
    aspectRatio?: unknown;
    resolution?: unknown;
};

const ALLOWED_RATIOS = new Set(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]);

const workflowRules: Record<StudioWorkflow, string> = {
    outfit: "分析参考服装的版型、材质、颜色、图案和穿搭方式。为同一位人物设计差异明显但自然可拍的姿势、动作、景别和焦段，不复制服装参考图里的人脸、身体、姿态或背景。",
    recreate: "严格拆解并复现参考照片的姿势、服装、场景、表情、光线、色调、构图和氛围。每个镜头只允许有连拍级微小差异，不得擅自换造型或换场景。",
    variants: "把参考成片作为母片，保留人物造型、视觉风格和核心叙事，设计适合社交平台选片的高质量变体。变化应有明确摄影价值，避免只是随机改色或无意义扭动。",
};

export async function planStudioShots(input: {
    config: AiConfig;
    workflow: StudioWorkflow;
    brief: string;
    count: number;
    aspectRatio: string;
    resolution: "1K" | "2K" | "4K";
    reference: StudioStoredImage;
    modelSource: StudioShot["modelSource"];
    imageModel: string;
    signal?: AbortSignal;
}) {
    const count = Math.max(1, Math.min(60, Math.floor(input.count)));
    const referenceDataUrl = await imageToDataUrl({ storageKey: input.reference.storageKey });
    if (!referenceDataUrl) throw new Error("无法读取工作流参考图");
    const instruction = [
        "你是商业人像摄影导演，需要输出可直接交给图像模型执行的结构化拍摄清单。",
        workflowRules[input.workflow],
        `必须返回 ${count} 个镜头，默认画幅 ${input.aspectRatio}，默认分辨率 ${input.resolution}。`,
        "每个镜头都要写清人物动作、手部状态、眼神与表情、景别、相机机位、镜头焦段、光线、场景细节和画面质感。",
        '只返回合法 JSON，不要 Markdown，不要解释。格式：{"shots":[{"title":"","prompt":"","pose":"","framing":"","lens":"","aspectRatio":"3:4","resolution":"4K"}]}。',
        input.brief.trim() ? `用户补充要求：${input.brief.trim()}` : "用户没有额外补充要求。",
    ].join("\n");
    const messages: AiTextMessage[] = [
        { role: "system", content: "只输出严格 JSON。所有镜头描述使用中文，避免空泛形容词和互相矛盾的摄影参数。" },
        {
            role: "user",
            content: [
                { type: "text", text: instruction },
                { type: "image_url", image_url: { url: referenceDataUrl } },
            ],
        },
    ];
    const output = await requestImageQuestion(input.config, messages, () => undefined, { signal: input.signal });
    const rawShots = parseShotList(output);
    if (rawShots.length < count) throw new Error(`LLM 只规划了 ${rawShots.length} 个镜头，少于要求的 ${count} 个`);
    const now = new Date().toISOString();
    return rawShots.slice(0, count).map(
        (shot, index): StudioShot => ({
            id: nanoid(),
            index,
            title: textValue(shot.title) || `镜头 ${index + 1}`,
            prompt: textValue(shot.prompt),
            pose: textValue(shot.pose) || "自然动作",
            framing: textValue(shot.framing) || "中景",
            lens: textValue(shot.lens) || "50mm",
            aspectRatio: normalizeRatio(shot.aspectRatio, input.aspectRatio),
            resolution: normalizeResolution(shot.resolution, input.resolution),
            modelSource: input.modelSource,
            model: input.imageModel,
            status: "queued",
            attempts: 0,
            favorite: false,
            updatedAt: now,
        }),
    );
}

function parseShotList(output: string): PlannedShot[] {
    const trimmed = output
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    const candidate = firstBrace >= 0 && lastBrace > firstBrace ? trimmed.slice(firstBrace, lastBrace + 1) : trimmed;
    let parsed: unknown;
    try {
        parsed = JSON.parse(candidate);
    } catch {
        throw new Error("LLM 返回的拍摄计划不是合法 JSON");
    }
    const shots = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && "shots" in parsed ? (parsed as { shots?: unknown }).shots : null;
    if (!Array.isArray(shots)) throw new Error("LLM 返回的拍摄计划缺少 shots 数组");
    const valid = shots.filter((shot): shot is PlannedShot => Boolean(shot && typeof shot === "object" && textValue((shot as PlannedShot).prompt)));
    if (!valid.length) throw new Error("LLM 没有返回可执行的镜头提示词");
    return valid;
}

function textValue(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function normalizeRatio(value: unknown, fallback: string) {
    const ratio = textValue(value);
    return ALLOWED_RATIOS.has(ratio) ? ratio : fallback;
}

function normalizeResolution(value: unknown, fallback: "1K" | "2K" | "4K") {
    const resolution = textValue(value).toUpperCase();
    return resolution === "1K" || resolution === "2K" || resolution === "4K" ? resolution : fallback;
}
