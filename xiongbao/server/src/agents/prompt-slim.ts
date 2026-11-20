import { withToolHint } from "./step-hints";

/**
 * 提示词瘦身（期 1 补充）：每一步都发给模型的固定部分，工具定义这一半。
 *
 * 为什么。评测里熊宝每一步带约 23K 字符的工具定义，其中大半是这道题永远用不到的：生成视频、记忆、跟进、
 * 浏览器的八个动作、请人登录……每步都付钱。做法有三样，都在这里：
 *
 *  1. 按需加载：{@link DEFERRED_TOOLS} 里的工具不放在每一步的定义里，而是排在 `search_tools` 后面
 *     （和应用的工具同一套机制，见 `tool-search.ts`）。模型用几个词搜一次，下一步起就能用，同一轮后续每一步
 *     都还在。名字写在 `search_tools` 的描述里，所以模型知道有什么、凭名字就能取。
 *  2. 压缩描述：{@link TOOL_BRIEFS} 是常驻工具的短描述（工具名、参数名一个不改，含义不变）。
 *  3. 去掉 schema 里的噪音：每个工具都带的 `$schema`、满格的 `maximum: 9007199254740991`，以及模型根本不用的
 *     运行时状态工具（{@link HIDDEN_TOOLS}）。
 *
 * 这些都只改「发给模型的那一份」：工具仍然全部注册在运行时里，授权、审批、审计一步没少；被挡在后面的只是
 * 「展示给模型看」，不是授权边界（和 `tool-search.ts` 开头说的一样）。
 *
 * 开关：`XIONGBAO_PROMPT_SLIM=off` 一次关掉全部（系统提示的短写法见 `slim-guidance.ts`），回到原样。默认开。
 */
export const PROMPT_SLIM_ENV = "XIONGBAO_PROMPT_SLIM";

/** 瘦身是否开着：默认开，只有明确写 `off` 才关（关着就是原样，逐字节）。 */
export function promptSlimOn(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[PROMPT_SLIM_ENV]?.trim().toLowerCase() !== "off";
}

const BROWSER = "browser web page website open form fill";
const HELP = "sign in login password captcha code secret takeover person help";
const MEDIA = "image picture video poster draw generate media";
const FOLLOW_UP = "follow up reminder remind schedule later wake";
const MEMORY = "memory remember recall forget fact preference";
const ACCESS = "app access connect connector grant permission";
const GIT = "git branch commit diff changes pull request pr github push";

/**
 * 排在检索后面的工具，和各自的检索关键词（在名字和描述之外再多几个词，让「browser」「image」「remind」这样的
 * 说法也找得到）。
 *
 * 选法：评测里员工靠命令、读写改文件、搜索读网页、计划、子代理和交付这些完成任务，它们常驻；其余是偶尔才用
 * 的，或者一类工具里模型只会用其中一两个（浏览器的八个动作）。一类里的工具共用关键词，搜一次整类都来。
 */
export const DEFERRED_TOOLS: Readonly<Record<string, string>> = {
  web_crawl: "crawl site website pages docs documentation",
  computer_navigate: BROWSER,
  computer_snapshot: BROWSER,
  computer_click: BROWSER,
  computer_type: BROWSER,
  computer_key: BROWSER,
  computer_scroll: BROWSER,
  computer_screenshot: BROWSER,
  computer_read: BROWSER,
  computer_request_help: HELP,
  computer_request_secret: HELP,
  computer_request_sign_in: HELP,
  generate_image: MEDIA,
  generate_video: MEDIA,
  check_video: MEDIA,
  schedule_follow_up: FOLLOW_UP,
  list_follow_ups: FOLLOW_UP,
  cancel_follow_up: FOLLOW_UP,
  offer_check_in: "check in daily watch monitor offer",
  save_observed_memory: MEMORY,
  remember_personal_fact: MEMORY,
  recall_personal_memory: MEMORY,
  forget_personal_memory: MEMORY,
  request_app_access: ACCESS,
  show_app_access: ACCESS,
  host_list_folders: "folder folders shared host local files",
  git_branch: GIT,
  git_commit: GIT,
  git_diff_summary: GIT,
  open_pull_request: GIT,
  report_refusal: "refuse refusal decline declined record",
  update_heartbeat_checklist: "heartbeat checklist wake periodic check",
  save_learned_skill: "skill learn save lesson reuse",
  refine_skill: "skill learn refine improve lesson",
};

/** 名字直接写进 `search_tools` 描述的上限：排在后面的工具不超过这个数才写（应用的几百个工具不写）。 */
export const SLIM_NAMES_LIMIT = 40;

