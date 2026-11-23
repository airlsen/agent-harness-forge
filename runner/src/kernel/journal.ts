/**
 * 会话执行日志（Runner 侧事件账本）：一轮的事件先写进这里，再推给订阅者。
 *
 * - 持久事件按 seq 递增编号，同步追加到 DATA/<id>/events.jsonl：控制面断线、重启后按 seq 续读
 *   （GET /v1/sessions/:id/events?after=seq），Runner 自己重启后仍能补读重启前已产生的事件。
 * - 流式增量（message_delta / reasoning_delta）只推给在线订阅者，不落盘、不占编号（seq 取当前值）：
 *   断线期间漏掉的增量由随后的完整 message 兜底，续读时不会重复或错位。
 * - 控制面落库后回执（ack）：已回执的事件从日志中移除，日志只保留尚未确认的部分（另有条数上限兜底）。
 * - seq 高水位记在 events.meta.json：事件全部回执清空后，新事件也不会复用旧编号。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KernelEvent } from './types.js';

const LOG = 'events.jsonl';
const META = 'events.meta.json';
/** 未回执事件的保留上限（内存与磁盘一致）：控制面长期不回执时只保留最新的这些 */
export const MAX_JOURNAL_EVENTS = 20000;
/** 只推给在线订阅者、不落盘不编号的流式事件 */
export const TRANSIENT_KINDS = new Set(['message_delta', 'reasoning_delta']);

export class EventJournal {
  private events: KernelEvent[] = [];
  private acked = 0;
  private seq = 0;
  /** 日志文件当前行数：控制面长期不回执时，超过上限两倍即压缩一次，文件不会无限增长 */
  private lines = 0;
  private constructor(private readonly dir: string) {}

  /** 打开会话日志（不存在时为空）；只读场景（Runner 未加载该会话）同样用它读取 */
  static open(dir: string): EventJournal {
    const journal = new EventJournal(dir);
    try {
      const meta = JSON.parse(readFileSync(join(dir, META), 'utf8'));
      journal.acked = Number.isSafeInteger(meta.acked) ? meta.acked : 0;
      journal.seq = Number.isSafeInteger(meta.lastSeq) ? meta.lastSeq : 0;
    } catch {
      /* 没有元数据：新会话或旧版本 Runner 的会话 */
    }
    let damaged = false;
    if (existsSync(join(dir, LOG))) {
      const text = readFileSync(join(dir, LOG), 'utf8');
      // 进程在写一行的中途退出：末尾没有换行的半行丢弃，之前的事件仍然有效
      damaged = text.length > 0 && !text.endsWith('\n');
      for (const line of text.split('\n')) {
        if (!line) continue;
        journal.lines++;
        try {
          const event = JSON.parse(line) as KernelEvent;
          if (event.seq > journal.acked) journal.events.push(event);
          journal.seq = Math.max(journal.seq, event.seq);
        } catch {
          damaged = true;
        }
      }
    }
    if (journal.events.length > MAX_JOURNAL_EVENTS)
      journal.events = journal.events.slice(-MAX_JOURNAL_EVENTS);
    // 修复损坏的日志：否则下一条事件会接在半行后面，一起变成无法解析的一行
    if (damaged) journal.compact();
    return journal;
  }
  static exists(dir: string) {
    return existsSync(join(dir, LOG)) || existsSync(join(dir, META));
  }
  /** 最后一个持久事件的 seq */
  get lastSeq() {
    return this.seq;
  }
  /** 记录一条事件并返回（持久事件同步落盘：进程崩溃时已返回的事件不会丢） */
  append(kind: string, payload: unknown, source: KernelEvent['source']): KernelEvent {
    if (TRANSIENT_KINDS.has(kind))
      return { seq: this.seq, kind, payload, source, ts: Date.now(), transient: true };
    const event: KernelEvent = { seq: this.seq + 1, kind, payload, source, ts: Date.now() };
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(this.dir, LOG), JSON.stringify(event) + '\n', { mode: 0o600 });
    this.seq = event.seq;
    this.events.push(event);
    if (this.events.length > MAX_JOURNAL_EVENTS) this.events.shift();
    if (++this.lines > 2 * MAX_JOURNAL_EVENTS) this.compact();
    return event;
  }
  /** seq 之后的持久事件（不含流式增量） */
  after(seq: number): KernelEvent[] {
    if (!this.events.length || this.events[this.events.length - 1].seq <= seq) return [];
    const start = this.events.findIndex((event) => event.seq > seq);
    return this.events.slice(start);
  }
  /** 控制面已落库到 seq：移除已确认的事件并压缩日志文件 */
  ack(seq: number) {
    const acked = Math.min(Math.max(this.acked, Math.floor(seq)), this.seq);
    if (acked === this.acked) return;
    this.acked = acked;
    this.events = this.events.filter((event) => event.seq > acked);
    this.compact();
  }
  /** 重写日志只保留未确认事件（先写临时文件再改名，中途退出不会损坏原日志） */
  private compact() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const log = join(this.dir, LOG);
    const lines = this.events.map((event) => JSON.stringify(event) + '\n').join('');
    writeFileSync(log + '.tmp', lines, { mode: 0o600 });
    writeFileSync(join(this.dir, META), JSON.stringify({ lastSeq: this.seq, acked: this.acked }), {
      mode: 0o600,
    });
    renameSync(log + '.tmp', log);
    this.lines = this.events.length;
  }
}
