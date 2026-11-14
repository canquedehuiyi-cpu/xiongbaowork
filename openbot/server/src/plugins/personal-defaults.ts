/**
 * 个人版的默认（上游 `plugins/personal-defaults.ts`，#977 #998 #1130 #1222 #1273 #1315）。
 *
 * 个人版只有一个人，他也是管理员：连上一个应用，就是决定每位员工都能用它；写的技能，每位员工都会；
 * 例行任务（Routines）一直开着；联网搜索开箱即用；每位员工都参与自动学习。这里把这些默认落到数据上。
 *
 * 只在 `currentEdition() === "personal"` 时做任何事。团队版里每个包装都原样放行、每个启动步骤都什么也不写，
 * 授予仍由管理员逐个决定（和上游不同：上游在团队版里也把 Routines 加上并给每位员工，fork 的 Routines 在
 * 团队版里是管理员要像对待别的应用一样授予的能力，见 `catalogue.ts` 的 routines 条目）。
 *
 * 安全面（每一条都有测试）：
 * - 授予只改「员工持有什么」，不改调用时的任何一道门：审批底线（`approvals/policy.ts`：交给本人、删除和
 *   外发只给允许一次）、共享使用闸门（X3）、账号规则（X1）、check-in 只认可靠读，都在调用那一刻照旧判。
 * - 个人默认会把写工具也给每位员工（和上游一样），而底线不管普通写（新建、修改）。所以在给出第一个工具
 *   之前，先把这个人的「改动之前先问」打开（`askBeforeChangesFirst`）：默认配置下普通写也要本人点头，网页里
 *   的提示注入不能让员工默默改写他的内容。他自己选过的（包括关掉）原样保留，之后也可以在设置里关掉。
 *   和上游不同：上游个人版默认不问普通写。
 * - 「每位员工」是这个人能看见的、内置的普通员工：分身不算（它的连接器来源只写只读工具，移除来源就收回，
 *   见 `avatar-sources.ts`），远端员工不算（本人不控制的外部端点）。
 * - 拒绝过的不再回来：关掉的默认应用记在 `personal_default_apps` 里，下次启动不再打开；一位员工身上关掉的
 *   技能，那位员工记过「已给过一次」，之后的启动和运行都不再给。
 * - 帧：授予写在个人版那个人自己的帧里（`asPerson`），所以落成他的行；读员工也在那一帧里读，行安全看不见
 *   的员工永远不会被授予。服务器级的事（添加应用、刷新工具）由调用方放在平台帧里做。
 */
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  ne,
  notLike,
  sql,
} from "drizzle-orm";
import {
  type AuditStore,
  DEPLOYMENT_INITIATOR,
  recordAuditEvent,
} from "../audit";
import { productName } from "../brand";
import type { Database } from "../db/client";
import { reasonWithoutStatement } from "../db/query-failure";
import { enterpriseSettings } from "../db/schema/admin";
import { approvalPreferences } from "../db/schema/approvals";
import { agents } from "../db/schema/core";
import { agentProfiles } from "../db/schema/coworker";
import { learningSettings } from "../db/schema/learning";
import {
  mcpServers,
  mcpTools,
  pluginGrants,
  skills,
} from "../db/schema/plugins";
import { currentEdition } from "../edition";
import { currentTenant, runAsTenant } from "../tenant/context";
import { STAFFING_DEFAULT_BY } from "../tenant/provisioning";

type ListedTool = { ref: string };

type Store = {
  refreshTools(
    serverId: string,
    actorId?: string,
    ...rest: never[]
  ): Promise<{ tools: number }>;
  grant(
    kind: "mcp" | "skill",
    ref: string,
    agentId: string,
    by: string,
    ...rest: never[]
  ): Promise<void>;
  grantTools(
    app: string,
    refs: string[],
    agentId: string,
    by: string,
  ): Promise<unknown>;
  listForAgent(agentId: string): Promise<unknown>;
  installSkill(input: { slug: string; by: string }): Promise<void>;
};

export type PersonalDefaultsDeps = {
  /** 部署为一个应用（行 id 或目录键）记下的工具，ref 写成授予用的 `<应用键>/<工具名>`。 */
  tools(app: string): Promise<ListedTool[]>;
  /** 这个人能看见的每一位内置的普通员工（没有删除的；不含分身和远端员工）。 */
  bots(): Promise<string[]>;
  /** 一位员工在一个应用（键）上持有的授予 ref。 */
  granted(agentId: string, appKey: string): Promise<Set<string>>;
  /** 部署添加过的每个应用（行 id）。 */
  servers(): Promise<string[]>;
  /** 这一帧里是否已经有这个 slug 的技能。 */
  skillExists(slug: string): Promise<boolean>;
  /** 这个人能用的每个技能的 slug。 */
  skills(): Promise<string[]>;
  /** 一位员工提供的技能 slug。 */
  heldSkills(agentId: string): Promise<Set<string>>;
  /** 这位员工是否已经被给过一次全部技能。 */
  skillsGiven(agentId: string): Promise<boolean>;
  /** 记下已经给过，于是在技能页上为它关掉的技能就一直关着。 */
  rememberSkillsGiven(agentId: string): Promise<void>;
  /**
   * 把被排除在自动学习之外的员工（按员工映射为 null）带回来，让它像别的员工一样跟随默认容器。
   * 答带回来的员工。
   */
  includeEveryBotInLearning(): Promise<string[]>;
  /**
   * 第一次给员工工具之前，把这个人的「改动之前先问」打开；他选过的不动。只在个人版里调。
   */
  askBeforeChangesFirst?: () => Promise<void>;
  /** 清掉已删除员工的「技能已给过」记录。 */
  forgetDepartedBots?: () => Promise<void>;
  /**
   * 在个人版那个人自己的帧里做一件事（fork 的租户模型）：授予写成他的行，读员工、读授予都只读他能看见的。
   * 不给时就在调用方当前的帧里做。
   */
  asPerson?: <T>(work: () => Promise<T>) => Promise<T>;
};

