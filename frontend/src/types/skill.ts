export type SkillStatus = 'draft' | 'published';

export type SkillReference = {
  filename: string;
  path: string;
  bytes: number;
};

export type SkillSummary = {
  id: number;
  name: string;
  machineName: string;
  publishedMachineName: string;
  publishedName: string;
  publishedDescription: string;
  publishedReferenceCount: number;
  description: string;
  status: SkillStatus;
  tags: string[];
  currentRevisionId: number | null;
  publishedRevisionId: number | null;
  publishedVersion: number | null;
  revision: number | null;
  content: string;
  changeSummary: string;
  referenceFiles: SkillReference[];
  createdAt: string | null;
  updatedAt: string | null;
};

export type SkillDetail = SkillSummary;

export type SkillRevision = {
  id: number;
  revision: number;
  publishedVersion: number | null;
  content: string;
  contentHash: string;
  changeSummary: string;
  source: 'manual' | 'assistant' | 'publish' | 'restore' | string;
  referenceFiles: SkillReference[];
  createdBy: string;
  createdAt: string | null;
};

export type SkillAuthoringMessage = {
  id: number | string;
  role: 'user' | 'assistant' | 'system' | string;
  content: string;
  createdAt?: string | null;
};

export type SkillAuthoringSession = {
  id: number;
  messages: SkillAuthoringMessage[];
};
