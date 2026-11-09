import { describe, expect, test } from "bun:test";
import { HANDED_OVER, PUT_TO } from "../src/lib/copilot/markers";
import {
  asText,
  browserCallFailed,
  DECLINED_BY_PERSON,
  DECLINED_FOR_PERSON,
  flaggedFailure,
  forDisplay,
  refusalOf,
  saidItWentAhead,
  toolResultFailed,
  unofferedTool,
} from "../src/lib/plugins/tool-result";

/**
 * What a tool actually said, recovered from how the transcript carries it.
 *
 * A tool returns a string and the runtime puts it into a message as JSON, so everything arriving at
 * the screen is encoded. Getting this wrong is not only ugly: the refusal marker is matched against
 * the start of this text, and an encoded string starts with a quote.
 */
describe("reading a tool's answer", () => {
  test("a JSON-encoded string is unwrapped, escapes and all", () => {
    const refusal =
      'This deployment\'s policy does not allow that: search_notes on notes is blocked by the rule `mcp.server == "notes"`.';
    expect(asText(JSON.stringify(refusal))).toBe(refusal);
  });

  test("a refusal is still recognisable as one after decoding", () => {
    const encoded = JSON.stringify("Refused. The rule says no.");
    // The check the transcript makes. Against the raw text it is false, which is the bug.
    expect(encoded.startsWith("Refused.")).toBe(false);
    expect(asText(encoded).startsWith("Refused.")).toBe(true);
  });

  test("plain text is left alone", () => {
    expect(asText("Meals under $75 need no receipt.")).toBe(
      "Meals under $75 need no receipt.",
    );
  });

  /*
   * An envelope is not a string, and unwrapping one here would take the vendor's structure apart
   * before forDisplay has had the chance to find the answer inside it.
   */
  test("a JSON object or array is left for forDisplay", () => {
    expect(asText('{"results":"# Found"}')).toBe('{"results":"# Found"}');
    expect(asText("[1,2]")).toBe("[1,2]");
  });

  test("something that only looks like JSON is drawn as it came", () => {
    expect(asText('"unterminated')).toBe('"unterminated');
  });

  test("an encoded envelope is decoded and then unwrapped", () => {
    expect(forDisplay(JSON.stringify('{"results":"# Found\\n\\nBody"}'))).toBe(
      "# Found\n\nBody",
    );
  });
});

/**
 * The two lines a hop draws.
 *
 * Both read an outcome out of the tool's own prose, which is what a server-side tool leaves
 * available, and both read it through `asText` for the reason above: matched against the raw value
 * the prefix never matches, and every accepted hop was drawn as Blocked.
 */
describe("telling an accepted hop from a refused one", () => {
  /*
   * Read from the server's own source, not retyped.
   *
   * These markers cross a network: the server writes the sentence and the transcript reads its first
   * words. Nothing coupled the two ends, so a rewording on the server left every accepted hop drawn
   * as Blocked with the whole suite green — which is the bug both renderers' comments recount. The
   * test imports the browser's copies and asserts they still match the server's.
   */
  const handedOver = HANDED_OVER;
  const putTo = PUT_TO;

  test("an accepted handoff is not a refusal, encoded or not", () => {
    const said = `${handedOver}Knowledge. It will answer in its own conversation.`;
    expect(asText(JSON.stringify(said)).startsWith(handedOver)).toBe(true);
    expect(asText(said).startsWith(handedOver)).toBe(true);
  });

  test("a cap refusing a hop does not start with the marker", () => {
    const said =
      "This turn has already asked 3 Bots, which is as many as this deployment allows.";
    expect(asText(JSON.stringify(said)).startsWith(handedOver)).toBe(false);
  });

  test("a question that reached somebody is not drawn as one that did not", () => {
    const said = `${putTo}the person in this conversation. Ask it in your own words now.`;
    expect(asText(JSON.stringify(said)).startsWith(putTo)).toBe(true);
  });

  test("a route that reached nobody does not start with the marker", () => {
    const said = "The on-call rota is not configured.";
    expect(asText(JSON.stringify(said)).startsWith(putTo)).toBe(false);
  });
});

/**
 * The two ends of a phrase that crosses a network.
 *
 * The server writes the sentence; the transcript reads its first words to decide whether to draw a
 * hop or a boundary. One declaration in `shared/handoff-markers.ts` means the two cannot disagree
 * about the phrase, so what is left to hold is how the transcript READS a result — which is what
 * this block does. That the sentences still begin with these markers is asserted where the sentences
 * are written: `server/tests/agent-handoff-tool.test.ts` and `agent-escalation.test.ts`.
 */
describe("the markers the server and the transcript both use", () => {
  /*
   * A result that is neither a string nor absent used to mean success to one renderer and a refusal
   * to the other, for the same situation. Anything unrecognisable is not success: a boundary that
   * held drawn as a Bot getting on with it is the worse of the two mistakes.
   */
  test("an unrecognisable result is never drawn as success", () => {
    expect(saidItWentAhead({ some: "object" }, HANDED_OVER)).toBe(false);
    expect(saidItWentAhead(42, PUT_TO)).toBe(false);
  });

  test("a result that has not arrived yet is left to the caller's status", () => {
    expect(saidItWentAhead(undefined, HANDED_OVER)).toBe(true);
  });
});

/*
 * 失败和成功分开（上游 #729）。前缀是服务端两道工具门写的：plugins/tools.ts 的
 * "The vendor reported an error:" 和 "That tool could not be called"。拒绝有自己的标记，不算失败。
 */
