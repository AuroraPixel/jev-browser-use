import type { JevResult } from "./types.ts";

/** A compact, actionable return envelope for native Codex/Claude reasoning. */
export function describeHandoff(result: Pick<JevResult, "status" | "stopReason" | "sessionId" | "requestId" | "reason">, modelSelected: boolean): JevResult["handoff"] {
  if (!result.requestId || !["needs_text", "needs_host", "paused"].includes(result.status)) return undefined;
  const next = result.status === "needs_text" ? "supply_text"
    : result.stopReason === "submission_unconfirmed" ? "verify_submission"
    : result.stopReason === "new_window" ? "inspect_new_window"
    : result.stopReason === "burst_limit" ? "resume" : "inspect_page";
  const instruction = next === "supply_text" ? "Use the goal, field and current page to write text natively, then add text to resume. Stop if required information is unavailable."
    : next === "verify_submission" ? "Inspect the submitted result. Resume only observes late confirmation; never repeat the submit."
    : next === "inspect_new_window" ? "Use openedPages targetId with browser.getPage(targetId), or refresh browser.listPages() while attachment finishes. Inspect the child result; do not repeat the opening action."
    : next === "resume" ? "Review progress and resume the same goal without text."
    : "Inspect the page, unmet checkpoint checks and recent actions. Resolve the issue before resuming without text; stop and start a new run if the goal must change.";
  return { source: result.status === "needs_text" ? "text" : modelSelected ? "model" : "runtime", next, instruction,
    resume: { action: "resume", sessionId: result.sessionId, requestId: result.requestId } };
}
