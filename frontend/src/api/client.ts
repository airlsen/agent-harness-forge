let csrf = '';
export function setCsrf(value: string) {
  csrf = value;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T = any>(url: string, options: RequestInit = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...((options.headers as Record<string, string>) ?? {}),
  };
  if (!['GET', 'HEAD'].includes(method) && csrf) headers['X-Forge-CSRF'] = csrf;
  const response = await fetch('/api' + url, {
    credentials: 'same-origin',
    ...options,
    headers,
    cache: 'no-store',
  });
  let body: any;
  try {
    body = await response.json();
  } catch {
    throw new ApiError('服务未返回有效响应，请检查后端连接', response.status);
  }
  if (!response.ok || body.code !== 0) {
    if (response.status === 401 && url !== '/auth/login')
      window.dispatchEvent(new Event('forge:unauthorized'));
    throw new ApiError(body.message ?? body.detail ?? '请求失败', response.status);
  }
  return body.data as T;
}
export const post = <T = any>(url: string, data?: unknown) =>
  api<T>(url, { method: 'POST', ...(data ? { body: JSON.stringify(data) } : {}) });
export const put = <T = any>(url: string, data: unknown) =>
  api<T>(url, { method: 'PUT', body: JSON.stringify(data) });
export const remove = (url: string) => api(url, { method: 'DELETE' });
