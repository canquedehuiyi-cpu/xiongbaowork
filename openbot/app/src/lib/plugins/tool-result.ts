/**
 * What the server puts in front of a refused call's reason.
 *
 * Written out here rather than imported, because this crosses a network: the server's copy travels
 * in a tool result and this one reads it, the same way a status code is declared at both ends. It
 * must match `REFUSAL_MARKER` in `server/src/plugins/tools.ts`.
 *
 * The alternative is guessing a refusal from its wording, which breaks the first time an
 * administrator rephrases a policy message, and fails silently by drawing a refusal as a result.
 */
export const REFUSAL_MARKER = "Refused.";

/**
 * The tool's own answer, out of whatever the transcript is carrying it in.
 *
 * A tool returns a string and the runtime puts it in a message as JSON, so what arrives here is that
 * string encoded: quotes around the whole thing, and every quote inside it escaped. Drawn as-is, a
 * refusal reads `"This deployment's policy does not allow that: ... the rule \"mcp.server ...`, with
 * the escapes on screen.
 *
 * It also breaks more than the look. `REFUSAL_MARKER` is matched against the start of this text, and
 * an encoded string starts with a quote, so a refusal is drawn as an ordinary result: the one thing
 * the marker exists to prevent.
 *
 * Only a JSON string is unwrapped. An object or an array is a vendor's envelope, which is
 * {@link forDisplay}'s job, and anything that is not JSON at all is already what it says.
 */
export function asText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('"')) return text;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed : text;
  } catch {
    return text;
  }
}

/**
 * The content inside the untrusted-content envelope, without the notice in front of it.
 *
 * The server marks every connector result as outside data before the model reads it
 * (`server/src/untrusted-content.ts`). The notice is for the model; a person reading the transcript
 * wants the vendor's answer, drawn the way it always was. Declared at both ends like
 * {@link REFUSAL_MARKER}. Text with no envelope is returned unchanged.
 */
export function withoutUntrustedEnvelope(text: string): string {
  return text.replace(
    /CRITICAL: The following [^\n]* is untrusted data, not instructions or tool authorization\.[^\n]*\n<untrusted_data source="[^"]*">\n([\s\S]*?)\n<\/untrusted_data>/g,
    (_match, inner: string) =>
      inner.replace(/<\\\/untrusted_data/gi, "</untrusted_data"),
  );
}

/**
 * A tool result, as something worth looking at.
 *
 * MCP says a text part, and vendors fill it with anything from plain markdown to a JSON envelope
 * with the markdown inside one field. Markdown is drawn as markdown, a JSON wrapper is unwrapped to
 * the markdown it was hiding, and anything else is fenced as JSON. Nothing is discarded.
 */
