import { OFFER_CHECK_IN_TOOL } from "./check-in-offer";
import { SHOW_APP_ACCESS_TOOL } from "./connect-prompt";
import { RESEARCH_ROLE_LABELS, researchRoleOfTool } from "./research";
import { SUBAGENT_TOOL } from "./subagent";
import { lowerFirst, nameInWords } from "./tool-name-words";
import { SEARCH_TOOLS } from "./tool-search";

/**
 * A tool call, named the way the person watching would name it.
 *
 * The model is offered `mcp__notes__search_notes`, because a tool name has to be unique across every
 * server a Bot holds and has to survive two vendors both calling something `search`. None of that is
 * the reader's problem, and putting it on screen tells them how the thing is built rather than what
 * their Bot just did.
 *
 * ANY OTHER NAME IS PUT IN WORDS TOO, never drawn as it came. A line is drawn the moment a call
 * starts, before its arguments and before the app's own renderer for it may have loaded, so its name
 * is all there is to say. FOUND LIVE: a Bot first called `web_search`, a name it was never offered,
 * and its line read "web_search" until the real search joined it. A component the app draws
 * (`showBarChart`) reads "Show bar chart" while its renderer is not there yet, and a name with no
 * words in it reads as a tool being used.
 */
export type ToolName = {
  /** What was done, for the line itself. */
  label: string;
  /** Which server it was done against, muted beside the label. Absent for anything not MCP. */
  detail?: string;
};

export function readToolName(name: string, running = false): ToolName {
  const own = ownToolLabel(name, running);
  if (own) return { label: own };
  const parts = name.split("__");
  if (parts.length < 3 || parts[0] !== "mcp")
    return {
      label:
        wordsOf(name).length > 0
          ? humanise(name)
          : running
            ? "正在使用工具"
            : "使用了工具",
    };

  const [, rawServer, ...rest] = parts;
  /*
   * OpenBot's own Routines app also carries a goal's tools for a conversation. They are the tools a
   * goal's run holds, so they read in its words, 「创建了目标」, and not "Create goal" beside
   * "routines".
   */
  if (rawServer === ROUTINES_APP) {
    const goal = ownToolLabel(rest.join("__"), running);
    if (goal) return { label: goal };
  }
  return appToolName(rawServer ?? "", rest.join("__"));
}

/** The key of OpenBot's own Routines app (`ALWAYS_ON_APP` on the server). */
const ROUTINES_APP = "routines";

/**
 * One app's tool, from its server key and the tool's own name: what `readToolName` reads out of an
 * `mcp__server__tool` name, and what an approval is asked about as `server/tool`.
 */
