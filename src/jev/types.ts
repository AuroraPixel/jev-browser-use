/** Jev never supplies selectors or executable code: targets are observed refs. */
export type Operation = "CLICK" | "TYPE_TEXT" | "SELECT" | "SCROLL_UP" | "SCROLL_DOWN" | "WAIT" | "DONE" | "BLOCKED" | "HANDOFF";
export type HandoffReason = "reasoning" | "unsupported_control" | "missing_information" | "no_progress";
export interface Candidate {
  ref: string;
  role: string;
  label: string;
  value: string;
  operations: Array<"CLICK" | "TYPE_TEXT" | "SELECT">;
  options?: Array<{ index: string; label: string; value: string }>;
  checked?: boolean | "mixed";
  expanded?: boolean;
  selected?: boolean;
  focused?: boolean;
  className?: string;
  context: string;
  href?: string;
}
export interface Observation {
  documentId: string;
  url: string;
  title: string;
  text: string;
  elements: Candidate[];
  scroll: { x: number; y: number; up: boolean; down: boolean };
  truncated: boolean;
  unsupportedFrames: boolean;
  loading?: boolean;
  /** Visible disabled controls are context, never executable targets. */
  disabledControls?: Array<Pick<Candidate, "ref" | "role" | "label">>;
  /** Visible live-region feedback, separate from article/ordinary page text. */
  feedback?: Array<{ key: string; text: string }>;
  /** Local freshness checks only; never included in the model request or host response. */
  guards?: { page: string; targets: Record<string, string> };
}
export interface Decision {
  operation: Operation;
  target?: string;
  confidence: number;
  targetConfidence?: number;
  probabilities?: Record<string, number>;
  targetProbabilities?: Record<string, number>;
  latencyMs: number;
  model: string;
  handoffReason?: HandoffReason;
  requestBytes?: number;
  candidateCount?: number;
}
export interface HistoryEntry {
  operation: Operation;
  target?: string;
  label?: string;
  checkedBefore?: boolean | "mixed";
  checkedAfter?: boolean | "mixed";
  outcome: "executed" | "uncertain";
}
export interface DecisionTrace {
  index: number;
  operation: Operation;
  target?: string;
  model: string;
  latencyMs: number;
  requestBytes?: number;
  candidateCount?: number;
  confidence?: number;
  targetConfidence?: number;
  probabilities?: Record<string, number>;
  targetProbabilities?: Record<string, number>;
  textSource?: "provided" | "host";
  outcome: "selected" | "stale" | "executed" | "uncertain" | "needs_text" | "handoff" | "done" | "blocked";
  staleReason?: string;
}
/** Each actual HTTP attempt, including bounded read-only inference retries. */
export interface ApiRequestTrace {
  index: number;
  decision: number;
  attempt: number;
  latencyMs: number;
  requestBytes: number;
  candidateCount: number;
  outcome: "success" | "http_error" | "network_error" | "invalid_response";
  httpStatus?: number;
  retrying: boolean;
}
export interface JevTiming {
  decisionMs: number;
  observeMs: number;
  preflightMs: number;
  actionMs: number;
  settleMs: number;
  hostWaitMs: number;
  wallMs: number;
}
export interface SubmissionCompletion {
  /** Exact accessible name of the final submit button (not a reply opener). */
  submitLabel: string;
  /** Expected text in a newly appearing/changed visible alert/status region. */
  successText: string;
}
export interface ProvidedInput {
  /** Exact page URL and unique accessible field name; no selectors or patterns. */
  url: string;
  label: string;
  text: string;
}
/** Host-authored, conjunctive stop conditions evaluated against fresh visible DOM. */
export interface PageCheckpoint {
  url?: { origin: string; pathname?: string; pathnameIncludes?: string };
  text?: string[];
  /** Visible prose is case-insensitive by default; form values always match exactly. */
  matchCase?: boolean;
  fields?: Array<{ label: string; role?: string; value?: string; checked?: boolean; selected?: boolean }>;
}
export interface CheckpointCheck {
  condition: string;
  matched: boolean;
  actual?: string | boolean;
}
export type JevInput =
  | { action: "run"; goal: string; maxSteps?: number; stepLimit?: number; completion?: SubmissionCompletion; inputs?: ProvidedInput[]; until?: PageCheckpoint; diagnostics?: "summary" | "full" }
  | { action: "resume"; sessionId: string; requestId: string; text?: string; maxSteps?: number }
  | { action: "status"; sessionId: string; diagnostics?: "summary" | "full" }
  | { action: "stop"; sessionId: string };