describe("telling a failed tool from a successful one", () => {
  test("vendor errors are failures, encoded or not", () => {
    const answer = "The vendor reported an error:\npermission denied";
    expect(toolResultFailed(answer)).toBe(true);
    expect(toolResultFailed(JSON.stringify(answer))).toBe(true);
  });

  test("a call that could not be made is a failure", () => {
    expect(toolResultFailed("That tool could not be called.")).toBe(true);
    expect(
      toolResultFailed("That tool could not be called: connection reset"),
    ).toBe(true);
  });

  test("a folder operation that could not be completed is a failure", () => {
    expect(
      toolResultFailed(
        "That host operation could not be completed: ENOENT: no such file",
      ),
    ).toBe(true);
  });

  test("ordinary results, refusals and running calls are not failures", () => {
    expect(toolResultFailed("Found 12 results.")).toBe(false);
    expect(toolResultFailed("Refused. The rule says no.")).toBe(false);
    expect(toolResultFailed(undefined)).toBe(false);
  });
});

/*
 * 调用了自己没有的工具（上游 #1153）。只认运行时自己的两种原话：AI SDK 的 NoSuchToolError
 * （本仓库 node_modules 里的 ai 包可查到原文），以及 LangGraph 预置 ToolNode 的报错。
 */
describe("a Bot asking for a tool it was never offered", () => {
  test("the AI SDK's wording, with or without the runtime's Error prefix", () => {
    const said =
      "Model tried to call unavailable tool 'web_search'. Available tools: computer_navigate, computer_read.";
    expect(unofferedTool(said)).toBe(true);
    expect(unofferedTool(`Error: ${said}`)).toBe(true);
    expect(unofferedTool(JSON.stringify(`Error: ${said}`))).toBe(true);
  });

  test("LangGraph's prebuilt ToolNode wording", () => {
    expect(
      unofferedTool(
        "Error: web_search is not a valid tool, try one of [computer_read].",
      ),
    ).toBe(true);
  });

  test("read through the Claude Agent SDK harness's failure wrapper", () => {
    const wrapped = JSON.stringify({
      error: true,
      content:
        "Model tried to call unavailable tool 'web_search'. Available tools: a, b.",
    });
    expect(unofferedTool(wrapped)).toBe(true);
  });

  test("anything else is drawn as it came", () => {
    expect(unofferedTool("Error: the page did not load.")).toBe(false);
    expect(
      unofferedTool("I tried to call unavailable tool 'x'. It said no."),
    ).toBe(false);
    expect(unofferedTool(undefined)).toBe(false);
  });
});

/*
 * 主人拒绝的步骤（上游 #1230）。审批服务给被拒的一步的答复就是写给 Bot 的那句话，不带拒绝标记；
 * 被当成工具结果画出来，一次被拒的文件写入就读成了「写好了」。
 */
describe("a step that was refused or declined", () => {
  test("the reason behind the refusal marker is a boundary's no", () => {
    expect(refusalOf("Refused. The rule says no.")).toEqual({
      reason: "The rule says no.",
      declined: false,
    });
  });

  test("the approval service's answer for a declined step is the person's no", () => {
    expect(refusalOf(DECLINED_BY_PERSON)).toEqual({
      reason: DECLINED_FOR_PERSON,
      declined: true,
    });
    // The plugin door puts the marker in front of the same sentence when it refuses at once.
    expect(refusalOf(`Refused. ${DECLINED_BY_PERSON}`)).toEqual({
      reason: DECLINED_FOR_PERSON,
      declined: true,
    });
  });

  test("the folder door's wrapper around the person's no is still the person's no", () => {
    expect(
      refusalOf(
        `That host operation could not be completed: ${DECLINED_BY_PERSON}`,
      ),
    ).toEqual({ reason: DECLINED_FOR_PERSON, declined: true });
    // Any other folder failure is a failure, not a refusal.
    expect(
      refusalOf("That host operation could not be completed: ENOENT"),
    ).toBeUndefined();
  });

  test("an ordinary answer, or none, is not a refusal", () => {
    expect(refusalOf("Saved notes.txt")).toBeUndefined();
    expect(refusalOf(undefined)).toBeUndefined();
    // Quoting the sentence inside a longer answer is not the service answering.
    expect(refusalOf(`The file said: ${DECLINED_BY_PERSON}`)).toBeUndefined();
  });
});

/*
 * gallery 调用没画出东西（上游 #1132）。三种失败各有标记：Claude Agent SDK 适配器的包装、
 * Claude Code 的 <tool_use_error>、CopilotKit 自己的 "Error: "。
 */
describe("a gallery call that failed instead of drawing", () => {
  test("only the harness's exact wrapper is a flagged failure", () => {
    expect(flaggedFailure('{"error": true, "content": "bad args"}')).toBe(
      "bad args",
    );
    // An API's own error object printed by a command is not the harness's wrapper.
    expect(
      flaggedFailure('{"error": true, "content": "x", "message": "y"}'),
    ).toBeUndefined();
    expect(flaggedFailure('{"error": "true", "content": "x"}')).toBeUndefined();
    expect(flaggedFailure("not json")).toBeUndefined();
  });

  test("each of the three marks is a failure", () => {
    expect(
      browserCallFailed('{"error": true, "content": "InputValidationError"}'),
    ).toBe(true);
    expect(
      browserCallFailed(
        "<tool_use_error>InputValidationError</tool_use_error>",
      ),
    ).toBe(true);
    expect(browserCallFailed("Error: arguments did not parse")).toBe(true);
  });

  test("a confirmation, a refusal or a running call is not", () => {
    expect(browserCallFailed("It is now on screen for the person.")).toBe(
      false,
    );
    expect(browserCallFailed("Not shown: Data table. No.")).toBe(false);
    expect(browserCallFailed(undefined)).toBe(false);
  });
});