const inPersonsFrame = <T>(
  deps: Pick<PersonalDefaultsDeps, "asPerson">,
  work: () => Promise<T>,
): Promise<T> => (deps.asPerson ? deps.asPerson(work) : work());

/** 没有人按按钮的授予，轨迹上写的是谁。 */
const GRANTED_BY = "openbot:personal-defaults";

/**
 * 每个版本里都在、在个人版里一开始就打开、全部工具给每位员工、关不掉也收不回的那个应用：一个不能给自己
 * 排提醒和定期检查的员工，少了一半用处。
 */
export const ALWAYS_ON_APP = "routines";

/** 常开授予在轨迹上写的是谁。 */
const ALWAYS_ON_BY = "openbot:always-on";

/** 一个应用或它的一个动作（`app/tool`）是不是那个常开的应用。按名字判断，与版本无关。 */
export function isAlwaysOn(ref: string): boolean {
  return ref === ALWAYS_ON_APP || ref.startsWith(`${ALWAYS_ON_APP}/`);
}

/**
 * 在这个版本里，一个应用、它的一个动作，或它在本部署的行 id（`team:routines`）是不是常开的。只有个人版
 * 有常开应用；团队版里 Routines 是管理员授予的能力，可以关、可以收回，答 false。
 */
export function alwaysOnHere(refOrRowId: string): boolean {
  if (currentEdition() !== "personal") return false;
  const ref = refOrRowId.startsWith("team:")
    ? refOrRowId.slice("team:".length)
    : refOrRowId;
  return isAlwaysOn(ref);
}

/**
 * 按员工单独授予、不属于「每位员工」的内置应用：「招聘与组群」。默认只给小管家，别的员工要不要有由招它的
 * 人决定，主人也能逐个员工开关，所以个人版不把它补给每位员工，也不拒绝从一位员工身上收回它。
 */
export const PER_BOT_APP = "staffing";

export function isPerBotApp(ref: string): boolean {
  return ref === PER_BOT_APP || ref.startsWith(`${PER_BOT_APP}/`);
}

/** 有人想关掉它、或从一位员工身上收回它时，服务端的答复。 */
export const ALWAYS_ON_REFUSAL = "例行任务一直开着，每位员工都能用。";

/** 个人版里有人想从一位员工身上收回一个应用时，服务端的答复。 */
export const EVERY_BOT_REFUSAL =
  "个人版里，你连上的每个应用每位员工都能用。要让所有员工都不用它，请把这个应用关掉。";

/** 个人版里有人想不让一位员工去问另一位时，服务端的答复（见 `botsReachableFrom`）。 */
export const EVERY_BOT_ASKS_REFUSAL =
  "个人版里，每位员工都可以请你的其他员工帮忙。";

/**
 * 一位员工在不在个人默认的「每位员工」里：内置的普通员工在；分身（它的连接器来源只写只读工具，移除就收回，
 * 见 `avatar-sources.ts`）、远端员工（本人不控制的外部端点）和召唤来的员工（`summoned_from` 非空，授予由本人
 * 在自己的这份上决定）不在。和 `personalDefaultsDeps` 的 `bots()` 是同一条规则。
 */
export function coveredByPersonalDefaults(
  agentId: string,
  type: string | undefined,
  summoned = false,
): boolean {
  return type === "built_in" && !summoned && !agentId.startsWith(AVATAR_PREFIX);
}

/**
 * 个人版里不能从一位员工身上收回的东西，`DELETE /grants` 和 `DELETE /for/:agentId/apps/:app/give` 先问它
 * （上游 `revokeRefusal` 的前三行）：常开的 Routines、任何一个应用（每位员工都持有每个已连接的应用）、另一位
 * 员工（每位员工都能问其他员工，删掉一行什么也不会改变）。
 *
 * 只对个人默认管着的员工拒绝：分身和远端员工不被补齐，它们的授予来自批准、主人或管理员，必须能从它们身上
 * 单独收回，收回之后也不会被加回来。团队版答 null，照旧由 `enablementDecision` 决定。技能不在其中：个人版里
 * 技能可以为一位员工关掉，而且会一直关着。
 */
