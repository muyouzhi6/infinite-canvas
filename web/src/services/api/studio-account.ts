import { encodeChannelModel, guessCapability, modelOptionName, useConfigStore, type AiConfig, type ChannelModel, type ModelChannel } from "@/stores/use-config-store";
import { useStudioAuthStore, type StudioAccountToken, type StudioAccountUser } from "@/stores/use-studio-auth-store";
import { useStudioStore, waitForStudioHydration } from "@/stores/use-studio-store";
import type { StudioNodeSource } from "@/types/studio";

type ApiResponse<T> = { success: boolean; message?: string; data?: T; code?: string };
type AccountUserPayload = {
    id: number;
    username: string;
    display_name?: string;
    group?: string;
    quota?: number;
    used_quota?: number;
};
type AuthBundle = {
    access_token: string;
    access_expires_at: number;
    session?: { sid?: string };
    user: AccountUserPayload;
};
type LoginResult = { ready: true } | { ready: false; flowToken: string };
type TokenItem = { id: number; name: string; status: number; created_time?: number };
type TokenPage = { items?: TokenItem[]; total?: number };
type PaidSiteStatusPayload = {
    turnstile_check?: boolean;
    turnstile_site_key?: string;
    password_login_enabled?: boolean;
};

export type PaidSiteLoginStatus = {
    turnstileCheck: boolean;
    turnstileSiteKey: string;
    passwordLoginEnabled: boolean;
};

const STUDIO_TOKEN_NAME = "人物影棚";
const TRUSTED_ACCOUNT_KEY = "personal-image-studio:trusted-account";
export const PAID_OPENAI_CHANNEL_ID = "huiliu-account-openai";
export const PAID_GEMINI_CHANNEL_ID = "huiliu-account-gemini";
const dashboardBase = String(import.meta.env.VITE_PAID_DASHBOARD_BASE || "").replace(/\/+$/, "");
const relayBase = String(import.meta.env.VITE_PAID_API_BASE || (typeof window === "undefined" ? "" : window.location.origin)).replace(/\/+$/, "");
let accountConnectionGeneration = 0;

function accountUrl(path: string) {
    return `${dashboardBase}${path}`;
}

function trustedAccountUserId() {
    if (typeof window === "undefined") return null;
    try {
        const value = Number.parseInt(window.localStorage.getItem(TRUSTED_ACCOUNT_KEY) || "", 10);
        return Number.isInteger(value) && value > 0 ? value : null;
    } catch {
        return null;
    }
}

function rememberTrustedAccount(userId: number) {
    try {
        if (typeof window !== "undefined") window.localStorage.setItem(TRUSTED_ACCOUNT_KEY, String(userId));
    } catch {}
}

function forgetTrustedAccount() {
    try {
        if (typeof window !== "undefined") window.localStorage.removeItem(TRUSTED_ACCOUNT_KEY);
    } catch {}
}

function asUser(value: AccountUserPayload): StudioAccountUser {
    return {
        id: value.id,
        username: value.username,
        displayName: value.display_name || value.username,
        group: value.group || "default",
        quota: value.quota,
        usedQuota: value.used_quota,
    };
}

async function parseResponse<T>(response: Response): Promise<ApiResponse<T>> {
    const body = (await response.json().catch(() => ({}))) as ApiResponse<T>;
    if (!response.ok || !body.success) throw new Error(body.message || `请求失败 (${response.status})`);
    return body;
}

async function refreshAccessToken(expectedUserId?: number) {
    const current = useStudioAuthStore.getState();
    const response = await fetch(accountUrl("/api/user/auth/refresh"), {
        method: "POST",
        credentials: "include",
        headers: current.sessionId ? { "X-Auth-Session": current.sessionId } : undefined,
    });
    const body = await parseResponse<AuthBundle>(response);
    if (!body.data) throw new Error("登录会话返回为空");
    if (expectedUserId !== undefined && body.data.user.id !== expectedUserId) throw new Error("登录会话与本浏览器绑定账号不一致");
    setAuthBundle(body.data);
    return body.data;
}

