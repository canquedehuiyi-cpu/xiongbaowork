/**
 * DoD-7 的覆盖台账：`app/src/routes` 下每个路由文件，要么被扫过，要么有一条写明的理由。
 *
 * 为什么要有这个文件：口径说的是「主路径路由的 DOM 扫描」，而扫描表是手写的。手写的表有个必然后果——
 * 新加一个路由文件，没人会记得回来加一行，于是「主路径」悄悄缩小，数出来的 0 还是 0，却盖不到新页面。
 * `server-tests.list.txt` 那类「文件存在但从不运行」的坑就是这么来的。所以先有台账，再有扫表：
 *
 * - `SCANNED`：扫表本身。`at` 是地址，`file` 是 `app/src/routes/` 下的相对路径。两者必须对得上，
 *   `addressOf()` 会从文件名机械推出地址来核对，写错一个字母就红。
 * - `UNCOVERED`：这一轮还没扫的文件，按理由分桶。**只许变短**：扫住一条就从桶里删掉它；
 *   桶里的文件要是已经出现在 `SCANNED` 里，测试会红，逼着把两头对齐。
 *
 * `app/tests/i18n-route-coverage.test.ts` 拿这两份数据跟磁盘上的文件比对，`i18n-dom-scan.test.tsx`
 * 拿 `SCANNED` 当扫表。分成三个文件是为了让「扫」和「算账」各自单独可读：算账不需要渲染，渲染不需要
 * 关心还剩多少没扫。
 */

/** 扫表的一行：一个地址，一个文件。 */
export type Scanned = {
  readonly at: string;
  readonly file: string;
  /**
   * 这条路由渲染出多少行文字才算「真画出来了」。默认 `FLOOR`（10）。
   *
   * 存在这个字段是因为一刀切的下限会误伤**天生很小的页面**：`/admin/plugins` 加载时只有两行、
   * `/pipelines` 五行。把它们判成「没扫到」并赶出扫表，等于因为量具粗糙而放弃这一页的覆盖。
   * 每一处下调都要写清是量的哪一次、为什么，不许拿它当「先过了再说」。
   */
  readonly minLines?: number;
  /**
   * 扫哪几种状态。默认两种（加载中 / 读完了）。
   *
   * 给 `/capabilities/memory` 这种页用的：它在请求还没回来时**一个字都不画**（连骨架都没有），
   * 「加载中」那一遍得到的 0 行既不能证明画好了、也不能证明画坏了——扫它是空转。
   * 只扫「读完了」，并在报告里如实记成一条，而不是假装两种状态都量过了。
   */
  readonly states?: readonly ("pending" | "loaded")[];
};

/**
 * 已被扫过的路由。地址取的是**落地页**：`/capabilities` 自己会 `redirect` 到 `/capabilities/plugins`，
 * `/routines` 到 `/autonomous`，扫的是跳过去之后那一页。
 *
 * 这一轮的判据是「外壳能带你到的页面」：侧栏与账户菜单的九个目的地、入口栏的入口页、以及「能力」这个
 * 目的地自己的九个页签（只扫它落到的那一个页签，等于这个目的地只盖了十分之一）。
 */
