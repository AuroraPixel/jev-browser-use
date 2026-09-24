import type { CheckpointCheck, Observation, PageCheckpoint } from "./types.ts";

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/** Pure evaluator: positive visible evidence only, no code supplied by the model.
 * Unrelated animation is irrelevant; loading/partial observations fail closed. */
export function evaluateCheckpoint(contract: PageCheckpoint, page: Observation): { matched: boolean; checks: CheckpointCheck[] } {
  const checks: CheckpointCheck[] = [];
  checks.push({ condition: "page_ready", matched: !page.loading && !page.truncated && !page.unsupportedFrames });
  for (const field of page.pendingSelections ?? []) checks.push({ condition: `selection:${field.label}`, matched: false });
  if (contract.url) {
    const actual = new URL(page.url);
    checks.push({ condition: "url.origin", matched: actual.origin === contract.url.origin, actual: actual.origin });
    if (contract.url.pathname !== undefined) checks.push({ condition: "url.pathname", matched: actual.pathname === contract.url.pathname, actual: actual.pathname });
    if (contract.url.pathnameIncludes !== undefined) checks.push({ condition: "url.pathnameIncludes", matched: actual.pathname.includes(contract.url.pathnameIncludes), actual: actual.pathname });
  }
  const prose = (text: string) => contract.matchCase ? normalize(text) : normalize(text).toLowerCase();
  for (const text of contract.text ?? []) checks.push({ condition: `text:${text}`, matched: prose(page.text).includes(prose(text)) });
  for (const row of contract.rows ?? []) checks.push({ condition: `row:${row.text.join(" | ")}`,
    matched: (page.rows ?? []).some(actual => row.text.every(text => prose(actual).includes(prose(text)))) });
  for (const field of contract.fields ?? []) {
    const matches = page.elements.filter(e => normalize(e.label) === field.label && (!field.role || e.role === field.role) &&
      (!field.contextIncludes || normalize(e.context).includes(field.contextIncludes)));
    checks.push({ condition: `unique_field:${field.label}`, matched: matches.length === 1 });
    for (const key of ["value", "checked", "selected"] as const) if (field[key] !== undefined) {
      const actual = matches.length === 1 ? matches[0]![key] : undefined;
      checks.push({ condition: `${field.label}.${key}`, matched: matches.length === 1 && actual === field[key], actual });
    }
  }
  return { matched: checks.every(c => c.matched), checks };
}
