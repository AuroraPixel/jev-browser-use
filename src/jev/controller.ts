import { createHash, randomUUID } from "node:crypto";
import type { Page } from "puppeteer-core";
import { currentRun } from "../daemon/run-context.ts";
import { jevConfigFromEnv } from "../shared/jev.ts";
import { withRendering } from "../page/rendering.ts";
import { checkActive, delay, execute, fingerprint, observe, prepare, settle, StaleObservation, watchWindowOpen } from "./browser.ts";
import { withJevLock } from "./lock.ts";
import { createChooser, type Choose } from "./model.ts";
import { evaluateCheckpoint } from "./checkpoint.ts";
import { describeHandoff } from "./handoff.ts";
import { parseJevInput, type Candidate, type Decision, type DecisionTrace, type HandoffReason, type HistoryEntry, type JevInput, type JevResult, type JevStatus, type JevTiming, type Observation, type ProvidedInput, type SubmissionCompletion, type PageCheckpoint } from "./types.ts";

type Pending = { id: string; observation?: Observation; decision?: Decision; field?: Candidate; trace?: DecisionTrace };
type TimedPhase = "decisionMs" | "observeMs" | "preflightMs" | "actionMs" | "settleMs";
interface Session {
  id: string;
  goal: string;
  status: JevStatus;
  stepLimit: number;
  steps: number;
  decisions: number;
  elapsedMs: number;
  startedAt: number;
  startedAtIso: string;
  returnedAt?: number;
  endedAt?: number;
  timing: JevTiming;
  trace: DecisionTrace[];
  requests: JevResult["requests"];
  diagnostics: "summary" | "full";
  history: HistoryEntry[];
  page?: Observation;
  reason?: string;
  stopReason?: JevResult["stopReason"];
  handoffReason?: HandoffReason;
  modelHandoff?: boolean;
  pending?: Pending;
  completion?: SubmissionCompletion;
  until?: PageCheckpoint;
  checkpoint?: JevResult["checkpoint"];
  inputs: ProvidedInput[];
  filled: Array<{ documentId: string; url: string; ref: string; label: string; digest: string }>;
  submission?: { previousFeedback: string[] };
  completionEvidence?: JevResult["completionEvidence"];
  openedWindows?: string[];
  recentAction?: { before: Observation; at: number };
  toggleActions: Set<string>;
  consumed: Map<string, { digest: string; result?: JevResult }>;
  abort?: AbortController;
}
const TERMINAL = new Set<JevStatus>(["done", "blocked", "stopped", "error"]);
const HANDOFF_MESSAGES: Record<HandoffReason, string> = {
  reasoning: "Jev requests host reasoning or interpretation before continuing",
  unsupported_control: "Jev requests host help with an unsupported control",
  missing_information: "Jev requests missing information from the host",
  no_progress: "Jev is not making progress; the host must inspect the page",
};

const textDigest = (text: string) => createHash("sha256").update(text).digest("hex");
const fieldLabel = (label: string) => label.replace(/\s+/g, " ").trim();

/** A page owns one bounded session. Provided values live only until used/stopped. */
export class JevController {
  private session?: Session;
  constructor(private readonly page: Page, private readonly chooseForTest?: Choose) {}