export function appToolName(server: string, tool: string): ToolName {
  const broker = brokeredApp(server);
  /*
   * Research is named for what it did, not for who did it. `web_search_exa` would read "Web search
   * exa", which tells the person which vendor this deployment buys search from and nothing about
   * their answer. Which provider is granted is an administrator's fact, on the Bot's access page.
   */
  const role = researchRoleOfTool(server, tool);
  if (role) return { label: RESEARCH_ROLE_LABELS[role] };
  /*
   * A BROKERED APP IS NAMED ONCE, AS THE APP, BESIDE THE ACTION. Composio publishes
   * `<APP>_<VERB>_<NOUN>`, so its app leads every action and reads as a vendor's prefix
   * ("Airtable list bases"). The action starts at the verb and the app is said once, in its own
   * name.
   */
  if (broker) {
    const appWords = wordsOf(broker);
    const toolWords = wordsOf(tool);
    const leads = appWords.every((word, index) => toolWords[index] === word);
    const action = leads ? toolWords.slice(appWords.length) : toolWords;
    return {
      label: nameInWords(
        action.length > 0 ? humanise(action.join(" ")) : humanise(tool),
      ),
      detail: connectorName(server),
    };
  }
  /*
   * A vendor that leads its own tool names with its name (`notion-fetch`) is named once, as the
   * app, beside the action, the way a brokered app is: "Fetch" on Notion, not "Notion fetch notion".
   */
  const serverLead = wordsOf(server);
  const toolLead = wordsOf(tool);
  if (
    toolLead.length > serverLead.length &&
    serverLead.every((word, index) => toolLead[index] === word)
  )
    return {
      label: nameInWords(humanise(toolLead.slice(serverLead.length).join(" "))),
      detail: connectorName(server),
    };
  const label = humanise(tool);

  /*
   * The server is dropped when the action already names it as the thing acted upon. Vendors name a
   * tool after the thing it acts on, so `mcp__notes__search_notes` would otherwise read "Search
   * notes notes" and `mcp__routines__create_routine` "Create routine routines", both of which look
   * like a bug rather than a label. A server key can itself be more than one word — `google-drive`,
   * `google_drive` — so it is split into words the same way `humanise` splits the tool name, each
   * singularised, and looked for as a contiguous run inside the label's words. Whole words in an
   * unbroken sequence, never a substring test: that is what let "Create routine routines" through in
   * the first place.
   *
   * `humanise` always puts the verb first, and that leading word is excluded from the search:
   * `mcp__posts__post_message` singularises its server to "post", which is also the tool's own verb,
   * so without this exclusion "Post message" would lose its "posts" attribution over a coincidence
   * with the verb rather than a naming of the server. Same shape for `mcp__lists__list_files`
   * against "List". Only the words after the verb describe what the action was taken on, so only
   * those are eligible to match the server.
   *
   * This does not, and cannot, catch every collision: `mcp__news__get_new_items` singularises "news"
   * to "new", which genuinely is the second word of "Get new items", so the server is still dropped
   * there. English plural heuristics cannot tell that "new" apart from the "new" in "news" — that is
   * a known limit of this rule, not a bug to chase with a word list.
   */
  const labelWords = label.toLowerCase().split(" ").map(singular);
  const wordsActedOn = labelWords.slice(1);
  const serverWords = wordsOf(server).map(singular);
  const named = containsPhrase(wordsActedOn, serverWords);
  const said = nameInWords(label);
  return named ? { label: said } : { label: said, detail: server };
}

/**
 * The connector a server key names, the way a person would say it: "google-drive" as "Google
 * Drive", and a broker's "composio-airtable" or "arcade-Gmail" as the app alone.
 */
