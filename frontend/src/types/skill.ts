export type SkillStatus = 'draft' | 'published';

/** SKILL.md 之外的附加文件：references/、assets/ 下的一层文件 */
export type SkillFile = {
  path: string;
  bytes: number;
  /** manual：维护者上传或编辑；agent：Skill 助手写入 */
  source: 'manual' | 'agent' | 'restore' | string;
};

export type SkillSummary = {
  id: number;
  name: string;
  machineName: string;
  publishedMachineName: string;
  publishedName: string;
  publishedDescription: string;
  publishedFileCount: number;
  description: string;
  status: SkillStatus;
  tags: string[];
  currentRevisionId: number | null;
  publishedRevisionId: number | null;
  publishedVersion: number | null;
  /** 发布过、但当前没有上线版本（已下线）：可以重新发布或删除 */
  offline?: boolean;
  /** 最近一次发布的版本号（下线后仍保留）；从未发布为 null */
  lastPublishedVersion?: number | null;
  revision: number | null;
  content: string;
  changeSummary: string;
  files: SkillFile[];
  createdAt: string | null;
  updatedAt: string | null;
  publishedAt: string | null;
};

export type SkillDetail = SkillSummary;

export type PublishedSkillSummary = {
  id: number;
  name: string;
  machineName: string;
  description: string;
  version: number;
  fileCount: number;
  publishedAt: string | null;
};

export type PublishedSkillDetail = Omit<PublishedSkillSummary, 'fileCount'> & {
  content: string;
  files: SkillFile[];
};

export type SkillRevision = {
  id: number;
  revision: number;
  publishedVersion: number | null;
  content: string;
  contentHash: string;
  changeSummary: string;
  source: 'manual' | 'assistant' | 'publish' | 'restore' | string;
  files: SkillFile[];
  createdBy: string;
  createdAt: string | null;
};

export type SkillAuthoringMessage = {
  id: number | string;
  role: 'user' | 'assistant' | 'system' | string;
  content: string;
  /** 与工作台消息一致：assistant 含 reasoning / partial，tool 含 toolCallId / tool / arguments / isError / revision */
  meta?: Record<string, any>;
  createdAt?: string | null;
};

export type SkillAuthoringSession = {
  id: number;
  messages: SkillAuthoringMessage[];
};

/** 正在使用某个 Skill 的场景（下线、删除前确认用） */
export type SkillUsageScenario = {
  id: number;
  name: string;
  space: string;
  /** 场景已发布的版本在用 */
  published: boolean;
  /** 场景当前配置在用 */
  draft: boolean;
};
