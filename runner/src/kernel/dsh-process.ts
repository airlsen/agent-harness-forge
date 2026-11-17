/** dsh sdk-minimal 子进程 + 换行 JSON-RPC。控制面不直接依赖此协议。 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface DshSpawnOptions {
  binPath: string;
  profile: string;
  patchPaths: string[];
  env?: NodeJS.ProcessEnv;
  rawFrameSink?: (direction: 'out' | 'in', frame: unknown) => void;
}
export class DshProcess {
  private child: ChildProcess | null = null;
  private seq = 0;
  private rawFrameSink?: DshSpawnOptions['rawFrameSink'];
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private notificationHandlers: Array<(method: string, params: any) => void> = [];
  hostHandlers = new Map<string, (params: any) => Promise<unknown> | unknown>();

  async start(opts: DshSpawnOptions): Promise<void> {
    if (this.child) throw new Error('dsh is already started');
    this.rawFrameSink = opts.rawFrameSink;
    const args = [opts.binPath, '--profile', opts.profile];
    for (const p of opts.patchPaths) args.push('--patch', p);
    // 显式复用当前 Node，避免子进程 shebang 意外落回系统旧版 Node。
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.child = child;
    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => this.onLine(line));
    const fail = (err: Error) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      if (this.child === child) this.child = null;
    };
    child.once('error', fail);
    child.once('exit', (code) => {
      rl.close();
      fail(new Error(`dsh exited with code ${code}`));
    });
  }
  private onLine(line: string) {
    let frame: any;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    this.rawFrameSink?.('in', frame);
    if ('id' in frame && 'method' in frame) {
      const handler = this.hostHandlers.get(frame.method);
      const child = this.child;
      // 中止时可能仍有审批 promise 正在结算；不能向已关闭或下一代进程回写。
      const reply = (value: unknown) => {
        if (this.child !== child || !child?.stdin?.writable) return;
        try {
          this.send(value);
        } catch {
          /* 进程已退出，原请求不再有效。 */
        }
      };
      const respond = async () => {
        try {
          if (!handler) {
            reply({
              jsonrpc: '2.0',
              id: frame.id,
              error: { code: -32601, message: 'Host method not supported' },
            });
            return;
          }
          const result = await handler(frame.params);
          reply({ jsonrpc: '2.0', id: frame.id, result });
        } catch (e) {
          reply({ jsonrpc: '2.0', id: frame.id, error: { code: -32603, message: String(e) } });
        }
      };
      void respond();
    } else if ('id' in frame) {
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      if (frame.error) p.reject(new Error(frame.error.message ?? 'jsonrpc error'));
      else p.resolve(frame.result);
    } else if ('method' in frame) {
      for (const h of this.notificationHandlers) h(frame.method, frame.params);
    }
  }
  private send(frame: unknown) {
    if (!this.child?.stdin?.writable) throw new Error('dsh process is not writable');
    this.rawFrameSink?.('out', frame);
    this.child.stdin.write(JSON.stringify(frame) + '\n');
  }
  request<T = any>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as any, reject });
      try {
        this.send({ jsonrpc: '2.0', method, id, params });
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  onNotification(handler: (method: string, params: any) => void): () => void {
    this.notificationHandlers.push(handler);
    return () => {
      const i = this.notificationHandlers.indexOf(handler);
      if (i >= 0) this.notificationHandlers.splice(i, 1);
    };
  }
  async dispose(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 1500);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
}
