import { parseCheckpoint, type PageCheckpoint } from "./types.ts";

/** Host-authored semantic identities. Reuse is explicit: never cache a relative
 * judgment such as "cheapest", "first unread" or "currently empty". */
export interface PlanTarget {
  description?: string;
  label?: string;
  role?: string;
  contextIncludes?: string;
  href?: string;
  reuse?: boolean;
}
export type PlanAction =
  | { operation: "TYPE_TEXT"; target: string; text?: string }
  | { operation: "SELECT"; target: string; option: { label?: string; value?: string } }
  | { operation: "CLICK"; target: string; checked?: boolean };
export interface PlanStage {
  id: string;
  goal: string;
  before?: PageCheckpoint;
  until?: PageCheckpoint;
  action?: PlanAction;
  /** Wait for evidence locally, without asking Jev to poll a loading page. */
  wait?: boolean;
  timeoutMs?: number;
  /** Defaults to the following stage; null ends the plan. */
  next?: string | null;
  /** Evaluated in order AFTER this stage's completion evidence is satisfied. */
  branches?: Array<{ when: PageCheckpoint; next: string | null }>;
}
export interface BrowserPlan {
  origins: string[];
  targets: Record<string, PlanTarget>;
  stages: PlanStage[];
  start?: string;
}
export interface RoutingPolicy {
  minConfidence?: number;
  minTargetConfidence?: number;
}
export interface PlanProgress {
  stage?: string;
  stageGoal?: string;
  completed: string[];
  transitions: number;
  localActions: number;
  bindingHits: number;
  bindingInvalidations: number;
  modelCalls: number;
  confidenceHandoffs: number;
  waitingForEvidence: boolean;
}