function accountStateFor(expectedUserId?: number) {
    const state = useStudioAuthStore.getState();
    if (expectedUserId !== undefined && state.user?.id !== expectedUserId) throw new Error("登录账号已切换，请重新同步");
    return state;
}

export async function paidAccountFetch(path: string, init: RequestInit = {}, retry = true, expectedUserId?: number) {
    let token = accountStateFor(expectedUserId).accessToken;
    if (!token) token = (await refreshAccessToken(expectedUserId)).access_token;
    accountStateFor(expectedUserId);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(accountUrl(path), { ...init, headers, credentials: "include" });
    if (response.status !== 401 || !retry) return response;
    token = (await refreshAccessToken(expectedUserId)).access_token;
    accountStateFor(expectedUserId);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(accountUrl(path), { ...init, headers, credentials: "include" });
}

function setAuthBundle(bundle: AuthBundle) {
    useStudioAuthStore.getState().setSession({
        user: asUser(bundle.user),
        accessToken: bundle.access_token,
        accessExpiresAt: bundle.access_expires_at,
        sessionId: bundle.session?.sid || "",
        status: "loading",
        error: "",
    });
}

async function loadAccountModels(expectedUserId: number) {
    const response = await paidAccountFetch("/api/user/models", {}, true, expectedUserId);
    const body = await parseResponse<string[]>(response);
    return Array.from(new Set((body.data || []).map((model) => model.trim()).filter(Boolean))).sort();
}

async function listTokens(expectedUserId: number) {
    const response = await paidAccountFetch("/api/token/?p=0&size=100", {}, true, expectedUserId);
    const body = await parseResponse<TokenPage>(response);
    return body.data?.items || [];
}

async function createStudioToken(group: string, expectedUserId: number) {
    const response = await paidAccountFetch(
        "/api/token/",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: STUDIO_TOKEN_NAME,
                expired_time: -1,
                remain_quota: 0,
                unlimited_quota: true,
                model_limits_enabled: false,
                model_limits: "",
                allow_ips: "",
                group,
                cross_group_retry: false,
            }),
        },
        true,
        expectedUserId,
    );
    await parseResponse<never>(response);
}

async function ensureStudioToken(group: string, expectedUserId: number): Promise<StudioAccountToken> {
    let tokens = await listTokens(expectedUserId);
    let selected = tokens.filter((token) => token.status === 1 && token.name === STUDIO_TOKEN_NAME).sort((a, b) => (b.created_time || b.id) - (a.created_time || a.id))[0];
    if (!selected) {
        await createStudioToken(group, expectedUserId);
        tokens = await listTokens(expectedUserId);
        selected = tokens.filter((token) => token.status === 1 && token.name === STUDIO_TOKEN_NAME).sort((a, b) => (b.created_time || b.id) - (a.created_time || a.id))[0];
    }
    if (!selected) throw new Error("无法创建人物影棚专用 API Key");
    const response = await paidAccountFetch(`/api/token/${selected.id}/key`, { method: "POST" }, true, expectedUserId);
    const body = await parseResponse<{ key?: string }>(response);
    const key = body.data?.key || "";
    if (!key) throw new Error("无法读取人物影棚 API Key");
    return { id: selected.id, name: selected.name, key };
}

function paidChannelModels(models: string[]): ChannelModel[] {
    return models.map((name) => ({ name, capability: guessCapability(name) }));
}

