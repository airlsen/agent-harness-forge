/**
 * 场景 API（沿用旧 claude-scenario.ts 五接口形态 + 试运行）。
 */
import type { Scenario, ScenarioPayload } from '../types/agent'

const BASE = '/api/agent-scenarios'

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  const body = (await res.json()) as { code: number; message: string; data: T }
  if (body.code !== 0) throw new Error(body.message)
  return body.data
}

export const listScenarios = () => http<Scenario[]>(BASE)
export const createScenario = (p: ScenarioPayload) =>
  http<Scenario>(BASE, { method: 'POST', body: JSON.stringify(p) })
export const updateScenario = (id: number, p: ScenarioPayload) =>
  http<void>(`${BASE}/${id}`, { method: 'PUT', body: JSON.stringify(p) })
export const removeScenario = (id: number) => http<void>(`${BASE}/${id}`, { method: 'DELETE' })

/** AI 生成草稿（不落库）：后端走 dsh Creative 模式会话 */
export const generateScenario = (description: string) =>
  http<ScenarioPayload>(`${BASE}/generate`, { method: 'POST', body: JSON.stringify({ description }) })

/** 试运行（质量红线：跑通一次才允许保存/发布） */
export const runTestScenario = (id: number) =>
  http<{ ok: boolean; summary: string }>(`${BASE}/${id}/run-test`, { method: 'POST' })