export function personalRevokeRefusal(
  kind: string,
  ref: string,
  /** 收回的是哪位员工的授予；不给时按个人默认管着的员工答（只看授予本身时用）。 */
  bot?: { id: string; type: string | undefined; summoned?: boolean },
): string | null {
  if (currentEdition() !== "personal") return null;
  if (bot && !coveredByPersonalDefaults(bot.id, bot.type, bot.summoned))
    return null;
  if (kind === "mcp" && isAlwaysOn(ref)) return ALWAYS_ON_REFUSAL;
  if (kind === "mcp" && isPerBotApp(ref)) return null;
  if (kind === "mcp") return EVERY_BOT_REFUSAL;
  if (kind === "bot") return EVERY_BOT_ASKS_REFUSAL;
  return null;
}

/** {@link personalRevokeRefusal}，员工的类型从 store 读；团队版不读库。 */
export async function personalRevokeRefusalFor(
  store: {
    agentType(agentId: string): Promise<string | undefined>;
    agentSummoned?(agentId: string): Promise<boolean>;
  },
  kind: string,
  ref: string,
  agentId: string,
): Promise<string | null> {
  if (currentEdition() !== "personal") return null;
  return personalRevokeRefusal(kind, ref, {
    id: agentId,
    type: await store.agentType(agentId),
    summoned: (await store.agentSummoned?.(agentId)) ?? false,
  });
}

/** 分身的 id 前缀（`tenant/provisioning.ts` 的 `avatarAgentId`）。 */
const AVATAR_PREFIX = "avatar-";

/** 授予 ref 的应用键部分：`notion/search` → `notion`。 */
const appKeyOf = (ref: string): string => ref.split("/")[0] ?? ref;

/**
 * 把这些应用里员工还没有的工具全部给它们。都已持有时一行都不写，所以每次运行都问一遍只花读、不进轨迹。
 * 轨迹写明原因：Routines 的授予记为常开，别的应用记为 `by`。每位员工每个应用只写一行轨迹，列出给了的
 * 全部动作，由 OpenBot 发起（见 `store.grantTools`）。
 */
async function grantEveryTool(
  store: Pick<Store, "grantTools">,
  deps: PersonalDefaultsDeps,
  apps: string[],
  bots: string[],
  by: string,
): Promise<void> {
  for (const app of apps) {
    const tools = await deps.tools(app);
    const first = tools[0];
    if (!first) continue;
    const key = appKeyOf(first.ref);
    // 只按员工授予的应用：不补给每位员工（见 `PER_BOT_APP`）。
    if (isPerBotApp(key)) continue;
    const grantedBy = isAlwaysOn(key) ? ALWAYS_ON_BY : by;
    for (const bot of bots) {
      const held = await deps.granted(bot, key);
      const missing = tools
        .map((tool) => tool.ref)
        .filter((ref) => !held.has(ref))
        .sort();
      if (missing.length === 0) continue;
      await deps.askBeforeChangesFirst?.();
      await store.grantTools(key, missing, bot, grantedBy);
    }
  }
}

/**
 * 个人版里，给这些员工每个它还没提供的技能，每位员工只给一次。
 *
 * 应用的工具每位员工一直都持有；技能不同，可以在技能页上为一位员工关掉，而且必须一直关着。所以一位员工
 * 第一次经过这里时（已有的员工在启动时，之后建的员工在它第一次被列出或运行时）给它当时有的技能，记下来，
 * 以后再也不给。之后写的技能经下面 `installSkill` 的包装给每位员工。
 */
async function giveEverySkillOnce(
  store: Pick<Store, "grant">,
  deps: PersonalDefaultsDeps,
  bots: string[],
): Promise<void> {
  if (currentEdition() !== "personal") return;
  for (const bot of bots) {
    if (await deps.skillsGiven(bot)) continue;
    const held = await deps.heldSkills(bot);
    for (const slug of await deps.skills())
      if (!held.has(slug)) await store.grant("skill", slug, bot, GRANTED_BY);
    await deps.rememberSkillsGiven(bot);
  }
}

/** 个人版启动时：给已有的每位员工每个技能，各一次。见 {@link giveEverySkillOnce}。 */
export async function ensurePersonalSkills(
  store: Pick<Store, "grant">,
  deps: PersonalDefaultsDeps,
): Promise<void> {
  if (currentEdition() !== "personal") return;
  await inPersonsFrame(deps, async () => {
    await deps.forgetDepartedBots?.();
    await giveEverySkillOnce(store, deps, await deps.bots());
  });
}

/**
 * 个人版启动时：替还没做过选择的人把「改动之前先问」打开，不等有工具要补。默认值因此不依赖这次启动有没有
 * 东西要给；给工具的每条路径另外还会在给之前再确保一次（`withPersonalDefaults` 的 `grant` 包装）。团队版
 * 什么也不写。
 */
export async function ensurePersonalAskBeforeChanges(
  deps: Pick<PersonalDefaultsDeps, "askBeforeChangesFirst">,
): Promise<void> {
  if (currentEdition() !== "personal") return;
  await deps.askBeforeChangesFirst?.();
}

