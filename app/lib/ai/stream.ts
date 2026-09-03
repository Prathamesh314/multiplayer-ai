/**
 * Parsers that turn a coding CLI's streamed output into things to show live.
 *
 * Claude Code's default `-p` (print) mode buffers the whole answer and prints
 * it only when the run finishes — so the user stares at "Thinking…" for the
 * entire run and then the reply lands all at once. Driving it with
 * `--output-format stream-json --include-partial-messages` instead emits the
 * run as newline-delimited JSON events, which we decode here so the chat shows,
 * live and Conductor-style:
 *
 *   - reply     the assistant's answer, token by token
 *   - thinking  the reasoning trace, so a long run reads as working, not frozen
 *   - activity  each tool step ("Read note.txt", "Bash: npm test") as it happens
 *
 * Only the reply is durable — thinking and activity are ephemeral progress and
 * are not stored with the turn. Tool input arrives split across many JSON
 * lines, so the parser is stateful: it reassembles each tool call's input by
 * content-block index and emits one activity line when the block closes.
 */

/** A piece of streamed output, tagged so the UI can show each differently. */
export type StreamPiece =
  | { kind: "reply"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "activity"; text: string };

/** A stateful, line-at-a-time decoder. `push` returns 0+ pieces per line. */
export type StreamParser = { push: (line: string) => StreamPiece[] };

type Delta = {
  type?: string;
  text?: string;
  thinking?: string;
  partial_json?: string;
};
type ContentBlock = { type?: string; name?: string };
type StreamEvent = {
  type?: string;
  index?: number;
  delta?: Delta;
  content_block?: ContentBlock;
};
type StreamLine = { type?: string; event?: StreamEvent };

/**
 * A decoder for `claude --output-format stream-json`. Reassembles tool input
 * across `input_json_delta` lines keyed by content-block index, so a tool call
 * becomes a single readable activity line when its block closes.
 */
export function createClaudeStreamParser(): StreamParser {
  const tools = new Map<number, { name: string; json: string }>();

  return {
    push(line: string): StreamPiece[] {
      const trimmed = line.trim();
      if (!trimmed) return [];

      let parsed: StreamLine;
      try {
        parsed = JSON.parse(trimmed) as StreamLine;
      } catch {
        return [];
      }
      if (parsed.type !== "stream_event" || !parsed.event) return [];
      const event = parsed.event;

      // A tool call begins: remember its name so streamed input can be attached.
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block?.type === "tool_use" && typeof event.index === "number") {
          tools.set(event.index, { name: String(block.name ?? "tool"), json: "" });
        }
        return [];
      }

      if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          return [{ kind: "reply", text: delta.text }];
        }
        if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
          return [{ kind: "thinking", text: delta.thinking }];
        }
        if (delta?.type === "input_json_delta" && typeof event.index === "number") {
          const tool = tools.get(event.index);
          if (tool && typeof delta.partial_json === "string") tool.json += delta.partial_json;
        }
        return [];
      }

      // A tool call is fully formed: turn its input into one activity line.
      if (event.type === "content_block_stop" && typeof event.index === "number") {
        const tool = tools.get(event.index);
        if (tool) {
          tools.delete(event.index);
          return [{ kind: "activity", text: toolActivity(tool.name, tool.json) }];
        }
      }

      return [];
    },
  };
}

/** A short, human label for a tool call, e.g. `Read app/x.ts` or `Bash: ls`. */
function toolActivity(name: string, inputJson: string): string {
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(inputJson || "{}") as Record<string, unknown>;
  } catch {
    // Partial or malformed input — the tool name alone still reads clearly.
  }

  const str = (key: string): string | null =>
    typeof input[key] === "string" ? (input[key] as string) : null;

  const path = str("file_path") ?? str("path") ?? str("notebook_path");
  if (path) return `${name} ${shorten(path)}`;

  const command = str("command");
  if (command) return `${name}: ${firstLine(command)}`;

  const pattern = str("pattern");
  if (pattern) return `${name} ${firstLine(pattern)}`;

  const url = str("url");
  if (url) return `${name} ${url}`;

  const description = str("description") ?? str("prompt");
  if (description) return `${name}: ${firstLine(description)}`;

  return name;
}

/** Keeps the tail of a long path — the filename is what identifies it. */
function shorten(path: string, max = 40): string {
  return path.length <= max ? path : `…${path.slice(-(max - 1))}`;
}

function firstLine(text: string, max = 60): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}
