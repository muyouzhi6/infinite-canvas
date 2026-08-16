import type { ReferenceImage } from "@/types/image";

import i18n from "@/i18n";

export function imageReferenceLabel(index: number) {
    return i18n.t("imageReferences.label", { index: index + 1 });
}

export function imageReferenceDescriptor(reference: ReferenceImage, index: number) {
    const label = imageReferenceLabel(index);
    const role = reference.promptRole?.replace(/\s+/g, " ").trim().slice(0, 240);
    return role ? `${label}（${role}）` : label;
}

export function buildImageReferencePromptText(prompt: string, references: ReferenceImage[]) {
    const text = prompt.trim();
    if (!references.length) return text;
    const labels = references.map(imageReferenceDescriptor);
    return i18n.t("imageReferences.promptPrefix", { labels: labels.join(i18n.t("imageReferences.separator")), prompt: text });
}