function obj(value: unknown, keys: string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(k => !keys.includes(k))) throw new TypeError("Invalid " + name);
  return value as Record<string, unknown>;
}
function str(value: unknown, name: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError("Invalid " + name);
  return value;
}
function normalized(value: unknown, name: string): string { return str(value, name).replace(/\s+/g, " ").trim(); }
function id(value: unknown): string {
  const s = str(value, "plan identifier", 64);
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s) || ["__proto__", "constructor", "prototype"].includes(s)) throw new TypeError("Invalid plan identifier");
  return s;
}
function next(value: unknown): string | null { return value === null ? null : id(value); }
export function parseRouting(value: unknown): RoutingPolicy {
  const r = obj(value, ["minConfidence", "minTargetConfidence"], "routing");
  for (const v of Object.values(r)) if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) throw new TypeError("Routing thresholds must be in [0, 1]");
  return { ...r } as RoutingPolicy;
}
export function parseBrowserPlan(value: unknown): BrowserPlan {
  const p = obj(value, ["origins", "targets", "stages", "start"], "plan");
  if (!Array.isArray(p.origins) || !p.origins.length || p.origins.length > 10) throw new TypeError("plan.origins requires 1..10 HTTP(S) origins");
  const origins = [...new Set(p.origins.map(v => {
    const u = new URL(str(v, "plan origin", 4000));
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.pathname !== "/" || u.search || u.hash) throw new TypeError("plan origins must not contain paths or credentials");
    return u.origin;
  }))];
  if (!p.targets || typeof p.targets !== "object" || Array.isArray(p.targets) || Object.keys(p.targets).length > 30) throw new TypeError("plan.targets must contain at most 30 semantic targets");
  const targets: Record<string, PlanTarget> = {};
  for (const [key, raw] of Object.entries(p.targets)) {
    id(key);
    const t = obj(raw, ["description", "label", "role", "contextIncludes", "href", "reuse"], "plan target");
    const target: PlanTarget = {};
    if (t.description !== undefined) target.description = str(t.description, "target description", 1000);
    if (t.label !== undefined) target.label = normalized(t.label, "target label");
    if (t.role !== undefined) target.role = str(t.role, "target role", 50);
    if (t.contextIncludes !== undefined) target.contextIncludes = normalized(t.contextIncludes, "target context");
    if (t.href !== undefined) {
      const href = new URL(str(t.href, "target href", 4000));
      if (!["http:", "https:"].includes(href.protocol) || href.username || href.password) throw new TypeError("target href must be an HTTP(S) URL without credentials");
      target.href = href.href;
    }
    if (t.reuse !== undefined) {
      if (typeof t.reuse !== "boolean") throw new TypeError("target.reuse must be boolean");
      target.reuse = t.reuse;
    }
    if (!target.label && !target.description && !target.href) throw new TypeError("A target requires a label, href or semantic description");
    targets[key] = target;
  }
  if (!Array.isArray(p.stages) || !p.stages.length || p.stages.length > 30) throw new TypeError("plan.stages requires 1..30 stages");
  let textSize = 0;
  const stages: PlanStage[] = p.stages.map(raw => {
    const s = obj(raw, ["id", "goal", "before", "until", "action", "wait", "timeoutMs", "next", "branches"], "plan stage");
    const stage: PlanStage = { id: id(s.id), goal: str(s.goal, "stage goal", 2000) };
    if (s.before !== undefined) stage.before = parseCheckpoint(s.before);
    if (s.until !== undefined) stage.until = parseCheckpoint(s.until);
    if (s.wait !== undefined) {
      if (typeof s.wait !== "boolean") throw new TypeError("stage.wait must be boolean");
      stage.wait = s.wait;
    }
    if (s.timeoutMs !== undefined) {
      if (!Number.isInteger(s.timeoutMs) || Number(s.timeoutMs) < 100 || Number(s.timeoutMs) > 30000) throw new TypeError("stage.timeoutMs must be 100..30000");
      stage.timeoutMs = Number(s.timeoutMs);
    }
    if (s.action !== undefined) {
      const a = obj(s.action, ["operation", "target", "text", "option", "checked"], "plan action");
      const target = id(a.target);
      if (!Object.hasOwn(targets, target)) throw new TypeError("Unknown plan target: " + target);
      if (a.operation === "TYPE_TEXT") {
        if (a.option !== undefined || a.checked !== undefined) throw new TypeError("TYPE_TEXT accepts only text");
        if (a.text !== undefined && (typeof a.text !== "string" || (textSize += a.text.length) > 20000)) throw new TypeError("Plan text must total at most 20000 characters");
        stage.action = { operation: "TYPE_TEXT", target, ...(a.text !== undefined ? { text: a.text as string } : {}) };
      } else if (a.operation === "SELECT") {
        if (a.text !== undefined || a.checked !== undefined) throw new TypeError("SELECT accepts only option");
        const o = obj(a.option, ["label", "value"], "select option");
        if (o.label === undefined && o.value === undefined) throw new TypeError("SELECT requires an option label or value");
        const option: { label?: string; value?: string } = {};
        if (o.label !== undefined) option.label = normalized(o.label, "option label");
        if (o.value !== undefined) {
          if (typeof o.value !== "string" || o.value.length > 2000) throw new TypeError("Invalid option value");
          option.value = o.value;
        }
        stage.action = { operation: "SELECT", target, option };
      } else if (a.operation === "CLICK") {
        if (a.text !== undefined || a.option !== undefined || (a.checked !== undefined && typeof a.checked !== "boolean")) throw new TypeError("CLICK accepts only an optional checked state");
        if (a.checked === undefined && !stage.until) throw new TypeError("CLICK requires until evidence, or an explicit checked state");
        stage.action = { operation: "CLICK", target, ...(a.checked !== undefined ? { checked: a.checked as boolean } : {}) };
      } else throw new TypeError("Unsupported plan action");
    }
    if (stage.wait && stage.action) throw new TypeError("A wait stage cannot dispatch an action");
    if (!stage.action && !stage.until) throw new TypeError("Goal/wait stages require until evidence");
    if (s.next !== undefined) stage.next = next(s.next);
    if (s.branches !== undefined) {
      if (!Array.isArray(s.branches) || s.branches.length > 10) throw new TypeError("At most 10 stage branches are allowed");
      stage.branches = s.branches.map(raw => {
        const b = obj(raw, ["when", "next"], "stage branch");
        return { when: parseCheckpoint(b.when), next: next(b.next) };
      });
    }
    return stage;
  });
  const ids = new Set(stages.map(s => s.id));
  if (ids.size !== stages.length) throw new TypeError("Plan stage identifiers must be unique");
  const start = p.start === undefined ? stages[0]!.id : id(p.start);
  for (const ref of [start, ...stages.flatMap(s => [s.next, ...(s.branches ?? []).map(b => b.next)])]) {
    if (ref != null && !ids.has(ref)) throw new TypeError("Unknown plan stage: " + ref);
  }
  return { origins, targets, stages, start };
}
