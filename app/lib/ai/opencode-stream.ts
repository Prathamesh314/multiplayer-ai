import type { StreamParser } from "./stream";

export function createOpenCodeStreamParser(): StreamParser {
  return {
    push(line) {
      let event;
      try { event = JSON.parse(line); } catch { return []; }
      if (event?.type === "text" && typeof event.part?.text === "string") return [{ kind: "reply", text: event.part.text }];
      if (event?.type === "tool_use" && typeof event.part?.tool === "string") return [{ kind: "activity", text: event.part.tool }];
      if (event?.type === "error") return [{ kind: "error", text: "OpenCode reported a provider error. Check the selected model and credentials on your runner." }];
      return [];
    },
  };
}
