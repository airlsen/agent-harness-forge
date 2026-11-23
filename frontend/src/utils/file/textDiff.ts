import { diffArrays, diffChars, diffWords, type Change } from 'diff';

/**
 * 前端文本对比（Skill 修改前后等）：逐行对比，配对的删除/新增行再做词级对比，
 * 远离改动的未改动行折叠。样式与工作台「本轮改动」的 diff 表格一致。
 */
export type DiffRowKind = 'context' | 'add' | 'remove';
export interface DiffSegment {
  text: string;
  /** 这一段在本行内被改动（词级高亮） */
  changed: boolean;
}
export interface DiffRow {
  kind: DiffRowKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
  /** 与相邻的删除/新增行配对时的词级分段；整行都变了（或无法配对）时省略 */
  segments?: DiffSegment[];
}
export type DiffBlock = { type: 'rows'; rows: DiffRow[] } | { type: 'fold'; rows: DiffRow[] };
export interface TextDiffResult {
  rows: DiffRow[];
  added: number;
  removed: number;
}
/** 左右并排的一行：任一侧可以为空（对侧是纯新增或纯删除） */
export interface SplitRow {
  left: DiffRow | null;
  right: DiffRow | null;
}

/** 改动行前后保留的未改动行数 */
export const DIFF_CONTEXT = 3;
/** 连续未改动行少于这个数时不折叠（折叠后只省一两行反而更难读） */
const MIN_FOLD = 4;
/** 行级对比的编辑距离上限：超过时退化为「整段删除 + 整段新增」，避免大文件卡住页面 */
const MAX_EDIT_LENGTH = 5000;
/** 词级对比只做在不太长的行上 */
const MAX_WORD_DIFF_LENGTH = 4000;
/** 一行里超过这个比例都变了，就不再做词级高亮（满屏碎片反而更难读） */
const MAX_CHANGED_RATIO = 0.6;

export function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  if (!normalized) return [];
  const lines = normalized.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

let segmenter: Intl.Segmenter | null | undefined;
function wordSegmenter() {
  if (segmenter === undefined) {
    try {
      // 中文没有空格分词：用浏览器内置的分词器按词切分，不支持时退回逐字对比
      segmenter =
        typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh', { granularity: 'word' }) : null;
    } catch {
      segmenter = null;
    }
  }
  return segmenter;
}

/** 一对删除/新增行的词级分段；改动过多时返回 null（整行高亮即可） */
export function wordSegments(
  before: string,
  after: string,
): { before: DiffSegment[]; after: DiffSegment[] } | null {
  if (!before || !after || before.length + after.length > MAX_WORD_DIFF_LENGTH) return null;
  const seg = wordSegmenter();
  const changes: Change[] = seg ? diffWords(before, after, { intlSegmenter: seg }) : diffChars(before, after);
  let changed = 0;
  const left: DiffSegment[] = [];
  const right: DiffSegment[] = [];
  for (const change of changes) {
    if (change.added) {
      changed += change.value.length;
      right.push({ text: change.value, changed: true });
    } else if (change.removed) {
      changed += change.value.length;
      left.push({ text: change.value, changed: true });
    } else {
      left.push({ text: change.value, changed: false });
      right.push({ text: change.value, changed: false });
    }
  }
  if (!changed || changed / (before.length + after.length) > MAX_CHANGED_RATIO) return null;
  return { before: merge(left), after: merge(right) };
}

function merge(segments: DiffSegment[]) {
  const out: DiffSegment[] = [];
  for (const segment of segments) {
    const last = out.at(-1);
    if (last && last.changed === segment.changed) last.text += segment.text;
    else if (segment.text) out.push({ ...segment });
  }
  return out;
}

export function diffText(before: string, after: string): TextDiffResult {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const changes = diffArrays(oldLines, newLines, { maxEditLength: MAX_EDIT_LENGTH }) ?? [
    ...(oldLines.length ? [{ value: oldLines, count: oldLines.length, added: false, removed: true }] : []),
    ...(newLines.length ? [{ value: newLines, count: newLines.length, added: true, removed: false }] : []),
  ];
  const rows: DiffRow[] = [];
  let oldLine = 1;
  let newLine = 1;
  let added = 0;
  let removed = 0;
  for (let index = 0; index < changes.length; index++) {
    const change = changes[index]!;
    if (!change.added && !change.removed) {
      for (const text of change.value)
        rows.push({ kind: 'context', oldLine: oldLine++, newLine: newLine++, text });
      continue;
    }
    // 删除块紧跟新增块：按位置配对，配对的两行做词级对比
    const removedLines = change.removed ? change.value : [];
    const next = change.removed ? changes[index + 1] : undefined;
    const addedLines = change.added ? change.value : next?.added ? next.value : [];
    if (change.removed && next?.added) index++;
    const removeRows: DiffRow[] = removedLines.map((text) => ({
      kind: 'remove',
      oldLine: oldLine++,
      newLine: null,
      text,
    }));
    const addRows: DiffRow[] = addedLines.map((text) => ({
      kind: 'add',
      oldLine: null,
      newLine: newLine++,
      text,
    }));
    for (let pair = 0; pair < Math.min(removeRows.length, addRows.length); pair++) {
      const segments = wordSegments(removeRows[pair]!.text, addRows[pair]!.text);
      if (segments) {
        removeRows[pair]!.segments = segments.before;
        addRows[pair]!.segments = segments.after;
      }
    }
    removed += removeRows.length;
    added += addRows.length;
    rows.push(...removeRows, ...addRows);
  }
  return { rows, added, removed };
}

/** 远离改动的未改动行折叠成块；没有任何改动时返回空列表 */
export function foldRows(rows: DiffRow[], context = DIFF_CONTEXT): DiffBlock[] {
  const changed = rows
    .map((row, index) => (row.kind === 'context' ? -1 : index))
    .filter((index) => index >= 0);
  if (!changed.length) return [];
  const keep = new Array<boolean>(rows.length).fill(false);
  for (const index of changed)
    for (let near = Math.max(0, index - context); near <= Math.min(rows.length - 1, index + context); near++)
      keep[near] = true;
  const blocks: DiffBlock[] = [];
  let start = 0;
  while (start < rows.length) {
    let end = start;
    while (end < rows.length && keep[end] === keep[start]) end++;
    const slice = rows.slice(start, end);
    if (!keep[start] && slice.length >= MIN_FOLD) blocks.push({ type: 'fold', rows: slice });
    else {
      const last = blocks.at(-1);
      if (last?.type === 'rows') last.rows.push(...slice);
      else blocks.push({ type: 'rows', rows: slice });
    }
    start = end;
  }
  return blocks;
}

/** 左右并排：未改动行两侧相同，连续的删除/新增行左右按位置对齐 */
export function splitRows(rows: DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index]!;
    if (row.kind === 'context') {
      out.push({ left: row, right: row });
      index++;
      continue;
    }
    const removes: DiffRow[] = [];
    const adds: DiffRow[] = [];
    while (rows[index]?.kind === 'remove') removes.push(rows[index++]!);
    while (rows[index]?.kind === 'add') adds.push(rows[index++]!);
    for (let pair = 0; pair < Math.max(removes.length, adds.length); pair++)
      out.push({ left: removes[pair] ?? null, right: adds[pair] ?? null });
  }
  return out;
}
