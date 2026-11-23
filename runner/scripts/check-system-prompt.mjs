#!/usr/bin/env node
/** 系统提示词拼装检查：渲染说明由 runner 统一追加，不依赖会话清单里的场景快照。 */
import assert from 'node:assert/strict';
import { buildSystemPrompt, codeGuide, RENDER_GUIDE, workspaceGuide } from '../src/kernel/system-prompt.ts';
import { sessionToolset, BASE_TOOLS, SEARCH_TOOLS } from '../src/kernel/toolset.ts';
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
// 全局输出风格：两条分支（结构化 / 兜底）都要拼入
assert.ok(s.includes('语气友好、表达简约'));
assert.ok(buildSystemPrompt(undefined).includes('语气友好、表达简约'));
// 工作区能力说明只描述实际可用的工具
const full = [...BASE_TOOLS, 'workspace_present', ...SEARCH_TOOLS];
const withTools = buildSystemPrompt({ identity: 'I' }, full);
assert.ok(withTools.includes('必须调用 workspace_write'));
assert.ok(withTools.includes('workspace_present'));
assert.ok(withTools.includes('glob 按文件名模式查找'));
assert.ok(withTools.includes('你可以调用 bash 执行受限的终端与 Git 命令'));
assert.ok(withTools.endsWith('不可声称执行了未实际调用的工具。'));
assert.ok(!buildSystemPrompt({ identity: 'I' }).includes('workspace_write'));
const readOnly = workspaceGuide(['current_time', 'workspace_list', 'workspace_read', 'glob', 'grep']);
assert.equal(readOnly.length, 1);
assert.ok(!readOnly.join('').includes('workspace_write'));
assert.deepEqual(workspaceGuide(['skill_read_draft']), []);

// 基础能力：只声明 current_time 的场景（如「通用助手」）也获得文件读写与搜索
const policy = { allowedTools: [...BASE_TOOLS] };
assert.deepEqual(sessionToolset({ tools: { builtin: ['current_time'] }, policy }), {
  allowed: [...BASE_TOOLS, 'workspace_present', ...SEARCH_TOOLS],
  search: true,
  code: false,
  read: false,
  skills: false,
  approval: [],
});
// 清单没有策略上限与场景工具时同样补齐
assert.deepEqual(sessionToolset().allowed, [...BASE_TOOLS, 'workspace_present', ...SEARCH_TOOLS]);
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
  sessionToolset({ policy, tools: { plugin: ['crm_find_customer'] } }).allowed.includes('crm_find_customer'),
);
// Skill 编辑会话的策略只含 skill_*：保持受限，不附加基础能力
const authoring = ['skill_read_draft', 'skill_update_draft'];
assert.deepEqual(sessionToolset({ tools: { builtin: authoring }, policy: { allowedTools: authoring } }), {
  allowed: authoring,
  search: false,
  code: false,
  read: false,
  skills: false,
  approval: [],
});
// 关联代码：与场景无关，关联了项目就开放只读的 glob/grep/read；
// 受控终端命令（bash）仍以平台策略为上限，策略未勾选时关联代码也不开放
const codeOnly = sessionToolset({ policy: { allowedTools: ['current_time'] } }, true);
assert.deepEqual(codeOnly, {
  allowed: ['current_time', 'glob', 'grep', 'read'],
  search: true,
  code: true,
  read: true,
  skills: false,
  approval: [],
});
const codeWithBash = sessionToolset({ policy: { allowedTools: ['current_time', 'bash'] } }, true);
assert.deepEqual(codeWithBash.allowed, ['current_time', 'bash', 'glob', 'grep', 'read']);
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
assert.ok(coded.includes('或通过 bash 执行只读 Git 命令'));
// 策略未开放 bash 时，关联代码说明不再引导模型调用 bash
const codedNoBash = buildSystemPrompt({ identity: 'I' }, ['current_time', 'glob', 'grep', 'read'], [project]);
assert.ok(codedNoBash.includes('## 关联代码（只读）'));
assert.ok(!codedNoBash.includes('bash'));
assert.ok(!withTools.includes('关联代码'));
assert.deepEqual(codeGuide([]), []);
console.log('system-prompt OK');
