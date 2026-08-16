import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const port = Number(process.env.PORT || 3100);
const dataDir = process.env.DATA_DIR || "/data";
const paidSiteUrl = String(
  process.env.PAID_SITE_INTERNAL_URL || "http://huiliu-api:3000",
).replace(/\/+$/, "");
const authCache = new Map();
const AUTH_CACHE_MS = 10_000;
const STATE_LIMIT = 16 * 1024 * 1024;
const FILE_LIMIT = 48 * 1024 * 1024;

await mkdir(join(dataDir, "users"), { recursive: true });

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

async function readBody(request, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) {
      const error = new Error("请求体过大");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function bearerToken(request) {
  const match = String(request.headers.authorization || "").match(
    /^Bearer\s+(.+)$/i,
  );
  return match?.[1]?.trim() || "";
}

async function authenticate(request) {
  const token = bearerToken(request);
  if (!token) {
    const error = new Error("请先登录付费站账号");
    error.status = 401;
    throw error;
  }
  const cacheKey = createHash("sha256").update(token).digest("hex");
  const cached = authCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.user;
  const upstream = await fetch(`${paidSiteUrl}/api/user/self`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await upstream.json().catch(() => ({}));
  const user = body?.data;
  if (
    !upstream.ok ||
    !body?.success ||
    !Number.isInteger(user?.id) ||
    user.id <= 0
  ) {
    authCache.delete(cacheKey);
    const error = new Error("付费站登录已失效");
    error.status = 401;
    throw error;
  }
  const safeUser = { id: user.id, username: String(user.username || "") };
  authCache.set(cacheKey, {
    user: safeUser,
    expiresAt: Date.now() + AUTH_CACHE_MS,
  });
  return safeUser;
}

function userPath(userId, ...parts) {
  return join(dataDir, "users", String(userId), ...parts);
}

function safeFileName(storageKey) {
  if (!/^image:[A-Za-z0-9_-]+$/.test(storageKey)) {
    const error = new Error("无效的媒体标识");
    error.status = 400;
    throw error;
  }
  return Buffer.from(storageKey).toString("base64url");
}

async function atomicWrite(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

async function handleState(request, response, user) {
  const path = userPath(user.id, "studio-state.json");
  if (request.method === "GET") {
    try {
      const data = await readFile(path);
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": data.length,
        "Cache-Control": "no-store",
      });
      response.end(data);
    } catch (error) {
      if (error?.code === "ENOENT")
        return sendJson(response, 404, {
          success: false,
          message: "尚无云端数据",
        });
      throw error;
    }
    return;
  }
  if (request.method === "PUT") {
    const data = await readBody(request, STATE_LIMIT);
    let manifest;
    try {
      manifest = JSON.parse(data.toString("utf8"));
    } catch {
      const error = new Error("同步清单不是合法 JSON");
      error.status = 400;
      throw error;
    }
    if (
      manifest?.app !== "personal-image-studio" ||
      manifest?.version !== 1 ||
      typeof manifest?.data !== "object"
    ) {
      const error = new Error("同步清单格式不受支持");
      error.status = 400;
      throw error;
    }
    manifest.updatedAt = new Date().toISOString();
    await atomicWrite(path, Buffer.from(JSON.stringify(manifest)));
    return sendJson(response, 200, {
      success: true,
      updatedAt: manifest.updatedAt,
    });
  }
  sendJson(response, 405, { success: false, message: "不支持的请求方法" });
}

async function handleFile(request, response, user, storageKey) {
  const name = safeFileName(storageKey);
  const filePath = userPath(user.id, "files", name);
  const metaPath = `${filePath}.json`;
  if (request.method === "HEAD" || request.method === "GET") {
    try {
      const [info, metaRaw] = await Promise.all([
        stat(filePath),
        readFile(metaPath, "utf8").catch(() => "{}"),
      ]);
      let meta = {};
      try {
        meta = JSON.parse(metaRaw);
      } catch {
        meta = {};
      }
      response.writeHead(200, {
        "Content-Type": meta.mimeType || "application/octet-stream",
        "Content-Length": info.size,
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      });
      if (request.method === "HEAD") return response.end();
      response.end(await readFile(filePath));
    } catch (error) {
      if (error?.code === "ENOENT")
        return sendJson(response, 404, {
          success: false,
          message: "媒体不存在",
        });
      throw error;
    }
    return;
  }
  if (request.method === "PUT") {
    const data = await readBody(request, FILE_LIMIT);
    const mimeType = String(
      request.headers["content-type"] || "application/octet-stream",
    )
      .split(";")[0]
      .trim();
    await atomicWrite(filePath, data);
    await atomicWrite(
      metaPath,
      Buffer.from(
        JSON.stringify({
          storageKey,
          mimeType,
          bytes: data.length,
          updatedAt: new Date().toISOString(),
        }),
      ),
    );
    return sendJson(response, 200, { success: true, bytes: data.length });
  }
  if (request.method === "DELETE") {
    await Promise.all([
      unlink(filePath).catch(() => undefined),
      unlink(metaPath).catch(() => undefined),
    ]);
    return sendJson(response, 200, { success: true });
  }
  sendJson(response, 405, { success: false, message: "不支持的请求方法" });
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://studio.local");
    if (url.pathname === "/health")
      return sendJson(response, 200, { status: "ok" });
    const user = await authenticate(request);
    if (url.pathname === "/state")
      return await handleState(request, response, user);
    if (url.pathname.startsWith("/files/")) {
      const storageKey = decodeURIComponent(
        url.pathname.slice("/files/".length),
      );
      return await handleFile(request, response, user, storageKey);
    }
    sendJson(response, 404, { success: false, message: "接口不存在" });
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error("studio-server request failed", error);
    sendJson(response, status, {
      success: false,
      message: status >= 500 ? "云同步服务异常" : error.message,
    });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`personal image studio server listening on ${port}`);
});