export const SCANNED: readonly Scanned[] = [
  { at: "/admin", file: "_authed/admin/index.tsx" },
  { at: "/admin/boundaries/new", file: "_authed/admin/boundaries_.new.tsx" },
  { at: "/admin/computers", file: "_authed/admin/computers.tsx" },
  { at: "/admin/credentials/new", file: "_authed/admin/credentials_.new.tsx" },
  // 加载时只有「插件」两个字和一行提示：实测 2 行。读完了是 12 行。
  {
    at: "/admin/plugins",
    file: "_authed/admin/plugins/index.tsx",
    minLines: 2,
  },
  { at: "/admin/skills/new", file: "_authed/admin/skills_.new.tsx" },
  { at: "/approvals", file: "_authed/_app/approvals.tsx" },
  { at: "/autonomous", file: "_authed/_app/autonomous.tsx" },
  { at: "/bots", file: "_authed/_app/bots.index.tsx" },
  {
    at: "/capabilities/components",
    file: "_authed/_app/capabilities.components.tsx",
  },
  {
    at: "/capabilities/knowledge",
    file: "_authed/_app/capabilities.knowledge.tsx",
  },
  // 请求没回来时整页空白（连骨架都没有），只扫「读完了」那一遍。
  {
    at: "/capabilities/memory",
    file: "_authed/_app/capabilities.memory.tsx",
    states: ["loaded"],
  },
  { at: "/capabilities/mine", file: "_authed/_app/capabilities.mine.tsx" },
  { at: "/capabilities/models", file: "_authed/_app/capabilities.models.tsx" },
  {
    at: "/capabilities/plugins",
    file: "_authed/_app/capabilities.plugins.tsx",
  },
  {
    at: "/capabilities/projects",
    file: "_authed/_app/capabilities.projects.tsx",
  },
  { at: "/capabilities/roles", file: "_authed/_app/capabilities.roles.tsx" },
  { at: "/capabilities/skills", file: "_authed/_app/capabilities.skills.tsx" },
  {
    at: "/capabilities/wakerflows",
    file: "_authed/_app/capabilities.wakerflows.tsx",
  },
  // 加载时 7 行（页头、页签、空状态的位置都还没出来），读完了 12 行。
  {
    at: "/connections",
    file: "_authed/_app/connections.index.tsx",
    minLines: 7,
  },
  // 整页就是个空状态：加载时 5 行，读完了 6 行。
  { at: "/pipelines", file: "_authed/_app/pipelines.tsx", minLines: 5 },
  { at: "/settings", file: "_authed/settings/index.tsx" },
  { at: "/settings/approvals", file: "_authed/settings/approvals.tsx" },
  { at: "/settings/computer", file: "_authed/settings/_personal/computer.tsx" },
  {
    at: "/settings/credentials/new",
    file: "_authed/settings/_personal/credentials_.new.tsx",
  },
  { at: "/settings/notifications", file: "_authed/settings/notifications.tsx" },
  { at: "/settings/plans", file: "_authed/settings/plans.tsx" },
  {
    at: "/settings/skills/new",
    file: "_authed/settings/_personal/skills_.new.tsx",
  },
  { at: "/tasks", file: "_authed/_app/tasks.tsx" },
  { at: "/team-bots", file: "_authed/_app/team-bots.tsx" },
  { at: "/wakerflows/new", file: "_authed/_app/wakerflows.new.tsx" },
  { at: "/workbench", file: "_authed/_app/workbench.tsx" },
];

/** 未覆盖的理由。固定几个码，不允许临时发明词汇。 */
export type UncoveredWhy =
  | "布局"
  | "参数"
  | "旧地址"
  | "缺夹具"
  | "非界面文案"
  | "不足下限"
  | "待翻";

export type Uncovered = {
  readonly why: UncoveredWhy;
  /** 这个理由是什么意思，写给人看。 */
  readonly note: string;
  readonly files: readonly string[];
};

