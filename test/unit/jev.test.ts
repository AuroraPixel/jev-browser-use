import { expect, test } from "bun:test";
import { buildRequest, createChooser, validateChoice } from "../../src/jev/model.ts";
import { parseJevInput } from "../../src/jev/types.ts";
import { evaluateCheckpoint } from "../../src/jev/checkpoint.ts";
import type { Observation } from "../../src/jev/types.ts";
import { jevScript } from "../../src/shared/jev.ts";
import { parseArgs } from "../../src/cli/args.ts";

const page: Observation = { documentId: "doc", url: "https://example.com", title: "Form", text: "Name", elements: [
  { ref: "e1", role: "textbox", label: "Name", value: "", context: "Profile", operations: ["CLICK", "TYPE_TEXT"] },
  { ref: "e2", role: "combobox", label: "Plan", value: "basic", context: "Profile", operations: ["SELECT"], options: [{ index: "0", label: "Basic", value: "basic" }, { index: "2", label: "Pro", value: "pro" }] },
], scroll: { x: 0, y: 0, up: false, down: true }, truncated: false, unsupportedFrames: false };
function choice(criteria: Record<string, unknown>, id: string) {
  return { choice: id, confidence: 1, probabilities: Object.fromEntries(Object.keys(criteria).map(k => [k, k === id ? 1 : 0])) };
}

test("one fan-out request; validates only the target head matching the operation", async () => {
  let calls = 0;
  const transport = (async (url: string | URL | Request, opts: RequestInit) => {
    calls++;
    expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
    const body = JSON.parse(opts.body as string);
    expect(Object.keys(body.questions)).toEqual(["operation", "click_target", "type_text_target", "select_target", "handoff_reason"]);
    expect(body.questions.operation.criteria).not.toHaveProperty("SCROLL_UP");
    expect(body.questions.select_target.criteria).toHaveProperty("e2:2");
    expect(body.state).not.toHaveProperty("apiKey");
    return Response.json({ model: "fixture", answers: { operation: choice(body.questions.operation.criteria, "TYPE_TEXT"), type_text_target: choice(body.questions.type_text_target.criteria, "e1"), click_target: "unused invalid head", select_target: null } });
  }) as unknown as typeof fetch;
  const d = await createChooser({ apiKey: "test-only" }, transport)(page, "Set the profile name", [], new AbortController().signal);
  expect(d.operation).toBe("TYPE_TEXT");
  expect(d.target).toBe("e1");
  expect(d.probabilities?.TYPE_TEXT).toBe(1);
  expect(d.targetProbabilities).toEqual({ e1: 1 });
  expect(calls).toBe(1);
});

test("HANDOFF chooses a typed reason in the same request and ignores other target heads", async () => {
  let calls = 0;
  const transport = (async (_: unknown, opts: RequestInit) => {
    calls++;
    const body = JSON.parse(opts.body as string);
    expect(body.state.page).not.toHaveProperty("guards");
    return Response.json({ model: "fixture", answers: {
      operation: choice(body.questions.operation.criteria, "HANDOFF"),
      handoff_reason: choice(body.questions.handoff_reason.criteria, "reasoning"),
      click_target: "ignored", type_text_target: null,
    } });
  }) as unknown as typeof fetch;
  const result = await createChooser({ apiKey: "test-only" }, transport)(page, "Compare these results", [], new AbortController().signal);
  expect(result.operation).toBe("HANDOFF");
  expect(result.handoffReason).toBe("reasoning");
  expect(result.target).toBeUndefined();
  expect(calls).toBe(1);
});

