// MCP 服务目录：与后端 mcp_service.public_view 返回结构一致
export type McpTool = {
  name: string;
  description: string;
  inputSchema?: Record<string, any>;
};

export type McpServer = {
  id: number;
  name: string;
  url: string;
  transport: string;
  enabled: boolean;
  status: string;
  lastError: string;
  tools: McpTool[];
  serverInfo: Record<string, unknown>;
  hasCredentials: boolean;
};
