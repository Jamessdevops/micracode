import { describe, expect, test } from "bun:test";

import { mapClaudeLine } from "../src/cliHarness.js";

// Trimmed from a real `claude -p ... --output-format stream-json` run
// (see plan). Absolute file_path is intentional — the mapper must relativize it.
const WS = "/tmp/proj";
const INIT = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "sess-abc",
});
const ASSISTANT_TOOL = JSON.stringify({
  type: "assistant",
  message: {
    content: [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "Write",
        input: { file_path: `${WS}/app/page.tsx`, content: "x" },
      },
    ],
  },
});
const USER_RESULT = JSON.stringify({
  type: "user",
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        is_error: null,
        content: "ok",
      },
    ],
  },
});
const ASSISTANT_TEXT = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "text", text: "Done." }] },
});
const RESULT_ERR = JSON.stringify({
  type: "result",
  subtype: "error_max_turns",
  is_error: true,
  result: "boom",
});

describe("mapClaudeLine (stream-json -> pi-shaped events)", () => {
  test("init captures session id, emits nothing", () => {
    const ids: string[] = [];
    expect(mapClaudeLine(INIT, WS, (id) => ids.push(id))).toEqual([]);
    expect(ids).toEqual(["sess-abc"]);
  });

  test("Write tool_use -> write start with workspace-relative file_path", () => {
    const [ev] = mapClaudeLine(ASSISTANT_TOOL, WS);
    expect(ev.type).toBe("tool_execution_start");
    expect(ev.toolName).toBe("write");
    expect(ev.toolCallId).toBe("toolu_1");
    expect(ev.args.file_path).toBe("app/page.tsx"); // relativized from absolute
  });

  test("tool_result -> tool_execution_end (null is_error => false)", () => {
    const [ev] = mapClaudeLine(USER_RESULT, WS);
    expect(ev.type).toBe("tool_execution_end");
    expect(ev.toolCallId).toBe("toolu_1");
    expect(ev.isError).toBe(false);
  });

  test("assistant text -> text_delta", () => {
    const [ev] = mapClaudeLine(ASSISTANT_TEXT, WS);
    expect(ev.assistantMessageEvent).toEqual({
      type: "text_delta",
      delta: "Done.",
    });
  });

  test("error result -> message_end error", () => {
    const [ev] = mapClaudeLine(RESULT_ERR, WS);
    expect(ev).toEqual({
      type: "message_end",
      message: { stopReason: "error", errorMessage: "boom" },
    });
  });

  test("garbage line -> no events, no throw", () => {
    expect(mapClaudeLine("not json", WS)).toEqual([]);
  });
});