/**
 * 熊宝自己给每位员工的工具（计划、联网、记忆、跟进、交付、电脑……），不是接进来的应用。瘦身时「你可以直接访问
 * 这些系统」那一段不再把它们当系统列一遍。只认名单里的名字：名单外的（测试里的、别处加的）照旧。
 */
export function isDeploymentTool(name: string): boolean {
  return (
    Object.hasOwn(DEFERRED_TOOLS, name) ||
    Object.hasOwn(TOOL_BRIEFS, name) ||
    name === "web_search"
  );
}

/** 模型用不到、也不该看到的运行时状态工具（`AGUISendState*`，共享状态用的）。 */
export const HIDDEN_TOOLS: ReadonlySet<string> = new Set([
  "AGUISendStateSnapshot",
  "AGUISendStateDelta",
]);

/** 这个名字是不是瘦身时排到检索后面的熊宝自带工具。 */
export function isDeferredTool(name: string): boolean {
  return Object.hasOwn(DEFERRED_TOOLS, name);
}

/** 这一轮手上的工具名里，哪些排到检索后面。关着瘦身就是空。 */
export function deferredNames(
  names: Iterable<string>,
  env?: Record<string, string | undefined>,
): Set<string> {
  if (!promptSlimOn(env)) return new Set();
  return new Set(
    [...names].filter((name) => Object.hasOwn(DEFERRED_TOOLS, name)),
  );
}

/**
 * 常驻工具的短描述。键是工具名，值是发给模型的描述；参数名、参数个数、必填项都不变，
 * `params` 里写的是要换短的某个参数的说明。
 *
 * 原文在各工具自己的文件里，这里只是发给模型时换一份短的；`tests/prompt-budget.test.ts` 逐个核对这里的每个
 * 键都对得上一个真实的工具、短写法确实更短，免得工具改名后这里悄悄失效。
 */
export const TOOL_BRIEFS: Readonly<
  Record<string, { description: string; params?: Record<string, string> }>
> = {
  ask_person: {
    description:
      "Ask a person only when you cannot go on without them: a wrong guess would send, delete, pay or do something else hard to undo; the readings would lead to materially different work; or only they know the answer. Otherwise decide, say what you assumed, and keep going. Say what you need and why, then stop and wait. Put each decision in `parts`, one entry each; give `options` only when you can name likely answers.",
  },
  deliver_task: {
    description:
      "交付（规约第 2 条）：做完接下的活时调用。items 列交付物：attachment（对话里的附件 id）、component（这件活里画过的组件，ref 写组件名或调用 id）、link（http(s) 地址）、workspace_file（工作区里的文件，ref 写相对路径，如 reports/对比.xlsx）、note（只有文字结论时，ref 写结论）；title 写清是什么。checks 写你怎么查过的，每条一句。验收标准写了「必需：…」时，每项都要在 title 或 checks 里提到。服务器会核对，缺了会挡回并告诉你，补齐再交；交了以后等验收，没被验收前不要说「做完了」。",
  },
  accept_task: {
    description:
      "接活回执：对方交给你一件有交付物的活时调用（规约第 1 条）。due_at 写预计几点交（「40 分钟」「15:00」「明早 10 点」等，按对方的时区算）；不知道就不填，按接下后 2 小时核对。criteria 写你整理的验收标准，一两句；有必须交的项就在末尾写「必需：A、B、C」。同一个对话里再接另一件活就再调一次，另开一张卡。",
  },
  request_extension: {
    description:
      "申请延期（规约第 3 条）：接下的活到预计时间交不了时调用。due_at 写想延到几点，reason 写缺什么、为什么。对方准许前，预计时间不变。",
  },
  update_plan: {
    description:
      "列出或更新你这次工作的计划清单，每次都传完整清单。多步任务先列计划；开始哪一项就标 in_progress，做完立刻标 done。一两步的小事不用列。",
  },
  run_subagent: {
    description:
      "把工作里一个独立的部分交给子代理：你的新副本，带你的工具、替同一个人办事，看不到这段对话，只交回答案。能拆成两个以上相互独立的部分时，在同一步里多次调用并行去做；计划、汇总和最后的判断自己做，一两步的小事自己做。task 写目标、范围和它需要知道的一切，answer 写要交回什么、什么格式。每轮最多 5 个，子代理不能再派子代理，团队成员不是子代理。需要批准的操作子代理会停下，交还给你。",
  },
  computer_run_command: {
    description:
      "Run a bash command in your workspace. Pipes and && work; long output is truncated and long commands are stopped. Use installed tools first; to get a new one, install it inside your workspace (npm install without -g, bun add, or a python3 venv). If told you have no sudo permission, do not try to escalate: say so.",
    params: {
      timeoutMs:
        "Optional. Milliseconds the command may run; default 120000, at most 600000. Ask for more for a long build, install or test run.",
    },
  },
  computer_read_file: {
    description:
      "Read a file in your persistent workspace (such as notes.md) or in one of the person's shared read-only folders (pass its root and a path inside it). For part of a long file pass offset (first line, from 1) and limit (line count); lines then come back numbered with the file's total line count.",
  },
  computer_edit_file: {
    description:
      "Replace one passage of a text file in your workspace. old_string must appear exactly once, so include enough surrounding lines; it is replaced by new_string (replace_all replaces every occurrence). Prefer this to rewriting a file with computer_write_file. If old_string is missing or not unique nothing changes and you are told why: read the file again and retry.",
  },
  computer_grep: {
    description:
      "Search file contents in your workspace for a regular expression, as rg -n would: path:line:text, at most 200 lines. path limits to a folder or file, glob to matching files (such as *.ts), ignore_case ignores case. Hidden files and node_modules are skipped.",
  },
  computer_glob: {
    description:
      "Find files in your workspace by glob pattern, such as src/**/*.ts, relative to path when given. Up to 500 paths, the most recently changed first.",
  },
  computer_list_files: {
    description:
      "List files and folders in your workspace; call it before reading a filename you are unsure of. Pass root for one of the person's shared read-only folders.",
  },
  web_fetch: {
    description:
      "读取一个公开网页的正文，转成 Markdown。只读 http 或 https 的公开网址，内网地址会被拒绝；页面靠脚本加载时 render_js 设为 true；web_crawl 返回的 ref（crawl://…）也可以交给它读全文。正文超过 8KB 时，有电脑的员工会把全文存进工作区、这里只给头尾（看中间用 computer_read_file 按行段读，找内容用 computer_grep）；没有电脑的只给前 8KB。",
  },
};

