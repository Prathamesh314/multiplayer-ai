/**
 * A failed run, said plainly. AI tools fail with stack traces and retry noise
 * on stderr; the chat shows one sentence about what went wrong and what to do,
 * and keeps the full output under it as the agent log. Used where a failure is
 * stored (finalize) and where it is shown live (the chat), so both read alike.
 */

/** Between the explanation and the raw output in a stored failure message. */
export const AGENT_LOG = "\n\n--- Agent log ---\n";

export type ToolInfo = { name: string; signIn?: string };

const RULES: { test: RegExp; say: (tool: ToolInfo) => string }[] = [
  {
    test: /self[- ]signed certificate|unable to (?:get|verify) (?:local )?issuer certificate|UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_HAS_EXPIRED|certificate has expired|SELF_SIGNED_CERT/i,
    say: tool => `${tool.name} couldn’t make a secure connection to its AI service: a certificate on your network isn’t trusted. This is usually antivirus or a company proxy inspecting HTTPS. Allow ${tool.name} in your antivirus, or ask your IT team for their certificate.`,
  },
  {
    test: /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|ENETUNREACH|EHOSTUNREACH|getaddrinfo|socket hang up|network ?error|Could not resolve host|Failed to connect|connection (?:refused|reset|timed out)|UND_ERR_CONNECT/i,
    say: tool => `${tool.name} couldn’t reach its AI service over the network. Check the internet connection on your computer; on a VPN, proxy or company network, make sure ${tool.name} is allowed through. Then try again.`,
  },
  {
    test: /not (?:logged|signed) in|please (?:log|sign) ?in|login required|unauthori[sz]ed|\b401\b|invalid (?:api[_ -]?key|x-api-key|authentication)|API key not valid|authentication (?:failed|required|error)|credentials? (?:are |is )?(?:missing|invalid|expired)|token (?:has )?expired/i,
    say: tool => `${tool.name} isn’t signed in on your computer, or its sign-in has expired.${tool.signIn ? ` Run ${tool.signIn} in a terminal there, then try again.` : " Sign in to it in a terminal there, then try again."}`,
  },
  {
    test: /\b429\b|rate[ -]?limit|quota|RESOURCE_EXHAUSTED|usage limit|too many requests|credit balance|insufficient[_ ](?:quota|credits)/i,
    say: tool => `${tool.name} hit a usage or rate limit with its AI provider. Wait a little and try again, or check your plan or billing with the provider.`,
  },
  {
    test: /model[^\n]{0,80}(?:not found|does not exist|not supported|isn’t available|isn't available|is unavailable|not available)|invalid model|unknown model|does not have access to (?:the )?model/i,
    say: tool => `The chosen model isn’t available to ${tool.name} on your computer. Pick another model in the message box and try again.`,
  },
];

/** The last line that says something: not a stack frame, a retry notice or a blank. */
function lastMeaningfulLine(raw: string): string | null {
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(line =>
    line && !/^at\s/.test(line) && !/^Attempt \d+ failed/i.test(line) && !/^[-=─]+$/.test(line));
  const line = lines.at(-1);
  return line ? line.replace(/^(?:Error|TypeError|Exception):\s*/i, "").slice(0, 240) : null;
}

export function explainFailure(raw: string, tool: ToolInfo): string {
  const text = raw.trim();
  if (!text) return `${tool.name} stopped without saying why. Try again; if it keeps happening, run it once in a terminal on your computer to see its message.`;
  // Messages from this app and the runner are already written for people.
  if (/Git was not found/.test(text)) return text.split(/\r?\n/).find(line => /Git was not found/.test(line))!.replace(/^Git \S+ failed:\s*/, "");
  if (/Execution limit reached/i.test(text)) return "This task ran past its time or output limit and was stopped.";
  for (const rule of RULES) if (rule.test.test(text)) return rule.say(tool);
  if (text.length <= 240 && !text.includes("\n")) return text;
  const line = lastMeaningfulLine(text);
  return line ? `${tool.name} stopped with an error: ${line}` : `${tool.name} stopped with an error.`;
}

/** A failure as stored: the explanation, then the agent log. */
export function failureMessage(raw: string, tool: ToolInfo): string {
  const text = raw.trim();
  return text ? `${explainFailure(text, tool)}${AGENT_LOG}${text}` : explainFailure(text, tool);
}

/** A stored failure split back into its explanation and log; null for other messages. */
export function splitFailure(body: string): { message: string; log: string } | null {
  const at = body.indexOf(AGENT_LOG);
  return at < 0 ? null : { message: body.slice(0, at), log: body.slice(at + AGENT_LOG.length) };
}
