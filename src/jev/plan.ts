import { evaluateCheckpoint } from "./checkpoint.ts";
import { createHash } from "node:crypto";
import type { BrowserPlan, PlanAction, PlanProgress, PlanStage, PlanTarget } from "./plan-types.ts";
import type { Candidate, Decision, Observation } from "./types.ts";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
type Source = "local" | "binding";
type Bound = { field: Candidate; source: Source };
type Receipt = { decision: Decision; documentId: string; url: string; text?: string; at: number };
export type PlanRoute =
  | { kind: "done" }
  | { kind: "wait" }
  | { kind: "handoff"; reason: string }
  | { kind: "ready"; page: Observation; goal: string; decision?: Decision; text?: string; source?: Source };

function matches(t: PlanTarget, e: Candidate): boolean {
  return (t.label === undefined || norm(e.label) === t.label) &&
    (t.role === undefined || e.role === t.role) &&
    (t.contextIncludes === undefined || norm(e.context).includes(t.contextIncludes)) &&
    (t.href === undefined || e.href === t.href);
}
function eligible(action: PlanAction, target: PlanTarget, page: Observation): Candidate[] {
  return page.elements.filter(e => matches(target, e) && e.operations.includes(action.operation) &&
    !(action.operation === "CLICK" && action.checked !== undefined && !["checkbox", "switch"].includes(e.role)));
}
/** No values, field text or credentials are cached. Identity and competing
 * candidates are dependencies; a changed peer set invalidates the binding. */
function identity(e: Candidate): string {
  return createHash("sha256").update(JSON.stringify([e.ref, e.role, e.label, e.context, e.href, e.operations, e.className])).digest("hex");
}
function peers(candidates: Candidate[]): string { return JSON.stringify(candidates.map(identity).sort()); }
function cacheKey(target: PlanTarget, action: PlanAction, page: Observation): string {
  const u = new URL(page.url);
  return JSON.stringify([u.origin, u.pathname, target, action.operation]);
}

/** Bounded, in-memory, per-page cache. A reload never inherits old DOM refs. */
export class BindingCache {
  private entries = new Map<string, { documentId: string; ref: string; identity: string; peers: string }>();
  lookup(target: PlanTarget, action: PlanAction, page: Observation, candidates: Candidate[]): { field?: Candidate; invalidated?: boolean } {
    if (!target.reuse) return {};
    const key = cacheKey(target, action, page), entry = this.entries.get(key);
    if (!entry) return {};
    const field = candidates.find(e => e.ref === entry.ref);
    if (entry.documentId !== page.documentId || !field || identity(field) !== entry.identity || peers(candidates) !== entry.peers) {
      this.entries.delete(key);
      return { invalidated: true };
    }
    this.entries.delete(key); this.entries.set(key, entry);
    return { field };
  }
  remember(target: PlanTarget, action: PlanAction, page: Observation, field: Candidate): void {
    if (!target.reuse) return;
    const candidates = eligible(action, target, page);
    if (!candidates.some(e => e.ref === field.ref)) return;
    const key = cacheKey(target, action, page);
    this.entries.delete(key);
    this.entries.set(key, { documentId: page.documentId, ref: field.ref, identity: identity(field), peers: peers(candidates) });
    while (this.entries.size > 64) this.entries.delete(this.entries.keys().next().value!);
  }
  clear(): void { this.entries.clear(); }
}

/** A conditional program authored by the native host. No site scripts or
 * selectors are synthesized by Jev; every dispatch still uses normal guards. */
export class PlanRuntime {
  private current?: string;
  private receipt?: Receipt;
  private bound?: { documentId: string; url: string; ref: string; guard: string; identity: string; peers: string };
  private waitingAt?: number;
  readonly progress: PlanProgress = {
    completed: [], transitions: 0, localActions: 0, bindingHits: 0,
    bindingInvalidations: 0, modelCalls: 0, confidenceHandoffs: 0, waitingForEvidence: false,
  };
  constructor(readonly plan: BrowserPlan, private cache: BindingCache) {
    this.current = plan.start ?? plan.stages[0]!.id;
  }
  get stage(): PlanStage | undefined { return this.plan.stages.find(s => s.id === this.current); }
  get pending(): boolean { return !!this.receipt; }
  private target(): PlanTarget { return this.plan.targets[this.stage!.action!.target]!; }