/** JavaScript 的最大安全整数：zod 的 `.int()` 给每个整数参数都写上它，模型读了没用。 */
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * 去掉 schema 里每个工具都带、模型用不上的东西，别的一概不动。
 *
 * `additionalProperties: false` 只在 `loose` 时去掉：它每个对象都写一遍，约占一个工具定义的 6%，普通聊天接口
 * 不看它（参数由服务器按 zod 再校验一遍）；但 OpenAI 的 Responses 接口把函数工具当 strict 处理，要求每个对象
 * 都写明它，所以那条路径不能去。
 */
function cleanSchema(value: unknown, loose: boolean, root = true): unknown {
  if (Array.isArray(value))
    return value.map((item) => cleanSchema(item, loose, false));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (root && key === "$schema") continue;
    if (key === "maximum" && inner === MAX_SAFE) continue;
    if (loose && key === "additionalProperties" && inner === false) continue;
    // `properties` 的键是参数名，不是关键字：参数叫 `maximum` 也照留。
    out[key] =
      key === "properties" && inner && typeof inner === "object"
        ? Object.fromEntries(
            Object.entries(inner).map(([name, schema]) => [
              name,
              cleanSchema(schema, loose, false),
            ]),
          )
        : cleanSchema(inner, loose, false);
  }
  return out;
}

/** 一个工具定义，发给模型的形状（AI SDK 的 function 工具）。 */
type FunctionTool = {
  type: string;
  name?: string;
  description?: string;
  inputSchema?: unknown;
};

/**
 * 一步要发给模型的工具，瘦身后的样子：隐藏运行时状态工具，常驻工具换短描述，schema 去噪音。
 * 不认识的工具、不是 function 的工具原样放行。
 */
export function slimModelTools<T extends FunctionTool>(
  tools: readonly T[],
  options: { strict?: boolean } = {},
): T[] {
  return tools
    .filter(
      (tool) =>
        !(tool.type === "function" && HIDDEN_TOOLS.has(tool.name ?? "")),
    )
    .map((tool) => {
      if (tool.type !== "function") return tool;
      const brief =
        tool.name && Object.hasOwn(TOOL_BRIEFS, tool.name)
          ? TOOL_BRIEFS[tool.name]
          : undefined;
      const schema = cleanSchema(tool.inputSchema, !options.strict) as
        | { properties?: Record<string, { description?: string }> }
        | undefined;
      if (brief?.params && schema?.properties)
        for (const [name, description] of Object.entries(brief.params)) {
          const property = schema.properties[name];
          if (property) property.description = description;
        }
      return {
        ...tool,
        ...(brief
          ? { description: withToolHint(tool.name, brief.description) }
          : {}),
        ...(tool.inputSchema !== undefined ? { inputSchema: schema } : {}),
      };
    });
}
