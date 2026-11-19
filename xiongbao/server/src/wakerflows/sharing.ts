import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type {
  WakerFlow,
  WakerFlowInput,
  WakerFlowMember,
  WakerFlowPlan,
  WakerFlowStep,
} from "../../../shared/wakerflows";
import type { Database } from "../db/client";
import { flowShareImports, flowShareLinks, wakerFlows } from "../db/schema";
import { runAsTenant } from "../tenant/context";
import { wakerFlowPlanSchema } from "./plan";

/**
 * Sharing a WakerFlow by link, and importing one (story WF9, spec 2026-11-04-wf9-flow-sessions-sharing
 * §3.2-§3.4, option L-A).
 *
 * What travels is a copy of the definition, never a reference (decision D1, an approved exception to
 * J3): the package names role slots instead of coworkers and holds no model, run, output, card,
 * knowledge source or credential. The importer maps each slot to a coworker of their OWN, and the
 * result is a new draft Flow of theirs that a person checks and saves (D8), with no tie back.
 *
 * The link is found by its token, which is shown once when the link is made and stored only as its
 * sha256. Redemption runs entirely in the importer's own frame: for one transaction the token's hash
 * is set as `app.flow_share_token` (`set_config(..., true)` is `SET LOCAL`), which lets row security
 * show and update exactly that one row, and the 0141 guard lets that update do nothing but add one
 * use to a link that is live. The use, the import record and the new draft are one transaction, so a
 * use is spent exactly when an import happened, and a repeat of the import's request id answers with
 * the same draft without spending another (D7).
 *
 * This file imports only types from `store.ts`, which builds it.
 */

export const SHARE_FORMAT = "wakerflow-share-v1";
/** D4: a link must expire; 7 days unless the person says otherwise, never more than 30. */
export const SHARE_DEFAULT_DAYS = 7;
export const SHARE_MAX_DAYS = 30;
/** D5: a link has a use limit; 10 unless the person says otherwise, never more than 100. */
export const SHARE_DEFAULT_USES = 10;
export const SHARE_MAX_USES = 100;
/** The most bytes a package may take, as its canonical JSON. */
export const SHARE_MAX_BYTES = 64 * 1024;

/** A share refusal, carrying the HTTP answer it means. */
export class FlowShareError extends Error {
  readonly status: 400 | 404 | 409 | 410;
  constructor(status: 400 | 404 | 409 | 410, message: string) {
    super(message);
    this.name = "FlowShareError";
    this.status = status;
  }
}

const FLOW_NOT_FOUND = "这个工作区里没有这个 WakerFlow。";
const LINK_NOT_FOUND = "这个分享链接不存在。";
const SHARE_NOT_FOUND = "这个 WakerFlow 没有这个分享链接。";
export const SHARE_EXPIRED_MESSAGE = "这个分享链接已过期。";
export const SHARE_REVOKED_MESSAGE = "这个分享链接已被撤销。";
export const SHARE_EXHAUSTED_MESSAGE = "这个分享链接的导入次数已用完。";
export const SHARE_NESTED_MESSAGE =
  "含嵌套子流程的 WakerFlow 暂不能分享，请先去掉子流程步骤后再保存并分享。";
export const SHARE_DIGEST_MESSAGE = "分享内容校验失败，无法导入。";
const REQUEST_CONFLICT = "这个请求编号已用于另一项操作，请刷新后重新发起。";

/** One role slot of a package: what a coworker did in the source Flow, without the coworker. */
export type FlowShareSlot = { slot: string; role: string; prompt?: string };

type Slotted<T> = T extends { agentId: string }
  ? Omit<T, "agentId"> & { slot: string }
  : T;

/** The package a link holds: the Flow's definition with every coworker replaced by its slot. */
export type FlowSharePackage = {
  format: typeof SHARE_FORMAT;
  name: string;
  description: string;
  slots: FlowShareSlot[];
  inputs: WakerFlowInput[];
  steps: Slotted<WakerFlowStep>[];
};

export type FlowShareStatus = "active" | "expired" | "revoked" | "exhausted";

/** A link as its owner's list shows it. The token is never in it. */
export type FlowShareLink = {
  id: string;
  flowId: string;
  status: FlowShareStatus;
  expiresAt: string;
  maxUses: number;
  uses: number;
  remainingUses: number;
  revokedAt: string | null;
  createdAt: string;
};