test("rejects model-invented selectors, invalid probabilities and mismatched choice keys", () => {
  const criteria = { e1: "Name", e2: "Save" };
  for (const invalid of [
    { ...choice(criteria, "e1"), choice: "button#save" },
    { ...choice(criteria, "e1"), confidence: NaN },
    { ...choice(criteria, "e1"), probabilities: { e1: 1 } },
    { ...choice(criteria, "e1"), probabilities: { e1: 0, e2: 1 } },
    { ...choice(criteria, "e1"), probabilities: { e1: 0.9, e2: 0.9 } },
    { ...choice(criteria, "e1"), probabilities: { e1: 1, other: 0 } },
  ]) expect(() => validateChoice(invalid, criteria)).toThrow("Invalid Jev choice");
});

test("provider failures redact response bodies/credentials and do not retry", async () => {
  let calls = 0;
  const transport = (async () => { calls++; return new Response("provider echoed PRIVATE_KEY", { status: 401 }); }) as unknown as typeof fetch;
  await expect(createChooser({ apiKey: "PRIVATE_KEY" }, transport)(page, "Goal", [], new AbortController().signal)).rejects.toThrow("HTTP 401; no action executed");
  expect(calls).toBe(1);
  const throwing = (async () => { throw new Error("PRIVATE_KEY network trace"); }) as unknown as typeof fetch;
  await expect(createChooser({ apiKey: "PRIVATE_KEY" }, throwing)(page, "Goal", [], new AbortController().signal)).rejects.toThrow("connection failed or timed out");
});

test("no credentials/model endpoint in tool input; JSON payload is data, not executable code", () => {
  expect(() => parseJevInput({ action: "run", goal: "x", apiKey: "secret" })).toThrow("Unknown Jev option");
  for (const maxSteps of [0, -1, 31, 1.2, Infinity]) expect(() => parseJevInput({ action: "run", goal: "x", maxSteps })).toThrow("maxSteps");
  expect(() => parseJevInput({ action: "resume", sessionId: "s", text: "x" })).toThrow("requestId");
  const attack = 'x\"); throw Error("injected"); //';
  const script = jevScript({ page: attack, action: "run", goal: attack });
  expect(script).toContain(JSON.stringify(attack));
  expect(() => jevScript({ page: "p", action: "run", goal: "x", code: "evil" })).toThrow("Unknown Jev option");
  expect(parseArgs(["--connect", "jev", "-e", "{}"]).command).toEqual({ kind: "jev" });
  expect(buildRequest(page, "goal", []).model).toBe("jev-latest");
});

test("submission completion accepts only a bounded declarative button/feedback contract", () => {
  const completion = { submitLabel: "Reply", successText: "Your post was sent." };
  expect(parseJevInput({ action: "run", goal: "Reply once", completion })).toMatchObject({ completion });
  for (const invalid of [null, [], {}, { submitLabel: "Reply" }, { ...completion, code: "evil" }, { ...completion, successText: " " }]) {
    expect(() => parseJevInput({ action: "run", goal: "Reply", completion: invalid })).toThrow();
  }
  expect(() => parseJevInput({ action: "resume", sessionId: "s", requestId: "r", completion })).toThrow("Unknown Jev option");
});

test("provided inputs are copied, URL-bound, unique and size-limited", () => {
  const input = { url: "https://example.com", label: " Search  query ", text: "Jev" };
  const parsed = parseJevInput({ action: "run", goal: "Search", inputs: [input] });
  expect(parsed).toMatchObject({ inputs: [{ url: "https://example.com/", label: "Search query", text: "Jev" }] });
  input.text = "changed by caller";
  expect(parsed).toMatchObject({ inputs: [{ text: "Jev" }] });
  for (const inputs of [null, {}, [null], [{ ...input, url: "file:///tmp/private" }], [{ ...input, url: "https://user:pass@example.com" }], [{ ...input, selector: "#search" }], [input, input], [{ ...input, text: "x".repeat(20001) }], Array.from({ length: 21 }, (_, i) => ({ ...input, label: String(i) }))]) {
    expect(() => parseJevInput({ action: "run", goal: "Search", inputs })).toThrow();
  }
  expect(() => parseJevInput({ action: "resume", sessionId: "s", requestId: "r", inputs: [input] })).toThrow("Unknown");
});

