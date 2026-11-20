/** 展示名称 title 与机器标识 name 分离，所有修改保留其他 YAML 字段。 */
import { parseDocument, stringify, isMap } from 'yaml';

export function readSkillDocument(content: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) throw new Error('文档需要有效的 YAML 元信息（---）。');
  const doc = parseDocument(match[1]!);
  if (doc.errors.length || !isMap(doc.contents)) throw new Error('技能元信息不是有效的 YAML 对象。');
  const data = doc.toJS() as Record<string, unknown>;
  if (typeof data.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(data.name))
    throw new Error('技能标识需为英文、数字、点、下划线或连字符，最多 64 位。');
  if (typeof data.description !== 'string' || !data.description.trim() || data.description.length > 512)
    throw new Error('用途说明应为 1–512 个字符。');
  if (
    data.title !== undefined &&
    (typeof data.title !== 'string' || !data.title.trim() || data.title.length > 120)
  )
    throw new Error('展示名称应为 1–120 个字符。');
  return { doc, data, body: content.slice(match[0].length) };
}
export function updateSkillMetadata(content: string, title: string, description: string, name: string) {
  const { doc, body } = readSkillDocument(content);
  doc.set('title', title.trim());
  doc.set('name', name.trim());
  doc.set('description', description.trim());
  const result = `---\n${doc.toString()}---\n${body}`;
  readSkillDocument(result);
  return result;
}
export function initialSkillDocument(title = '未命名技能') {
  return `---\n${stringify({ name: 'my-skill', title, description: '待补充技能用途' })}---\n\n# ${title}\n\n## 目标\n\n## 工作步骤\n\n## 输出要求\n`;
}
