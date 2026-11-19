#!/usr/bin/env node
/** 系统提示词拼装检查：渲染说明由 runner 统一追加，不依赖场景 Bundle 快照。 */
import assert from 'node:assert/strict';
import { buildSystemPrompt, codeGuide, RENDER_GUIDE, workspaceGuide } from '../src/kernel/system-prompt.ts';
import { sessionToolset, BASE_TOOLS, SEARCH_TOOLS } from '../src/kernel/dsh-kernel.ts';
const s = buildSystemPrompt({
  identity: 'I',
  domain: 'D',
  safety: ['S'],
  workspace: ['W'],
  output: ['OLD-OUTPUT'],
});
assert.ok(s.startsWith('I\n\nD\n\nS\n\nW\n\n'));
assert.ok(RENDER_GUIDE.every((l) => s.includes(l)));
assert.ok(!s.includes('OLD-OUTPUT'));
assert.ok(s.endsWith('不可声称执行了未实际调用的工具。'));
assert.ok(buildSystemPrompt('custom').startsWith('custom\n\n'));
assert.ok(buildSystemPrompt(undefined).startsWith('你是 Forge 企业智能体'));
assert.ok(buildSystemPrompt(undefined).includes('mermaid'));
// 工作区能力说明只描述实际可用的工具
const full = [...BASE_TOOLS, 'workspace_present', ...SEARCH_TOOLS];
const withTools = buildSystemPrompt({ identity: 'I' }, full);
assert.ok(withTools.includes('必须调用 workspace_write'));
assert.ok(withTools.includes('workspace_present'));
assert.ok(withTools.includes('glob 按文件名模式查找'));
assert.ok(withTools.endsWith('不可声称执行了未实际调用的工具。'));
assert.ok(!buildSystemPrompt({ identity: 'I' }).includes('workspace_write'));
const readOnly = workspaceGuide(['current_time', 'workspace_list', 'workspace_read', 'glob', 'grep']);
assert.equal(readOnly.length, 1);
assert.ok(!readOnly.join('').includes('workspace_write'));
assert.deepEqual(workspaceGuide(['skill_read_draft']), []);

// 基础能力：只声明 current_time 的场景（如「通用助手」）也获得文件读写与搜索
const policy = { allowedTools: [...BASE_TOOLS] };
assert.deepEqual(sessionToolset({ builtin_tools: ['current_time'], policy }), {
  allowed: [...BASE_TOOLS, 'workspace_present', ...SEARCH_TOOLS],
  search: true,
  code: false,
  read: false,
  skills: false,
  approval: [],
});
// 旧 Bundle 没有 policy/builtin_tools 时同样补齐
assert.deepEqual(sessionToolset(undefined).allowed, [...BASE_TOOLS, 'workspace_present', ...SEARCH_TOOLS]);
// 平台策略仍是上限：关闭写入 → 无交付声明；关闭读取 → 不加载搜索插件
const noWrite = sessionToolset({
  policy: { allowedTools: ['current_time', 'workspace_list', 'workspace_read'] },
});
assert.ok(!noWrite.allowed.includes('workspace_write') && !noWrite.allowed.includes('workspace_present'));
assert.ok(noWrite.search && noWrite.allowed.includes('grep'));
const noRead = sessionToolset({ policy: { allowedTools: ['current_time', 'workspace_write'] } });
assert.equal(noRead.search, false);
assert.ok(!noRead.allowed.includes('grep') && noRead.allowed.includes('workspace_present'));
// 受管插件工具由控制面筛选，不再被内置工具策略误过滤
assert.ok(
  sessionToolset({ policy, plugin_tools: ['crm_find_customer'] }).allowed.includes('crm_find_customer'),
);
// Skill 编辑会话的策略只含 skill_*：保持受限，不附加基础能力
const authoring = ['skill_read_draft', 'skill_update_draft'];
assert.deepEqual(sessionToolset({ builtin_tools: authoring, policy: { allowedTools: authoring } }), {
  allowed: authoring,
  search: false,
  code: false,
  read: false,
  skills: false,
  approval: [],
});
// 关联代码：与场景、策略无关，关联了项目就开放 glob/grep/read（只读）
const codeOnly = sessionToolset({ policy: { allowedTools: ['current_time'] } }, true);
assert.deepEqual(codeOnly, {
  allowed: ['current_time', 'glob', 'grep', 'read'],
  search: true,
  code: true,
  read: true,
  skills: false,
  approval: [],
});
const project = {
  name: 'forge',
  path: '/usr/data/git/forge',
  branch: 'main',
  commit: 'abc123',
  overview: '顶层：src/',
};
const coded = buildSystemPrompt({ identity: 'I' }, [...full, 'read'], [project]);
assert.ok(coded.includes('## 关联代码（只读）'));
assert.ok(coded.includes('### forge → /usr/data/git/forge（git main@abc123）'));
assert.ok(coded.includes('顶层：src/'));
assert.ok(coded.includes('关联的代码项目只读'));
assert.ok(coded.endsWith('不可声称执行了未实际调用的工具。'));
assert.ok(!withTools.includes('关联代码'));
assert.deepEqual(codeGuide([]), []);
console.log('system-prompt OK');
