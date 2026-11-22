export type PluginTool = {
  name: string;
  title: string;
  description: string;
  permission: 'read' | 'approval' | string;
  risk: 'read' | 'write' | 'external_side_effect' | string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
};

export type PluginPackage = {
  id: number;
  package: string;
  /** 所属空间（公共空间 = 1）；同一插件的所有版本一致 */
  spaceId?: number;
  displayName: string;
  description: string;
  version: string;
  runtime: string;
  source: string;
  artifactHash: string;
  releaseKey: string;
  artifactName: string;
  artifactBytes: number;
  scanStatus: string;
  reviewNote: string;
  execution: {
    kind?: string;
    endpoint?: string;
    networkDomains?: string[];
    timeoutSeconds?: number;
    authRef?: string;
  };
  extensionPoints: string[];
  permissions: string[];
  tools: PluginTool[];
  auditStatus: 'pending' | 'approved' | 'rejected' | string;
  enabled: boolean;
  isDefault: boolean;
  lastTestedAt: string | null;
  lastTestError: string;
};

export type PluginDetail = {
  id: string;
  /** 所属空间（公共空间 = 1） */
  spaceId?: number;
  releases: PluginPackage[];
  scenarios: { id: number; name: string; status: string; version: string; artifactHash: string }[];
  recentCalls: {
    sessionId: number;
    tool: string;
    version: string;
    outcome: string;
    elapsedMs: number;
    createdAt: string | null;
  }[];
};