/**
 * 个人版启动时：这个人写的、之前的版本存成「谁的都不是」的技能，归他（上游 #1273）。
 *
 * 个人版的设置 › 技能和管理 › 技能是同一个页面，保存时带 `global`，路由把这样的技能存成了部署的，于是员工
 * 的「你的技能」里一个都没有。路由现在把它给这个人（`routes.ts` 的 POST /skills）；这里补上之前写的。
 *
 * 只认这个人自己装的：`installed_by` 是他的邮箱，`origin` 是 `yours`。OpenBot 自带的技能没有安装人，被他编辑
 * 过的自带技能保留原来的主人，都仍是 OpenBot 的。一个都没有时什么也不写；有时写一行由 OpenBot 发起的轨迹。
 * 在他自己的帧里改，所以只碰得到他的行。
 *
 * @returns 给了他的技能 slug
 */
export async function ensurePersonalSkillsOwned(
  database: Pick<Database, "update">,
  person: { id: string; email: string },
  audit?: AuditStore,
): Promise<string[]> {
  if (currentEdition() !== "personal") return [];
  const owned = await runAsTenant(person.id, () =>
    database
      .update(skills)
      .set({ ownerUserId: person.id })
      .where(
        and(
          eq(skills.tenantId, person.id),
          isNull(skills.ownerUserId),
          eq(skills.origin, "yours"),
          eq(skills.installedBy, person.email),
        ),
      )
      .returning({ slug: skills.slug }),
  );
  const slugs = owned.map((row) => row.slug).sort();
  if (slugs.length > 0 && audit)
    await runAsTenant(person.id, () =>
      recordAuditEvent(audit, {
        eventType: "configuration.changed",
        targetType: "skill",
        initiator: DEPLOYMENT_INITIATOR,
        payload: { change: "skills_owned_personal", skills: slugs },
      }),
    );
  return slugs;
}

/**
 * 个人版里每位员工都参与自动学习（上游 #1222）。个人版没有按员工的开关（有开关的管理页是团队版的），
 * 所以被排除在外的员工——只有同一个库里团队版存下的设置能做到——被带回来。启动时对已有的员工做一次；
 * 每位员工第一次被列出或运行时再查一次（见 `withPersonalDefaults`）。之后建的员工没有映射，本来就跟随默认。
 *
 * 只在有员工被排除时才写，并写一行由 OpenBot 发起、列出这些员工的轨迹。
 */
export async function ensurePersonalLearning(
  deps: Pick<PersonalDefaultsDeps, "includeEveryBotInLearning" | "asPerson">,
  audit?: AuditStore,
): Promise<string[]> {
  if (currentEdition() !== "personal") return [];
  const included = await deps.includeEveryBotInLearning();
  if (included.length > 0 && audit)
    await inPersonsFrame(deps, () =>
      recordAuditEvent(audit, {
        eventType: "configuration.changed",
        targetType: "learning",
        initiator: DEPLOYMENT_INITIATOR,
        payload: { change: "every_bot_included_personal", bots: included },
      }),
    );
  return included;
}

/** 每位员工持有全部工具的应用：个人版里是每个应用，团队版里没有（由管理员授予）。 */
async function everyBotApps(deps: PersonalDefaultsDeps): Promise<string[]> {
  return currentEdition() === "personal" ? await deps.servers() : [];
}

/**
 * 个人版启动时：Routines 还没添加就添加，把工具清单就是 OpenBot 自己代码的应用（Routines、Drive、百度网盘）
 * 刷新到这一版（见 `refreshOwnListings`），然后把每个应用的全部工具给每位员工。会改东西的也给：排程本来就
 * 是它的用处。给之前先把这个人的「改动之前先问」打开（他自己关掉过的除外），所以默认配置下员工每次改东西
 * 之前都先问。
 *
 * 先刷新、后授予，所以这一版新加的工具在同一次启动里就到了每位员工手上，不必等下一次。
 *
 * 服务器级的事（添加、刷新）在调用方的帧里做，`index.ts` 放在平台帧里；授予在这个人的帧里做。团队版什么
 * 也不做，`index.ts` 那里只刷新自带应用的清单。
 */
export async function ensureAlwaysOnApp(
  store: Pick<Store, "grantTools"> & {
    serverAddress(serverId: string): Promise<unknown>;
    addServer(input: { key: string; by: string }): Promise<unknown>;
    refreshOwnListings(): Promise<string[]>;
  },
  deps: PersonalDefaultsDeps,
): Promise<void> {
  if (currentEdition() !== "personal") return;
  if (!(await store.serverAddress(ALWAYS_ON_APP)))
    await store.addServer({ key: ALWAYS_ON_APP, by: ALWAYS_ON_BY });
  await store.refreshOwnListings();
  await inPersonsFrame(deps, async () =>
    grantEveryTool(
      store,
      deps,
      await everyBotApps(deps),
      await deps.bots(),
      GRANTED_BY,
    ),
  );
}

/**
 * 个人版第一次启动时自己打开、只打开一次的应用：Parallel 的免密钥联网搜索，让员工什么都不用设置就能查东西。
 * 和 Routines 不同，这个人可以关掉它，关掉就一直关着。
 */
export const PERSONAL_DEFAULT_APPS: readonly string[] = Object.freeze([
  "parallel",
]);

/** 部署记得的默认应用的事。 */
export type DefaultAppsMemory = {
  /** 这个部署已经打开过一次的默认应用。 */
  added(): Promise<Set<string>>;
  /** 记下打开过了，于是关掉它就是最终的。 */
  remember(app: string): Promise<void>;
};

