import { z } from "zod";
import { ApprovalRefusedError } from "../approvals/types";
import type { AuditInitiator } from "../audit";
import { HeadlessToolSuspension } from "../computer/headless-tools";
import { markUntrusted } from "../untrusted-content";
import type { SelectableSkill } from "./selection";
import {
  isDeploymentFault,
  PluginRefusedError,
  type PluginStore,
  refFromToolName,
} from "./store";

/**
 * The tools a Bot may call, as the runtime's own tool definitions, executed on the server.
 *
 * The loop used to run in the browser: every MCP tool was registered with `useFrontendTool` and its
 * handler posted back to `/api/plugins/call`. That made a browser a hard requirement for a Bot to do
 * anything, which rules out an embedded widget, a run nobody is watching, and any surface that is
 * not our own app.
 *
 * Nothing about governance moves with it. `callTool` is still the only path to a vendor: it checks
 * the grant, evaluates the policy, writes the audit row, and only then calls out. This module hands
 * the model a description of what it may call; the store remains what decides whether a call happens.
 *
 * Read at run time rather than captured, so a grant an administrator adds or revokes applies to the
 * next run rather than after a restart.
 */
/**
 * What a refused call answers with.
 *
 * The transcript draws a refusal differently from a result, and it has only the tool's answer to go
 * on. Guessing from the wording would break the first time an administrator rephrased a policy
 * message, so the answer says which it is. The model reads this too, and "Refused." in front of a
 * reason is what it should be told anyway.
 */
export const REFUSAL_MARKER = "Refused.";

/**
 * What a model is told a vendor answered: its result as written, or its error named as one.
 *
 * `isError` used to be dropped, and it cost a diagnosis. Google refused the Drive MCP server with
 * `isError: true` and the text "The caller does not have permission"; the model received that as an
 * ordinary result, believed it, and told the person it had no access to their Drive — which read as
 * the Bot being confused rather than as the vendor refusing.
 *
 * The prefix is the vendor's, and says so. It is deliberately NOT `REFUSAL_MARKER`: that one means
 * this deployment declined, and the transcript draws it as a boundary holding. A vendor saying no is
 * a different fact with a different fix, and collapsing the two would make a misconfigured connector
 * look like a policy working correctly.
 *
 * One function for both doors to one store — {@link grantedTools} for a Bot running here, and
 * `/api/agent-tools/call` for a Bot running its own loop — because the second answered with the bare
 * text, and neither framework Bot words an `isError` answer on its way through. Which door a Bot
 * arrives at is a deployment topology decision, not a decision about what its model is told.
 */
export function vendorAnswer(result: { text: string; isError: boolean }) {
  /*
   * Marked as outside content either way. A vendor's answer is somebody else's data: an issue title,
   * an email body, a document, any of which can be written to read like an instruction. The error
   * text is the vendor's too. See untrusted-content.ts; the transcript unwraps the envelope to draw it.
   */
  return result.isError
    ? `The vendor reported an error:\n${markUntrusted(result.text, "connector error")}`
    : markUntrusted(result.text, "connector result");
}

export type GrantedTool = {
  name: string;
  description: string;
  parameters: z.ZodType;
  execute: (args: unknown) => Promise<string>;
  initiator?: AuditInitiator;
  /**
   * `<serverId>/<toolName>`, carried alongside the name the model is offered.
   *
   * The two spellings exist because a model tool name may not contain a slash, and selection has to
   * compare a tool against what a skill declared, which is written in the ref spelling because that
   * is how a grant is written. Carried rather than derived at the comparison, so there is one place
   * the two forms are converted (`toolNameFor`) and no second parser to drift from it.
   */
  ref: string;
};

/**
 * A vendor's JSON Schema as something the model can be handed.
 *
 * Anything that is not an object schema describes something other than a tool's arguments, and a
 * schema we cannot read must not stop the tool being offered: an open object lets the model call it
 * and lets the vendor be the one to reject a bad argument, which is where that error belongs.
 */
export function parametersFor(inputSchema: Record<string, unknown>): z.ZodType {
  try {
    const converted = z.fromJSONSchema(inputSchema as never);
    if (converted instanceof z.ZodObject) return converted;
  } catch {}
  return z.object({}).catchall(z.unknown());
}

/**
 * 谁在删除前问主人：OpenBot，不是 Bot。
 *
 * 应用工具的删除、归档，以及应用标为破坏性的工具，删除类底线总是先问（approvals/policy.ts 的
 * `destructiveFloor`）。Bot 自己再问一遍，主人就要为一次删除回答两次；OpenBot 的卡片写明了具体
 * 动作，留它就够了。只在 Bot 至少持有一个经插件调用路径的应用工具（`mcp__` 开头）时才说，并且
 * 只说应用工具：记忆等 OpenBot 内部工具不经审批门，`computer_*` 和主人电脑上的命令也不归这条
 * 底线管，Bot 对它们该怎么确认还怎么确认。
 */
