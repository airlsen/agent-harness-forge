import type { McpServer } from '../types/mcp';

export function transportLabel(transport: string) {
  if (transport === 'stdio') return '本机进程';
  if (transport === 'sse') return '旧版 SSE';
  return 'Streamable HTTP';
}

export function mcpState(server: McpServer): { label: string; color?: string } {
  if (server.status === 'connected') return { label: '连接正常', color: 'success' };
  if (server.status === 'error') return { label: '连接失败', color: 'error' };
  return { label: '待测试' };
}

export function mcpDescription(server: McpServer) {
  const name = String(
    server.serverInfo?.name || (server.transport === 'stdio' ? '本机 MCP 进程' : server.url),
  );
  return server.serverInfo?.version ? `${name} · ${String(server.serverInfo.version)}` : name;
}

/** 与后端 parse_import_config 一致的协议推断：显式 type / transport 优先，有 command 视为 stdio */
export function inferTransport(entry: Record<string, unknown>): string | null {
  const kind = String(
    entry.type ?? entry.transport ?? ('command' in entry ? 'stdio' : 'streamable-http'),
  ).toLowerCase();
  if (['http', 'streamable_http', 'streamable-http'].includes(kind)) return 'streamable-http';
  if (['sse', 'http-sse'].includes(kind)) return 'sse';
  if (kind === 'stdio') return 'stdio';
  return null;
}

export type McpImportEntry = {
  name: string;
  transport: string | null;
  /** 与已有服务同名，导入会覆盖并重置为未启用 */
  overwrite: boolean;
  /** 远程地址不是 https，后端会拒绝 */
  insecure: boolean;
};

export type McpImportPreview = { entries: McpImportEntry[]; error: string };

/** 导入弹窗的实时预览：只做前端能确定的检查，其余（地址可达性、请求头等）仍以后端为准 */
export function previewMcpImport(text: string, existingNames: string[]): McpImportPreview | null {
  if (!text.trim()) return null;
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    return { entries: [], error: 'JSON 格式有误' };
  }
  const servers = (config as { mcpServers?: unknown } | null)?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers) || !Object.keys(servers).length)
    return { entries: [], error: '需包含非空的 mcpServers 对象' };
  const names = Object.keys(servers);
  if (names.length > 20) return { entries: [], error: '一次最多导入 20 个服务' };
  const existing = new Set(existingNames);
  const entries = Object.entries(servers as Record<string, unknown>).map(([rawName, value]) => {
    const name = rawName.trim();
    const entry = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const transport = inferTransport(entry);
    const url = String(entry.url ?? '');
    return {
      name,
      transport,
      overwrite: existing.has(name),
      insecure: transport !== null && transport !== 'stdio' && !/^https:\/\//i.test(url),
    };
  });
  return { entries, error: '' };
}