type DefaultAppsStore = Pick<Store, "refreshTools"> & {
  serverAddress(serverId: string): Promise<unknown>;
  addServer(input: { key: string; by: string }): Promise<unknown>;
};

/**
 * 个人版启动时：每个默认应用第一次时打开它；打开着却没有工具（离线的第一次启动会这样）的，去要它的工具。
 * 上面 `refreshTools` 的包装再把这些工具给每位员工。答仍在等工具的应用。
 *
 * 只在应用的行已经写下之后才记下，所以在写行之前失败的启动下次会再试，写行之后失败的不会第二次添加。没有
 * 行、却记着的应用，是这个人关掉的，不去动它。
 */
export async function ensurePersonalDefaultApps(
  store: DefaultAppsStore,
  deps: PersonalDefaultsDeps,
  memory: DefaultAppsMemory,
): Promise<string[]> {
  if (currentEdition() !== "personal") return [];
  const remembered = await memory.added();
  const waiting: string[] = [];
  for (const app of PERSONAL_DEFAULT_APPS) {
    // 添加时已经向 vendor 要过工具了，刚添加的不再问第二次。
    let asked = false;
    if (!remembered.has(app)) {
      if (!(await store.serverAddress(app))) {
        asked = true;
        try {
          await store.addServer({ key: app, by: GRANTED_BY });
        } catch (error) {
          if (!(await store.serverAddress(app))) throw error;
        }
      }
      await memory.remember(app);
    }
    if (!(await store.serverAddress(app))) continue;
    if ((await deps.tools(app)).length > 0) continue;
    if (asked || (await store.refreshTools(app)).tools === 0) waiting.push(app);
  }
  return waiting;
}

/** 默认应用还没有工具时，每次重试前等多久。最后一档一直重复。 */
export const DEFAULT_APPS_RETRY_MS: readonly number[] = Object.freeze([
  30_000, 60_000, 120_000, 300_000,
]);

/**
 * 不拖住启动地跑 {@link ensurePersonalDefaultApps}，有应用还在等工具时按计时器再跑，于是网络回来后联网搜索
 * 自己就能用，不用谁去按刷新。失败只是一条警告，从来不是不启动的理由。答一个停止重试的函数。
 */