export interface JevConfig {
  apiKey?: string;
  model?: string;
  /** Optional HTTP(S) proxy, read from the caller environment; never sent to the page/model. */
  proxy?: string;
}
export type JevStatus = "running" | "needs_text" | "needs_host" | "paused" | "done" | "blocked" | "stopped" | "error";
export interface JevResult {
  sessionId: string;
  status: JevStatus;
  goal: string;
  /** Always false: Jev's DONE is a claim, not an independent outcome check. */
  verified: false;
  requestId?: string;
  field?: Candidate;
  page?: Pick<Observation, "url" | "title" | "text" | "truncated" | "unsupportedFrames">;
  reason?: string;
  handoffReason?: HandoffReason;
  completionEvidence?: { kind: "feedback" | "checkpoint"; text: string; url?: string; checks?: CheckpointCheck[] };
  checkpoint?: { matched: boolean; checks: CheckpointCheck[] };
  handoff?: {
    source: "model" | "runtime" | "text";
    next: "supply_text" | "inspect_page" | "verify_submission" | "inspect_new_window" | "resume";
    instruction: string;
    resume: { action: "resume"; sessionId: string; requestId: string };
  };
  /** URLs announced by this page opening a window; not proof of loaded results. */
  openedWindows?: string[];
  stopReason?: "text_required" | "host_required" | "new_window" | "burst_limit" | "step_limit" | "decision_limit" | "stale_page" | "submission_confirmed" | "submission_unconfirmed" | "checkpoint_reached" | "done" | "blocked" | "cancelled" | "error";
  steps: number;
  decisions: number;
  elapsedMs: number;
  history: HistoryEntry[];
  timing: JevTiming;
  trace: DecisionTrace[];
  requests: ApiRequestTrace[];
  /** UTC timestamps for stitching host runs together; wallMs uses a monotonic clock. */
  startedAt: string;
  returnedAt: string;
}

const ACTIONS = new Set(["run", "resume", "status", "stop"]);
function string(value: unknown, name: string, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new TypeError(`${name} must be a non-empty string (max ${limit} characters)`);
  return value;
}
function budget(value: unknown, name: string, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) throw new TypeError(`${name} must be an integer from 1 to ${max}`);
  return value as number;
}
/** Validate at the trust boundary, including calls made by script or MCP without schema enforcement. */
export function parseJevInput(value: unknown): JevInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Jev requires an object");
  const v = value as Record<string, unknown>;
  if (typeof v.action !== "string" || !ACTIONS.has(v.action)) throw new TypeError("action must be run, resume, status or stop");
  const allowed = v.action === "run" ? ["action", "goal", "maxSteps", "stepLimit", "completion", "inputs", "until", "diagnostics"] : v.action === "resume" ? ["action", "sessionId", "requestId", "text", "maxSteps"] : v.action === "status" ? ["action", "sessionId", "diagnostics"] : ["action", "sessionId"];
  if (Object.keys(v).some((k) => !allowed.includes(k))) throw new TypeError("Unknown Jev option; see jev-browser-use help jev");
  if (v.diagnostics !== undefined && v.diagnostics !== "summary" && v.diagnostics !== "full") throw new TypeError("diagnostics must be summary or full");
  const diagnostics = v.diagnostics as "summary" | "full" | undefined;
  if (v.action === "run") {
    let inputs: ProvidedInput[] | undefined;
    if (v.inputs !== undefined) {
      if (!Array.isArray(v.inputs) || v.inputs.length > 20) throw new TypeError("inputs must be an array of at most 20 URL-bound field values");
      const keys = new Set<string>();
      let length = 0;
      inputs = v.inputs.map(raw => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(k => !["url", "label", "text"].includes(k))) throw new TypeError("Each input requires url, label and text");
        const url = new URL(string(raw.url, "inputs.url", 4000));
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new TypeError("inputs.url must be an HTTP(S) URL without credentials");
        const label = string(raw.label, "inputs.label", 200).replace(/\s+/g, " ").trim();
        if (typeof raw.text !== "string" || (length += raw.text.length) > 20000) throw new TypeError("inputs text must be strings totaling at most 20000 characters");
        const key = JSON.stringify([url.href, label]);
        if (keys.has(key)) throw new TypeError("Duplicate URL/label in inputs");
        keys.add(key);
        return { url: url.href, label, text: raw.text };
      });
    }
    let completion: SubmissionCompletion | undefined;
    if (v.completion !== undefined) {
      const c = v.completion as Record<string, unknown>;
      if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).some(k => !["submitLabel", "successText"].includes(k))) throw new TypeError("completion requires submitLabel and successText");
      completion = { submitLabel: string(c.submitLabel, "completion.submitLabel", 200), successText: string(c.successText, "completion.successText", 500) };
    }
    const until = v.until === undefined ? undefined : parseCheckpoint(v.until);
    if (completion && until) throw new TypeError("Use either until for a page checkpoint or completion for a single submission, not both");
    return { action: "run", goal: string(v.goal, "goal", 4000), maxSteps: budget(v.maxSteps, "maxSteps", 30), stepLimit: budget(v.stepLimit, "stepLimit", 100), ...(completion ? { completion } : {}), ...(inputs ? { inputs } : {}), ...(until ? { until } : {}), ...(diagnostics ? { diagnostics } : {}) };
  }
  const sessionId = string(v.sessionId, "sessionId", 100);
  if (v.action !== "resume") return v.action === "status" ? { action: "status", sessionId, ...(diagnostics ? { diagnostics } : {}) } : { action: "stop", sessionId };
  if (v.text !== undefined && (typeof v.text !== "string" || v.text.length > 20000)) throw new TypeError("text must be a string of at most 20000 characters (empty clears the field)");
  return { action: "resume", sessionId, requestId: string(v.requestId, "requestId", 100), text: v.text as string | undefined, maxSteps: budget(v.maxSteps, "maxSteps", 30) };
}