/**
 * 这一轮还没扫到的文件。分桶不按「好不好看」分，按**为什么扫不到**分——每一桶的下一轮动作不同：
 *
 * - `布局`：没有自己的地址（`__root`、`_authed`、`_app`、`route.tsx`）。它们只在别的路由里画 `<Outlet/>`，
 *   没有自己的 DOM，扫到的是子路由的内容，重复计算。
 * - `参数`：地址里有 `$id`。要一段真实 id 才画得出来，凭空造一个 id 进去只会得到「找不到这条对话」。
 *   下一轮的做法是造夹具（真的建一个对话/员工），不是编 id。
 * - `旧地址`：老链接，`beforeLoad` 里就 `throw redirect`，自己不画东西。探针里它们只画出一行
 *   TanStack 默认的 `Not Found`（真应用里 `notFoundComponent` 是跳回首页），这一行不是产品文案。
 * - `缺夹具`：有固定地址，但要先造出某种状态才画得出来——管理员身份、一个已有数据的工作台、
 *   一个能跑浏览器的部署。现在进去会崩，崩在数据形状上，不是文案上。
 * - `非界面文案`：`/settings/about` 的正文是**第三方许可证原文**，三千多行英文，按许可协议不能翻译，
 *   也不该记进「界面没翻」的账。这一条不是「以后补」，是**口径上就不该扫**。
 * - `不足下限`：页面本身就只有几行（`/contacts` 六行、`/bot` 一行），低于 `FLOOR`。这是量具的缺陷，
 *   不是页面的：下一轮改成按路由配下限，这些就能扫。
 * - `待翻`：能画出来，但里面有真英文，得先翻译。`/admin/playground` 三十七行里十七行英文，
 *   `/desktop-return` 六行全是英文。
 */
