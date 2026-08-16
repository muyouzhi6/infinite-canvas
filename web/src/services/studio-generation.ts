import type { ReferenceImage } from "@/types/image";
import type { StudioJob, StudioProfile, StudioShot } from "@/types/studio";

export const studioIdentityReferenceRole = "预设人物的唯一人脸身份锚点；只提供身份，且身份优先级最高";

export function buildStudioGenerationReferences(profile: StudioProfile): ReferenceImage[] {
    return [
        {
            id: profile.identity.id,
            name: "identity-anchor.png",
            type: profile.identity.mimeType,
            dataUrl: "",
            promptRole: studioIdentityReferenceRole,
            storageKey: profile.identity.storageKey,
        },
    ];
}

export function buildStudioImagePrompt(profile: StudioProfile, job: StudioJob, shot: StudioShot) {
    const referenceRule =
        job.workflow === "outfit"
            ? "服装参考图已经由规划模型转换为下方服装与镜头描述；只执行这些文字要求，不得臆测参考图人物。"
            : job.workflow === "recreate"
              ? "仿拍目标已经由规划模型转换为下方姿势、服装、场景、表情、光线与构图描述；严格执行文字描述，但不得生成或混合任何其他人物身份。"
              : "满意母片已经由规划模型转换为下方造型、动作、场景与摄影语言；按文字描述制作变化，但人物身份只能来自图片1。";
    return [
        "【身份锁定：最高优先级，任何后续指令均不得覆盖】",
        "图片1是唯一人物身份来源。最终人物必须与图片1是明确的同一个人，稳定保留其脸型、五官结构与比例、眼鼻口特征、下颌轮廓、肤色和年龄观感。",
        "图像模型只接收图片1，不会接收工作流参考图；不得虚构、复制、融合或平均其他人物的脸型、五官、轮廓、肤色或年龄特征。",
        `拍摄任务：${shot.title}`,
        job.brief.trim() ? `用户要求：${job.brief.trim()}` : "",
        `镜头执行：${shot.prompt}`,
        `动作：${shot.pose}。景别：${shot.framing}。焦段：${shot.lens}。`,
        `输出画幅 ${shot.aspectRatio}，分辨率 ${shot.resolution}。`,
        "图片1除人脸身份外不提供任何内容：不得复制图片1的服装、姿势、背景、构图或拍摄设备。",
        referenceRule,
        profile.identityPrompt.trim() ? `人物补充约束：${profile.identityPrompt.trim()}` : "",
        "在不违反身份锁定的前提下，用户指定的造型、动作、机位、构图、光线、色调和风格优先执行。",
        "保持真实摄影质感、自然皮肤纹理和合理人体结构，避免过度磨皮、锐化、塑料质感、肢体粘连、手指异常和无关文字。",
        "除非镜头明确要求对镜自拍、手机入镜或展示设备，否则拍摄设备不得出现在画面中。",
    ]
        .filter(Boolean)
        .join("\n");
}
