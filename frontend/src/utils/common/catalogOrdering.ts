import type { Scenario } from '../../types/platform';
import type { SkillSummary, PublishedSkillSummary } from '../../types/skill';
import { formatDate } from './format';

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** Known dates first; IDs descending make equal or unavailable timestamps stable. */
function newest(a: string | null | undefined, b: string | null | undefined, idA: number, idB: number) {
  const left = timestamp(a);
  const right = timestamp(b);
  if (left === null && right !== null) return 1;
  if (left !== null && right === null) return -1;
  if (left !== null && right !== null && left !== right) return right - left;
  return idB - idA;
}

export function scenarioPublished(scenario: Scenario) {
  return scenario.published_version > 0 || scenario.status === 'published';
}

export function orderScenarios(items: Scenario[]): Scenario[] {
  return [...items].sort((a, b) => {
    // Presets have no release event: keep their familiar fixed ID order after enterprise scenes.
    if (a.space === 'official' || b.space === 'official') {
      if (a.space !== b.space) return a.space === 'official' ? 1 : -1;
      return a.id - b.id;
    }
    return newest(
      scenarioPublished(a) ? a.publishedAt : a.createdAt,
      scenarioPublished(b) ? b.publishedAt : b.createdAt,
      a.id,
      b.id,
    );
  });
}

export function orderManagedSkills(items: SkillSummary[]): SkillSummary[] {
  return [...items].sort((a, b) =>
    newest(
      a.publishedRevisionId != null ? a.publishedAt : a.createdAt,
      b.publishedRevisionId != null ? b.publishedAt : b.createdAt,
      a.id,
      b.id,
    ),
  );
}

export function orderPublishedSkills(items: PublishedSkillSummary[]): PublishedSkillSummary[] {
  return [...items].sort((a, b) => newest(a.publishedAt, b.publishedAt, a.id, b.id));
}

export function orderByCreated<T extends { id: number; createdAt?: string | null }>(items: T[]): T[] {
  return [...items].sort((a, b) => newest(a.createdAt, b.createdAt, a.id, b.id));
}

export function catalogDate(label: string, value: string | null | undefined): string {
  return timestamp(value) === null ? `${label}日期未知` : `${label}于 ${formatDate(value!)}`;
}