export const CONNECTOR_APPROVAL_GUIDANCE =
  "For the tools of connected apps (their names start with mcp__), OpenBot itself asks the person before you delete or archive anything and before you use a tool marked destructive, on a card that shows exactly what you are about to do. So for those, do not ask them first: say what you are going to do and call the tool, and they are asked once, by OpenBot. This covers connected-app tools only: not your memory tools, and not commands or files on a computer.";

/**
 * 应用标为破坏性的工具（MCP 的 `destructiveHint`、Composio 的破坏性标签），提供给模型时追加在
 * 描述末尾。它的名字不一定看得出会删除什么，所以在工具本身上写明。
 */
export const DESTRUCTIVE_TOOL_NOTE =
  "This tool is marked destructive: it deletes or overwrites something, so OpenBot asks the person before it runs. Do not ask them first.";

/** 默认的中文网页搜索地址：百度为主，必应作备选。关键词 URL 编码后接在后面。 */
export const BAIDU_SEARCH_URL = "https://www.baidu.com/s?wd=";
export const BING_SEARCH_URL = "https://cn.bing.com/search?q=";

/** 搜索要用到的浏览器工具：打开页面和读页面，两个都有才算能搜。 */
export const BROWSER_SEARCH_TOOLS = ["computer_navigate", "computer_read"];

/**
 * 这次运行是否持有浏览器搜索要用的工具，按实际提供给模型的工具名判断。
 *
 * 浏览器工具不在 {@link GrantedTool} 里：网页聊天由前端注册（app/src/lib/copilot/computer-tools.tsx），
 * 无人值守由 headless-tools 提供，两者都随 RunAgentInput.tools 到达。所以看工具名，而不看部署有没有
 * 电脑说明：纯设备模式（TENANT_RUNTIME=device，没有云端电脑）的聊天没有电脑说明，却照样持有这些工具。
 */
export function holdsBrowserSearchTools(names: Iterable<string>): boolean {
  const held = new Set(names);
  return BROWSER_SEARCH_TOOLS.every((name) => held.has(name));
}

/**
 * 员工持有浏览器时，查公开网页信息怎么搜（2026-11-09 选定的免费方案：不接付费搜索服务）。
 *
 * 只管公开网页。已连接系统的规则（不许改用浏览器访问、缺授权如实说、审批门）在
 * {@link grantedToolGuidance} 里照旧，这段自己也写明不适用于它们。搜索页遇到验证码或登录墙时
 * 先换另一个搜索引擎；仍被拦，就按电脑说明（shared/bot-prompt.ts 的 COMPUTER_GUIDANCE）已有的规则，
 * 调用 computer_request_help 请人接管，不另立一条相反的规则。
 *
 * `withParallel`：员工同时持有 Parallel 时，写明中文问题先走百度，Parallel 用于英文和国际信息，
 * 和 Parallel 那段的说法一致。
 */
function browserSearchGuidance(withParallel: boolean): string[] {
  return [
    `Searching the public web with your browser: when a question needs public information from the web, call computer_navigate on ${BAIDU_SEARCH_URL}<keywords>, with the keywords URL-encoded. If Baidu does not load or its results are poor, use ${BING_SEARCH_URL}<keywords> instead.`,
    "Read the results page (computer_read), then open one to three of the source pages and check the answer there rather than answering from the result snippets. In your answer give the source links and the date you searched.",
    withParallel
      ? "Prefer Baidu for questions in Chinese. Parallel is still there for English-language or international information, but a question in Chinese goes to Baidu in the browser first."
      : "Prefer Baidu for questions in Chinese.",
    "Search for public information only. Put only the few keywords the question needs in the search address: never the conversation, the contents of a private document or file, or anything about the person they did not ask you to look up.",
    "If a search page shows a CAPTCHA, a verification check or a sign-in wall, do not try to get around it: switch to the other search engine and try once more. If that is blocked too, treat it like any page that needs a person: call computer_request_help and say exactly what needs doing, and never ask them to type a password or a code to you.",
    "This is for public web pages only. It is never a way into a system this deployment connects to: for those, everything said here about connected systems, missing grants and approvals still applies.",
  ];
}

/**
 * What this Bot holds, said in its instructions rather than left to be inferred from a tool list.
 *
 * A tool array tells a model a tool exists. It does not tell it that the tool is the right way to
 * reach that system, and it competes with a page of prose about the browser that every Bot is given
 * whether or not it has any connectors at all. The browser prose wins: it is emphatic, it is about
 * capability, and it says "never claim you cannot browse".
 *
 * So a Bot holding four Google Drive tools browsed to drive.google.com, met a sign-in page its
 * container could never satisfy, and asked its person to sign in to a vendor that person had already
 * connected. The tools were there the whole time.
 *
 * Generated from the grants rather than written down, because the point is that it tracks them. An
 * administrator switching a connector on, or granting one more of its tools, changes what the Bot is
 * told on its next run with nothing else to remember and nothing to keep in step.
 *
 * Empty when the Bot holds nothing, so a deployment with no connectors says nothing about them.
 */
