/** Shared advertised schema; parseJevInput remains the runtime trust boundary. */
export const checkpointSchema = {
          type: "object", additionalProperties: false, minProperties: 1,
          description: "Run-only AND checkpoint: stop as soon as fresh visible page evidence matches, without another Jev call. Use known URL/text/field expectations. Mutually exclusive with submission completion. All evidence still needs independent host verification.",
          properties: {
            url: { type: "object", additionalProperties: false, required: ["origin"], properties: {
              origin: { type: "string", description: "HTTP(S) origin only, e.g. https://x.com." },
              pathname: { type: "string", description: "Exact literal path starting with /; excludes query/fragment." },
              pathnameIncludes: { type: "string", description: "Literal path fragment starting with /, e.g. /status/. Not a regex." },
            } },
            text: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", minLength: 1, maxLength: 500 }, description: "Every fragment must appear in visible text (whitespace normalized, case-insensitive by default)." },
            rows: { type: "array", minItems: 1, maxItems: 10, items: {
              type: "object", additionalProperties: false, required: ["text"], properties: {
                text: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", minLength: 1, maxLength: 500 } },
              },
            }, description: "Each group must match in one rendered table/grid data row; headings and query summaries do not count." },
            matchCase: { type: "boolean", description: "Require exact case for text fragments (default false). Does not affect exact field values." },
            fields: { type: "array", minItems: 1, maxItems: 10, items: {
              type: "object", additionalProperties: false, required: ["label"], properties: {
                label: { type: "string", minLength: 1, maxLength: 200 }, role: { type: "string" },
                contextIncludes: { type: "string", minLength: 1, maxLength: 200 },
                value: { type: "string", maxLength: 2000 }, checked: { type: "boolean" }, selected: { type: "boolean" },
              },
            }, description: "Unique visible field label (optional role) plus at least one expected value/checked/selected state." },
          },
        };
export const routingSchema = {
  type: "object", additionalProperties: false,
  description: "Run-only confidence floors. Plans default to 0.5 for operation and target; goal-only DONE also defaults to 0.5. Tune on task-specific evidence, not as a guaranteed error probability.",
  properties: { minConfidence: { type: "number", minimum: 0, maximum: 1 }, minTargetConfidence: { type: "number", minimum: 0, maximum: 1 } },
};

export const planSchema = {
  type: "object", additionalProperties: false, required: ["origins", "targets", "stages"],
  description: "Host-authored conditional browser program. Prefer for multi-step tasks: known controls run locally; semantic targets use Jev; every stage requires outcome evidence. No site-specific selectors. Mutually exclusive with top-level inputs/until/completion. Read help jev-plans for authoring examples.",
  properties: {
    origins: { type: "array", minItems: 1, maxItems: 10, items: { type: "string" }, description: "Allowed HTTP(S) origins, without paths or credentials. Leaving these origins hands control to the host." },
    start: { type: "string", description: "Entry stage id; defaults to the first stage." },
    targets: {
      type: "object", maxProperties: 30,
      description: "Semantic target aliases. Use observed exact labels/hrefs when known. A description requires Jev even if only one candidate matches the hard filters. No refs or selectors.",
      additionalProperties: {
        type: "object", additionalProperties: false,
        properties: {
          label: { type: "string", maxLength: 200 }, role: { type: "string", maxLength: 50 },
          contextIncludes: { type: "string", maxLength: 200 },
          href: { type: "string", maxLength: 4000 },
          description: { type: "string", maxLength: 1000 },
          reuse: { type: "boolean", description: "Opt in only for stable identities (e.g. primary search field), never relative judgments (e.g. cheapest result). Verified bindings are reused only in the same document with unchanged identity and competing controls." },
        },
      },
    },
    stages: { type: "array", minItems: 1, maxItems: 30, items: {
      type: "object", additionalProperties: false, required: ["id", "goal"],
      properties: {
        id: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_-]*$", maxLength: 64 },
        goal: { type: "string", minLength: 1, maxLength: 2000 },
        before: { ...checkpointSchema, description: "Required preconditions before acting. If unmet, wait boundedly then hand off." },
        until: { ...checkpointSchema, description: "Required stage completion evidence. Mandatory for goal/wait stages and ordinary clicks. Field actions also verify their actual values." },
        wait: { type: "boolean", description: "Observe until evidence matches; no Jev calls or actions." },
        timeoutMs: { type: "integer", minimum: 100, maximum: 30000, description: "Local waiting deadline (default 5000 ms). Expiry hands off without repeating a dispatched action." },
        next: { type: ["string", "null"], description: "Next stage on success; omitted means following array element, null finishes." },
        branches: { type: "array", maxItems: 10, items: { type: "object", additionalProperties: false, required: ["when", "next"],
          properties: { when: checkpointSchema, next: { type: ["string", "null"] } },
        }, description: "After success, first matching branch wins; otherwise use next." },
        action: {
          type: "object", additionalProperties: false, required: ["operation", "target"],
          description: "One explicit action intent. Omit action to let Jev handle a whole bounded semantic goal (custom widget, unknown layout) until the stage checkpoint.",
          properties: {
            operation: { type: "string", enum: ["TYPE_TEXT", "CLICK", "SELECT"] },
            target: { type: "string", description: "An alias defined in plan.targets." },
            text: { type: "string", maxLength: 20000, description: "TYPE_TEXT only. Omit for a native host text handoff. Combined plan text <=20000 chars." },
            checked: { type: "boolean", description: "CLICK only, for checkbox/switch: ensure this state without toggling an already-correct field." },
            option: { type: "object", additionalProperties: false, properties: {
              label: { type: "string", maxLength: 200 }, value: { type: "string", maxLength: 2000 },
            }, description: "SELECT only. At least one exact label/value; if both, both must match." },
          },
        },
      },
    } },
  },
};