export const UNCOVERED: readonly Uncovered[] = [
  {
    why: "布局",
    note: "没有自己的地址，只画 Outlet",
    files: [
      "__root.tsx",
      "_authed.tsx",
      "_authed/_app.tsx",
      "_authed/admin/route.tsx",
      "_authed/settings/_personal.tsx",
      "_authed/settings/route.tsx",
    ],
  },
  {
    why: "参数",
    note: "地址里有 $id，要真实 id 才画得出来",
    files: [
      "_authed/_app/assemble.$agentId.tsx",
      "_authed/_app/bots.$agentId.access.tsx",
      "_authed/_app/bots.$agentId.activity.tsx",
      "_authed/_app/bots.$agentId.approvals.tsx",
      "_authed/_app/bots.$agentId.index.tsx",
      "_authed/_app/bots.$agentId.memory.tsx",
      "_authed/_app/bots.$agentId.reach.tsx",
      "_authed/_app/bots.$agentId.responsibilities.tsx",
      "_authed/_app/bots.$agentId.routines.tsx",
      "_authed/_app/bots.$agentId.setup.tsx",
      "_authed/_app/bots.$agentId.sharing.tsx",
      "_authed/_app/channel/$channelId.tsx",
      "_authed/_app/connections.$key.tsx",
      "_authed/_app/connections.$key_.bots.$agentId.tsx",
      "_authed/_app/connections.$key_.tools.$tool.tsx",
      "_authed/_app/group/$channelId.tsx",
      "_authed/_app/s/$screen.tsx",
      "_authed/_app/start.$startId.tsx",
      "_authed/_app/tasks.$taskId.tsx",
      "_authed/_app/wakerflows.$flowId.tsx",
      "_authed/_app/wakerflows.import.$token.tsx",
      "_authed/_app/wakers_.$agentId.tsx",
      "_authed/admin/boundaries_.$index.tsx",
      "_authed/admin/components/$name.tsx",
      "_authed/admin/plugins/$key.tsx",
      "_authed/admin/plugins/$key_.bots.$agentId.tsx",
      "_authed/admin/plugins/$key_.tools.$tool.tsx",
      "_authed/admin/skills_.$slug.tsx",
      "_authed/settings/_personal/plugins.$.tsx",
      "_authed/settings/_personal/skills_.$slug.tsx",
      "_authed/settings/components-gallery/$name.tsx",
      "_authed/settings/connected-accounts/$key.tsx",
      "_authed/sign-in/$requestId.tsx",
    ],
  },
  {
    why: "旧地址",
    note: "beforeLoad 里就 throw redirect，自己不画东西",
    files: [
      "_authed/_app/agents/index.tsx",
      "_authed/_app/capabilities.index.tsx",
      "_authed/_app/knowledge.tsx",
      "_authed/_app/memory.tsx",
      "_authed/_app/plans.tsx",
      "_authed/_app/platform.tsx",
      "_authed/_app/resources.tsx",
      "_authed/_app/role-templates.tsx",
      "_authed/_app/routines.tsx",
      "_authed/_app/skills.tsx",
      "_authed/_app/wakers.tsx",
      "_authed/admin/plugins/arcade.tsx",
      "_authed/settings/connected-accounts/index.tsx",
      "_authed/settings/memory.tsx",
      "_authed/settings/setup.tsx",
      "sign.tsx",
    ],
  },
  {
    why: "缺夹具",
    note: "有地址，但要先造出状态（管理员/已有数据/能跑浏览器的部署）才画得出来",
    files: [
      "_authed/_app/browser.tsx",
      "_authed/_app/index.tsx",
      "_authed/_app/me.tsx",
      "_authed/_app/responsibilities.tsx",
      "_authed/_app/routines_.new.tsx",
      "_authed/_app/connections.browse.arcade.tsx",
      "_authed/_app/connections.browse.composio.tsx",
      "_authed/admin/audit.tsx",
      "_authed/admin/enterprise.tsx",
      "_authed/admin/learning.tsx",
      "_authed/admin/people.tsx",
      "_authed/admin/proactive.tsx",
      "_authed/admin/what-if.tsx",
      "_authed/onboarding.tsx",
      "_authed/settings/_personal/activity.tsx",
      "_authed/settings/browsers.tsx",
      "_authed/settings/learning.tsx",
      "_authed/_app/reachability.tsx",
    ],
  },
  {
    why: "非界面文案",
    note: "正文是第三方许可证原文，按协议不能翻译，口径上就不该扫",
    files: ["_authed/settings/about.tsx"],
  },
  {
    why: "不足下限",
    note: "页面本身不足 FLOOR 行；下一轮改成按路由配下限",
    files: [
      "_authed/_app/bot.tsx",
      "_authed/_app/briefing.tsx",
      "_authed/_app/capabilities.tsx",
      "_authed/_app/channel/new.tsx",
      "_authed/_app/contacts.tsx",
      "_authed/_app/group/new.tsx",
      "_authed/_app/wakerflows.index.tsx",
      "_authed/admin/approvals.tsx",
      "_authed/admin/approvals_.describe.tsx",
      "_authed/admin/approvals_.guidance.tsx",
      "_authed/admin/boundaries.tsx",
      "_authed/admin/components/index.tsx",
      "_authed/admin/credentials.tsx",
      "_authed/admin/identity-providers.tsx",
      "_authed/admin/permissions.tsx",
      "_authed/admin/permissions_.describe.tsx",
      "_authed/admin/platform.tsx",
      "_authed/admin/plugins/composio.tsx",
      "_authed/admin/providers.tsx",
      "_authed/admin/skills.tsx",
      "_authed/settings/_personal/credentials.tsx",
      "_authed/settings/_personal/skills.tsx",
      "_authed/settings/components-gallery/index.tsx",
      "_authed/settings/devices.tsx",
      "_authed/settings/passwords.tsx",
      "_authed/settings/this-computer.tsx",
    ],
  },
  {
    why: "待翻",
    note: "能画出来，但里面有真英文，得先翻译",
    files: ["_authed/desktop-return.tsx", "_authed/admin/playground.tsx"],
  },
];

/**
 * 从文件名机械推出地址：`_` 开头的目录与文件是布局（不占地址），`route` 是布局文件，`index` 落到父级，
 * 结尾的 `_` 表示逃出父布局（`routines_.new` → `/routines/new`），点分与斜杠都是层级。
 *
 * 这个函数存在的唯一目的，是让 `SCANNED` 里的 `at` 与 `file` 不能各说各话。
 */
export function addressOf(file: string): string {
  const out: string[] = [];
  for (const segment of file.replace(/\.tsx$/, "").split("/")) {
    if (segment.startsWith("_") || segment === "route") continue;
    for (const piece of segment.split(".")) {
      if (piece === "index") continue;
      out.push(piece.endsWith("_") ? piece.slice(0, -1) : piece);
    }
  }
  return `/${out.join("/")}`;
}