export function grantedToolGuidance(
  tools: GrantedTool[],
  /**
   * Systems this deployment connects to that this Bot holds nothing for.
   *
   * Without these a Bot holding no grants is told nothing at all, so it treats a connected vendor as
   * an ordinary website and browses to it. That is how a Bot with no Drive grant ended up on Google's
   * sign-in page asking a person to sign in to an account the deployment had already connected: the
   * connector existed, the Bot simply was not on it, and nothing said so.
   */
  connectedButNotHeld: readonly string[] = [],
  /**
   * `browser`：这次运行持有浏览器（`computer_navigate`、`computer_read`，见 {@link holdsBrowserSearchTools}）。为真时加上公开网页搜索引导
   * （见 {@link browserSearchGuidance}），并把 Parallel 那段改成「中文先百度」的说法；为假或不传时，
   * 输出与没有这个参数时逐字一致。
   */
  options: { browser?: boolean } = {},
): string {
  const browser = options.browser === true;
  if (tools.length === 0 && connectedButNotHeld.length === 0 && !browser)
    return "";

  const bySystem = new Map<string, string[]>();
  for (const tool of tools) {
    // `mcp__server__tool`, which is the shape the model is offered.
    const parts = tool.name.replace(/^mcp__/, "").split("__");
    const system = parts.length > 1 ? (parts[0] as string) : "this deployment";
    const rest = parts.length > 1 ? parts.slice(1).join("__") : tool.name;
    bySystem.set(system, [...(bySystem.get(system) ?? []), rest]);
  }

  const held = [...bySystem.keys()];
  const missing = connectedButNotHeld.filter(
    (system) => !held.includes(system),
  );

  const researchConnector = ["parallel-authenticated", "parallel"].find(
    (server) =>
      ["web_search", "web_fetch"].every((name) =>
        tools.some((tool) => tool.ref === `${server}/${name}`),
      ),
  );
  const researchTools = researchConnector
    ? tools.filter(
        (tool) =>
          tool.ref === `${researchConnector}/web_search` ||
          tool.ref === `${researchConnector}/web_fetch`,
      )
    : [];

  return [
    ...(tools.length > 0
      ? [
          "You can reach these systems directly, as the person asking, with their own access:",
        ]
      : []),
    ...[...bySystem.entries()].map(
      ([system, names]) => `- ${system}: ${names.join(", ")}`,
    ),
    ...(tools.length > 0
      ? [
          "Use them for anything about those systems. Do NOT browse to one of their websites instead: your",
          "browser is signed in as nobody, so it sees less than these tools do and will meet a sign-in wall",
          "that connecting an account has already solved.",
          "If one of these systems is involved and no tool above covers the part you need, that is a",
          "missing grant and not something to work around. Say so plainly, name the capability you would",
          "need, and say an administrator can grant it on that connector. Do not reach for the browser, do",
          "not ask the person to sign in, and do not ask them to fetch it for you: they already have the",
          "access, and the thing that is missing is yours, not theirs.",
        ]
      : []),
    // 只有内部工具（记忆、跟进等）时不说：它们不经审批门。
    ...(tools.some((tool) => refFromToolName(tool.name) !== null)
      ? [CONNECTOR_APPROVAL_GUIDANCE]
      : []),
    ...(researchConnector
      ? [
          `Parallel provides public-web search and extraction: ${researchTools.map((tool) => tool.name).join(" and ")} discover sources and read selected pages.`,
          "Parallel searches the public web; it does not connect a person's private account. Send only the research objective, necessary search queries and requested URLs, not a full transcript or private documents. Generate one session_id for the conversation and reuse it on related search/fetch calls. Omit model_name unless the exact configured model identifier is known.",
          browser
            ? "Cite source URLs and distinguish excerpts from full-page reads. Report provider errors or missing sources; do not invent evidence or quietly bypass a denial. For a question in Chinese, search Baidu in your browser first, as described below; use Parallel for English-language or international information. Interactive browser work uses the authorized computer tools."
            : "Cite source URLs and distinguish excerpts from full-page reads. Report provider errors or missing sources; do not invent evidence or quietly bypass a denial. Interactive browser work still uses the authorized computer tools when needed.",
        ]
      : []),
    // 公开网页搜索，放在已连接系统的明确禁令之前，让那段禁令仍是最后读到的。
    ...(browser ? browserSearchGuidance(Boolean(researchConnector)) : []),
    /*
     * The vendors this deployment connects to and this Bot does not hold.
     *
     * Named so the Bot can say which one, because "I have not been granted it" is only actionable if
     * the person is told what "it" is. The browser is refused for these by the same reasoning as
     * above and for a sharper reason: a connector exists precisely so the vendor is reached as the
     * person asking, and the container's browser is signed in as nobody, so browsing there abandons
     * the per-person path and lands on a login wall by construction.
     */
    ...(missing.length > 0
      ? [
          ...(tools.length > 0 || browser ? [""] : []),
          `This deployment also connects to: ${missing.join(", ")}. You hold none of their tools.`,
          "If a question needs one of them, say plainly that you have not been granted it and that an",
          "administrator can grant it on that connector. Do NOT browse to its website: that is not the",
          "same thing, your browser is signed in as nobody, and it will meet a sign-in wall that the",
          "connector exists to avoid. Do not ask the person to sign in there either.",
        ]
      : []),
  ].join("\n");
}

