/**
 * Runner 内核对外的数据形状（服务端与控制面依赖它们，执行引擎实现细节不出现在这里）。
 * 执行引擎经 DSH 适配层（./dsh/）接入，见 docs/03-后端架构分析。
 */

export interface SessionHandle {
  sessionId: string;
  /** 当前清单的摘要（诊断用） */
  manifestHash: string;
  /** 执行日志当前的最后序号：控制面从这里之后订阅 */
  lastSeq: number;
}

export interface KernelEvent {
  /** 执行日志序号：持久事件递增；流式增量不占编号（取当前值） */
  seq: number;
  source: 'system' | 'llm' | 'tools' | 'agent' | 'ui';
  kind: string;
  payload: unknown;
  ts: number;
  /** 流式增量：只推给在线订阅者，不落盘、不参与续读与去重 */
  transient?: true;
}