  async call(value: unknown): Promise<JevResult> {
    const input = parseJevInput(value);
    if (input.action === "run") {
      if (this.session && (!TERMINAL.has(this.session.status) || this.session.abort)) throw new Error("This page has an active Jev session; resume or stop it first");
      const session: Session = {
        id: randomUUID(), goal: input.goal, status: "running", stepLimit: input.stepLimit ?? 60,
        completion: input.completion, until: input.until,
        inputs: input.inputs ?? [], filled: [], toggleActions: new Set(),
        steps: 0, decisions: 0, elapsedMs: 0, startedAt: performance.now(), startedAtIso: new Date().toISOString(), history: [], trace: [], requests: [], diagnostics: input.diagnostics ?? "summary", consumed: new Map(),
        timing: { decisionMs: 0, observeMs: 0, preflightMs: 0, actionMs: 0, settleMs: 0, hostWaitMs: 0, wallMs: 0 },
      };
      this.session = session;
      // Keep ordinary browser work inside the daemon. A small burst is opt-in.
      return this.burst(session, input.maxSteps ?? session.stepLimit);
    }
    const s = this.session;
    if (!s || input.sessionId !== s.id) throw new Error("Unknown Jev session for this page (sessions end when the daemon/browser restarts)");
    if (input.action === "status") return this.result(s, input.diagnostics);
    if (input.action === "stop") {
      if (!TERMINAL.has(s.status)) {
        this.accountHostWait(s);
        s.status = "stopped"; s.stopReason = "cancelled"; s.endedAt = performance.now();
        s.reason = "Stopped by caller; inspect any in-flight action before continuing";
        s.pending = undefined; s.abort?.abort();
        s.inputs = [];
      }
      return this.result(s);
    }
    const digest = createHash("sha256").update(JSON.stringify([input.text, input.maxSteps])).digest("hex");
    const previous = s.consumed.get(input.requestId);
    if (previous) {
      if (previous.digest !== digest) throw new Error("This requestId was already consumed with different input; it cannot be reused");
      if (!previous.result) throw new Error("This resume is still running; use status");
      return structuredClone(previous.result);
    }
    if (!s.pending || s.pending.id !== input.requestId || s.abort) throw new Error("Stale or unknown requestId; use the latest session status");
    if (s.status === "needs_text" ? input.text === undefined : input.text !== undefined) throw new Error(s.status === "needs_text" ? "Supply text for this needs_text request (an empty string clears the field)" : "This paused request does not accept text");
    const pending = s.pending;
    const receipt: { digest: string; result?: JevResult } = { digest };
    s.consumed.set(input.requestId, receipt);
    s.pending = undefined;
    this.accountHostWait(s);
    receipt.result = await this.burst(s, input.maxSteps ?? s.stepLimit, pending, input.text);
    return structuredClone(receipt.result);
  }

  private accountHostWait(s: Session): void {
    if (s.returnedAt !== undefined) s.timing.hostWaitMs += performance.now() - s.returnedAt;
    s.returnedAt = undefined;
  }
  private async timed<T>(s: Session, phase: TimedPhase, fn: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try { return await fn(); } finally { s.timing[phase] += performance.now() - started; }
  }
  private read(s: Session, signal: AbortSignal): Promise<Observation> {
    return this.timed(s, "observeMs", () => observe(this.page, signal));
  }
  private result(s: Session, diagnostics = s.diagnostics): JevResult {
    const p = s.page, now = s.endedAt ?? performance.now();
    const timing = { ...s.timing, wallMs: now - s.startedAt,
      hostWaitMs: s.timing.hostWaitMs + (s.returnedAt !== undefined && !s.endedAt ? now - s.returnedAt : 0) };
    for (const key of Object.keys(timing) as Array<keyof JevTiming>) timing[key] = Math.round(timing[key]);
    return structuredClone({
      sessionId: s.id, status: s.status, goal: s.goal, verified: false,
      requestId: s.pending?.id, field: s.pending?.field,
      page: p ? { url: p.url, title: p.title, text: p.text, truncated: p.truncated, unsupportedFrames: p.unsupportedFrames } : undefined,
      reason: s.reason, stopReason: s.stopReason, handoffReason: s.handoffReason,
      completionEvidence: s.completionEvidence,
      checkpoint: s.checkpoint,
      handoff: describeHandoff({ status: s.status, stopReason: s.stopReason, sessionId: s.id, requestId: s.pending?.id, reason: s.reason }, !!s.modelHandoff),
      openedWindows: s.openedWindows,
      steps: s.steps, decisions: s.decisions, elapsedMs: Math.round(s.elapsedMs), history: s.history.slice(-10), timing,
      trace: diagnostics === "full" ? s.trace : s.trace.map(({ probabilities, targetProbabilities, ...entry }) => entry),
      requests: s.requests, startedAt: s.startedAtIso, returnedAt: new Date().toISOString(),
    });
  }
  private pause(s: Session, reason: string, stopReason: JevResult["stopReason"] = "burst_limit"): void {
    s.status = "paused"; s.reason = reason; s.stopReason = stopReason; s.pending = { id: randomUUID() };
  }
  private handoff(s: Session, reason: HandoffReason, message = HANDOFF_MESSAGES[reason]): void {
    s.status = "needs_host"; s.stopReason = "host_required"; s.handoffReason = reason; s.reason = message;
    s.pending = { id: randomUUID() };
  }

