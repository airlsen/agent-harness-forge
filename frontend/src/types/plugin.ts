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
  displayName: string;
  description: string;
  version: string;
  runtime: string;
  source: string;
  artifactHash: string;
  extensionPoints: string[];
  permissions: string[];
  tools: PluginTool[];
  auditStatus: 'pending' | 'approved' | 'rejected' | string;
  enabled: boolean;
};
