import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import {
  brokeredAccounts,
  composioConnections,
  mcpServers,
} from "../db/schema";
import { isPersonTenant, runAsTenant } from "../tenant/context";
import type { ComposioBroker } from "./broker";
import { type BrokerProvider, toolkitOfFor } from "./access";
import { filedUnderPerson } from "./shared-accounts";

/**
 * 一个人在每个 broker 应用上的每一个账号，按 vendor 自己的列表保持同步（上游
 * `plugin-store/accounts.ts`，#1298，按 fork 改写）。
 *
 * store 的账号方法与调用路径共用这一份，所以「一次调用指向哪个账号」与「页面列出哪些账号」按同一种读法。
 *
 * 与上游的差异：
 * - provider 是活动的那一个（Composio，或 X5 起的 Arcade），vendor 的 user id 永远是本人的用户 id。
 * - 一个人的账号行落在写入时的帧（本人的租户，见迁移 0180），别人的帧看不到。Team Bot 的队友在自己的帧里
 *   读不到主人的账号行，`pick` 因此答 null，调用照旧不指定账号。
 * - 拒绝的句子是中文。
 */

/** 一个人的账号，按他的应用页面与 Bot 的调用读它的样子。 */
export type BrokeredAccountRecord = {
  /** 对浏览器不透明：一次「断开」或「设为默认」点的是哪一行。 */
  id: string;
  /** vendor 说这个账号是什么：邮箱或登录名；它没说时为 null。 */
  identity: string | null;
  /** 人和模型怎么称呼这个账号：identity，或者没有时「账号 2」。 */
  label: string;
  isDefault: boolean;
  connectedAt: string | null;
};

/** 一次调用进的账号，从它选中的那一行读出。 */
export type PinnedAccount = {
  /** 账号表里这一行的 id：页面与卡片用它指名这个账号（不是厂商的 id）。 */
  id: string;
  vendorUserId: string;
  /** vendor 的账号 id；只凭 user id 就能指名时为 null。 */
  accountId: string | null;
  label: string;
  /**
   * 审批绑定的是哪个账号（`ApprovalCandidate.accountBinding`）：vendor 报的地址，没报时是这一行的 id
   * （`row:<id>`）。`label` 没有地址时按位置叫「账号 N」，断开前面的账号后会变；这个不会，所以为一个账号
   * 保存的规则不会落到另一个账号上（X1 评审 M1）。
   */
  binding: string;
  /** 这个人在该应用上有几个账号，也就说明了有没有选择可做。 */
  among: number;
};

/** 一行账号在审批里的稳定绑定；见 {@link PinnedAccount.binding}。 */
export const accountBinding = (row: { id: string; identity: string | null }) =>
  row.identity ?? `row:${row.id}`;

/** 点名的账号不是这个人的：给人看的句子，由调用路径记审计后拒绝。 */
export type AccountRefusal = { refused: string };

type Row = typeof brokeredAccounts.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const iso = (value: Date | null): string | null =>
  value ? value.toISOString() : null;

/** 最早的在前：先按 vendor 说的建立时间，再按这里第一次看到它的时间。 */
const ordered = (rows: Row[]): Row[] =>
  [...rows].sort((left, right) => {
    const a = left.connectedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const b = right.connectedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (a !== b) return a < b ? -1 : 1;
    if (left.vendorUserId.length !== right.vendorUserId.length)
      return left.vendorUserId.length - right.vendorUserId.length;
    return left.createdAt.getTime() - right.createdAt.getTime();
  });

function recordsOf(rows: Row[]): BrokeredAccountRecord[] {
  return ordered(rows).map((row, index) => ({
    id: row.id,
    identity: row.identity,
    label: row.identity ?? `账号 ${index + 1}`,
    isDefault: row.isDefault,
    connectedAt: iso(row.connectedAt),
  }));
}