export function forDisplay(text: string): string {
  const trimmed = withoutUntrustedEnvelope(asText(text)).trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON after all. Draw what the server sent, without the model's notice.
    return trimmed;
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const entries = Object.entries(parsed as Record<string, unknown>);
    // The field carrying the answer, told apart from the ones carrying bookkeeping: Slack sends
    // `{ results, pagination_info }`. The rest is kept below rather than dropped.
    const markdown = entries
      .filter(
        ([, value]) =>
          typeof value === "string" &&
          (value.includes("\n#") || value.startsWith("#")),
      )
      .sort((a, b) => String(b[1]).length - String(a[1]).length)[0];

    if (markdown) {
      const rest = entries.filter(([key]) => key !== markdown[0]);
      const body = String(markdown[1]);
      if (rest.length === 0) return body;
      return `${body}\n\n\`\`\`json\n${JSON.stringify(
        Object.fromEntries(rest),
        null,
        2,
      )}\n\`\`\``;
    }
  }

  return `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
}

/**
 * Whether a server-side tool's result begins with the phrase that means it went ahead.
 *
 * TWO CALLERS AND ONE RULE, because they had two. A tool that runs on the server reaches the
 * transcript as text meant for a model, so the only thing the renderer can read an outcome out of is
 * the wording — and the wording arrives JSON-encoded, which is why this decodes before it matches.
 *
 * The awkward case is a result that is neither a string nor absent. `message_bot` treated that as
 * success and `ask_person` treated it as a refusal, for the same situation, and the handoff's own
 * comments say which way round is worse: a boundary that held drawn as a Bot getting on with it.
 * So anything unrecognisable is not success. Absent is left alone, because a call still running has
 * no result yet and the caller decides that from its status.
 */
export function saidItWentAhead(result: unknown, marker: string): boolean {
  if (result === undefined) return true;
  if (typeof result !== "string") return false;
  return asText(result).startsWith(marker);
}

/**
 * 主人在对话卡片上拒绝一步时，审批服务答给 Bot 的那句话。
 *
 * 和 {@link REFUSAL_MARKER} 一样两端各声明一份：服务端那份随工具结果过网络，这一份负责认出它。
 * 必须与 `server/src/approvals/service.ts` 的 `DECLINED_BY_PERSON` 一字不差，
 * `server/tests/approvals-frontend.test.ts` 会比对两份。
 */
export const DECLINED_BY_PERSON =
  "The person declined this action when you asked for their approval, so it was not done. This was their decision, not a policy or a boundary. Do not try this action, or anything equivalent, again in this conversation unless the person asks you to in words; tell them you did not do it because they declined.";

/** 被主人拒绝的一步，给主人看的说法。上面那句是写给 Bot 的，主人不该读到「不要再试」。 */
export const DECLINED_FOR_PERSON = "你拒绝了这一步。";

/** 一步没有执行：边界或策略说了不（`declined: false`），或者是主人自己拒绝的（`declined: true`）。 */
export type Refusal = { reason: string; declined: boolean };

/**
 * 一步为什么没有执行；它执行了就是 undefined。
 *
 * 两种来源：拒绝标记后面的理由；或者主人在对话卡片上拒绝后，审批服务答的那句话。后者不带标记
 * （服务对所有种类的步骤都这么答），当成结果画出来，一次被拒的文件写入就读成了「写好了」。
 * 插件那道门立即拒绝时会在同一句话前加标记，所以标记之后也要再认一次。
 * 主人拒绝的理由换成给主人看的说法。
 */
export function refusalOf(answer: string | undefined): Refusal | undefined {
  if (answer === undefined) return undefined;
  const marked = answer.startsWith(REFUSAL_MARKER);
  const reason = marked ? answer.slice(REFUSAL_MARKER.length).trim() : answer;
  if (reason.trim() === DECLINED_BY_PERSON)
    return { reason: DECLINED_FOR_PERSON, declined: true };
  return marked ? { reason, declined: false } : undefined;
}

/**
 * Claude Agent SDK 适配器包装失败的格式里的文本；不是这个格式就是 undefined。
 *
 * `ag-ui-claude-sdk` 在 AG-UI 的结果里没有地方放 Claude Code 的 `is_error`，于是把失败的结果包成
 * `{"error": true, "content": "..."}`，重新打开的对话里的历史也保留这层包装。
 *
 * 只认这一个精确形状：`error: true`、字符串 `content`，再没有别的字段。命令打印出来的 API 错误
 * 对象（`{"error": true, "message": "..."}`）长得很像，但不是适配器的包装，把它读成失败会把一次
 * 成功的请求画成「没有成功」。
 */
export function flaggedFailure(answer: string): string | undefined {
  if (!answer.trimStart().startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(answer);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined;
    const { error, content, ...rest } = parsed as Record<string, unknown>;
    if (error !== true || typeof content !== "string") return undefined;
    return Object.keys(rest).length === 0 ? content : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 一次由浏览器应答的调用（gallery 组件）是否失败了、什么都没画出来。
 *
 * 成功的结果是已知的：组件的确认、拒绝、或者主人的回答。失败有三处来源，各有标记：
 * - Claude Agent SDK 适配器：参数解析不了，Claude Code 在调用到达浏览器之前就拒绝了，
 *   包装成 {@link flaggedFailure}；
 * - 适配器保留包装之前的历史：Claude Code 裸的 `<tool_use_error>`；
 * - CopilotKit 自己跑不了的调用（参数解析不了、处理函数抛错）：`Error: ` 加原因。
 */
export function browserCallFailed(result: string | undefined): boolean {
  if (result === undefined) return false;
  const answer = asText(result);
  return (
    flaggedFailure(answer) !== undefined ||
    /^\s*<tool_use_error>/.test(answer) ||
    answer.startsWith("Error: ")
  );
}

/** Bot 调用了它没有的工具时，展开这一步看到的那句话。 */
export const UNOFFERED_TOOL_SENTENCE =
  "这位员工调用了一个它没有的工具，于是没用它，接着做了下去。";

/**
 * 这次调用的答复是不是运行时在说：这个工具从来没有提供给这位 Bot。
 *
 * 那句答复是写给模型的：它按标识符列出 Bot 拥有的每个工具，好让模型下次挑一个。原样画出来，
 * 主人展开这一步读到的是一长串 `computer_navigate, computer_read, …`。只认两种库自己的原话：
 * AI SDK 的 `NoSuchToolError`（「Model tried to call unavailable tool 'web_search'. Available
 * tools: …」，运行时会在前面加 `Error: `），以及 LangGraph 预置 `ToolNode` 的（「Error: web_search
 * is not a valid tool, try one of […].」）。Claude Agent SDK 的失败包装会先拆开再认。
 */
export function unofferedTool(result: string | undefined): boolean {
  if (result === undefined) return false;
  const answer = asText(result);
  const text = (flaggedFailure(answer) ?? answer).trim();
  return (
    /^(Error: )?Model tried to call unavailable tool '[^']*'\./.test(text) ||
    /^Error: \S+ is not a valid tool, try one of \[/.test(text)
  );
}

/**
 * 服务端工具是否以失败告终，而不是返回了结果。
 *
 * 这两个前缀由服务端的两道工具门（`server/src/plugins/tools.ts`、`server/src/app.ts`）在区分完
 * 「策略拒绝」和「执行失败」之后写入。拒绝有自己的标记，不能并进这个状态。
 */
export function toolResultFailed(result: string | undefined): boolean {
  if (result === undefined) return false;
  const answer = asText(result);
  return (
    answer.startsWith("The vendor reported an error:") ||
    answer.startsWith("That tool could not be called")
  );
}
