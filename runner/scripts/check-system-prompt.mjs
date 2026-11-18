#!/usr/bin/env node
/** 系统提示词拼装检查：渲染说明由 runner 统一追加，不依赖场景 Bundle 快照。 */
import assert from 'node:assert/strict';
import { buildSystemPrompt, RENDER_GUIDE } from '../src/kernel/system-prompt.ts';
const s = buildSystemPrompt({ identity: 'I', domain: 'D', safety: ['S'], workspace: ['W'], output: ['OLD-OUTPUT'] });
assert.ok(s.startsWith('I\n\nD\n\nS\n\nW\n\n'));
assert.ok(RENDER_GUIDE.every((l) => s.includes(l)));
assert.ok(!s.includes('OLD-OUTPUT'));
assert.ok(s.endsWith('不可声称执行了未实际调用的工具。'));
assert.ok(buildSystemPrompt('custom').startsWith('custom\n\n'));
assert.ok(buildSystemPrompt(undefined).startsWith('你是 Forge 企业智能体'));
assert.ok(buildSystemPrompt(undefined).includes('mermaid'));
console.log('system-prompt OK');