function record(value: unknown, name: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new TypeError(`Invalid ${name} fields`);
  return value as Record<string, unknown>;
}
function parseCheckpoint(value: unknown): PageCheckpoint {
  const c = record(value, "until", ["url", "text", "fields", "matchCase"]), out: PageCheckpoint = {};
  if (c.url !== undefined) {
    const u = record(c.url, "until.url", ["origin", "pathname", "pathnameIncludes"]);
    const origin = new URL(string(u.origin, "until.url.origin", 4000));
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new TypeError("until.url.origin must be an HTTP(S) origin, without a path, query or credentials");
    out.url = { origin: origin.origin };
    for (const key of ["pathname", "pathnameIncludes"] as const) if (u[key] !== undefined) {
      const path = string(u[key], `until.url.${key}`, 2000);
      if (!path.startsWith("/") || path.includes("?") || path.includes("#")) throw new TypeError(`until.url.${key} must be a literal path starting with /`);
      out.url[key] = path;
    }
  }
  if (c.text !== undefined) {
    if (!Array.isArray(c.text) || !c.text.length || c.text.length > 10) throw new TypeError("until.text requires 1..10 visible text fragments");
    out.text = c.text.map(t => string(t, "until.text", 500).replace(/\s+/g, " ").trim());
  }
  if (c.matchCase !== undefined) {
    if (typeof c.matchCase !== "boolean" || !out.text) throw new TypeError("until.matchCase must be boolean and requires text conditions");
    out.matchCase = c.matchCase;
  }
  if (c.fields !== undefined) {
    if (!Array.isArray(c.fields) || !c.fields.length || c.fields.length > 10) throw new TypeError("until.fields requires 1..10 field states");
    out.fields = c.fields.map(raw => {
      const f = record(raw, "until.fields", ["label", "role", "value", "checked", "selected"]);
      const field: NonNullable<PageCheckpoint['fields']>[number] = { label: string(f.label, "until.fields.label", 200).replace(/\s+/g, " ").trim() };
      if (f.role !== undefined) field.role = string(f.role, "until.fields.role", 50);
      if (f.value !== undefined) {
        if (typeof f.value !== "string" || f.value.length > 2000) throw new TypeError("until.fields.value must be a string of at most 2000 characters");
        field.value = f.value;
      }
      for (const key of ["checked", "selected"] as const) if (f[key] !== undefined) {
        if (typeof f[key] !== "boolean") throw new TypeError(`until.fields.${key} must be boolean`);
        field[key] = f[key];
      }
      if (field.value === undefined && field.checked === undefined && field.selected === undefined) throw new TypeError("until.fields requires value, checked or selected");
      return field;
    });
  }
  if (!Object.keys(out).length) throw new TypeError("until requires at least one URL, text or field condition");
  return out;
}
