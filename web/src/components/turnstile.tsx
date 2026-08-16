import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type TurnstileWidget = {
    render: (container: HTMLElement, options: Record<string, unknown>) => string;
    remove: (widgetId: string) => void;
};

declare global {
    interface Window {
        turnstile?: TurnstileWidget;
    }
}

type TurnstileProps = {
    siteKey: string;
    refreshKey: number;
    onVerify: (token: string) => void;
    onExpire: () => void;
    onError: () => void;
};

const SCRIPT_ID = "personal-image-studio-turnstile";
let scriptPromise: Promise<void> | null = null;

function loadTurnstileScript() {
    if (window.turnstile) return Promise.resolve();
    if (scriptPromise) return scriptPromise;

    scriptPromise = new Promise<void>((resolve, reject) => {
        let script = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
        let shouldAppend = false;
        if (script?.dataset.failed === "true") {
            script.remove();
            script = null;
        }

        const onLoad = () => {
            cleanup();
            if (!window.turnstile) {
                scriptPromise = null;
                reject(new Error("Turnstile API 未就绪"));
                return;
            }
            if (script) script.dataset.loaded = "true";
            resolve();
        };
        const onError = () => {
            cleanup();
            if (script) script.dataset.failed = "true";
            scriptPromise = null;
            reject(new Error("Turnstile 脚本加载失败"));
        };
        const cleanup = () => {
            script?.removeEventListener("load", onLoad);
            script?.removeEventListener("error", onError);
        };

        if (!script) {
            script = document.createElement("script");
            script.id = SCRIPT_ID;
            script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
            script.async = true;
            script.defer = true;
            shouldAppend = true;
        }
        if (script.dataset.loaded === "true") {
            onLoad();
            return;
        }
        script.addEventListener("load", onLoad, { once: true });
        script.addEventListener("error", onError, { once: true });
        if (shouldAppend) document.head.appendChild(script);
    });

    return scriptPromise;
}

export function Turnstile({ siteKey, refreshKey, onVerify, onExpire, onError }: TurnstileProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const onVerifyRef = useRef(onVerify);
    const onExpireRef = useRef(onExpire);
    const onErrorRef = useRef(onError);
    const [loading, setLoading] = useState(true);
    onVerifyRef.current = onVerify;
    onExpireRef.current = onExpire;
    onErrorRef.current = onError;

    useEffect(() => {
        const container = containerRef.current;
        let cancelled = false;
        let widgetId = "";
        setLoading(true);

        void loadTurnstileScript()
            .then(() => {
                if (cancelled || !container || !window.turnstile) return;
                widgetId = window.turnstile.render(container, {
                    sitekey: siteKey,
                    size: "flexible",
                    theme: "auto",
                    retry: "auto",
                    "refresh-expired": "auto",
                    callback: (token: string) => onVerifyRef.current(token),
                    "expired-callback": () => onExpireRef.current(),
                    "timeout-callback": () => onExpireRef.current(),
                    "error-callback": () => onErrorRef.current(),
                });
                setLoading(false);
            })
            .catch(() => {
                if (cancelled) return;
                setLoading(false);
                onErrorRef.current();
            });

        return () => {
            cancelled = true;
            if (widgetId) window.turnstile?.remove(widgetId);
            container?.replaceChildren();
        };
    }, [refreshKey, siteKey]);

    return (
        <div className="relative min-h-[65px] w-full overflow-hidden">
            <div ref={containerRef} className="w-full" />
            {loading ? (
                <div className="absolute inset-0 flex items-center justify-center gap-2 bg-white text-xs text-stone-500 dark:bg-stone-950">
                    <LoaderCircle className="size-4 animate-spin" />
                    正在载入安全验证
                </div>
            ) : null}
        </div>
    );
}