  private rememberText(s: Session, page: Observation, field: Candidate, text: string): void {
    s.filled.push({ documentId: page.documentId, url: page.url, ref: field.ref, label: field.label, digest: textDigest(text) });
  }

  /** The host specifies evidence; the executor can stop before another paid choice. */
  private reachedCheckpoint(s: Session, page: Observation): boolean {
    if (!s.until) return false;
    s.checkpoint = evaluateCheckpoint(s.until, page);
    // Do not declare success while a prepared replacement on this page is unfilled.
    const pending = s.inputs.filter(i => i.url === page.url &&
      (page.elements.filter(e => e.operations.includes("TYPE_TEXT") && fieldLabel(e.label) === i.label).length !== 1 ||
       !page.elements.some(e => e.operations.includes("TYPE_TEXT") && fieldLabel(e.label) === i.label && e.value === i.text)));
    if (pending.length) {
      s.checkpoint.checks.push(...pending.map(i => ({ condition: `prepared_input:${i.label}`, matched: false })));
      s.checkpoint.matched = false;
    }
    if (!s.checkpoint.matched) return false;
    s.status = "done"; s.stopReason = "checkpoint_reached";
    s.completionEvidence = { kind: "checkpoint", text: "All host-authored page conditions match the current visible observation", url: page.url, checks: s.checkpoint.checks };
    s.reason = "Reached the host's page checkpoint without another model decision. Independently verify the full task outcome";
    return true;
  }

  /** Keep satisfied text fields out of TYPE_TEXT without hiding other actions. */
  private choices(s: Session, page: Observation): Observation {
    for (const input of [...s.inputs]) {
      const fields = page.elements.filter(e => e.operations.includes("TYPE_TEXT") && fieldLabel(e.label) === input.label);
      if (page.url === input.url && fields.length === 1 && fields[0]!.value === input.text) {
        this.rememberText(s, page, fields[0]!, input.text);
        s.inputs.splice(s.inputs.indexOf(input), 1);
      }
    }
    return { ...page, elements: page.elements.map(e => {
      const filled = s.filled.some(f => f.documentId === page.documentId && f.url === page.url && f.ref === e.ref && f.digest === textDigest(e.value));
      return filled ? { ...e, operations: e.operations.filter(op => op !== "TYPE_TEXT") } : e;
    }).filter(e => e.operations.length) };
  }

  /** Observe a pending UI transition locally. Never replay its initiating action. */
  private async waitForChange(s: Session, page: Observation, until: number, signal: AbortSignal): Promise<void> {
    const initial = fingerprint(page);
    while (performance.now() < until) {
      await this.timed(s, "settleMs", () => delay(Math.min(100, Math.max(1, until - performance.now())), signal));
      s.page = await this.read(s, signal);
      if (fingerprint(s.page) !== initial) return;
    }
  }

  /** After a single authorized submit, only observe. Never ask the model for
   * another action until this session is explicitly stopped by its caller. */
  private async confirmSubmission(s: Session, signal: AbortSignal): Promise<void> {
    const deadline = performance.now() + 2500;
    while (true) {
      checkActive(signal);
      try {
        const page = await this.read(s, signal);
        s.page = page;
        const expected = s.completion!.successText.replace(/\s+/g, " ").trim();
        const evidence = page.feedback?.find(f => f.text.includes(expected) &&
          !s.submission!.previousFeedback.includes(JSON.stringify(f)));
        if (evidence) {
          s.status = "done"; s.stopReason = "submission_confirmed";
          s.completionEvidence = { kind: "feedback", text: evidence.text };
          s.reason = "Submitted once and observed the configured success feedback. Independently verify the resulting record or permalink";
          return;
        }
      } catch (error) { if (!(error instanceof StaleObservation)) throw error; }
      if (performance.now() >= deadline) break;
      await this.timed(s, "settleMs", () => delay(100, signal));
    }
    this.handoff(s, "reasoning", "The submit was dispatched once but success feedback is unconfirmed. Inspect the outcome; resuming only checks for confirmation and never submits again");
    s.stopReason = "submission_unconfirmed";
  }

