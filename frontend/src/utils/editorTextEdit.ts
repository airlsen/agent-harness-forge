/** 只替换发生变化的区间，保留其他文本的标记和编辑历史。偏移量与 Monaco 一样使用 UTF-16。 */
export function minimalTextEdit(before: string, after: string) {
  if (before === after) return null;
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let end = before.length;
  let nextEnd = after.length;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  return { start, end, text: after.slice(start, nextEnd) };
}