/**
 * 按名字点账号、名字对不上时补地址的那一次同步，同一个人、同一个应用、同一批行在这段时间里只做一次。
 * 一行一直没有地址时（厂商不报邮箱或登录名），模型每点错一次名字都会再问一次厂商；真实适配器里那是认证
 * 提供商列表加连接列表的分页请求。表里多出一行（刚完成的另一个账号）时不等，那正是要补地址的时候。
 */
const FILL_IN_INTERVAL_MS = 10 * 60 * 1000;
/** 节流记录的上限：超过时先丢掉过期的，仍超过就整个清空（最坏只是多问一次厂商）。 */
const FILL_IN_MEMORY = 1000;

/** 两次同步撞上唯一索引，后一次可以忽略。 */
const isUniqueViolation = (error: unknown): boolean => {
  const code =
    (error as { code?: unknown })?.code ??
    (error as { cause?: { code?: unknown } })?.cause?.code;
  return code === "23505";
};

export function createAccountBook(context: {
  database: Database;
  broker: ComposioBroker | undefined;
  auditStore: AuditStore;
  /** 活动的提供商（X5）；不给时是 Composio，与以前一样。 */
  provider?: BrokerProvider;
  /**
   * 一个人的账号在厂商那边记在哪个名字下（上游 #927）；不给时就是本人的用户 id。缓存的行记这个名字，
   * 所以单用户安装换了名字之后，旧名字下的行在下一次同步时被当作厂商不再列出的账号删掉。
   */
  vendorNameOf?: (userId: string) => string;
}) {
  const { database, broker, auditStore } = context;
  const PROVIDER: BrokerProvider = context.provider ?? "composio";
  /**
   * 一个人的账号在厂商那边记在哪个名字下（上游 #927）。缓存的行记的是这个名字，所以「这一行是不是这个人
   * 自己的账号」也必须拿它来认：拿本地的用户 id 去认，单用户安装的那个人（名字是这台安装自己的）一个账号
   * 都认不出来，按名字挑账号、Team Bot 用主人的默认账号、断开其中一个都会落空。
   */
  const nameOf = context.vendorNameOf ?? ((userId: string) => userId);

  const rowsFor = (toolkit: string, userId: string) =>
    database
      .select()
      .from(brokeredAccounts)
      .where(
        and(
          eq(brokeredAccounts.provider, PROVIDER),
          eq(brokeredAccounts.app, toolkit),
          eq(brokeredAccounts.userId, userId),
        ),
      );

  /** 这个人在这个应用上有没有连接行。 */
  const hasConnection = async (toolkit: string, userId: string) =>
    (
      await database
        .select({ toolkit: composioConnections.toolkit })
        .from(composioConnections)
        .where(
          and(
            eq(composioConnections.toolkit, toolkit),
            eq(composioConnections.userId, userId),
          ),
        )
        .limit(1)
    ).length > 0;

  /** 没有默认账号时，让最早的那个成为默认。 */
  const settleDefault = async (toolkit: string, userId: string) => {
    const rows = ordered(await rowsFor(toolkit, userId));
    if (rows.length === 0 || rows.some((row) => row.isDefault)) return;
    try {
      await database
        .update(brokeredAccounts)
        .set({ isDefault: true })
        .where(eq(brokeredAccounts.id, rows[0]?.id ?? ""));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  };

  /**
   * 一个默认账号在厂商那边没了、而这个人还有别的账号时，把默认交给厂商说还活着的那个，这一行本身留着。
   * 不点名的调用因此落到还在的账号上（与上游「忘掉没了的账号」一样），而不是每一次都被拒；留着的行让卡片
   * 仍能把同一个账号连回来。连回来之后它不自动恢复默认，本人可以在账号页上再设回去。
   *
   * 只交给 `isLive` 答「活着」的账号：失效的行为了重连都留着，剩下的行里也可能有同样失效的；交给最早的
   * 那一行，A、B 两个都失效时默认会在它们之间来回换，永远到不了还活着的 C。本人名下的账号先问（上游回落
   * 到的就是它），其余按列出的顺序。一个都没答「活着」时（都失效，或厂商答不上）默认不动：换到另一个
   * 可能失效的行不比留着更好，调用照样被拒、照样出卡片。
   */
  const passOverDefault = async (
    toolkit: string,
    userId: string,
    rowId: string,
    isLive: (vendorUserId: string) => Promise<boolean>,
  ) => {
    const own = nameOf(userId);
    const rows = ordered(await rowsFor(toolkit, userId)).filter((row) =>
      filedUnderPerson(row.vendorUserId, own),
    );
    const lost = rows.find((row) => row.id === rowId);
    if (!lost?.isDefault) return;
    const candidates = rows
      .filter((row) => row.vendorUserId !== lost.vendorUserId)
      .sort(
        (left, right) =>
          Number(right.vendorUserId === own) -
          Number(left.vendorUserId === own),
      );
    const answers = new Map<string, boolean>();
    let next: Row | undefined;
    for (const candidate of candidates) {
      if (!answers.has(candidate.vendorUserId))
        answers.set(
          candidate.vendorUserId,
          await isLive(candidate.vendorUserId).catch(() => false),
        );
      if (answers.get(candidate.vendorUserId)) {
        next = candidate;
        break;
      }
    }
    if (!next) return;
    await database
      .update(brokeredAccounts)
      .set({ isDefault: false })
      .where(eq(brokeredAccounts.id, rowId));
    try {
      await database
        .update(brokeredAccounts)
        .set({ isDefault: true })
        .where(eq(brokeredAccounts.id, next.id));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  };

  /**
   * 按 vendor 现在列出的，重建一个人在一个应用上的账号，并答出来。
   *
   * vendor 不再列出的账号在这里删掉，列出而这里没有的加上，所以一行从来不是账号存在的唯一证据。默认账号在
   * 它的账号还在时保留。不能逐个列账号的 broker 按表里现有的答。
   *
   * `prune: false` 只加上与补地址、不删行：按名字点账号时为补地址的那一次用它。厂商这一刻没把第二个账号
   * 列为「活着」可能只是暂时过期；那时删掉它的行，离职、移除应用、切换模式的清扫就再也找不到这个账号。
   * 删行只留给账号页上的同步。
   */
  async function sync(input: {
    toolkit: string;
    userId: string;
    prune?: boolean;
  }): Promise<BrokeredAccountRecord[]> {
    const { toolkit, userId, prune = true } = input;
    if (!broker?.accountsOf) return recordsOf(await rowsFor(toolkit, userId));

    const held = await rowsFor(toolkit, userId);
    /*
     * Arcade 按认证提供商列连接：一个只连了日历、从没连过邮件的人打开邮件的账号页，厂商答的是他日历
     * 那条 Google 连接。记下来，就成了一条「邮件、本人名字」的账号行，之后移除或切换邮件的清扫会把
     * 他当成邮件的用户。所以这个应用上没有他的连接行时，不问厂商、不写，也不列出表里留下的旧行：应用读作
     * 未连接，列表就是空的；在一行旧的「本人名字」上按「断开」会撤掉他在同一认证提供商下正在用的连接。
     * 旧行本身留着，清扫路径还要靠它们找到可能仍活着的第二个账号。Composio 按应用列账号，照旧同步。
     */
    if (PROVIDER === "arcade" && !(await hasConnection(toolkit, userId)))
      return [];
    /*
     * 这个人在厂商那边的每一个 id：他自己的名字，加上表里已经记下的「另一个账号」的 id（上游 #1298 的
     * Arcade 一半）。Composio 把一个人的所有账号记在同一个 id 下，这里就只有一个；Arcade 每个 id 一个
     * 账号，所以逐个 id 去问。另一个 id 只在它的同意经回程完成时写进表里，这里从不凭空生出一个。
     */
    const own = nameOf(userId);
    const filedUnder = [
      ...new Set([
        own,
        ...held
          .map((row) => row.vendorUserId)
          .filter((id) => filedUnderPerson(id, own)),
      ]),
    ];
    const listed: {
      vendorUserId: string;
      accountId: string;
      identity: string | null;
      connectedAt: Date | null;
    }[] = [];
    for (const vendorUserId of filedUnder) {
      // 本人自己的名字按本地 id 去问（broker 那一层换名）；另一个 id 已经是厂商那边的 id，原样去问。
      for (const found of await broker.accountsOf({
        userId: vendorUserId === own ? userId : vendorUserId,
        toolkit,
      })) {
        listed.push({
          vendorUserId,
          accountId: found.accountId ?? "",
          identity: found.identity,
          connectedAt: found.connectedAt ? new Date(found.connectedAt) : null,
        });
      }
    }

    const key = (row: { vendorUserId: string; accountId: string }) =>
      `${row.vendorUserId}\u0000${row.accountId}`;
    const keep = new Set(listed.map(key));
    const gone = prune ? held.filter((row) => !keep.has(key(row))) : [];
    if (gone.length > 0) {
      await database.delete(brokeredAccounts).where(
        inArray(
          brokeredAccounts.id,
          gone.map((row) => row.id),
        ),
      );
    }
    for (const found of listed) {
      await database
        .insert(brokeredAccounts)
        .values({
          provider: PROVIDER,
          app: toolkit,
          userId,
          vendorUserId: found.vendorUserId,
          accountId: found.accountId,
          identity: found.identity,
          connectedAt: found.connectedAt,
        })
        .onConflictDoUpdate({
          target: [
            brokeredAccounts.tenantId,
            brokeredAccounts.provider,
            brokeredAccounts.app,
            brokeredAccounts.userId,
            brokeredAccounts.vendorUserId,
            brokeredAccounts.accountId,
          ],
          set: { identity: found.identity, connectedAt: found.connectedAt },
        });
    }
    await settleDefault(toolkit, userId);
    return recordsOf(await rowsFor(toolkit, userId));
  }

  /** 每个人、每个应用上一次为补地址问厂商的时间，和那时表里有哪些行；见 {@link FILL_IN_INTERVAL_MS}。 */
  const filledIn = new Map<string, { at: number; rows: Set<string> }>();
  const fillInDue = (toolkit: string, userId: string, rows: Row[]) => {
    const last = filledIn.get(`${toolkit}\u0000${userId}`);
    return (
      !last ||
      Date.now() - last.at >= FILL_IN_INTERVAL_MS ||
      rows.some((row) => !last.rows.has(row.id))
    );
  };
  const filledInNow = (toolkit: string, userId: string, rows: Row[]) => {
    if (filledIn.size >= FILL_IN_MEMORY) {
      const now = Date.now();
      for (const [key, last] of filledIn)
        if (now - last.at >= FILL_IN_INTERVAL_MS) filledIn.delete(key);
      if (filledIn.size >= FILL_IN_MEMORY) filledIn.clear();
    }
    filledIn.set(`${toolkit}\u0000${userId}`, {
      at: Date.now(),
      rows: new Set(rows.map((row) => row.id)),
    });
  };

  /**
   * 一次调用进的账号：从调用所开账号的主人的账号里挑；他在这里一个账号都没记下时（账号被列出之前建立的
   * 连接）为 null，调用照旧。
   *
   * `named` 是模型传来的，只拿来比较、从不拿来用：只和这个人自己账号的名字比，别人的账号、一个 id、
   * 任何他没有的东西都答 `refused`，并列出他有的。
   */
  async function pick(input: {
    toolkit: string;
    title: string;
    userId: string;
    named: unknown;
  }): Promise<PinnedAccount | AccountRefusal | null> {
    const { toolkit, title, userId, named } = input;
    const mine = async () =>
      ordered(await rowsFor(toolkit, userId)).filter((row) =>
        filedUnderPerson(row.vendorUserId, nameOf(userId)),
      );
    let rows = await mine();
    const pinned = (row: Row, label: string): PinnedAccount => ({
      id: row.id,
      vendorUserId: row.vendorUserId,
      accountId: row.accountId === "" ? null : row.accountId,
      label,
      binding: accountBinding(row),
      among: rows.length,
    });

    if (named === undefined || named === null || named === "") {
      const records = recordsOf(rows);
      const chosen = records.find((record) => record.isDefault) ?? records[0];
      const row =
        chosen && rows.find((candidate) => candidate.id === chosen.id);
      return row && chosen ? pinned(row, chosen.label) : null;
    }

    const wanted =
      typeof named === "string" ? named.trim().toLowerCase() : null;
    const find = () => {
      const records = recordsOf(rows);
      const match = records.find(
        (record) =>
          record.label.toLowerCase() === wanted ||
          (record.identity !== null &&
            record.identity.toLowerCase() === wanted),
      );
      const row = match && rows.find((candidate) => candidate.id === match.id);
      return { records, match, row };
    };
    let found = find();
    /*
     * 还什么都没记下，所以问 vendor 一次：账号被列出之前建立的连接，在应用页面打开之前没有行；一次点名了
     * 账号的调用正是要紧的时刻，在这里列一次，而不是拒绝一个真实的账号。
     *
     * 表里有还没记下名字的行时也一样（第二个账号刚完成、本人那一行是随它补记的，厂商的地址都还没同步）：
     * 否则按原来的邮箱点名会被拒，因为那一行只有 id、没有地址。
     *
     * 这一次只补地址、不删行，而且有节流（见 {@link FILL_IN_INTERVAL_MS}）：它是模型一次点错名字就能
     * 触发的，不能每次都去问厂商，也不能因为厂商这一刻没列出第二个账号就忘掉它。
     */
    if (
      !found.row &&
      wanted !== null &&
      (rows.length === 0 || rows.some((row) => row.identity === null)) &&
      fillInDue(toolkit, userId, rows)
    ) {
      // 只在厂商答上来之后才记「问过了」：一次超时不该让接下来十分钟里点名一个真实的账号都被拒。
      const answered = await sync({ toolkit, userId, prune: false }).then(
        () => true,
        () => false,
      );
      rows = await mine();
      if (answered) filledInNow(toolkit, userId, rows);
      found = find();
    }
    if (found.row && found.match) return pinned(found.row, found.match.label);

    const yours = found.records.map((record) => record.label);
    return {
      refused:
        yours.length > 0
          ? `这不是你的 ${title} 账号，所以什么都没做。请用其中之一：${yours.join("、")}。`
          : `你没有可选的 ${title} 账号，所以什么都没做。不指定账号，就会用你连接的那个。`,
    };
  }

  /**
   * 别人的账号（Team Bot 队友用主人的账号）上一次调用要钉到的账号 id：主人的默认账号，没有默认时是最早
   * 的那个，与主人自己不点名时一样（评审 N1）。只读 `account_id` 与是否默认，不读名字，所以主人的账号名
   * 不会进队友的审批卡与审计（M5）。
   *
   * 在主人的帧里读：主人的账号行只在主人的租户里，队友的帧看不到；读法与审批里「员工主人那一层的规则
   * 在主人的帧里读」一样，只读、只读这一列。主人在这里一个账号都没记下时答 null，调用照旧不指定账号
   * （账号被列出之前的连接）。
   */
  async function ownersDefault(input: {
    toolkit: string;
    userId: string;
  }): Promise<{ accountId: string | null; vendorUserId: string } | null> {
    if (!isPersonTenant(input.userId)) return null;
    const rows = await runAsTenant(input.userId, () =>
      database
        .select({
          id: brokeredAccounts.id,
          vendorUserId: brokeredAccounts.vendorUserId,
          accountId: brokeredAccounts.accountId,
          isDefault: brokeredAccounts.isDefault,
          connectedAt: brokeredAccounts.connectedAt,
          createdAt: brokeredAccounts.createdAt,
        })
        .from(brokeredAccounts)
        .where(
          and(
            eq(brokeredAccounts.provider, PROVIDER),
            eq(brokeredAccounts.app, input.toolkit),
            eq(brokeredAccounts.userId, input.userId),
          ),
        ),
    );
    const mine = ordered(
      rows
        .filter((row) =>
          filedUnderPerson(row.vendorUserId, nameOf(input.userId)),
        )
        .map((row) => ({ ...row }) as unknown as Row),
    );
    const chosen = mine.find((row) => row.isDefault) ?? mine[0];
    if (!chosen) return null;
    return {
      accountId: chosen.accountId === "" ? null : chosen.accountId,
      // 这个账号在厂商那边记在哪个 id 下：Arcade 的另一个账号没有账号 id，只能靠它钉住。
      vendorUserId: chosen.vendorUserId,
    };
  }

  /**
   * 这个人在一个应用上「另一个账号」的 id（不含他自己的名字）。断开整个应用、离职处理、移除应用时用：
   * Arcade 每个 id 一个账号，只撤本人名字下的那个会把其余的留在厂商那边，这里再也够不着。
   */
  async function furtherIds(input: {
    toolkit: string;
    userId: string;
  }): Promise<string[]> {
    const own = nameOf(input.userId);
    return [
      ...new Set(
        (await rowsFor(input.toolkit, input.userId))
          .map((row) => row.vendorUserId)
          .filter((id) => id !== own && filedUnderPerson(id, own)),
      ),
    ];
  }

  return {
    rowsFor,
    sync,
    pick,
    settleDefault,
    passOverDefault,
    ownersDefault,
    furtherIds,

    /**
     * Bot 的工具所在的每个服务器上，这个人持有账号的 broker 个人应用：标题和他的账号。这是
     * `grantedTools` 告诉模型的。Shared 应用没有可选的账号，不在其中。
     */
    async choicesForServers(
      userId: string,
      serverIds: string[],
    ): Promise<
      Map<string, { title: string; choices: BrokeredAccountRecord[] }>
    > {
      const answer = new Map<
        string,
        { title: string; choices: BrokeredAccountRecord[] }
      >();
      if (!userId || serverIds.length === 0) return answer;
      const servers = await database
        .select({
          id: mcpServers.id,
          title: mcpServers.title,
          url: mcpServers.url,
          accountMode: mcpServers.accountMode,
        })
        .from(mcpServers)
        .where(
          and(
            inArray(mcpServers.id, [...new Set(serverIds)]),
            eq(mcpServers.provenance, PROVIDER),
          ),
        );
      const apps = new Map<string, { id: string; title: string }[]>();
      for (const server of servers) {
        if (server.accountMode === "shared") continue;
        const app = toolkitOfFor(PROVIDER, server.url);
        if (!app) continue;
        apps.set(app, [
          ...(apps.get(app) ?? []),
          { id: server.id, title: server.title },
        ]);
      }
      if (apps.size === 0) return answer;
      const rows = await database
        .select()
        .from(brokeredAccounts)
        .where(
          and(
            eq(brokeredAccounts.provider, PROVIDER),
            eq(brokeredAccounts.userId, userId),
            inArray(brokeredAccounts.app, [...apps.keys()]),
          ),
        )
        .orderBy(asc(brokeredAccounts.createdAt));
      const byApp = new Map<string, Row[]>();
      for (const row of rows) {
        byApp.set(row.app, [...(byApp.get(row.app) ?? []), row]);
      }
      for (const [app, held] of byApp) {
        const choices = recordsOf(held);
        for (const server of apps.get(app) ?? [])
          answer.set(server.id, { title: server.title, choices });
      }
      return answer;
    },

    /** 把这个人的一个账号设为不点名时用的那个。不是他的时答 false。 */
    async setDefault(input: {
      toolkit: string;
      userId: string;
      id: string;
    }): Promise<boolean> {
      // 不是这张表能存的 id，所以不是他的；按文本去查会是 500。
      if (!UUID.test(input.id)) return false;
      return await database.transaction(async (transaction) => {
        const mine = and(
          eq(brokeredAccounts.provider, PROVIDER),
          eq(brokeredAccounts.app, input.toolkit),
          eq(brokeredAccounts.userId, input.userId),
        );
        const [row] = await transaction
          .select({ id: brokeredAccounts.id })
          .from(brokeredAccounts)
          .where(and(mine, eq(brokeredAccounts.id, input.id)));
        if (!row) return false;
        await transaction
          .update(brokeredAccounts)
          .set({ isDefault: false })
          .where(and(mine, sql`${brokeredAccounts.isDefault}`));
        await transaction
          .update(brokeredAccounts)
          .set({ isDefault: true })
          .where(eq(brokeredAccounts.id, row.id));
        return true;
      });
    },

    /**
     * 断开这个人在某应用上的一个账号，其余保留。
     *
     * 是他在那里最后一个账号时答 `only`：调用方改为断开整个连接，走这个应用一直以来的那条断开路径，记录、
     * 连接行照旧处理。id 不是他在这个应用上的账号时答 null。
     */
    async disconnectOne(input: {
      toolkit: string;
      userId: string;
      id: string;
      by: string;
    }): Promise<{ only: true } | { remaining: number } | null> {
      if (!UUID.test(input.id)) return null;
      // 这个应用上没有他的连接时，表里留下的旧行不是能单独断开的账号（见 `sync`），答没有这个账号。
      if (
        PROVIDER === "arcade" &&
        !(await hasConnection(input.toolkit, input.userId))
      )
        return null;
      const rows = (await rowsFor(input.toolkit, input.userId)).filter((row) =>
        filedUnderPerson(row.vendorUserId, nameOf(input.userId)),
      );
      const row = rows.find((candidate) => candidate.id === input.id);
      if (!row) return null;
      if (rows.length === 1) return { only: true };
      if (!broker) return null;

      /*
       * 只断这一个，绝不清扫。`revoke` 会结束一个人在该应用上的所有账号；这里结束的是他点了「断开」的
       * 那一个。Composio 按账号 id 指名它。没有 id 的账号在 Composio 不会出现（`accountsOf` 不列）；
       * Arcade 每个 id 只有一个账号、不给账号 id，所以按这一行自己的 id 撤这个应用的授权——那个 id 是
       * 这个人名下的，上面已经筛过，撤的也只是这一个账号。
       */
      if (row.accountId !== "") await broker.revokeAccount(row.accountId);
      else
        await broker.revoke({
          userId:
            row.vendorUserId === nameOf(input.userId)
              ? input.userId
              : row.vendorUserId,
          toolkit: input.toolkit,
        });

      await database
        .delete(brokeredAccounts)
        .where(eq(brokeredAccounts.id, row.id));
      await settleDefault(input.toolkit, input.userId);

      const remaining = rows.length - 1;
      await recordAuditEvent(auditStore, {
        eventType: "mcp.account_disconnected",
        targetType: "mcp_server",
        targetId: input.toolkit,
        payload: {
          actor: input.by,
          server: input.toolkit,
          owner: input.userId,
          reason: "self",
          vendorRevocationRequested: true,
          scope: "one_account",
          remaining,
        },
      });
      return { remaining };
    },

    /** 整个连接结束时，忘掉这个人在该应用上的所有账号行。 */
    async forget(input: { toolkit: string; userId: string }): Promise<void> {
      await database
        .delete(brokeredAccounts)
        .where(
          and(
            eq(brokeredAccounts.provider, PROVIDER),
            eq(brokeredAccounts.app, input.toolkit),
            eq(brokeredAccounts.userId, input.userId),
          ),
        );
    },

    /** 应用被移除时，忘掉每个人在它上面的账号行。 */
    async forgetApp(toolkit: string): Promise<void> {
      await database
        .delete(brokeredAccounts)
        .where(
          and(
            eq(brokeredAccounts.provider, PROVIDER),
            eq(brokeredAccounts.app, toolkit),
          ),
        );
    },
  };
}

export type AccountBook = ReturnType<typeof createAccountBook>;