export function syncPaidModelsToCanvas(models: string[], apiKey: string) {
    const config = useConfigStore.getState().config;
    const customChannels = config.channels.filter((channel) => channel.id !== PAID_OPENAI_CHANNEL_ID && channel.id !== PAID_GEMINI_CHANNEL_ID);
    const openaiChannel: ModelChannel = {
        id: PAID_OPENAI_CHANNEL_ID,
        name: "付费站账号",
        baseUrl: relayBase,
        apiKey,
        apiFormat: "openai",
        models: paidChannelModels(models),
    };
    const geminiModels = models.filter((model) => model.toLowerCase().includes("gemini") && guessCapability(model) === "image");
    const channels = [openaiChannel, ...(geminiModels.length ? [{ ...openaiChannel, id: PAID_GEMINI_CHANNEL_ID, name: "付费站 Gemini 原生", apiFormat: "gemini" as const, models: paidChannelModels(geminiModels) }] : []), ...customChannels];
    useConfigStore.getState().updateConfig("channels", channels);
    useConfigStore.getState().updateConfig(
        "models",
        channels.flatMap((channel) => channel.models.map((model) => encodeChannelModel(channel.id, model.name))),
    );
}

export function removePaidModelsFromCanvas() {
    const config = useConfigStore.getState().config;
    const channels = config.channels.filter((channel) => channel.id !== PAID_OPENAI_CHANNEL_ID && channel.id !== PAID_GEMINI_CHANNEL_ID);
    useConfigStore.getState().updateConfig("channels", channels);
    useConfigStore.getState().updateConfig(
        "models",
        channels.flatMap((channel) => channel.models.map((model) => encodeChannelModel(channel.id, model.name))),
    );
}

function beginAccountConnection() {
    accountConnectionGeneration += 1;
    return accountConnectionGeneration;
}

function assertCurrentAccountConnection(generation: number, expectedUserId: number) {
    const auth = useStudioAuthStore.getState();
    if (generation !== accountConnectionGeneration || auth.user?.id !== expectedUserId) throw new Error("登录账号已切换，请重新连接");
}

async function finishAccountConnection(generation: number, expectedUserId: number, group: string) {
    assertCurrentAccountConnection(generation, expectedUserId);
    const [models, apiToken] = await Promise.all([loadAccountModels(expectedUserId), ensureStudioToken(group, expectedUserId)]);
    assertCurrentAccountConnection(generation, expectedUserId);
    await waitForStudioHydration();
    assertCurrentAccountConnection(generation, expectedUserId);
    useStudioStore.getState().bindAccountOwner(expectedUserId);
    syncPaidModelsToCanvas(models, apiToken.key);
    useStudioAuthStore.getState().setSession({ models, apiToken, status: "ready", error: "" });
}

export async function bootstrapPaidAccount() {
    const store = useStudioAuthStore.getState();
    const generation = beginAccountConnection();
    const expectedUserId = trustedAccountUserId();
    if (!expectedUserId) {
        removePaidModelsFromCanvas();
        store.reset();
        return false;
    }
    store.setSession({ status: "loading", error: "" });
    try {
        const bundle = await refreshAccessToken(expectedUserId);
        await finishAccountConnection(generation, bundle.user.id, bundle.user.group || "default");
        return true;
    } catch (error) {
        if (generation !== accountConnectionGeneration) return false;
        forgetTrustedAccount();
        removePaidModelsFromCanvas();
        store.reset();
        return false;
    }
}

export async function loadPaidSiteLoginStatus(): Promise<PaidSiteLoginStatus> {
    const response = await fetch(accountUrl("/api/status"), { credentials: "include" });
    const body = await parseResponse<PaidSiteStatusPayload>(response);
    if (!body.data) throw new Error("付费站登录状态为空");
    const turnstileCheck = body.data.turnstile_check === true;
    const turnstileSiteKey = body.data.turnstile_site_key?.trim() || "";
    if (turnstileCheck && !turnstileSiteKey) throw new Error("付费站人机验证配置不完整");
    return {
        turnstileCheck,
        turnstileSiteKey,
        passwordLoginEnabled: body.data.password_login_enabled !== false,
    };
}

