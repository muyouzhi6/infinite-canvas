import { createBrowserRouter, Outlet } from "react-router-dom";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import UserLayout from "@/layouts/user-layout";
import AssetsPage from "@/pages/assets";
import CanvasPage from "@/pages/canvas";
import CanvasProjectPage from "@/pages/canvas/project";
import ConfigPage from "@/pages/config";
import HomePage from "@/pages/home";
import ImagePage from "@/pages/image";
import NotFound from "@/pages/not-found";
import PromptsPage from "@/pages/prompts";
import StudioPage from "@/pages/studio";
import VideoPage from "@/pages/video";

const basePath = String(import.meta.env.BASE_URL || "/").replace(/\/$/, "") || "/";

export const router = createBrowserRouter(
    [
        {
            element: (
                <UserLayout>
                    <AnalyticsTracker />
                    <Outlet />
                </UserLayout>
            ),
            children: [
                { path: "/", element: basePath === "/" ? <HomePage /> : <StudioPage /> },
                { path: "/home", element: <HomePage /> },
                { path: "/studio", element: <StudioPage /> },
                { path: "/image", element: <ImagePage /> },
                { path: "/video", element: <VideoPage /> },
                { path: "/assets", element: <AssetsPage /> },
                { path: "/prompts", element: <PromptsPage /> },
                { path: "/canvas", element: <CanvasPage /> },
                { path: "/canvas/:id", element: <CanvasProjectPage /> },
                { path: "/config", element: <ConfigPage /> },
            ],
        },
        { path: "*", element: <NotFound /> },
    ],
    { basename: basePath },
);