  private async burst(s: Session, maxSteps: number, pending?: Pending, text?: string): Promise<JevResult> {
    const started = performance.now();
    const abort = new AbortController();
    const parent = currentRun()?.signal;
    const signal = AbortSignal.any([abort.signal, ...(parent ? [parent] : []), AbortSignal.timeout(120000)]);
    s.abort = abort; s.status = "running"; s.reason = undefined; s.stopReason = undefined; s.handoffReason = undefined; s.modelHandoff = false;
    const choose = this.chooseForTest ?? createChooser(currentRun()?.jev ?? jevConfigFromEnv(), fetch,
      request => s.requests.push({ ...request, index: s.requests.length + 1, decision: s.decisions }));
    let unwatch = () => {};
    let windowOpened = false;
    const handoffWindow = () => {
      this.handoff(s, "unsupported_control", "The page opened a new window. Inspect openedWindows and the resulting tab; this page-scoped session cannot verify its contents. Do not repeat the opening action");
      s.stopReason = "new_window";
    };
    try {
      await withJevLock(this.page, () => withRendering(this.page, async () => {
        unwatch = watchWindowOpen(this.page, url => {
          windowOpened = true;
          (s.openedWindows ??= []).push(url);
          s.openedWindows = s.openedWindows.slice(-5);
        });
        let used = 0, stale = 0, loadingDone = 0, repeats = 0;
        let location: string | undefined, navigationAt = -Infinity, loadingWaitUntil = -Infinity;
        let lastAction: { before: string; key: string } | undefined;
        if (s.submission) { await this.confirmSubmission(s, signal); return; }
        if (pending?.decision && pending.observation) {
          try {
            await this.act(s, pending.observation, pending.decision, text, signal, pending.trace);
            used++;
          } catch (e) {
            if (!(e instanceof StaleObservation)) throw e;
            if (pending.trace) { pending.trace.outcome = "stale"; pending.trace.staleReason = e.message; }
            s.page = await this.read(s, signal);
            this.pause(s, "Page changed while waiting for text; supplied text was discarded. Resume to choose from the new page", "stale_page");
            return;
          }
        }
        while (used < maxSteps) {
          checkActive(signal);
          if (windowOpened) { handoffWindow(); return; }
          let trace: DecisionTrace | undefined;
          try {
            const observation = await this.read(s, signal);
            const nextLocation = observation.documentId + ':' + observation.url;
            if (location !== undefined && location !== nextLocation) {
              navigationAt = performance.now();
              loadingWaitUntil = navigationAt + 5000;
            }
            location = nextLocation;
            s.page = observation;
            if (this.reachedCheckpoint(s, observation)) return;
            if (s.steps >= s.stepLimit || s.decisions >= s.stepLimit * 2) {
              s.status = "blocked"; s.stopReason = s.steps >= s.stepLimit ? "step_limit" : "decision_limit";
              s.reason = "Session step/decision limit reached; inspect the page before starting a new goal"; return;
            }
            const recent = s.recentAction;
            const sameDocument = recent && recent.before.documentId === observation.documentId && recent.before.url === observation.url;
            const newlyDisabled = sameDocument && observation.disabledControls?.some(e => !recent.before.disabledControls?.some(before => before.ref === e.ref));
            // Disabled controls alone do not imply loading. Wait proactively
            // only for a new busy state, or a known prepared field whose enable
            // action has temporarily disabled another control.
            const pendingInput = newlyDisabled && s.inputs.some(i => i.url === observation.url &&
              observation.disabledControls?.some(e => fieldLabel(e.label) === i.label));
            if (sameDocument && ((observation.loading && !recent.before.loading) || pendingInput)) {
              if (performance.now() >= recent.at + 5000) {
                this.handoff(s, "no_progress", "The action's controls are still pending after a bounded local wait; inspect the page before continuing");
                return;
              }
              await this.timed(s, "settleMs", () => delay(100, signal));
              continue;
            }
            // A new route may expose site navigation before its results. Poll
            // its visible loader locally instead of predicting against a shell.
            if (observation.loading && performance.now() < loadingWaitUntil) {
              await this.timed(s, "settleMs", () => delay(100, signal));
              continue;
            }
            if (lastAction && fingerprint(observation) === lastAction.before) {
              if (++repeats >= 3) { this.handoff(s, "no_progress"); return; }
            } else repeats = 0;
            s.decisions++;
            const choices = this.choices(s, observation);
            let goal = s.completion ? `${s.goal}\nExecution boundary: submit once using the button named ${JSON.stringify(s.completion.submitLabel)}. Completion requires new success feedback ${JSON.stringify(s.completion.successText)}. Do not choose DONE before submission.` : s.goal;
            if (s.until) goal += `\nHost checkpoint (all required): ${JSON.stringify(s.until)}. The runtime stops automatically when this matches. Still unmet: ${JSON.stringify(s.checkpoint?.checks.filter(c => !c.matched).map(c => c.condition))}. Continue toward these conditions; HANDOFF if interpretation is needed. Do not leave an already-open matching result to start unrelated searches.`;
            const prepared = s.inputs.filter(i => i.url === observation.url);
            if (prepared.length) goal += `\nPrepared text is available for these fields when they become actionable: ${JSON.stringify(prepared.map(i => i.label))}. Fill them with the prepared replacement, even if they currently contain an old value. Resolve any open autocomplete by choosing the suggestion matching the current focused field's value before filling the next field. A covered field is not an invitation to type into a different field.`;
            const filled = s.filled.filter(f => f.documentId === observation.documentId && f.url === observation.url && observation.elements.some(e => e.ref === f.ref && textDigest(e.value) === f.digest));
            if (filled.length) goal += `\nText has been inserted into ${JSON.stringify(filled.map(f => f.label))}. Text insertion does not confirm an autocomplete selection; choose its matching suggestion if the picker is still open. Do not retype or use unrelated site search.`;
            const decision = await this.timed(s, "decisionMs", () => choose(choices, goal, s.history, signal));
            trace = { index: s.decisions, operation: decision.operation, target: decision.target, model: decision.model, latencyMs: decision.latencyMs, requestBytes: decision.requestBytes, candidateCount: decision.candidateCount,
              confidence: decision.confidence, targetConfidence: decision.targetConfidence,
              probabilities: decision.probabilities, targetProbabilities: decision.targetProbabilities, outcome: "selected" };
            s.trace.push(trace);
            checkActive(signal);
            if (decision.operation === "TYPE_TEXT") {
              if (!choices.elements.some(e => e.ref === decision.target && e.operations.includes("TYPE_TEXT"))) throw new Error("Jev selected an unavailable text target");
              const field = observation.elements.find(e => e.ref === decision.target)!;
              const input = s.inputs.find(i => i.url === observation.url && i.label === fieldLabel(field.label));
              if (input) {
                if (observation.elements.filter(e => e.operations.includes("TYPE_TEXT") && fieldLabel(e.label) === input.label).length !== 1) {
                  trace.outcome = "handoff";
                  this.handoff(s, "missing_information", "Provided input matches more than one field. Inspect the target; no text was inserted");
                  return;
                }
                trace.textSource = "provided";
                await this.act(s, observation, decision, input.text, signal, trace, input);
                used++; stale = 0; loadingDone = 0;
                continue;
              }
            }
            if (decision.operation === "DONE" && s.until) {
              s.page = await this.read(s, signal);
              if (this.reachedCheckpoint(s, s.page)) { trace.outcome = "done"; return; }
              trace.outcome = "handoff";
              this.handoff(s, "reasoning", "Jev claimed completion but the host checkpoint is not satisfied. Inspect checkpoint.checks and the current page before continuing");
              return;
            }
            // A handoff cannot mutate the browser. Give the host fresh context
            // instead of discarding its reasoning request because a ticker moved.
            if (decision.operation === "HANDOFF") s.page = await this.read(s, signal);
            if (["DONE", "BLOCKED", "TYPE_TEXT"].includes(decision.operation)) {
              const handle = await this.timed(s, "preflightMs", () => prepare(this.page, observation, decision, signal, decision.operation === "TYPE_TEXT"));
              await handle?.dispose();
            }
            // Async button updates may have no standard loader. Recheck an
            // early inability to proceed after an action as well as navigation.
            // Genuine reasoning/missing-information handoffs stay immediate.
            const graceUntil = Math.max(navigationAt + 3000, (s.recentAction?.at ?? -Infinity) + 3500);
            if ((decision.operation === "BLOCKED" || (decision.operation === "HANDOFF" &&
                ["unsupported_control", "no_progress"].includes(decision.handoffReason ?? ""))) && performance.now() < graceUntil) {
              trace.outcome = "stale";
              trace.staleReason = "Awaiting a recent navigation/action update before accepting inability to proceed";
              await this.waitForChange(s, observation, graceUntil, signal);
              continue;
            }
            if (decision.operation === "DONE" || decision.operation === "BLOCKED") {
              if (decision.operation === "DONE" && s.completion) {
                trace.outcome = "stale";
                trace.staleReason = "Configured submission has not executed";
                if (++loadingDone >= 2) { this.handoff(s, "no_progress", "The configured submit has not executed; completion cannot be accepted"); return; }
                continue;
              }
              if (observation.loading) {
                trace.outcome = "stale";
                trace.staleReason = "The observed page is still loading";
                if (++loadingDone >= 8) { this.handoff(s, "no_progress", "The page is still loading; inspect it before accepting completion"); return; }
                await this.timed(s, "settleMs", () => delay(150, signal));
                continue;
              }
              s.status = decision.operation === "DONE" ? "done" : "blocked";
              trace.outcome = s.status; s.stopReason = s.status;
              s.reason = decision.operation === "DONE" ? "Jev reports completion. The host must independently verify the goal" : "Jev could not find a supported next action; inspect the page with jev-browser-use";
              return;
            }
            if (decision.operation === "HANDOFF") {
              trace.outcome = "handoff";
              this.handoff(s, decision.handoffReason ?? "reasoning"); s.modelHandoff = true; return;
            }
            if (decision.operation === "TYPE_TEXT") {
              // Refresh the host's context after the model round trip. Unrelated
              // translations may have changed while Jev selected a stable field.
              const requestPage = await this.read(s, signal);
              const ref = decision.target!;
              const sameField = observation.guards && requestPage.guards
                ? observation.guards.page === requestPage.guards.page && observation.guards.targets[ref] === requestPage.guards.targets[ref]
                : fingerprint(observation) === fingerprint(requestPage);
              const field = requestPage.elements.find(e => e.ref === ref && e.operations.includes("TYPE_TEXT"));
              if (!sameField || !field) throw new StaleObservation();
              s.page = requestPage;
              trace.outcome = "needs_text"; trace.textSource = "host"; s.status = "needs_text"; s.stopReason = "text_required";
              s.pending = { id: randomUUID(), observation: requestPage, decision, field, trace };
              s.reason = "Host agent must supply the field text, then resume with this requestId"; return;
            }
            const key = `${decision.operation}:${decision.target ?? ""}`;
            if (decision.operation === "WAIT" || lastAction?.key !== key) repeats = 0;
            const target = observation.elements.find(e => e.ref === decision.target);
            // A repeated checkbox action from the same form state is a cycle,
            // even though each individual click changed checked/unchecked.
            // Other control changes or a new document permit fresh progress.
            const toggleKey = decision.operation === "CLICK" && target && ["checkbox", "switch"].includes(target.role) && target.checked !== undefined
              ? JSON.stringify([observation.documentId, observation.url, target.ref, target.label, target.checked,
                observation.guards?.page ?? observation.elements.map(e => [e.ref, e.value, e.checked, e.selected])]) : undefined;
            if (toggleKey && s.toggleActions.has(toggleKey)) {
              trace.outcome = "handoff";
              this.handoff(s, "no_progress", "A repeated checkbox state/action cycle was detected; the next toggle was not dispatched. Inspect the intended state before continuing");
              return;
            }
            if (s.completion && decision.operation === "CLICK" && target?.role === "button" &&
                fieldLabel(target.label) === fieldLabel(s.completion.submitLabel) && s.inputs.some(i => i.url === observation.url)) {
              trace.outcome = "handoff";
              this.handoff(s, "no_progress", "Prepared inputs on this page are still unfilled; the configured submit was not dispatched. Inspect the fields before resuming");
              return;
            }
            await this.act(s, observation, decision, undefined, signal, trace);
            if (toggleKey) s.toggleActions.add(toggleKey);
            if (s.submission) { await this.confirmSubmission(s, signal); return; }
            if (windowOpened) { handoffWindow(); return; }
            if (decision.operation === "WAIT" && s.recentAction) {
              await this.waitForChange(s, observation, s.recentAction.at + 5000, signal);
            }
            lastAction = decision.operation === "WAIT" ? undefined : { before: fingerprint(observation), key };
            stale = 0; loadingDone = 0; used++;
          } catch (e) {
            if (!(e instanceof StaleObservation)) throw e;
            if (trace) { trace.outcome = "stale"; trace.staleReason = e.message; }
            if (++stale >= 3) { this.handoff(s, "no_progress", "Page kept changing or the target was covered; inspect it before resuming"); return; }
            await this.timed(s, "settleMs", () => delay(50, signal));
          }
        }
        s.page = await this.read(s, signal);
        if (this.reachedCheckpoint(s, s.page)) return;
        if (s.steps >= s.stepLimit) { s.status = "blocked"; s.stopReason = "step_limit"; s.reason = "Session step limit reached; independently check the outcome"; }
        else this.pause(s, "Explicit burst limit reached; inspect progress, then resume with this requestId");
      }));
    } catch (e) {
      if ((s.status as JevStatus) !== "stopped") {
        s.status = signal.aborted ? "stopped" : "error";
        s.stopReason = signal.aborted ? "cancelled" : "error";
        s.reason = signal.aborted ? "Execution cancelled or timed out; inspect the page before continuing" : e instanceof Error ? e.message : "Jev execution failed";
      }
      s.pending = undefined;
    } finally {
      unwatch();
      s.elapsedMs += performance.now() - started;
      s.abort = undefined;
      if (TERMINAL.has(s.status)) { s.endedAt ??= performance.now(); s.inputs = []; }
      else s.returnedAt = performance.now();
    }
    return this.result(s);
  }