export function connectorName(server: string): string {
  return wordsOf(brokeredApp(server) ?? server)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * 给人看的「动作 + 地点」怎么拼成中文。这个文件里所有把动作和地点放在一起的地方都按这几条写：
 *
 * 1. 动作是中文（OpenBot 自己的动作，浏览器、电脑、文件夹）：地点在前，「在 {地点} 上{动作}」——
 *    「在 en.wikipedia.org 上点击链接「Python」」「在 en.wikipedia.org 上打开页面」。
 * 2. 动作是英文：第三方应用的工具名由 `appToolName`/`humanise` 从厂商标识符生成，本来就是英文，
 *    不翻；从标识符拼出来的其他动作名也一样。英文动作不塞进「在…上」里（「在 Gmail 上send email」
 *    读不通），而是「{动作}（{地点}）」——「send email（Gmail）」。中文动作和英文动作只按动作的
 *    第一个字分：以中文开头的是第 1 条，其余是第 2 条（{@link atPlace}）。
 * 3. 文件夹里的一个文件：先说动作和文件，文件夹放在括号里，「保存文件 todo.txt（在 share 中）」；
 *    对整个文件夹的动作（列出文件、执行命令），「执行命令（在 share 中）」。文件和文件夹的说法
 *    由 {@link inFolder} 统一给出，审批卡、步骤和活动记录读起来一样。
 * 4. 员工自己电脑上的文件，动作后面直接跟路径：「保存文件 /home/bot/todo.txt」。
 *
 * 中文和英文、数字、路径之间留一个半角空格；括号、引号用全角（「」（））。
 */

/**
 * What an approval asks to do and where, as its card says it: the action ("保存文件", or an app's
 * "send email") over the place ("Gmail", "todo.txt（在 share 中）") on a list, and
 * 「{员工} 想要{action}」 above it.
 *
 * An app's tool is asked about as `<app>/<tool>` on the app itself (`toolRef` and `scope` in
 * server/src/plugins/plugin-store/calls.ts), so it read "requests/get request on requests": the app's
 * key twice and the tool's raw name. It is named the way the conversation names the same call, the
 * action in words and the app by its name, so the card reads "get request（Requests）". Every other
 * action keeps the words it had: a computer's on the site or folder it acts on, a command on the
 * computer it runs on.
 */
export function approvalWords(action: {
  toolRef: string;
  scope: string;
  /** What the action is aimed at, as the server resolved it. A folder's carries its name. */
  target?: unknown;
  /** 这个人在该应用上的哪一个账号（他有多个时）：地点读作「Gmail 账号 dana@work.example」。 */
  account?: string;
}): {
  action: string;
  place: string;
} {
  const { action: words, place } = approvalParts(action);
  return { action: words, place };
}

/**
 * What an approval waits on as one phrase, for a card's title and a task's waiting line, by the
 * rules above: "send email（Gmail）", 「在 example.com 上点击」, and a file as its step and its
 * Activity row name it, 「保存文件 todo.txt（在 share 中）」. A step on a whole folder is
 * 「执行命令（在 share 中）」.
 */
export function approvalPhrase(action: {
  toolRef: string;
  scope: string;
  target?: unknown;
  /** 这个人在该应用上的哪一个账号（他有多个时）：地点读作「Gmail 账号 dana@work.example」。 */
  account?: string;
}): string {
  const { action: words, place, form } = approvalParts(action);
  if (form === "in") return `${words}（${inFolder(undefined, place)}）`;
  if (form === "follows") return `${words} ${place}`;
  return atPlace(words, place);
}

/**
 * An action at a place: 「在 {place} 上{action}」 when the action is in Chinese, and
 * "{action}（{place}）" when it is a name made from an English identifier (rule 2 above).
 */
function atPlace(action: string, place: string): string {
  return /^[　-鿿＀-￯]/.test(action)
    ? `在 ${place} 上${action}`
    : `${action}（${place}）`;
}

/**
 * The action, the place, and how the two are joined: `at` a site, an app or a computer; `in` a whole
 * folder (the place is the folder's name); or a place that `follows` the action as it is, a file
 * already said with its folder or a path.
 */
function approvalParts(action: {
  toolRef: string;
  scope: string;
  target?: unknown;
  account?: string;
}): { action: string; place: string; form: "at" | "in" | "follows" } {
  const slash = action.toolRef.indexOf("/");
  const app = action.toolRef.slice(0, slash);
  if (slash > 0 && app === action.scope) {
    const { label } = appToolName(app, action.toolRef.slice(slash + 1));
    /*
     * 哪个账号（上游 #1298）：这个人在该应用上有不止一个账号时，卡片要说清楚问的是哪一个，
     * 「send email（Gmail 账号 dana@work.example）」。只有一个账号时没有什么要区分的，读法不变。
     */
    const account = action.account?.trim();
    return {
      action: lowerFirst(label),
      place: account
        ? `${connectorName(app)} 账号 ${account}`
        : connectorName(app),
      form: "at",
    };
  }
  /*
   * A browser action on the site it acts on, with the control it presses when the page named one:
   * 「在 en.wikipedia.org 上点击链接「Python」」. Activity said "Approve computer_click".
   */
  const browser = browserAction(action.toolRef, action.target);
  if (browser) return { action: browser, place: action.scope, form: "at" };
  /*
   * A computer's or a folder's own action in the words its step and its Activity row use. The card
   * said "write file on todo.txt in share" above a step that read "Save a file todo.txt in share".
   * One with no words of its own keeps the words of its identifier, in English (rule 2 above).
   */
  const own = ownToolAttempt(action.toolRef.replace(/^host\//, "host_"));
  const words = own
    ? lowerFirst(own)
    : action.toolRef.replace(/^computer_|^host\//, "").replaceAll("_", " ");
  /*
   * A folder on the person's computer by the name Settings > Computer shows. Its scope is the id
   * OpenBot gave the grant, which kept a rule saved from the card on that grant, and read on the
   * card as "write file on host-grant-15407-1794112361547002000".
   */
  if (action.toolRef.startsWith("host/")) {
    const file = folderFile(action.target);
    const folder = folderName(action.target);
    // 「保存文件 todo.txt（在 share 中）」；a command or a listing is in the folder itself.
    if (file)
      return {
        action: words,
        place: inFolder(file, folder) ?? file,
        form: "follows",
      };
    if (folder) return { action: words, place: folder, form: "in" };
  }
  // A file on the Bot's own computer by its path, as its step names it, not the folder it is in.
  const path = computerFile(action.target);
  if (path) return { action: words, place: path, form: "follows" };
  return { action: words, place: action.scope, form: "at" };
}

/** Handles the model cites and the run carries, which name nothing a person could check. */
const INTERNAL_ARGS = new Set(["ref", "snapshotId", "toolCallId", "signal"]);

/**
 * What an approval would send, as labelled lines for its card: "Text: hello", "To: sam@example.test".
 * 标签由参数名生成（`wordsOf`），和应用工具名一样保持英文，不翻；值里的是/否写成中文。
 * The card showed the arguments as JSON, and a click read `{ "ref": "f3e43", "snapshotId": 4 }`, two
 * handles to a page snapshot nobody can see. Those are left out, so a click has nothing to add to its
 * title and shows no lines at all. Everything else stays whole: nobody allows what they were not shown.
 */
export function approvalDetails(
  args: unknown,
): { label: string; value: string }[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  return Object.entries(args).flatMap(([key, value]) => {
    if (INTERNAL_ARGS.has(key) || value === undefined || value === null)
      return [];
    const text =
      typeof value === "string"
        ? value
        : typeof value === "boolean"
          ? value
            ? "是"
            : "否"
          : typeof value === "number"
            ? String(value)
            : Array.isArray(value) &&
                value.every((entry) => typeof entry === "string")
              ? value.join(", ")
              : JSON.stringify(value, null, 2);
    const words = wordsOf(key)
      .map((word) => ACRONYMS[word] ?? word)
      .join(" ");
    const label = words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
    return [{ label, value: text }];
  });
}

/** Argument words a person reads in capitals. */
const ACRONYMS: Record<string, string> = { url: "URL", id: "ID" };

/**
 * A saved approval rule's title, in the words its approval card used for the action it covers:
 * 「点击」, "Send email（Gmail）", 「Gmail 上的任何操作」. The list titled each rule by its tool id
 * ("computer_click", "mcp/gmail/*"). `place` is true when the title already names where the rule
 * applies, so the line under it need not say "composio-gmail" again. A pattern a person typed
 * that matches several actions some other way is kept as they wrote it.
 */
export function ruleTitle(rule: { toolRef: string; scope: string }): {
  title: string;
  place: boolean;
} {
  const upper = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
  if (rule.toolRef === "*") return { title: "任何操作", place: false };
  if (rule.toolRef === "host/*")
    return { title: "你的文件夹中的任何操作", place: false };
  const ref = rule.toolRef.replace(/^mcp\//, "");
  const slash = ref.indexOf("/");
  if (slash > 0 && !ref.startsWith("host/")) {
    const app = ref.slice(0, slash);
    const tool = ref.slice(slash + 1);
    if (app.includes("*")) return { title: rule.toolRef, place: false };
    const named = rule.scope === "*" || rule.scope === app;
    if (tool === "*")
      return { title: `${connectorName(app)} 上的任何操作`, place: named };
    if (tool.includes("*")) return { title: rule.toolRef, place: false };
    const { action, place } = approvalWords({ toolRef: ref, scope: app });
    return { title: atPlace(upper(action), place), place: named };
  }
  if (ref.includes("*")) return { title: rule.toolRef, place: false };
  return {
    title: upper(approvalWords({ toolRef: ref, scope: rule.scope }).action),
    place: false,
  };
}

/** What a browser action asks to do, said as its step says it. */
const BROWSER_ACTIONS: Record<string, string> = {
  computer_navigate: "打开页面",
  computer_click: "点击",
  computer_type: "填写字段",
  computer_key: "按下按键",
  computer_scroll: "滚动页面",
};

/** A page control's role in the words a person uses for it. */
const CONTROL_WORDS: Record<string, string> = {
  link: "链接",
  button: "按钮",
  checkbox: "复选框",
  radio: "选项",
  option: "选项",
  tab: "标签页",
  menuitem: "菜单项",
  switch: "开关",
  textbox: "输入框",
  searchbox: "搜索框",
  combobox: "下拉列表",
};

/**
 * A browser action in words, naming the control it presses from the label the server resolved
 * (`target.element`), never the ref and snapshot the model cited. Undefined for any other action.
 */
function browserAction(toolRef: string, target: unknown): string | undefined {
  const base = BROWSER_ACTIONS[toolRef];
  if (!base) return undefined;
  const element =
    target && typeof target === "object"
      ? (target as { element?: { role?: unknown; name?: unknown } }).element
      : undefined;
  const name =
    typeof element?.name === "string"
      ? element.name.replace(/\s+/g, " ").trim()
      : "";
  const role =
    typeof element?.role === "string" ? CONTROL_WORDS[element.role] : undefined;
  // 「点击链接「Python」」「点击按钮」「填写「搜索」」。
  if (toolRef === "computer_click") {
    if (name) return `点击${role ?? ""}「${clipName(name)}」`;
    return role ? `点击${role}` : base;
  }
  if (toolRef === "computer_type" && name) return `填写「${clipName(name)}」`;
  return base;
}

/** A control's label, short enough for a title. */
function clipName(name: string): string {
  const chars = Array.from(name);
  return chars.length > 60 ? `${chars.slice(0, 59).join("")}…` : name;
}

/** The path a file action on the Bot's own computer names (`target.filePath`), or undefined. */
function computerFile(target: unknown): string | undefined {
  if (!target || typeof target !== "object") return undefined;
  const { filePath } = target as { filePath?: unknown };
  return typeof filePath === "string" && filePath.trim() ? filePath : undefined;
}

/**
 * A file and the folder on the person's computer it is in, said the same way on the approval card,
 * on the step and in Activity: 「todo.txt（在 share 中）」. A step on the whole folder (a listing, a
 * command) is 「在 share 中」. Undefined when neither is known.
 */
export function inFolder(
  file: string | undefined,
  folder: string | undefined,
): string | undefined {
  if (file && folder) return `${file}（在 ${folder} 中）`;
  if (folder) return `在 ${folder} 中`;
  return file || undefined;
}

/** The file a folder action's target names, or undefined for the folder itself. */
function folderFile(target: unknown): string | undefined {
  if (!target || typeof target !== "object") return undefined;
  const { relativePath } = target as { relativePath?: unknown };
  return typeof relativePath === "string" &&
    relativePath.trim() &&
    relativePath !== "."
    ? relativePath
    : undefined;
}

/** The name of the folder a folder action's target names, or undefined. */
function folderName(target: unknown): string | undefined {
  if (!target || typeof target !== "object") return undefined;
  const { displayName } = target as { displayName?: unknown };
  return typeof displayName === "string" && displayName.trim()
    ? displayName
    : undefined;
}

type OwnTool = {
  running: string;
  done: string;
  /**
   * What was asked for, for a step that was blocked: 「保存文件」, not 「保存了文件」. A blocked
   * step did not happen, so its line says what was tried. Without it the line keeps `done`.
   */
  attempted?: string;
  /** The argument naming what the step acted on, said beside its words: a file's path. */
  subject?: "path";
  /**
   * What it was given and what it answered were both written for the model (a tool search's query
   * and limit), so its step in a folded group says what it did and does not open.
   */
  answersTheModel?: true;
};

/** A goal's tools, under the names they are offered as. */
function goalTools(names: {
  create: string;
  list: string;
  update: string;
  report: string;
  run: string;
  pause: string;
  resume: string;
  complete: string;
}): Record<string, OwnTool> {
  return {
    [names.create]: { running: "正在创建目标", done: "创建了目标" },
    [names.list]: { running: "正在查看目标", done: "查看了目标" },
    [names.update]: { running: "正在更新目标", done: "更新了目标" },
    [names.report]: {
      running: "正在记录进展",
      done: "记录了进展",
    },
    [names.run]: { running: "正在启动目标", done: "启动了目标" },
    [names.pause]: { running: "正在暂停目标", done: "暂停了目标" },
    [names.resume]: { running: "正在恢复目标", done: "恢复了目标" },
    [names.complete]: {
      running: "正在把目标标记为已完成",
      done: "把目标标记为已完成",
    },
  };
}

/**
 * The tools OpenBot itself offers a Bot, named in words somebody chose.
 *
 * These are not MCP names, so nothing above rewrites them, and the bare identifier is what a line
 * would otherwise say: "show_app_access", shimmering, while the Bot works out what an app is for the
 * person. Named twice, for the moment and for afterwards, because a line is drawn while it runs AND
 * left on screen once done.
 *
 * EVERY ONE OF THEM, including those the app draws a card for. A card is the usual picture, but the
 * same call is also a step inside a subtask, a line in a conversation opened where its card is not
 * registered, and a line in a run with no browser at all. `server/tests/built-in-tool-labels.test.ts`
 * reads every tool OpenBot registers and fails on one missing here.
 *
 * 中文时态：`running` 用进行时（「正在保存文件」），`done` 用完成时（「保存了文件」），`attempted`
 * 写尝试做什么（「保存文件」），被拦下时拼成「已拦截：保存文件」。术语跟 app 一致：Bot 叫员工，
 * Goal 叫目标，check-in 叫主动巡检，notebooks 叫知识库。
 */
const OWN_TOOLS: Record<string, OwnTool> = {
  [SHOW_APP_ACCESS_TOOL]: {
    running: "正在查看应用权限",
    done: "查看了应用权限",
    answersTheModel: true,
  },
  [SEARCH_TOOLS]: {
    running: "正在查找工具",
    done: "查找了工具",
    answersTheModel: true,
  },

  // Bringing someone else in.
  ask_person: { running: "正在问你", done: "问了你" },
  message_bot: { running: "正在问另一位员工", done: "问了另一位员工" },
  [SUBAGENT_TOOL]: { running: "正在处理子任务", done: "处理了子任务" },
  // A voice conversation handing what was said to the Bot behind it.
  ask_agent: { running: "正在问员工", done: "问了员工" },

  // Skills: the ones it learned, and the ones a person writes with it.
  copilotkit_load_skill: { running: "正在使用技能", done: "使用了技能" },
  copilotkit_read_skill_file: {
    running: "正在读取技能里的文件",
    done: "读取了技能里的文件",
  },
  list_skills: {
    running: "正在查看已有技能",
    done: "查看了已有技能",
  },
  read_skill: { running: "正在读取技能", done: "读取了技能" },
  list_skill_tools: {
    running: "正在查看可用工具",
    done: "查看了可用工具",
  },
  save_skill: { running: "正在提议新技能", done: "提议了新技能" },

  /*
   * Drawing a generated interface in the conversation. The runtime offers it, not an OpenBot
   * registration, so `built-in-tool-labels.test.ts` cannot find it; its words go here by hand.
   */
  render_ui: { running: "正在绘制界面", done: "绘制了界面" },

  // Making a Bot from a conversation.
  list_bots: {
    running: "正在查看已有员工",
    done: "查看了已有员工",
  },
  read_bot: {
    running: "正在读取员工的指令",
    done: "读取了员工的指令",
  },
  list_bot_skills: {
    running: "正在查看可用技能",
    done: "查看了可用技能",
  },
  save_bot: { running: "正在提议新员工", done: "提议了新员工" },

  // Its memory of you.
  recall_personal_memory: {
    running: "正在查看关于你的记忆",
    done: "查看了关于你的记忆",
  },
  remember_personal_fact: {
    running: "正在保存记忆",
    done: "保存了记忆",
  },
  save_observed_memory: {
    running: "正在记下关于你的事",
    done: "记下了关于你的事",
  },
  form_memory: {
    running: "正在记下关于你的事",
    done: "记下了关于你的事",
  },
  forget_personal_memory: {
    running: "正在忘掉一条记忆",
    done: "忘掉了一条记忆",
  },

  // Follow-ups, check-ins and next steps.
  schedule_follow_up: {
    running: "正在安排跟进",
    done: "安排了跟进",
  },
  list_follow_ups: {
    running: "正在查看跟进",
    done: "查看了跟进",
  },
  cancel_follow_up: {
    running: "正在取消跟进",
    done: "取消了跟进",
  },
  [OFFER_CHECK_IN_TOOL]: {
    running: "正在提议主动巡检",
    done: "提议了主动巡检",
  },
  suggest_next_step: {
    running: "正在建议下一步",
    done: "建议了下一步",
  },
  clear_next_step: {
    running: "正在清除下一步",
    done: "清除了下一步",
  },

  // Goals. The `*_responsibility` names are what a goal's tools were called before they said goal,
  // kept so the steps in a conversation recorded then still read as words.
  ...goalTools({
    create: "create_goal",
    list: "list_goals",
    update: "update_goal",
    report: "report_goal_progress",
    run: "run_goal",
    pause: "pause_goal",
    resume: "resume_goal",
    complete: "complete_goal",
  }),
  ...goalTools({
    create: "create_responsibility",
    list: "list_responsibilities",
    update: "update_responsibility",
    report: "report_responsibility_progress",
    run: "run_responsibility",
    pause: "pause_responsibility",
    resume: "resume_responsibility",
    complete: "complete_responsibility",
  }),

  // The browser. A folded group names these steps in the same words (`browser-activity.ts`).
  computer_navigate: { running: "正在打开页面", done: "打开了页面" },
  computer_read: { running: "正在读取页面", done: "读取了页面" },
  computer_snapshot: { running: "正在查看页面结构", done: "查看了页面结构" },
  computer_click: { running: "正在点击页面", done: "点击了页面" },
  computer_type: { running: "正在填写字段", done: "填写了字段" },
  computer_key: { running: "正在按键", done: "按了按键" },
  computer_scroll: { running: "正在滚动页面", done: "滚动了页面" },
  computer_screenshot: {
    running: "正在截屏",
    done: "截了屏",
  },

  // The Bot's computer, and folders on yours. The same action reads the same on either.
  computer_list_files: {
    running: "正在列出文件",
    done: "列出了文件",
    attempted: "列出文件",
  },
  computer_read_file: {
    running: "正在读取文件",
    done: "读取了文件",
    attempted: "读取文件",
    subject: "path",
  },
  computer_write_file: {
    running: "正在保存文件",
    done: "保存了文件",
    attempted: "保存文件",
    subject: "path",
  },
  computer_run_command: {
    running: "正在执行命令",
    done: "执行了命令",
    attempted: "执行命令",
  },
  host_list_folders: {
    running: "正在查看你的文件夹",
    done: "查看了你的文件夹",
    attempted: "查看你的文件夹",
  },
  host_list_files: {
    running: "正在列出文件",
    done: "列出了文件",
    attempted: "列出文件",
  },
  host_read_file: {
    running: "正在读取文件",
    done: "读取了文件",
    attempted: "读取文件",
    subject: "path",
  },
  host_write_file: {
    running: "正在保存文件",
    done: "保存了文件",
    attempted: "保存文件",
    subject: "path",
  },
  host_run_command: {
    running: "正在执行命令",
    done: "执行了命令",
    attempted: "执行命令",
  },

  // Apps and windows on the person's own paired computer.
  computer_apps: {
    running: "正在查看你电脑上的应用",
    done: "查看了你电脑上的应用",
  },
  computer_app_call: {
    running: "正在使用你电脑上的应用",
    done: "使用了你电脑上的应用",
    attempted: "使用你电脑上的应用",
  },
  computer_app_enable: {
    running: "正在开启你电脑上的应用",
    done: "开启了你电脑上的应用",
    attempted: "开启你电脑上的应用",
  },
  computer_desktop_windows: {
    running: "正在查看你电脑上的窗口",
    done: "查看了你电脑上的窗口",
  },
  computer_desktop_snapshot: {
    running: "正在读取你电脑上的窗口",
    done: "读取了你电脑上的窗口",
    attempted: "读取你电脑上的窗口",
  },

  // Asking an admin for an app the Bot cannot use yet (migration 0153).
  request_app_access: {
    running: "正在申请使用应用",
    done: "申请了使用应用",
  },

  // Notebooks the person let the Bot read.
  list_knowledge: { running: "正在查看知识库", done: "查看了知识库" },
  search_knowledge: {
    running: "正在搜索知识库",
    done: "搜索了知识库",
  },

  // Asking the person, from the computer.
  computer_request_help: {
    running: "正在向你求助",
    done: "向你求助了",
  },
  computer_request_secret: {
    running: "正在等你填写字段",
    done: "已请你填写字段",
  },
  computer_request_sign_in: {
    running: "正在等你登录",
    done: "已请你登录",
  },
  report_refusal: {
    running: "正在记录被拒绝的请求",
    done: "记录了被拒绝的请求",
  },
};

/** One of OpenBot's own tools in words, or null for any other name. */
export function ownToolLabel(name: string, running = false): string | null {
  const own = Object.hasOwn(OWN_TOOLS, name) ? OWN_TOOLS[name] : undefined;
  if (!own) return null;
  return running ? own.running : own.done;
}

/**
 * What one of OpenBot's own steps asked for, for a step that was blocked and so did not happen, or
 * null when it has no words of its own for that.
 */
export function ownToolAttempt(name: string): string | null {
  const own = Object.hasOwn(OWN_TOOLS, name) ? OWN_TOOLS[name] : undefined;
  return own?.attempted ?? null;
}

/**
 * What one of OpenBot's own steps acted on, read from its arguments (a JSON string while it streams,
 * or already parsed): the file a file step read or saved. Undefined for any other step, and for
 * arguments not yet complete.
 */
export function ownToolSubject(
  name: string,
  args: unknown,
): string | undefined {
  const own = Object.hasOwn(OWN_TOOLS, name) ? OWN_TOOLS[name] : undefined;
  if (!own?.subject) return undefined;
  let value = args;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object") return undefined;
  const subject = (value as Record<string, unknown>)[own.subject];
  return typeof subject === "string" && subject.trim()
    ? subject.trim()
    : undefined;
}

/** Whether a step's arguments and answer were written for the model and are not shown to the person. */
export function answersTheModel(name: string): boolean {
  return (
    Object.hasOwn(OWN_TOOLS, name) && OWN_TOOLS[name]?.answersTheModel === true
  );
}

/**
 * The app behind a brokered server key, or null for a server this deployment dials itself.
 *
 * A brokered server is keyed `<broker>-<app>` — `composio-gmail`, `arcade-Gmail` — because the broker is how the
 * credential is held and two brokers could both offer Gmail. Neither of those is the reader's
 * business: they asked their Bot about their email, not about which company holds the grant. This
 * is the same argument the research relabelling above makes, and the answer is the same — which
 * broker a deployment buys through is an administrator's fact, on the Bot's access page.
 *
 * Only the prefix is removed, never the app. "Gmail" is what was acted upon and stays legible.
 */
function brokeredApp(server: string): string | null {
  for (const prefix of BROKER_PREFIXES) {
    if (!server.startsWith(prefix)) continue;
    const app = server.slice(prefix.length);
    return app.length > 0 ? app : null;
  }
  return null;
}

/**
 * The brokers whose apps this deployment keys `<broker>-<app>`: Composio, and Arcade (X5). See
 * `BROKERED_PROFILE` in `server/src/plugins/access.ts`, which names each one's prefix.
 */
const BROKER_PREFIXES = ["composio-", "arcade-"] as const;

/**
 * `routines` and `routine` are the same word for this purpose.
 *
 * A vendor names the server for the collection and the tool for the one item —
 * `mcp__routines__create_routine` — so the exact-substring test that stops "Search notes notes" lets
 * "Create routine routines" straight through, and it reads as a typo rather than as a label.
 *
 * Dropping one trailing `s` from each side before comparing is the whole of the difference between
 * those two cases. This is not a stemmer and must not grow into one: the only thing it has to catch
 * is one vendor writing the same noun twice, once plural and once not.
 */
function singular(word: string): string {
  return word.endsWith("s") ? word.slice(0, -1) : word;
}

/**
 * `search_notes` as "Search notes".
 *
 * Vendors write tool names in snake_case, camelCase or a mixture, and the only thing they agree on
 * is that the first word is a verb. Splitting on both and sentence-casing the result gets a phrase
 * that reads as an action without anybody maintaining a table of names.
 */
export function humanise(tool: string): string {
  const words = wordsOf(tool).join(" ");
  if (words.length === 0) return tool;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * `google-drive`, `google_drive` and `googleDrive` all split to the same `["google", "drive"]`.
 *
 * The same splitting `humanise` does for a tool name, pulled out so a server key can be broken into
 * words too rather than compared as one opaque token.
 */
function wordsOf(text: string): string[] {
  return text
    .replace(/[_-]+/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase()
    .split(" ")
    .filter((word) => word.length > 0);
}

/**
 * Whether `needle` occurs in `haystack` as a run of whole words, in order and unbroken.
 *
 * This is the whole-word alternative to a substring test: `["routine"]` must line up with a word
 * in `["create", "routine"]`, not merely appear inside one of its letters.
 */
function containsPhrase(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0) return false;
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((word, offset) => haystack[start + offset] === word))
      return true;
  }
  return false;
}
