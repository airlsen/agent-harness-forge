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
  if (!['GET', 'HEAD'].includes((options.method ?? 'GET').toUpperCase()) && csrf)
    headers.set('X-Forge-CSRF', csrf);
  const response = await fetch(url, {
    ...options,
    // sandbox 的不透明源不能强制 credentials=include；兼容会话只用显式请求头。
    credentials: preview ? 'omit' : 'same-origin',
    headers,
    cache: 'no-store',
  });
  if (response.status === 401 && url !== '/api/auth/login') {
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
export async function downloadResponse(url: string, filename: string): Promise<void> {
  const response = await apiFetch('/api' + url);
  if (!response.ok) throw await responseError(response);
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
export const post = <T = any>(url: string, data?: unknown) =>
  api<T>(url, { method: 'POST', ...(data ? { body: JSON.stringify(data) } : {}) });
export const put = <T = any>(url: string, data: unknown) =>
  api<T>(url, { method: 'PUT', body: JSON.stringify(data) });
export const remove = (url: string) => api(url, { method: 'DELETE' });
