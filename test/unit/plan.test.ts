import { expect, test } from "bun:test";
import { parseJevInput } from "../../src/jev/types.ts";
import { jevScript } from "../../src/shared/jev.ts";

const plan = {
  origins: ["https://example.com"], targets: { name: { label: "Name" } },
  stages: [{ id: "fill", goal: "Fill name", action: { operation: "TYPE_TEXT", target: "name", text: "Ada" } }],
};
test("plans cross the same script/CLI/MCP validation boundary", () => {
  const parsed = parseJevInput({ action: "run", goal: "Fill", plan });
  expect(parsed).toMatchObject({ plan: { start: "fill", origins: ["https://example.com"] } });
  expect(jevScript({ page: "main", action: "run", goal: "Fill", plan })).toContain('"plan"');
  expect(() => parseJevInput({ action: "run", goal: "Fill", plan, until: { text: ["Ready"] } })).toThrow();
});
test("plans reject code, unbounded/invalid graphs and incomplete action contracts", () => {
  const invalid = [
    { ...plan, origins: ["https://example.com/path"] },
    { ...plan, targets: { name: { selector: "#name" } } },
    { ...plan, targets: { name: { label: "Name", reuse: "yes" } } },
    { ...plan, targets: { name: { role: "textbox" } } },
    { ...plan, start: "missing" },
    { ...plan, stages: [{ ...plan.stages[0], next: "missing" }] },
    { ...plan, stages: [plan.stages[0], plan.stages[0]] },
    { ...plan, stages: [{ ...plan.stages[0], action: { operation: "CLICK", target: "name" } }] },
    { ...plan, stages: [{ ...plan.stages[0], action: { operation: "TYPE_TEXT", target: "missing" } }] },
    { ...plan, stages: [{ ...plan.stages[0], action: { operation: "SELECT", target: "name", option: {} } }] },
    { ...plan, stages: [{ ...plan.stages[0], wait: true }] },
    { ...plan, stages: [{ id: "empty", goal: "No evidence" }] },
    { ...plan, stages: [{ ...plan.stages[0], timeoutMs: 600000 }] },
  ];
  for (const bad of invalid) expect(() => parseJevInput({ action: "run", goal: "Fill", plan: bad })).toThrow();
});
test("routing thresholds validate and legacy runs remain compatible", () => {
  expect(parseJevInput({ action: "run", goal: "Open" })).not.toHaveProperty("routing");
  expect(parseJevInput({ action: "run", goal: "Open", routing: { minConfidence: 0.6 } })).toMatchObject({ routing: { minConfidence: 0.6 } });
  for (const routing of [null, { minConfidence: -1 }, { minTargetConfidence: NaN }, { minConfidence: 2 }, { model: "ignored" }]) {
    expect(() => parseJevInput({ action: "run", goal: "Open", routing })).toThrow();
  }
});
