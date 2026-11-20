import { createHmac, randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export class PluginWorkerClient {
  private constructor(
    private readonly child: ChildProcess,
    private readonly secret: string,
    readonly url: string,
  ) {}

  static async start(): Promise<PluginWorkerClient> {
    const secret = randomBytes(32).toString('base64url');
    const workerPath = fileURLToPath(new URL('./plugin-worker.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', workerPath], {
      // Do not inherit Runner/model environment variables into the business adapter process.
      env: {
        PATH: process.env.PATH ?? '',
        NODE_PATH: process.env.NODE_PATH,
        FORGE_PLUGIN_WORKER_SECRET: secret,
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => /^FORGE_PLUGIN_AUTH_[A-Z0-9_]+$/.test(key)),
        ),
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const port = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('managed plugin worker did not become ready')), 5000);
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      child.once('error', fail);
      child.once('exit', (code) => fail(new Error(`managed plugin worker exited with code ${code}`)));
      const lines = createInterface({ input: child.stdout! });
      lines.on('line', (line) => {
        try {
          const message = JSON.parse(line);
          if (message?.type === 'forge-plugin-worker-ready' && /^\d+$/.test(String(message.port))) {
            clearTimeout(timer);
            lines.close();
            resolve(String(message.port));
          }
        } catch {
          // The worker only writes a readiness JSON record; ignore malformed early output defensively.
        }
      });
    });
    return new PluginWorkerClient(child, secret, `http://127.0.0.1:${port}`);
  }

  issueLease(sessionId: string, bindings: unknown[] = []): string {
    // Bind the lease to exact versions, tool names and remote execution metadata.
    // The DSH child receives only this opaque signed value, never a long-lived worker secret.
    const encoded = Buffer.from(
      JSON.stringify({ sessionId, expiresAt: Date.now() + 30 * 60 * 1000, bindings }),
    ).toString('base64url');
    const signature = createHmac('sha256', this.secret).update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
  }

  async test(binding: Record<string, unknown>, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`${this.url}/v1/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lease: this.issueLease('plugin-test', [binding]),
        binding: {
          package: binding.package,
          version: binding.version,
          artifactHash: binding.artifactHash,
          runtime: binding.runtime,
        },
        tool,
        arguments: args,
      }),
    });
    const body = (await response.json()) as { result?: unknown; message?: string };
    if (!response.ok) throw new Error(body.message ?? '插件试运行失败');
    return body.result;
  }

  async dispose(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        resolve();
      }, 1500);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.kill('SIGTERM');
    });
  }
}
