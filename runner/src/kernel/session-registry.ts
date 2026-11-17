/**
 * SessionRegistry：session_id ↔ dsh session 的进程内注册表。
 *  - 容量上限 N（默认 20，M0 压测校准）
 *  - 会话级互斥锁串行化 turn（吸收旧 ClientPool 思想）
 *  - 空闲回收由控制面调度（Runner 上报占用率供 HPA）
 */
export class SessionRegistry {
  private sessions = new Map<string, { lock: Promise<void>; idleSince: number }>();

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.sessions.size;
  }

  canAccept(): boolean {
    return this.sessions.size < this.capacity;
  }

  /** 会话级串行化：同会话同一时刻只允许一个 turn（对齐旧 asyncio.Lock 语义） */
  async withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const entry = this.sessions.get(sessionId) ?? { lock: Promise.resolve(), idleSince: 0 };
    this.sessions.set(sessionId, entry);
    const run = entry.lock.then(fn);
    entry.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
