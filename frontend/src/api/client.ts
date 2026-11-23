let csrf = '';
const PREVIEW_KEY = 'forge.preview-session.v1';
type PreviewSession = { token: string; expiresAt: number };
let preview: PreviewSession | null = null;
try {
  const saved = JSON.parse(sessionStorage.getItem(PREVIEW_KEY) ?? 'null');
  if (typeof saved?.token === 'string' && saved.expiresAt > Date.now() / 1000) preview = saved;
  else sessionStorage.removeItem(PREVIEW_KEY);
} catch {
  // 某些 sandbox 同时禁止 Cookie 和 Web Storage；仍允许内存内登录，本次刷新后需重新登录。
}
// 当前空间：所有 API 请求都带上，后端据此过滤列表（本空间 + 公共）并决定新建内容放在哪里。
// 刷新后从本地存储恢复（只存空间编号与名称，不含业务内容）。
export const SPACE_STORAGE_KEY = 'forge.space.v1';
export const SPACE_HEADER = 'X-Forge-Space';
// 未选择过空间时使用公共空间（编号 1）
let spaceId: number | null = 1;
try {
  const saved = JSON.parse(localStorage.getItem(SPACE_STORAGE_KEY) ?? 'null');
  if (Number.isInteger(saved?.id) && saved.id > 0) spaceId = saved.id;
} catch {
  // 本地存储不可用时使用公共空间
}
export function setSpaceHeader(value: number | null) {
  spaceId = value;
}
export function setCsrf(value: string) {
  csrf = value;
}
export function setPreviewSession(value: PreviewSession | null) {
  preview = value;
  try {
    if (value) sessionStorage.setItem(PREVIEW_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(PREVIEW_KEY);
  } catch {
    // 绝不回退到 localStorage、URL、DOM 或日志。只保留当前页面内存。
  }
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
/** 所有 API/SSE/导出统一使用此入口；凭据不附加到任意第三方 URL。 */
export async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  if (!url.startsWith('/api/')) throw new Error('只允许访问同源 Forge API');
  const headers = new Headers(options.headers);
  if (preview) headers.set('X-Forge-Session', preview.token);
  if (spaceId && !headers.has(SPACE_HEADER)) headers.set(SPACE_HEADER, String(spaceId));
  if (!['GET', 'HEAD'].includes((options.method ?? 'GET').toUpperCase()) && csrf)
    headers.set('X-Forge-CSRF', csrf);
  const response = await fetch(url, {
    ...options,
    // sandbox 的不透明源不能强制 credentials=include；兼容会话只用显式请求头。
    credentials: preview ? 'omit' : 'same-origin',
    headers,
    cache: 'no-store',
  });
  if (
    response.status === 401 &&
    !['/api/auth/login', '/api/auth/register', '/api/auth/verify-email'].includes(url)
  ) {
    setPreviewSession(null);
    setCsrf('');
    window.dispatchEvent(new Event('forge:unauthorized'));
  }
  return response;
}
async function responseError(response: Response): Promise<ApiError> {
  try {
    const body = await response.json();
    return new ApiError(body.message ?? body.detail ?? '请求失败', response.status);
  } catch {
    return new ApiError('服务未返回有效响应，请检查后端连接', response.status);
  }
}
export async function api<T = any>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set('Content-Type', 'application/json');
  const response = await apiFetch('/api' + url, { ...options, headers });
  if (!response.ok) throw await responseError(response);
  let body: any;
  try {
    body = await response.json();
  } catch {
    throw new ApiError('服务未返回有效响应，请检查后端连接', response.status);
  }
  if (body.code !== 0) throw new ApiError(body.message ?? '请求失败', response.status);
  return body.data as T;
}
/** 读取二进制响应（预览/下载会话文件等），失败时抛出带服务端消息的 ApiError */
export async function apiBlob(url: string): Promise<Blob> {
  const response = await apiFetch('/api' + url);
  if (!response.ok) throw await responseError(response);
  return response.blob();
}
/** 把 Blob 以指定文件名保存到本地 */
export function saveBlob(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
export async function downloadResponse(url: string, filename: string): Promise<void> {
  saveBlob(await apiBlob(url), filename);
}
export const post = <T = any>(url: string, data?: unknown) =>
  api<T>(url, { method: 'POST', ...(data ? { body: JSON.stringify(data) } : {}) });
export const put = <T = any>(url: string, data: unknown) =>
  api<T>(url, { method: 'PUT', body: JSON.stringify(data) });
export const remove = (url: string) => api(url, { method: 'DELETE' });
