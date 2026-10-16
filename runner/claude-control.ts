/*
 * Claude Code's stdio permission protocol, as the Agent SDK speaks it.
 *
 * Started with `--input-format stream-json --permission-prompt-tool=stdio`,
 * the CLI writes a control request on stdout before using a tool that needs
 * permission:
 *
 *   {"type":"control_request","request_id":"…","request":{"subtype":"can_use_tool",
 *    "tool_name":"WebFetch","input":{…},"description":"https://example.com",
 *    "permission_suggestions":[{"type":"addRules","behavior":"allow",
 *      "rules":[{"toolName":"WebFetch","ruleContent":"domain:example.com"}]}]}}
 *
 * and waits for the answer on stdin:
 *
 *   {"type":"control_response","response":{"subtype":"success","request_id":"…",
 *    "response":{"behavior":"allow","updatedInput":{…}} | {"behavior":"deny","message":"…"}}}
 *
 * Nothing here does I/O; runner/execute.ts relays requests to the chat.
 */
import type { ToolRequest } from "./permissions";

type Suggestion = { type?: string; behavior?: string; rules?: { toolName?: string; ruleContent?: string }[] };
export type CanUseTool = {
  subtype: "can_use_tool";
  tool_name: string;
  input?: Record<string, unknown>;
  display_name?: string;
  title?: string;
  description?: string;
  permission_suggestions?: Suggestion[];
};
export type ControlRequest = { type: "control_request"; request_id: string; request: { subtype: string } & Partial<CanUseTool> };

export function isControlRequest(message: unknown): message is ControlRequest {
  const value = message as ControlRequest | null;
  return !!value && value.type === "control_request" && typeof value.request_id === "string" && typeof value.request?.subtype === "string";
}

/** The rule "always allow" would remember: the CLI's own suggestion, as a settings rule. */
export function suggestedRule(request: CanUseTool): string | null {
  for (const suggestion of request.permission_suggestions ?? []) {
    if (suggestion.type !== "addRules" || suggestion.behavior !== "allow") continue;
    const rule = suggestion.rules?.[0];
    if (!rule?.toolName) continue;
    return rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;
  }
  return null;
}

const one = (value: unknown) => (typeof value === "string" ? value : "");
/** What a person sees in the chat: a short line, and the full input to inspect. */
export function describeToolUse(request: CanUseTool): ToolRequest {
  const input = request.input ?? {};
  const name = request.display_name || request.tool_name;
  const target = one(input.url) || one(input.command) || one(input.query) || one(input.file_path) || one(request.description);
  const mcp = /^mcp__(.+?)__(.+)$/.exec(request.tool_name);
  const title = request.title
    || (mcp ? `Use ${mcp[2].replace(/_/g, " ")} from ${mcp[1].replace(/^claude_ai_/, "").replace(/_/g, " ")}` : target ? `${name}: ${target}` : `Use ${name}`);
  let detail = "";
  try { detail = JSON.stringify(input, null, 2); } catch { /* unserialisable input */ }
  return { tool: request.tool_name, title: title.slice(0, 300), detail: detail.slice(0, 4000) || undefined, rule: suggestedRule(request) };
}

export function allowResponse(requestId: string, request: CanUseTool) {
  return { type: "control_response", response: { subtype: "success", request_id: requestId, response: { behavior: "allow", updatedInput: request.input ?? {} } } };
}
export function denyResponse(requestId: string, message: string) {
  return { type: "control_response", response: { subtype: "success", request_id: requestId, response: { behavior: "deny", message } } };
}
/** For control requests this runner does not handle. */
export function errorResponse(requestId: string, error: string) {
  return { type: "control_response", response: { subtype: "error", request_id: requestId, error } };
}