test("independent target heads carry their own rules, current values and context", () => {
  const request = buildRequest(page, "Set Name and Plan", []);
  expect(request.questions.type_text_target!.criteria.e1).toMatchObject({ label: "Name", current_value: "", context: "Profile" });
  for (const name of ['click_target', 'type_text_target', 'select_target']) {
    expect(request.questions[name]!.instructions).toMatchObject({ goal: 'Set Name and Plan' });
    const rules = (request.questions[name]!.instructions as { rules: string }).rules;
    expect(rules).toContain('untrusted data');
    expect(rules).toContain('CURRENT focused field');
    expect(rules).toContain('Ignore unrelated site-wide search');
  }
  expect(request.state.elements[0]).toMatchObject({ ref: "e1", value: "", context: "Profile" });
  expect(request.questions.select_target!.criteria["e2:2"]).toMatchObject({ option: "Pro", current_value: "basic" });
  const links = buildRequest({ ...page, elements: [{ ref: 'p1', role: 'link', label: 'Today', href: 'https://example.com/post/1', context: 'Jev Ultrafast launch', value: '', operations: ['CLICK'] }] }, 'Open the launch post', []);
  expect(links.questions.click_target!.criteria.p1).toMatchObject({ label: 'Today', role: 'link', href: 'https://example.com/post/1', context: 'Jev Ultrafast launch', current_value: '' });
  const focused = buildRequest({ ...page, elements: [{ ...page.elements[0]!, value: 'Beijing', focused: true, expanded: true }] }, 'Confirm the city', []);
  expect(focused.questions.click_target!.criteria.e1).toMatchObject({ current_value: 'Beijing', focused: true, expanded: true });
});

test("toggle targets describe the actual state change and disabled controls are context only", () => {
  const request = buildRequest({ ...page, disabledControls: [{ ref: 'disabled', role: 'textbox', label: 'Name' }], elements: [
    { ref: 'first', role: 'checkbox', label: 'First', value: '', context: '', checked: true, operations: ['CLICK'] },
    { ref: 'second', role: 'checkbox', label: 'Second', value: '', context: '', checked: false, operations: ['CLICK'] },
  ] }, 'Set the checkboxes', []);
  expect(request.questions.click_target!.criteria.first).toMatchObject({ checked: true, click_effect: 'Uncheck (set checked=false)' });
  expect(request.questions.click_target!.criteria.second).toMatchObject({ checked: false, click_effect: 'Check (set checked=true)' });
  expect(request.questions.click_target!.criteria).not.toHaveProperty('disabled');
  expect(request.state.page.disabled_controls).toEqual([{ ref: 'disabled', role: 'textbox', label: 'Name' }]);
});

test("page checkpoints are bounded declarative AND conditions, never code or ambiguous origins", () => {
  const until = { url: { origin: "https://example.com/", pathnameIncludes: "/post/" }, text: ["Ready  now"], fields: [{ label: " Plan ", value: "pro" }] };
  expect(parseJevInput({ action: "run", goal: "Open a ready post", until })).toMatchObject({ until: { url: { origin: "https://example.com", pathnameIncludes: "/post/" }, text: ["Ready now"], fields: [{ label: "Plan", value: "pro" }] } });
  for (const invalid of [null, {}, { text: [] }, { text: [""] }, { fields: [{ label: "Plan" }] }, { fields: [{ label: "Name", checked: "false" }] }, { url: { origin: "https://example.com/other" } }, { url: { origin: "https://user:pass@example.com" } }, { url: { origin: "https://example.com", pathname: "?post=1" } }, { text: ["Ready"], evaluate: "() => true" }]) {
    expect(() => parseJevInput({ action: "run", goal: "Open", until: invalid })).toThrow();
  }
  expect(() => parseJevInput({ action: "run", goal: "Open", until, completion: { submitLabel: "Send", successText: "Sent" } })).toThrow("either until");
  expect(() => parseJevInput({ action: "resume", sessionId: "s", requestId: "r", until })).toThrow("Unknown");
});