  private async act(s: Session, observation: Observation, decision: Decision, text: string | undefined, signal: AbortSignal, trace?: DecisionTrace, input?: ProvidedInput): Promise<void> {
    const handle = await this.timed(s, "preflightMs", () => prepare(this.page, observation, decision, signal, !!input));
    const field = observation.elements.find(e => e.ref === decision.target?.split(":")[0]);
    const entry: HistoryEntry = { operation: decision.operation, target: decision.target, label: field?.label, outcome: "uncertain",
      ...(decision.operation === "CLICK" && field?.checked !== undefined ? { checkedBefore: field.checked } : {}) };
    if (s.completion && decision.operation === "CLICK" && field?.role === "button" &&
        field.label.replace(/\s+/g, " ").trim() === s.completion.submitLabel.replace(/\s+/g, " ").trim()) {
      if (s.submission) { await handle?.dispose(); throw new Error("This session already dispatched its submit; no repeat is allowed"); }
      s.submission = { previousFeedback: (observation.feedback ?? []).map(f => JSON.stringify(f)) };
    }
    s.history.push(entry); s.steps++;
    // Consume before dispatch. A missing acknowledgement must never reuse text.
    if (input) s.inputs.splice(s.inputs.indexOf(input), 1);
    if (trace) trace.outcome = "uncertain";
    const dispatchedAt = performance.now();
    try {
      await this.timed(s, "actionMs", () => execute(this.page, observation, decision, handle, text, signal));
      entry.outcome = "executed";
      if (trace) trace.outcome = "executed";
    } catch {
      throw new Error("Action may have executed; it will not be retried. Inspect the page before starting another goal");
    } finally { await handle?.dispose().catch(() => {}); }
    // Execution has already been recorded. A lost post-action read cannot cause a retry.
    await this.timed(s, "settleMs", () => settle(this.page, observation, decision, signal));
    if (["CLICK", "TYPE_TEXT", "SELECT"].includes(decision.operation)) s.recentAction = { before: observation, at: dispatchedAt };
    if (entry.checkedBefore !== undefined) {
      try {
        const current = await this.read(s, signal);
        s.page = current;
        if (current.documentId === observation.documentId) entry.checkedAfter = current.elements.find(e => e.ref === decision.target)?.checked;
      } catch (error) {
        // The acknowledged click can navigate. A stale post-action read is
        // not a stale preflight and must not lose the recorded toggle.
        if (!(error instanceof StaleObservation)) throw error;
      }
    }
    if (decision.operation === "TYPE_TEXT") {
      const current = await this.read(s, signal);
      s.page = current;
      if (current.documentId !== observation.documentId || current.url !== observation.url ||
          current.elements.find(e => e.ref === decision.target)?.value !== text) {
        throw new Error("Text was dispatched but the editor did not retain the requested value; inspect it before continuing. Input will not be retried");
      }
      this.rememberText(s, current, current.elements.find(e => e.ref === decision.target)!, text!);
    }
  }
}

const controllers = new WeakMap<Page, JevController>();
export function jev(page: Page, input: JevInput): Promise<JevResult> {
  let controller = controllers.get(page);
  if (!controller) { controller = new JevController(page); controllers.set(page, controller); }
  return controller.call(input);
}