/** What an importer sees before importing: the package's own content, and the link's limits. */
export type FlowSharePreview = {
  name: string;
  description: string;
  slots: FlowShareSlot[];
  inputCount: number;
  stepCount: number;
  expiresAt: string;
  remainingUses: number;
};

export type FlowShareImportResult = { flowId: string; name: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);

/** Keys sorted at every depth, so the same package always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((name) => record[name] !== undefined)
      .sort()
      .map((name) => `${JSON.stringify(name)}:${canonical(record[name])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** The digest a package is stored and checked with: sha256 of its canonical JSON. */
export const packageDigest = (value: unknown) => sha256(canonical(value));

/** A token as a person may paste it: 43 characters of base64url (32 random bytes). */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The plan as a package: every member becomes a slot (`s1`, `s2`, ... in the plan's order) and
 * every step names its slot instead of its coworker. A nested Flow step names another Flow of the
 * source workspace, so a plan holding one is not shared at all (D6).
 */
export function flowPackage(plan: WakerFlowPlan): FlowSharePackage {
  if (plan.steps.some((step) => step.kind === "flow"))
    throw new FlowShareError(400, SHARE_NESTED_MESSAGE);
  const slotOf = new Map(
    plan.members.map((member, index) => [member.agentId, `s${index + 1}`]),
  );
  const slots = plan.members.map((member) => ({
    slot: slotOf.get(member.agentId) as string,
    role: member.role,
    ...(member.prompt ? { prompt: member.prompt } : {}),
  }));
  const steps = plan.steps.map((step) => {
    if (!("agentId" in step)) return step;
    const { agentId, ...rest } = step;
    const slot = slotOf.get(agentId);
    if (!slot)
      throw new FlowShareError(400, "计划中的步骤引用了未加入的员工。");
    return { ...rest, slot };
  }) as Slotted<WakerFlowStep>[];
  return {
    format: SHARE_FORMAT,
    name: plan.name,
    description: plan.description,
    slots,
    inputs: plan.inputs,
    steps,
  };
}

/** The package back as a plan of the importer's, each slot filled with the coworker they chose. */
function planFrom(
  pack: FlowSharePackage,
  members: Record<string, string>,
): WakerFlowPlan {
  const agentOf = (slot: string) => {
    const agentId = members[slot];
    if (typeof agentId !== "string" || !agentId)
      throw new FlowShareError(400, "请为每个角色选择一位员工。");
    return agentId;
  };
  const planMembers: WakerFlowMember[] = pack.slots.map((slot) => ({
    agentId: agentOf(slot.slot),
    role: slot.role,
    ...(slot.prompt ? { prompt: slot.prompt } : {}),
  }));
  if (new Set(planMembers.map((m) => m.agentId)).size !== planMembers.length)
    throw new FlowShareError(400, "每个角色需要选择不同的员工。");
  const steps = pack.steps.map((step) => {
    if (!("slot" in step)) return step;
    const { slot, ...rest } = step as { slot: string };
    return { ...rest, agentId: agentOf(slot) };
  });
  const parsed = wakerFlowPlanSchema.safeParse({
    name: pack.name,
    description: pack.description,
    members: planMembers,
    inputs: pack.inputs,
    steps,
  });
  if (!parsed.success)
    throw new FlowShareError(
      400,
      parsed.error.issues[0]?.message ?? "分享的计划格式不正确。",
    );
  return parsed.data;
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * The one place the share token reaches a session (G01-E, counted in `tests/tenant-invariants.test.ts`):
 * as `SET LOCAL`, inside a transaction of the caller's own frame, so it ends with the transaction.
 */
async function withShareToken(tx: Tx, tokenHash: string) {
  await tx.execute(
    sql`select set_config('app.flow_share_token', ${tokenHash}, true)`,
  );
}

const linkColumns = {
  id: flowShareLinks.id,
  flowId: flowShareLinks.flowId,
  tenantId: flowShareLinks.tenantId,
  packageSnapshot: flowShareLinks.packageSnapshot,
  digest: flowShareLinks.digest,
  creationFingerprint: flowShareLinks.creationFingerprint,
  expiresAt: flowShareLinks.expiresAt,
  maxUses: flowShareLinks.maxUses,
  uses: flowShareLinks.uses,
  revokedAt: flowShareLinks.revokedAt,
  createdAt: flowShareLinks.createdAt,
  // Read on the database clock, which is the one the guard and the expiry CHECK use.
  expired: sql<boolean>`${flowShareLinks.expiresAt} <= now()`,
};
type LinkRow = {
  id: string;
  flowId: string;
  expiresAt: Date;
  maxUses: number | null;
  uses: number;
  revokedAt: Date | null;
  createdAt: Date;
  expired: boolean;
};

function statusOf(row: LinkRow): FlowShareStatus {
  if (row.revokedAt) return "revoked";
  if (row.expired) return "expired";
  if (row.uses >= (row.maxUses ?? 0)) return "exhausted";
  return "active";
}

function shapeLink(row: LinkRow): FlowShareLink {
  const maxUses = row.maxUses ?? 0;
  return {
    id: row.id,
    flowId: row.flowId,
    status: statusOf(row),
    expiresAt: row.expiresAt.toISOString(),
    maxUses,
    uses: row.uses,
    remainingUses: Math.max(0, maxUses - row.uses),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Refuse a link that cannot be used, with the sentence for why. */
function assertUsable(row: LinkRow) {
  const status = statusOf(row);
  if (status === "revoked")
    throw new FlowShareError(410, SHARE_REVOKED_MESSAGE);
  if (status === "expired")
    throw new FlowShareError(410, SHARE_EXPIRED_MESSAGE);
  if (status === "exhausted")
    throw new FlowShareError(409, SHARE_EXHAUSTED_MESSAGE);
}

function limit(
  value: unknown,
  fallback: number,
  max: number,
  message: string,
): number {
  if (value === undefined || value === null) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > max
  )
    throw new FlowShareError(400, message);
  return value;
}

export type FlowSharingStore = ReturnType<typeof createFlowSharingStore>;

export function createFlowSharingStore(options: {
  database: Database;
  flows: {
    inspect: (tenantId: string, id: string) => Promise<WakerFlow | null>;
  };
  /** Spec I6: may THIS importer use THIS coworker? Asked for every slot. */
  canUse: (actor: string, agentId: string) => Promise<boolean>;
}) {
  const { database, flows, canUse } = options;

  const ownFlow = async (tenantId: string, flowId: string) => {
    const flow = await flows.inspect(tenantId, flowId);
    if (!flow) throw new FlowShareError(404, FLOW_NOT_FOUND);
    return flow;
  };

  const ownLinks = (tenantId: string, flowId: string) =>
    and(
      eq(flowShareLinks.tenantId, tenantId),
      eq(flowShareLinks.flowId, flowId),
    );

  /** The link a token names, read in the caller's frame with the token set for this transaction. */
  const byToken = async (tx: Tx, token: string) => {
    if (!TOKEN.test(token)) throw new FlowShareError(404, LINK_NOT_FOUND);
    const tokenHash = sha256(token);
    await withShareToken(tx, tokenHash);
    const [row] = await tx
      .select(linkColumns)
      .from(flowShareLinks)
      .where(eq(flowShareLinks.tokenHash, tokenHash))
      .limit(1);
    if (!row) throw new FlowShareError(404, LINK_NOT_FOUND);
    return row;
  };

  /** The stored package, if its digest still matches it. */
  const verified = (row: { packageSnapshot: unknown; digest: string }) => {
    const pack = row.packageSnapshot as FlowSharePackage;
    if (
      packageDigest(pack) !== row.digest ||
      pack?.format !== SHARE_FORMAT ||
      !Array.isArray(pack.slots) ||
      !Array.isArray(pack.steps) ||
      !Array.isArray(pack.inputs)
    )
      throw new FlowShareError(409, SHARE_DIGEST_MESSAGE);
    return pack;
  };

  return {
    /**
     * Make a link for a saved Flow, once per client-chosen id. The token is in this answer only;
     * a repeat of the same id answers with the link and `token: null`.
     */
    async create(
      tenantId: string,
      flowId: string,
      input: { id: string; expiresInDays?: unknown; maxUses?: unknown },
    ): Promise<{ share: FlowShareLink; token: string | null }> {
      if (!isUuid(input.id))
        throw new FlowShareError(400, "缺少有效的请求编号，请刷新后重试。");
      const days = limit(
        input.expiresInDays,
        SHARE_DEFAULT_DAYS,
        SHARE_MAX_DAYS,
        `有效期需在 1 到 ${SHARE_MAX_DAYS} 天之间。`,
      );
      const maxUses = limit(
        input.maxUses,
        SHARE_DEFAULT_USES,
        SHARE_MAX_USES,
        `可导入次数需在 1 到 ${SHARE_MAX_USES} 次之间。`,
      );
      const flow = await ownFlow(tenantId, flowId);
      if (flow.status !== "ready" || !flow.plan)
        throw new FlowShareError(400, "请先保存这个 WakerFlow，再分享。");
      const pack = flowPackage(flow.plan);
      if (Buffer.byteLength(canonical(pack)) > SHARE_MAX_BYTES)
        throw new FlowShareError(400, "这个 WakerFlow 太大，无法分享。");
      const fingerprint = packageDigest({
        flowId,
        revision: flow.revision,
        days,
        maxUses,
      });
      const token = randomBytes(32).toString("base64url");
      const [inserted] = await runAsTenant(tenantId, () =>
        database
          .insert(flowShareLinks)
          .values({
            id: input.id,
            tenantId,
            flowId,
            tokenHash: sha256(token),
            creationFingerprint: fingerprint,
            packageSnapshot: pack as unknown as Record<string, unknown>,
            digest: packageDigest(pack),
            expiresAt: sql`now() + make_interval(days => ${days}::int)`,
            maxUses,
          })
          .onConflictDoNothing({ target: flowShareLinks.id })
          .returning({ id: flowShareLinks.id }),
      );
      const [row] = await runAsTenant(tenantId, () =>
        database
          .select(linkColumns)
          .from(flowShareLinks)
          .where(
            and(
              eq(flowShareLinks.tenantId, tenantId),
              eq(flowShareLinks.id, input.id),
            ),
          )
          .limit(1),
      );
      if (
        !row ||
        row.flowId !== flowId ||
        row.creationFingerprint !== fingerprint
      )
        throw new FlowShareError(409, REQUEST_CONFLICT);
      return { share: shapeLink(row), token: inserted ? token : null };
    },

    /** The Flow's links, newest first, with what is left of each. Never a token. */
    async list(tenantId: string, flowId: string): Promise<FlowShareLink[]> {
      await ownFlow(tenantId, flowId);
      const rows = await runAsTenant(tenantId, () =>
        database
          .select(linkColumns)
          .from(flowShareLinks)
          .where(ownLinks(tenantId, flowId))
          .orderBy(desc(flowShareLinks.createdAt), desc(flowShareLinks.id)),
      );
      return rows.map(shapeLink);
    },

    /** Stop a link from working. A link already revoked stays as it was. */
    async revoke(
      tenantId: string,
      flowId: string,
      shareId: string,
    ): Promise<FlowShareLink> {
      await ownFlow(tenantId, flowId);
      if (!isUuid(shareId)) throw new FlowShareError(404, SHARE_NOT_FOUND);
      const mine = and(
        ownLinks(tenantId, flowId),
        eq(flowShareLinks.id, shareId),
      );
      await runAsTenant(tenantId, () =>
        database
          .update(flowShareLinks)
          .set({ revokedAt: new Date() })
          .where(and(mine, isNull(flowShareLinks.revokedAt))),
      );
      const [row] = await runAsTenant(tenantId, () =>
        database.select(linkColumns).from(flowShareLinks).where(mine).limit(1),
      );
      if (!row) throw new FlowShareError(404, SHARE_NOT_FOUND);
      return shapeLink(row);
    },

    /** What a link holds, for the import dialog. Spends no use. */
    async preview(tenantId: string, token: string): Promise<FlowSharePreview> {
      return runAsTenant(tenantId, () =>
        database.transaction(async (tx) => {
          const row = await byToken(tx, token);
          assertUsable(row);
          const pack = verified(row);
          return {
            name: pack.name,
            description: pack.description,
            slots: pack.slots,
            inputCount: pack.inputs.length,
            stepCount: pack.steps.length,
            expiresAt: row.expiresAt.toISOString(),
            remainingUses: Math.max(0, (row.maxUses ?? 0) - row.uses),
          };
        }),
      );
    },

    /**
     * Import once per request id: spend one use, check the package, fill each slot with one of the
     * importer's own coworkers, and create a draft Flow with that plan. A repeat of the request id
     * answers with the same draft and spends nothing; the same id for another import is a 409.
     */
    async import(
      tenantId: string,
      actor: string,
      token: string,
      input: { requestId: string; members: unknown },
    ): Promise<FlowShareImportResult> {
      if (!isUuid(input.requestId))
        throw new FlowShareError(400, "缺少有效的请求编号，请刷新后重试。");
      const members =
        input.members !== null &&
        typeof input.members === "object" &&
        !Array.isArray(input.members)
          ? (input.members as Record<string, string>)
          : {};
      const fingerprint = packageDigest({ token: sha256(token), members });
      const readImport = async () => {
        const [row] = await runAsTenant(tenantId, () =>
          database
            .select({
              fingerprint: flowShareImports.fingerprint,
              result: flowShareImports.result,
            })
            .from(flowShareImports)
            .where(
              and(
                eq(flowShareImports.tenantId, tenantId),
                eq(flowShareImports.requestId, input.requestId),
              ),
            )
            .limit(1),
        );
        if (!row) return null;
        if (row.fingerprint !== fingerprint || !row.result)
          throw new FlowShareError(409, REQUEST_CONFLICT);
        return row.result as FlowShareImportResult;
      };
      const earlier = await readImport();
      if (earlier) return earlier;

      // Checked before the transaction, so a refusal spends nothing: the link, the package, the
      // coworkers (each the importer's own, I6) and the plan they make.
      const plan = await runAsTenant(tenantId, () =>
        database.transaction(async (tx) => {
          const row = await byToken(tx, token);
          assertUsable(row);
          return planFrom(verified(row), members);
        }),
      );
      for (const member of plan.members) {
        const allowed = await canUse(actor, member.agentId).catch(() => false);
        if (!allowed)
          throw new FlowShareError(
            400,
            `员工「${member.role}」当前不可用，请换一位员工后再导入。`,
          );
      }

      const outcome = await runAsTenant(tenantId, () =>
        database.transaction(async (tx) => {
          const [claimed] = await tx
            .insert(flowShareImports)
            .values({ tenantId, requestId: input.requestId, fingerprint })
            .onConflictDoNothing({
              target: [flowShareImports.tenantId, flowShareImports.requestId],
            })
            .returning({ id: flowShareImports.id });
          // A twin claimed this request id first: its record is the answer.
          if (!claimed) return null;
          const row = await byToken(tx, token);
          assertUsable(row);
          verified(row);
          // One more use, only if nobody spent one since it was read: the guard (0141) allows no other
          // change in this frame, and the condition makes a lost race spend nothing.
          const [spent] = await tx
            .update(flowShareLinks)
            .set({ uses: sql`${flowShareLinks.uses} + 1` })
            .where(
              and(
                eq(flowShareLinks.id, row.id),
                eq(flowShareLinks.uses, row.uses),
                isNull(flowShareLinks.revokedAt),
                sql`${flowShareLinks.expiresAt} > now()`,
                sql`${flowShareLinks.uses} < ${flowShareLinks.maxUses}`,
              ),
            )
            .returning({ id: flowShareLinks.id });
          if (!spent) throw new FlowShareError(409, SHARE_EXHAUSTED_MESSAGE);
          const [flow] = await tx
            .insert(wakerFlows)
            .values({
              tenantId,
              name: plan.name,
              description: plan.description,
              idea: "",
              plan,
              definitionMode: "json-plan-v1",
            })
            .returning({ id: wakerFlows.id, name: wakerFlows.name });
          if (!flow) throw new Error("The imported draft was not written.");
          const result: FlowShareImportResult = {
            flowId: flow.id,
            name: flow.name,
          };
          await tx
            .update(flowShareImports)
            .set({ flowId: flow.id, result })
            .where(eq(flowShareImports.id, claimed.id));
          return result;
        }),
      );
      if (outcome) return outcome;
      const twin = await readImport();
      if (!twin) throw new FlowShareError(409, REQUEST_CONFLICT);
      return twin;
    },
  };
}