/**
 * Every MCP tool granted to one Bot, ready to hand to the runtime.
 *
 * A refusal is returned as the tool's result rather than thrown. The model is mid-run and the person
 * is owed a sentence about what was blocked; an exception here ends the run with nothing said, and
 * the refusal is already in the audit trail either way.
 */
export async function grantedTools(options: {
  store: PluginStore;
  botId: string;
  actorId: string;
  initiator?: AuditInitiator;
  /** Whose account a call reaches, when not the asker's; see `callTool`'s `credentialActorId`. */
  credentialActorFor?: (ref: string) => Promise<string>;
}): Promise<GrantedTool[]> {
  const { store, botId, actorId, initiator, credentialActorFor } = options;
  const granted = await store.listForAgent(botId);

  return granted.tools.map((tool) => ({
    name: tool.toolName,
    ref: tool.ref,
    initiator,
    // 应用标为破坏性的工具，名字不一定看得出来：在描述末尾写明 OpenBot 会先问，Bot 不必再问。
    description: tool.destructive
      ? [tool.description.trim(), DESTRUCTIVE_TOOL_NOTE]
          .filter(Boolean)
          .join("\n\n")
      : tool.description,
    parameters: parametersFor(tool.inputSchema),
    execute: async (args: unknown) => {
      try {
        const result = await store.callTool({
          ref: tool.ref,
          // The runtime hands through whatever the model produced. Anything that is not an object
          // is not a set of arguments, and the vendor should be the one to say so.
          args:
            args && typeof args === "object" && !Array.isArray(args)
              ? (args as Record<string, unknown>)
              : {},
          botId,
          actorId,
          ...(initiator ? { initiator } : {}),
          ...(credentialActorFor
            ? { credentialActorId: await credentialActorFor(tool.ref) }
            : {}),
        });
        return vendorAnswer(result);
      } catch (error) {
        if (error instanceof HeadlessToolSuspension) throw error;
        if (
          error instanceof PluginRefusedError ||
          error instanceof ApprovalRefusedError
        ) {
          return `${REFUSAL_MARKER} ${error.message}`;
        }
        /*
         * A contradiction in this deployment's own tables says nothing to a model.
         *
         * CRITERION. Nothing on the `isDeploymentFault` shelf may have its message relayed from
         * here, whatever it says.
         *
         * REASON. The branch below hands `error.message` to the model, which is right for a
         * vendor's own words — that is somebody else's software explaining itself, and the
         * diagnosis is worth having. These are not that. `ServerRowAmbiguousError` names two of
         * our columns and tells the reader to rename a row or correct its provenance: an
         * instruction only an operator can carry out, arriving in an end user's model context as
         * the reason their tool failed, from which the model can only invent something to tell
         * them. The operator who can act on it is served on the admin surface instead, where the
         * refresh route now answers with the sentence in full.
         */
        if (isDeploymentFault(error)) return "That tool could not be called.";
        // A vendor that failed is not a refusal, and the difference matters to the person reading
        // the answer: one means "not allowed", the other means "it broke".
        return error instanceof Error
          ? `That tool could not be called: ${error.message}`
          : "That tool could not be called.";
      }
    },
  }));
}

/**
 * The skills one Bot holds, as much of each as choosing between them needs.
 *
 * Read here rather than folded into `grantedTools` because the two answer different questions and
 * are wanted at different moments: the tools are what a Bot may call, asked once per request, and
 * the skills are the index a run is narrowed against. Both come from `listForAgent`, and both are
 * read fresh for the same reason: a grant added a minute ago has to count on the next run.
 */
export async function grantedSkills(options: {
  store: PluginStore;
  botId: string;
}): Promise<SelectableSkill[]> {
  const granted = await options.store.listForAgent(options.botId);
  return granted.skills.map((skill) => ({
    slug: skill.slug,
    title: skill.title,
    summary: skill.summary,
    tools: skill.tools,
  }));
}
