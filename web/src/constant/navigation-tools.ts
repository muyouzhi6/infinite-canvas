import { Camera, FileText, ImagePlus, Images, Maximize2, Settings2, Video } from "lucide-react";

export const navigationTools = [
    {
        slug: "studio",
        icon: Camera,
    },
    {
        slug: "canvas",
        icon: Maximize2,
    },
    {
        slug: "image",
        icon: ImagePlus,
    },
    {
        slug: "video",
        icon: Video,
    },
    {
        slug: "prompts",
        icon: FileText,
    },
    {
        slug: "assets",
        icon: Images,
    },
    {
        slug: "config",
        icon: Settings2,
    },
] as const;

export type NavigationToolSlug = (typeof navigationTools)[number]["slug"];

export function navigationToolPath(slug: NavigationToolSlug) {
    return slug === "studio" && import.meta.env.BASE_URL !== "/" ? "/" : `/${slug}`;
}