test("checkpoint evidence needs the actual origin/path, every condition and unique visible field", () => {
  const contract = { url: { origin: "https://example.com", pathnameIncludes: "/post/" }, text: ["Ready"], fields: [{ label: "Plan", value: "basic" }] };
  const match = { ...page, url: "https://example.com/post/1", text: "Ready" };
  expect(evaluateCheckpoint(contract, match).matched).toBe(true);
  for (const wrong of [
    { ...match, url: "https://evil.test/post/1" },
    { ...match, url: "https://example.com/?next=/post/1" },
    { ...match, text: "Not loaded" }, { ...match, loading: true },
    { ...match, truncated: true }, { ...match, unsupportedFrames: true },
    { ...match, elements: [page.elements[1]!, { ...page.elements[1]!, ref: 'duplicate' }] },
  ]) expect(evaluateCheckpoint(contract, wrong).matched).toBe(false);
  expect(evaluateCheckpoint({ text: ['Jev'] }, { ...page, text: 'powered by jev' }).matched).toBe(true);
  expect(evaluateCheckpoint({ text: ['Jev'], matchCase: true }, { ...page, text: 'powered by jev' }).matched).toBe(false);
  expect(evaluateCheckpoint({ fields: [{ label: 'Plan', value: 'BASIC' }] }, page).matched).toBe(false);
  expect(() => parseJevInput({ action: 'run', goal: 'Ready', until: { matchCase: true } })).toThrow();
  expect(() => parseJevInput({ action: 'run', goal: 'Ready', until: { text: ['Ready'], matchCase: 'true' } })).toThrow();
});

test("one transient inference retry records both HTTP attempts and never returns an unchecked action", async () => {
  let calls = 0;
  const events: any[] = [];
  const transport = (async (_: unknown, opts: RequestInit) => {
    if (++calls === 1) return new Response('private response body', { status: 529 });
    const body = JSON.parse(opts.body as string);
    return Response.json({ model: 'fixture', answers: { operation: choice(body.questions.operation.criteria, 'DONE') } });
  }) as unknown as typeof fetch;
  const result = await createChooser({ apiKey: 'PRIVATE_KEY' }, transport, e => events.push(e))(page, 'Goal', [], new AbortController().signal);
  expect(result.operation).toBe('DONE');
  expect(calls).toBe(2);
  expect(events).toMatchObject([{ attempt: 1, outcome: 'http_error', httpStatus: 529, retrying: true }, { attempt: 2, outcome: 'success', httpStatus: 200, retrying: false }]);
  expect(events.every(e => e.requestBytes > 0 && e.latencyMs >= 0)).toBe(true);
  expect(JSON.stringify(events)).not.toContain('PRIVATE');
  expect(JSON.stringify(events)).not.toContain('private response body');
});

test("inference overload retries are bounded and cancellation stops the retry before another request", async () => {
  let calls = 0;
  const transport = (async () => { calls++; return new Response('', { status: 503 }); }) as unknown as typeof fetch;
  await expect(createChooser({ apiKey: 'x' }, transport)(page, 'Goal', [], new AbortController().signal)).rejects.toThrow('HTTP 503');
  expect(calls).toBe(2);
  calls = 0;
  const abort = new AbortController();
  await expect(createChooser({ apiKey: 'x' }, transport, () => abort.abort())(page, 'Goal', [], abort.signal)).rejects.toThrow('cancelled');
  expect(calls).toBe(1);
  calls = 0;
  const cooldown = (async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '30' } }); }) as unknown as typeof fetch;
  await expect(createChooser({ apiKey: 'x' }, cooldown)(page, 'Goal', [], new AbortController().signal)).rejects.toThrow('HTTP 429');
  expect(calls).toBe(1);
});