  private resolve(page: Observation): Bound | undefined {
    const action = this.stage?.action;
    if (!action) return;
    const target = this.target(), candidates = eligible(action, target, page);
    // A model-selected target is only carried to confirmation, never rebound
    // to a lookalike after navigation or element replacement.
    if (this.bound?.documentId === page.documentId && this.bound.url === page.url) {
      const field = candidates.find(e => e.ref === this.bound!.ref);
      if (field && (this.receipt || this.bound.guard === this.selectionGuard(page, field))) return { field, source: "local" };
      this.bound = undefined;
    }
    const cached = this.cache.lookup(target, action, page, candidates);
    if (cached.invalidated) this.progress.bindingInvalidations++;
    if (cached.field) return { field: cached.field, source: "binding" };
    // A description adds a semantic constraint even if hard filters leave one
    // candidate. Only Jev may establish it; a unique role alone is not enough.
    if (!target.description && (target.label !== undefined || target.href !== undefined) && candidates.length === 1) {
      return { field: candidates[0]!, source: "local" };
    }
  }
  private selectionGuard(page: Observation, field: Candidate): string {
    return JSON.stringify([page.guards?.page, page.guards?.targets[field.ref], field,
      eligible(this.stage!.action!, this.target(), page).map(e => [e.ref, e.label, e.role, e.context, e.value])]);
  }
  invalidateSelection(): void { if (!this.receipt) this.bound = undefined; }
  private optionMatches(field: Candidate) {
    const action = this.stage!.action!;
    if (action.operation !== "SELECT") return [];
    return field.options?.filter(o =>
      (action.option.label === undefined || norm(o.label) === action.option.label) &&
      (action.option.value === undefined || o.value === action.option.value)) ?? [];
  }
  private option(field: Candidate) {
    const options = this.optionMatches(field);
    return options.length === 1 ? options[0] : undefined;
  }
  private intrinsic(page: Observation, field?: Candidate): boolean {
    const action = this.stage?.action;
    if (!action) return true;
    if (action.operation === "CLICK" && action.checked === undefined) return true; // requires explicit until
    if (!field) return false;
    if (this.receipt && (this.receipt.documentId !== page.documentId || this.receipt.url !== page.url ||
        this.receipt.decision.target?.split(":")[0] !== field.ref)) return false;
    if (action.operation === "TYPE_TEXT") {
      const text = this.receipt?.text ?? action.text;
      return text !== undefined && field.value === text;
    }
    if (action.operation === "SELECT") {
      const option = this.option(field);
      return !!option && field.selectedIndex === Number(option.index) && field.value === option.value;
    }
    return field.checked === action.checked;
  }
  private finish(page: Observation, field?: Candidate): void {
    const stage = this.stage!;
    // Learn the identity that was actually resolved, not a control that changed
    // meaning during the action. Values may change; semantic dependencies may not.
    if (stage.action && field && this.bound?.documentId === page.documentId && this.bound.url === page.url &&
        this.bound.identity === identity(field) && this.bound.peers === peers(eligible(stage.action, this.target(), page))) {
      this.cache.remember(this.target(), stage.action, page, field);
    }
    this.progress.completed.push(stage.id);
    this.progress.transitions++;
    const branch = stage.branches?.find(b => evaluateCheckpoint(b.when, page).matched);
    const following = this.plan.stages[this.plan.stages.indexOf(stage) + 1]?.id;
    this.current = branch ? branch.next ?? undefined : stage.next === null ? undefined : stage.next ?? following;
    this.receipt = undefined; this.bound = undefined; this.waitingAt = undefined;
  }
  private wait(now: number, reason: string): PlanRoute {
    this.waitingAt ??= now;
    this.progress.waitingForEvidence = true;
    return now - this.waitingAt >= (this.stage?.timeoutMs ?? 5000)
      ? { kind: "handoff", reason } : { kind: "wait" };
  }
  poll(page: Observation, now = performance.now()): PlanRoute {
    this.progress.waitingForEvidence = false;
    if (!this.plan.origins.includes(new URL(page.url).origin)) return { kind: "handoff", reason: "Page left the plan's allowed origins. Inspect it and compile a new plan; no action was dispatched." };
    if (page.frames?.some(f => !['about:blank', 'about:srcdoc'].includes(f.url) && !this.plan.origins.includes(new URL(f.url).origin))) {
      return { kind: "handoff", reason: "A visible frame is outside the plan's allowed origins. Inspect it before allowing cross-origin actions." };
    }
    if (page.truncated || page.unsupportedFrames) return { kind: "handoff", reason: "Plan observation is partial or contains unsupported frames. Use the host's browser/vision tools before replanning." };
    const visited = new Set<string>();
    while (this.stage) {
      const stage = this.stage;
      this.progress.stage = stage.id;
      this.progress.stageGoal = stage.goal;
      if (visited.has(stage.id) || this.progress.transitions >= 200) return { kind: "handoff", reason: "Plan branches formed a cycle without a new action, or exceeded the transition budget." };
      visited.add(stage.id);
      if (page.loading) return this.wait(now, "The active stage is still loading; inspect it before continuing.");
      const bound = this.resolve(page);
      const checkpoint = !stage.until || evaluateCheckpoint(stage.until, page).matched;
      if (checkpoint && this.intrinsic(page, bound?.field)) {
        this.finish(page, bound?.field);
        continue;
      }
      if (this.receipt) return this.wait(now, "The stage action was dispatched once, but its completion evidence is unconfirmed. Resume only observes; it never repeats that action.");
      if (stage.before && !evaluateCheckpoint(stage.before, page).matched) return this.wait(now, "The stage's preconditions are not satisfied. Inspect the page and repair or recompile the plan.");
      if (stage.wait) return this.wait(now, "The wait stage did not reach its expected evidence. Inspect the page before continuing.");
      if (bound && stage.action) {
        if (this.intrinsic(page, bound.field) && (stage.action.operation !== "CLICK" || stage.action.checked !== undefined)) return this.wait(now, "The field has the requested state, but additional completion evidence is missing.");
        const action = stage.action, option = action.operation === "SELECT" ? this.option(bound.field) : undefined;
        if (action.operation === "SELECT" && !option && this.optionMatches(bound.field).length > 1) {
          return { kind: "handoff", reason: "Several options match the planned selection. Add an observed label/value that distinguishes them before acting." };
        }
        if (action.operation !== "SELECT" || option) {
          const target = action.operation === "SELECT" ? bound.field.ref + ":" + option!.index : bound.field.ref;
          return { kind: "ready", page, goal: stage.goal, source: bound.source,
            text: action.operation === "TYPE_TEXT" ? action.text : undefined,
            decision: { operation: action.operation, target, confidence: 1, targetConfidence: 1, latencyMs: 0, model: "local-plan" } };
        }
      }
      const goal = stage.goal + "\nActive plan stage: " + stage.id +
        (stage.until ? "\nRequired completion evidence: " + JSON.stringify(stage.until) : "") +
        (stage.action ? "\nResolve this exact action intent: " + JSON.stringify({ ...stage.action, text: undefined, target: this.target() }) +
          "\nText is supplied by the host. Choose only this operation and an eligible observed target, or scroll/wait/handoff if unavailable. Do not substitute another operation." : "") +
        "\nThe runtime advances the plan after verification. Do not claim DONE while this stage is unmet.";
      return { kind: "ready", page: this.choices(page), goal };
    }
    this.progress.stage = undefined;
    this.progress.stageGoal = undefined;
    return { kind: "done" };
  }
  private choices(page: Observation): Observation {
    const action = this.stage?.action;
    if (!action) return page;
    return { ...page, elements: eligible(action, this.target(), page).map(e => ({
      ...e, operations: [action.operation],
      ...(action.operation === "SELECT" ? { options: this.optionMatches(e).length === 1 ? this.optionMatches(e) : [] } : {}),
    })).filter(e => action.operation !== "SELECT" || e.options?.length) };
  }
  /** Validate even injected/test choosers; a model result cannot broaden a plan. */
  accept(page: Observation, decision: Decision): { text?: string; skip: boolean } {
    const action = this.stage?.action;
    if (!action || ["WAIT", "SCROLL_UP", "SCROLL_DOWN", "HANDOFF", "DONE", "BLOCKED"].includes(decision.operation)) return { skip: false };
    if (decision.operation !== action.operation) throw new Error("Jev returned an operation outside the active plan stage");
    const offered = this.choices(page).elements;
    const field = offered.find(e => e.ref === decision.target?.split(":")[0]);
    if (!field || (action.operation === "SELECT" && !field.options?.some(o => decision.target === field.ref + ":" + o.index))) {
      throw new Error("Jev returned a target outside the active plan constraints");
    }
    // Use the full observed field; the offered projection may filter operations
    // or select options and is not itself the identity we need to guard.
    const observed = page.elements.find(e => e.ref === field.ref)!;
    this.bound = { documentId: page.documentId, url: page.url, ref: field.ref, guard: this.selectionGuard(page, observed),
      identity: identity(observed), peers: peers(eligible(action, this.target(), page)) };
    const skip = (action.operation !== "CLICK" || action.checked !== undefined) && this.intrinsic(page, field);
    return { text: action.operation === "TYPE_TEXT" ? action.text : undefined, skip };
  }
  /** Receipt is written BEFORE dispatch. Failed/uncertain writes are never retried. */
  dispatched(page: Observation, decision: Decision, text?: string, source?: Source | "jev"): void {
    const action = this.stage?.action;
    if (!action || decision.operation !== action.operation) return;
    if (this.receipt) throw new Error("The plan stage already dispatched its action");
    this.receipt = { decision, documentId: page.documentId, url: page.url, text, at: performance.now() };
    this.waitingAt = this.receipt.at;
    if (source === "local") this.progress.localActions++;
    if (source === "binding") this.progress.bindingHits++;
  }
  releaseValues(): void {
    for (const stage of this.plan.stages) if (stage.action?.operation === "TYPE_TEXT") delete stage.action.text;
    this.receipt = undefined; this.bound = undefined;
  }
  snapshot(): PlanProgress { return structuredClone(this.progress); }
}
