/** 带 HTTP 状态码的业务错误：服务端按 statusCode 原样返回给控制面 */
export function failure(message: string, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
/** Runner 会话 id（randomUUID），同时决定磁盘目录名，必须严格校验 */
const SESSION_ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
export function isSessionId(id: string) {
  return typeof id === 'string' && SESSION_ID.test(id);
}
