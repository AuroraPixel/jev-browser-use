import { parseJevInput, type JevConfig } from "../jev/types.ts";

/** Read per caller, so setting a key also works with an already-running daemon. */
export function jevConfigFromEnv(): JevConfig {
  return { apiKey: process.env.TYPESAFE_API_KEY, model: process.env.TYPESAFE_MODEL, proxy: process.env.TYPESAFE_PROXY };
}

/** A fixed script with a JSON payload: no model-supplied code or shell evaluation. */
export function jevScript(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Jev input must be a JSON object");
  const { page, ...rest } = value as Record<string, unknown>;
  if (typeof page !== "string" || !page.trim() || page.length > 200) throw new TypeError("page must be an existing tab name or target id");
  const input = parseJevInput(rest);
  return `const page = await browser.getPage(${JSON.stringify(page)});\nawait page.jev(${JSON.stringify(input)});`;
}
