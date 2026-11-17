import { apiFetch } from './client';
import type { KernelEvent } from '../types/platform';

type Handlers = {
  kernel: (event: KernelEvent) => void;
  settled: () => void;
  open: () => void;
  error: () => void;
};
/** fetch SSE 支持预览会话请求头；不将任何会话令牌放进 EventSource 的 URL。 */
export function openEventStream(url: string, handlers: Handlers): { close: () => void } {
  const controller = new AbortController();
  let cursor = '';
  const pause = () =>
    new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, 1000);
      controller.signal.addEventListener('abort', finish, { once: true });
      if (controller.signal.aborted) finish();
    });
  const run = async () => {
    while (!controller.signal.aborted) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await apiFetch(url, {
          signal: controller.signal,
          headers: { Accept: 'text/event-stream', ...(cursor ? { 'Last-Event-ID': cursor } : {}) },
        });
        if (response.status === 401) return;
        if (!response.ok || !response.body) throw new Error('无法连接事件流');
        handlers.open();
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '',
          event = '',
          data: string[] = [],
          id = '';
        while (!controller.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let boundary: number;
          while ((boundary = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, boundary).replace(/\r$/, '');
            buffer = buffer.slice(boundary + 1);
            if (line === '') {
              if (event === 'kernel' && data.length) handlers.kernel(JSON.parse(data.join('\n')));
              if (/^\d+$/.test(id)) cursor = id;
              if (event === 'settled') {
                handlers.settled();
                return;
              }
              event = '';
              data = [];
              id = '';
            } else if (line.startsWith('event:')) event = line.slice(6).trimStart();
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
            else if (line.startsWith('id:')) id = line.slice(3).trim();
            if (controller.signal.aborted) return;
          }
        }
        if (!controller.signal.aborted) handlers.error();
      } catch {
        if (controller.signal.aborted) return;
        handlers.error();
      } finally {
        await reader?.cancel().catch(() => {});
      }
      if (!controller.signal.aborted) await pause();
    }
  };
  void run();
  return { close: () => controller.abort() };
}