export async function loginPaidAccount(username: string, password: string, turnstileToken = ""): Promise<LoginResult> {
    const generation = beginAccountConnection();
    useStudioAuthStore.getState().setSession({ status: "loading", error: "" });
    try {
        const query = new URLSearchParams();
        if (turnstileToken) query.set("turnstile", turnstileToken);
        const loginPath = `/api/user/login${query.size ? `?${query.toString()}` : ""}`;
        const response = await fetch(accountUrl(loginPath), {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password }),
        });
        const body = await parseResponse<AuthBundle | { require_2fa?: boolean; flow_token?: string }>(response);
        if (body.data && "require_2fa" in body.data && body.data.require_2fa) {
            useStudioAuthStore.getState().setSession({ status: "anonymous" });
            return { ready: false, flowToken: body.data.flow_token || "" };
        }
        if (!body.data || !("access_token" in body.data)) throw new Error("登录响应缺少访问令牌");
        setAuthBundle(body.data);
        await finishAccountConnection(generation, body.data.user.id, body.data.user.group || "default");
        rememberTrustedAccount(body.data.user.id);
        return { ready: true };
    } catch (error) {
        if (generation !== accountConnectionGeneration) throw error;
        const message = error instanceof Error ? error.message : "登录失败";
        useStudioAuthStore.getState().setSession({ status: "error", error: message });
        throw error;
    }
}

export async function completePaidAccount2FA(flowToken: string, code: string) {
    const generation = beginAccountConnection();
    const response = await fetch(accountUrl("/api/user/login/2fa"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flow_token: flowToken, code }),
    });
    const body = await parseResponse<AuthBundle>(response);
    if (!body.data) throw new Error("两步验证响应为空");
    setAuthBundle(body.data);
    await finishAccountConnection(generation, body.data.user.id, body.data.user.group || "default");
    rememberTrustedAccount(body.data.user.id);
}

export function disconnectPaidAccount() {
    beginAccountConnection();
    forgetTrustedAccount();
    removePaidModelsFromCanvas();
    useStudioAuthStore.getState().reset();
}

export function buildStudioNodeConfig(base: AiConfig, source: StudioNodeSource, model: string, capability: "text" | "image", options?: { aspectRatio?: string; resolution?: "1K" | "2K" | "4K" }) {
    if (source === "custom") {
        return {
            ...base,
            model,
            textModel: capability === "text" ? model : base.textModel,
            imageModel: capability === "image" ? model : base.imageModel,
            size: options?.aspectRatio || base.size,
            quality: options?.resolution === "4K" ? "high" : options?.resolution === "2K" ? "medium" : options?.resolution === "1K" ? "low" : base.quality,
            count: "1",
        };
    }
    const auth = useStudioAuthStore.getState();
    if (!auth.apiToken?.key) throw new Error("请先登录付费站账号");
    const rawModel = modelOptionName(model);
    const geminiNative = capability === "image" && rawModel.toLowerCase().includes("gemini");
    const channel: ModelChannel = {
        id: geminiNative ? PAID_GEMINI_CHANNEL_ID : PAID_OPENAI_CHANNEL_ID,
        name: geminiNative ? "付费站 Gemini 原生" : "付费站账号",
        baseUrl: relayBase,
        apiKey: auth.apiToken.key,
        apiFormat: geminiNative ? "gemini" : "openai",
        models: [{ name: rawModel, capability }],
    };
    const encodedModel = encodeChannelModel(channel.id, rawModel);
    return {
        ...base,
        channels: [channel],
        models: [encodedModel],
        model: encodedModel,
        textModel: capability === "text" ? encodedModel : base.textModel,
        imageModel: capability === "image" ? encodedModel : base.imageModel,
        size: options?.aspectRatio || base.size,
        quality: options?.resolution === "4K" ? "high" : options?.resolution === "2K" ? "medium" : options?.resolution === "1K" ? "low" : base.quality,
        count: "1",
    };
}