export function startPersonalDefaultApps(
  store: DefaultAppsStore,
  deps: PersonalDefaultsDeps,
  memory: DefaultAppsMemory,
  retryMs: readonly number[] = DEFAULT_APPS_RETRY_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let warned = false;
  const warnOnce = (sentence: string) => {
    if (!warned) console.warn(sentence);
    warned = true;
  };
  const attempt = async (retry: number) => {
    try {
      const waiting = await ensurePersonalDefaultApps(store, deps, memory);
      if (waiting.length === 0) return;
      warnOnce(
        `${waiting.join("、")} 没能列出工具，联网搜索还不能用。${productName()}会继续尝试。`,
      );
    } catch (error) {
      warnOnce(
        `${productName()}没能打开默认应用（${reasonWithoutStatement(error)}）。会继续尝试。`,
      );
    }
    if (stopped) return;
    const delay = retryMs[Math.min(retry, retryMs.length - 1)] ?? 300_000;
    timer = setTimeout(() => void attempt(retry + 1), delay);
    timer.unref?.();
  };
  void attempt(0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * 个人版里，连上一个应用就是全部的决定：每位员工拿到它列出的每个工具，会改东西的也给，轨迹上记为管理员
 * 授予。对话卡片上的「连接」也经过这里，所以个人版里那一按给出的不只是只读动作。只有一个人，没有谁需要被
 * 挡在应用外面；挡在一次普通写操作前面的是「改动之前先问」，个人默认在给出第一个工具之前把它打开（本人选过
 * 的不动），删除、外发、分享、发布另由审批底线每次只给允许一次。从一位员工身上收回应用会被拒绝（{@link EVERY_BOT_REFUSAL}），关掉应用就从所有员工
 * 身上拿走。
 *
 * 装在 `refreshTools` 上，因为得知一个应用的工具的每条路都经过它：添加应用、连接账号、按刷新。store 的方法
 * 之间经 `this` 互相调用，所以替换这个属性，内部的调用也会经过这里。
 *
 * 团队版里三个包装都原样放行，不多读一次库。
 */
export function withPersonalDefaults<S extends Store>(
  store: S,
  deps: PersonalDefaultsDeps,
  /** 运行时把员工带回自动学习也进轨迹；不给时只在启动那一步（`ensurePersonalLearning`）写。 */
  audit?: AuditStore,
): S {
  const refresh = store.refreshTools;
  store.refreshTools = async function (
    this: S,
    serverId: string,
    actorId?: string,
    ...rest: never[]
  ) {
    const result = await refresh.call(this, serverId, actorId, ...rest);
    if (currentEdition() === "personal")
      await inPersonsFrame(deps, async () =>
        grantEveryTool(
          this,
          deps,
          [serverId],
          await deps.bots(),
          actorId || GRANTED_BY,
        ),
      );
    return result;
  } as S["refreshTools"];

  /*
   * 启动之后才建的员工，在它第一次运行时拿到每位员工都有的：个人版里的每个已连接应用、每个技能和自动学习。
   * 一次运行能用什么就是这里答的，所以这是每位员工，新的旧的，都会经过的一刻。只给这个人能看见的员工。
   */
  const list = store.listForAgent;
  store.listForAgent = async function (this: S, agentId: string) {
    /*
     * 这是每次运行都走的读路径：补齐默认时出了错，只记一条警告，运行照常拿到它已经持有的东西，下一次再补。
     */
    if (currentEdition() === "personal")
      await inPersonsFrame(deps, async () => {
        // 召唤来的员工不在 bots() 里：不补工具和技能，但仍和别的员工一样进自动学习。
        if ((await deps.bots()).includes(agentId)) {
          await grantEveryTool(
            this,
            deps,
            await everyBotApps(deps),
            [agentId],
            GRANTED_BY,
          );
          await giveEverySkillOnce(this, deps, [agentId]);
        }
        const included = await deps.includeEveryBotInLearning();
        if (included.length > 0 && audit)
          await recordAuditEvent(audit, {
            eventType: "configuration.changed",
            targetType: "learning",
            initiator: DEPLOYMENT_INITIATOR,
            payload: { change: "every_bot_included_personal", bots: included },
          });
      }).catch((error: unknown) =>
        console.warn(
          JSON.stringify({
            type: "personal-defaults-fill-failed",
            bot: agentId,
            reason: reasonWithoutStatement(error),
            timestamp: new Date().toISOString(),
          }),
        ),
      );
    return list.call(this, agentId);
  } as S["listForAgent"];

  /*
   * 个人版里给任何一位员工应用动作之前（管理员手动授予、主人给、批准、卡片一按），先确保本人的「改动之前
   * 先问」已经写下：没做过选择的人默认是开。写不进去就抛出、这次什么都不给（失败闭合），不让员工在默认不问
   * 的状态下拿到写工具。本人选过的不动。技能不经过这里。
   */
  const grantOne = store.grant;
  store.grant = async function (
    this: S,
    kind: "mcp" | "skill",
    ref: string,
    agentId: string,
    by: string,
    ...rest: never[]
  ) {
    if (currentEdition() === "personal" && kind === "mcp")
      await deps.askBeforeChangesFirst?.();
    return grantOne.call(this, kind, ref, agentId, by, ...rest);
  } as S["grant"];

  /*
   * 个人版里新技能给每位员工，和新应用一样：写它的人就是这里唯一的人，一个没有员工提供的技能，在他找到开关
   * 之前什么也做不了。只在它是新的时候：再保存一次是编辑，不能把他在技能页上为某位员工关掉的又打开。
   */
  const install = store.installSkill;
  store.installSkill = async function (
    this: S,
    input: Parameters<S["installSkill"]>[0],
  ) {
    const fresh =
      currentEdition() === "personal" && !(await deps.skillExists(input.slug));
    await install.call(this, input);
    if (fresh)
      await inPersonsFrame(deps, async () => {
        for (const bot of await deps.bots())
          await this.grant("skill", input.slug, bot, input.by || GRANTED_BY);
      });
  } as S["installSkill"];
  return store;
}

/** 一个应用（行 id 或目录键）对应的行，按目录键或行 id 找；授予 ref 用的是目录键。 */
const serverKey = sql<string>`coalesce(${mcpServers.catalogueKey}, ${mcpServers.id})`;

/**
 * 上面那些读，从数据库来。
 *
 * `person` 是个人版的那个人（`DEV_ACTOR`）：给了时每一次读写都在他的帧里做，见 {@link PersonalDefaultsDeps.asPerson}。
 */
export function personalDefaultsDeps(
  database: Database,
  person?: string,
  /** 替这个人打开「改动之前先问」时写的轨迹。 */
  audit?: AuditStore,
): PersonalDefaultsDeps {
  const asPerson = person
    ? <T>(work: () => Promise<T>): Promise<T> => runAsTenant(person, work)
    : undefined;
  const framed = <T>(work: () => Promise<T>): Promise<T> =>
    asPerson ? asPerson(work) : work();
  /** 一个应用的那一行：按行 id；给的是目录键时取那一个键下的一行，`team` 行优先。 */
  const rowOf = async (app: string): Promise<string | undefined> => {
    const [exact] = await database
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(eq(mcpServers.id, app))
      .limit(1);
    if (exact) return exact.id;
    const [byKey] = await database
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(eq(mcpServers.catalogueKey, app))
      .orderBy(sql`${mcpServers.tenantId} = 'team' desc`, mcpServers.id)
      .limit(1);
    return byKey?.id;
  };
  return {
    ...(asPerson ? { asPerson } : {}),
    /*
     * 只读那一行列出的工具：同一个目录键下另一行（某个人旧时留下的）列出的工具，不是这次刷新得知的。
     */
    tools: (app) =>
      framed(async () => {
        const row = await rowOf(app);
        if (!row) return [];
        const rows = await database
          .select({ key: serverKey, name: mcpTools.name })
          .from(mcpTools)
          .innerJoin(mcpServers, eq(mcpServers.id, mcpTools.serverId))
          .where(eq(mcpServers.id, row));
        return [...new Set(rows.map((row) => `${row.key}/${row.name}`))].map(
          (ref) => ({ ref }),
        );
      }),
    /*
     * 分身不算：它的连接器来源只写只读工具，移除来源就收回（`avatar-sources.ts`），给它全部工具会让来源失去
     * 意义，移除的也会在下一次运行时被加回来。远端员工不算：它们是本人不控制的外部端点，不该拿到本人全部
     * 账号的全部工具。召唤来的员工不算（`summoned_from` 非空）：它带着预设的技能直接可用，别的授予由本人
     * 在自己的这份上决定，默认授予（技能、全部工具、新技能广播）一概不给。
     */
    bots: () =>
      framed(async () => {
        const rows = await database
          .select({ id: agentProfiles.agentId })
          .from(agentProfiles)
          .innerJoin(agents, eq(agents.id, agentProfiles.agentId))
          .where(
            and(
              isNull(agentProfiles.deletedAt),
              isNull(agentProfiles.summonedFrom),
              eq(agents.type, "built_in"),
              notLike(agentProfiles.agentId, `${AVATAR_PREFIX}%`),
            ),
          );
        return rows.map((row) => row.id);
      }),
    granted: (agentId, appKey) =>
      framed(async () => {
        const rows = await database
          .select({ ref: pluginGrants.ref })
          .from(pluginGrants)
          .where(
            and(
              eq(pluginGrants.kind, "mcp"),
              eq(pluginGrants.agentId, agentId),
              sql`split_part(${pluginGrants.ref}, '/', 1) = ${appKey}`,
            ),
          );
        return new Set(rows.map((row) => row.ref));
      }),
    servers: () =>
      framed(async () => {
        const rows = await database
          .select({ id: mcpServers.id })
          .from(mcpServers);
        return rows.map((row) => row.id);
      }),
    skills: () =>
      framed(async () => {
        const rows = await database
          .selectDistinct({ slug: skills.slug })
          .from(skills);
        return rows.map((row) => row.slug);
      }),
    heldSkills: (agentId) =>
      framed(async () => {
        const rows = await database
          .select({ ref: pluginGrants.ref })
          .from(pluginGrants)
          .where(
            and(
              eq(pluginGrants.kind, "skill"),
              eq(pluginGrants.agentId, agentId),
            ),
          );
        return new Set(rows.map((row) => row.ref));
      }),
    /*
     * 每位员工一行设置，而不是一张名单：两位员工同时被列出时各自读名单、加上自己、写回，其中一位会丢，
     * 然后被再给一遍全部技能，连关掉的也给。
     */
    skillsGiven: (agentId) =>
      framed(async () => {
        const [row] = await database
          .select({ key: enterpriseSettings.key })
          .from(enterpriseSettings)
          .where(eq(enterpriseSettings.key, skillsGivenSetting(agentId)))
          .limit(1);
        return row !== undefined;
      }),
    rememberSkillsGiven: (agentId) =>
      framed(async () => {
        await database
          .insert(enterpriseSettings)
          .values({
            key: skillsGivenSetting(agentId),
            value: { value: true },
            updatedBy: GRANTED_BY,
          })
          .onConflictDoNothing();
      }),
    /*
     * 对那一行设置的一条语句，所以不会丢掉同一刻保存的改动，也保留其余每个键。没有员工被排除时一行都
     * 不匹配，什么也不写。
     */
    includeEveryBotInLearning: () =>
      framed(async () => {
        /*
         * 先不加锁地看一眼有没有被排除的员工：这在每次运行时都会走，绝大多数时候一个都没有，不该每次都
         * 锁住部署唯一的那一行设置。
         */
        const [leftOut] = await database
          .select({ id: learningSettings.id })
          .from(learningSettings)
          .where(
            and(
              eq(learningSettings.id, "current"),
              sql`jsonb_typeof(${learningSettings.settings}->'agents') = 'object'`,
              sql`EXISTS (SELECT 1 FROM jsonb_each(${learningSettings.settings}->'agents') AS mapping(bot, target) WHERE target = 'null'::jsonb)`,
            ),
          )
          .limit(1);
        if (!leftOut) return [];
        const rows = await database.execute<{ bots: string[] }>(sql`
          WITH old AS (
            SELECT ${learningSettings.settings} AS settings
            FROM ${learningSettings}
            WHERE ${learningSettings.id} = 'current'
            FOR UPDATE
          )
          UPDATE ${learningSettings}
          SET settings = jsonb_set(
                ${learningSettings.settings},
                '{agents}',
                COALESCE(
                  (SELECT jsonb_object_agg(bot, target)
                   FROM jsonb_each(${learningSettings.settings}->'agents') AS mapping(bot, target)
                   WHERE target <> 'null'::jsonb),
                  '{}'::jsonb
                )
              ),
              updated_at = now()
          FROM old
          WHERE ${learningSettings.id} = 'current'
            AND jsonb_typeof(old.settings->'agents') = 'object'
            AND EXISTS (
              SELECT 1 FROM jsonb_each(old.settings->'agents') AS mapping(bot, target)
              WHERE target = 'null'::jsonb
            )
          RETURNING (
            SELECT COALESCE(array_agg(bot ORDER BY bot), '{}')
            FROM jsonb_each(old.settings->'agents') AS mapping(bot, target)
            WHERE target = 'null'::jsonb
          ) AS bots
        `);
        return [...rows].flatMap((row) => row.bots);
      }),
    /*
     * 写下这个人的「改动之前先问」= 开，只在他还没有任何选择时（`onConflictDoNothing`）。他关掉过的、打开过
     * 的都原样保留。写下了就记一行由 OpenBot 发起的轨迹，和他自己在设置里改时同一个事件。只在真有工具要给时
     * 才走到这里，所以每次多的只是一条什么都不改的插入。
     */
    ...(person
      ? {
          askBeforeChangesFirst: () =>
            framed(async () => {
              const written = await database
                .insert(approvalPreferences)
                .values({ ownerUserId: person, enabled: true })
                .onConflictDoNothing()
                .returning({ owner: approvalPreferences.ownerUserId });
              if (written.length > 0 && audit)
                await recordAuditEvent(audit, {
                  eventType: "approval.settings_changed",
                  targetType: "approval_settings",
                  targetId: person,
                  initiator: DEPLOYMENT_INITIATOR,
                  payload: {
                    change: "ask_before_changes_personal_default",
                    enabled: true,
                  },
                });
            }),
        }
      : {}),
    /*
     * 已删除（软删）的员工不再需要「技能已给过」那一行；只看这个人能看见的员工。包里带来的员工除外：导入会
     * 把退役的包员工复活（`tenant-package.ts`），清掉的话它复活后会被再给一遍全部技能，本人为它关掉的也会回来。
     */
    forgetDepartedBots: () =>
      framed(async () => {
        const departed = await database
          .select({ id: agentProfiles.agentId })
          .from(agentProfiles)
          .innerJoin(agents, eq(agents.id, agentProfiles.agentId))
          .where(
            and(isNotNull(agentProfiles.deletedAt), isNull(agents.packageId)),
          );
        if (departed.length === 0) return;
        await database.delete(enterpriseSettings).where(
          inArray(
            enterpriseSettings.key,
            departed.map((row) => skillsGivenSetting(row.id)),
          ),
        );
      }),
    /** fork 的技能按租户唯一：只问这一帧自己的行，自带技能同名时这个人的新技能仍算新的。 */
    skillExists: (slug) =>
      framed(async () => {
        const [row] = await database
          .select({ slug: skills.slug })
          .from(skills)
          .where(
            and(eq(skills.slug, slug), eq(skills.tenantId, currentTenant())),
          )
          .limit(1);
        return row !== undefined;
      }),
  };
}

/**
 * 已经打开过的默认应用记在哪里：一行 `enterprise_settings`，所以这件事比应用自己的行活得久（关掉应用会删掉
 * 那一行）。个人版从不读那张表的其他键（见 `PERSONAL_ENTERPRISE_SETTINGS`），团队版的设置也不读这一个。
 */
export const DEFAULT_APPS_SETTING = "personal_default_apps";

/** 记着一位员工已经被给过一次全部技能的那一行设置。 */
export function skillsGivenSetting(agentId: string): string {
  return `personal_skills_given:${agentId}`;
}

/**
 * 上面的记忆，从数据库来。那一行是部署的、不属于任何人，调用方在平台帧里用它（`index.ts` 把默认应用的整个
 * 启动与重试放在平台帧里）。
 */
export function personalDefaultAppsMemory(
  database: Database,
): DefaultAppsMemory {
  const added = async () => {
    const [row] = await database
      .select({ value: enterpriseSettings.value })
      .from(enterpriseSettings)
      .where(eq(enterpriseSettings.key, DEFAULT_APPS_SETTING));
    const apps = (row?.value as { value?: unknown } | undefined)?.value;
    return new Set(
      Array.isArray(apps)
        ? apps.filter((app): app is string => typeof app === "string")
        : [],
    );
  };
  return {
    added,
    async remember(app) {
      const value = { value: [...new Set([...(await added()), app])].sort() };
      await database
        .insert(enterpriseSettings)
        .values({ key: DEFAULT_APPS_SETTING, value, updatedBy: GRANTED_BY })
        .onConflictDoUpdate({
          target: enterpriseSettings.key,
          set: { value, updatedBy: GRANTED_BY, updatedAt: new Date() },
        });
    },
  };
}

/**
 * 团队版里还在生效的、由个人默认写下的授予有没有（`granted_by` 以 `openbot:` 开头）。同一个库从个人版换成
 * 团队版时，这些宽授予原样生效，「管理员逐个授予」的前提不再成立；`index.ts` 在团队版启动时据此提醒运维。
 * 调用方在平台帧里问，数的是整个部署。
 */
export async function personalGrantsLeftInTeam(
  database: Database,
): Promise<boolean> {
  if (currentEdition() !== "team") return false;
  const [row] = await database
    .select({ ref: pluginGrants.ref })
    .from(pluginGrants)
    .where(
      and(
        like(pluginGrants.grantedBy, "openbot:%"),
        // 小管家默认的招聘能力两个版本都给，团队版里它是正常的，不是个人版留下的宽授予。
        ne(pluginGrants.grantedBy, STAFFING_DEFAULT_BY),
      ),
    )
    .limit(1);
  return row !== undefined;
}
