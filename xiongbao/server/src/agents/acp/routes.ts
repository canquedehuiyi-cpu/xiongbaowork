import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import {
  ACP_CODEX_CLOUD_REFUSAL,
  ACP_RULE_DEFAULTS,
  type AcpHarness,
  type AcpRuleKey,
  type AcpRuleValue,
  type AcpRuntime,
  acpRuntimeFrom,
  codexCannotRunInCloud,
} from "../../../../shared/acp";
import { type AuditStore, recordAuditEvent } from "../../audit";
import type { AppVariables } from "../../auth/guards";
import { shortName } from "../../brand";
import type { Database } from "../../db/client";
import { agents } from "../../db/schema";
import type { DeviceRecord, DeviceStore } from "../../devices/store";
import { QuotaExceeded, type QuotaService } from "../../quota/limits";
import { runAsTenant } from "../../tenant/context";
import {
  AgentNotFoundError,
  AgentNotManageableError,
  type AgentProfileStore,
  ExternalAgentRefusedError,
  type ExternalAgentRun,
} from "../profile-store";
import type { AgentActor, AgentProfile } from "../profile-types";
import { externalHirerOf } from "./external";
import { acpRulesOf } from "./permissions";
import type { AcpCancelOutcome } from "./relay";
import type { AcpTurnStore } from "./turns";

type Ctx = { Variables: AppVariables };

/**
 * Hiring an external employee from the person's own computer (spec §1, Task 8), mounted at
 * `/api/agents/external`.
 *
 * `POST /` hires one: Codex, Claude Code, Hermes, or the person's own agent registered on that
 * computer (`custom`). Only on a computer the person paired themselves (403 otherwise), with a working
 * folder (and, for `custom`, an agent) the computer's latest heartbeat offered (400 otherwise), and
 * within the plan's seats (402, counted like any coworker). It is private and the hirer's, always.
 *
 * `PATCH /:agentId` changes its name, department, computer, folder and rules (never which agent it
 * is): only its hirer (403 for anyone else; an id that is no external employee is 404).
 *
 * `POST /:agentId/turns/:turnId/cancel` stops one of its turns (spec §44, §131): a queued one never
 * runs, a running one is cancelled on the computer and ended here at once, its board card closed and
 * its open approvals expired (the relay's `cancelTurn`). Only its hirer: anyone else, and a turn that
 * is not this employee's, is 404; a turn already over is 409.
 *
 * Paths and commands never reach this server: a folder is the computer's `fld_…` reference and an
 * own agent its `app_…` reference, resolved on the computer.
 */

const HARNESSES = ["codex", "claude-code", "hermes", "custom"] as const;
/** Where an employee runs: its hirer's paired computer, or its own XiongBao computer. */
const RUNTIMES = ["cloud", "device"] as const;
/** Said when a harness that is not Claude Code is asked to run in the cloud. */
const CLOUD_CLAUDE_CODE_ONLY = "只有 Claude Code 能在云电脑上干活。";
const RULE_KEYS = Object.keys(ACP_RULE_DEFAULTS) as AcpRuleKey[];
const HARNESS_LABEL: Record<Exclude<AcpHarness, "custom">, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  hermes: "Hermes",
};

/**
 * Said with a Hermes hire: Hermes's own smart approvals can let an action through without asking,
 * so XiongBao cannot promise to see every one (Task 3 ruling M3). The hire page shows it.
 */
export const HERMES_CANNOT_GUARANTEE_ASK = "hermes_cannot_guarantee_ask";

const rulesSchema = z
  .record(z.string(), z.string())
  .superRefine((rules, context) => {
    for (const [key, value] of Object.entries(rules)) {
      if (!RULE_KEYS.includes(key as AcpRuleKey))
        context.addIssue({ code: "custom", message: `不认识的规则：${key}` });
      else if (
        !(
          value === "direct" ||
          value === "ask" ||
          (value === "dangerous" && key === "runCommand")
        )
      )
        context.addIssue({
          code: "custom",
          message: `规则 ${key} 不能设为 ${value}`,
        });
    }
  });

const ref = z.string().trim().min(1).max(200);
const name = z.string().trim().min(1).max(40);
// 32 characters, the column's own limit; "" clears it on an edit.
const department = z
  .string()
  .trim()
  .refine((value) => [...value].length <= 32, "部门名称最多 32 个字。");

const hireSchema = z.strictObject({
  deviceId: ref,
  harness: z.enum(HARNESSES),
  name,
  department: department.optional(),
  workdirRef: ref,
  appRef: ref.optional(),
  rules: rulesSchema,
  acknowledgeNoPermission: z.boolean().optional(),
  /** `device` is what hiring always was; `cloud` is the cloud-hire body below. */
  runtime: z.literal("device").optional(),
});

/*
 * Hired to run on the employee's own XiongBao computer (期八·二, 8.3): no computer of the hirer's and no
 * folder, so none is taken here; the server makes the employee's cloud device and fixed folder itself.
 */
const cloudHireSchema = z.strictObject({
  runtime: z.literal("cloud"),
  harness: z.enum(HARNESSES),
  name,
  department: department.optional(),
  rules: rulesSchema,
});

const editSchema = z.strictObject({
  deviceId: ref.optional(),
  name: name.optional(),
  department: department.optional(),
  workdirRef: ref.optional(),
  appRef: ref.optional(),
  rules: rulesSchema.optional(),
  /** Moves a Claude Code employee between its cloud computer and the hirer's own (8.3). */
  runtime: z.enum(RUNTIMES).optional(),
});

/** The saved rules with these on top: defaults (or what was saved) where a rule is not named. */
function withRules(
  base: Record<AcpRuleKey, AcpRuleValue>,
  rules: Record<string, string> | undefined,
): Record<AcpRuleKey, AcpRuleValue> {
  const merged = { ...base };
  for (const key of RULE_KEYS)
    if (rules?.[key] !== undefined) merged[key] = rules[key] as AcpRuleValue;
  return merged;
}

/** The first problem of a refused body, in a sentence. */
function invalid(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "招聘信息不完整。";
  if (issue.code === "unrecognized_keys")
    return issue.keys.includes("harness")
      ? "外部员工招进来后不能换成别的智能体；要用别的，请重新招一位。"
      : `不认识的字段：${issue.keys.join("、")}`;
  const field = issue.path.join(".");
  return issue.code === "custom" || !field
    ? issue.message
    : `「${field}」不对：${issue.message}`;
}

export function createExternalAgentRoutes(deps: {
  database: Database;
  profiles: AgentProfileStore;
  devices: Pick<DeviceStore, "list">;
  requireUser: MiddlewareHandler<Ctx>;
  /** The plan's coworker seats, when this deployment counts them: a hire takes one. */
  quota?: QuotaService;
  auditStore?: AuditStore;
  /** The employee's turns, read in the hirer's frame; with `cancelTurn`, the cancel route. */
  turns?: Pick<AcpTurnStore, "get">;
  /** The relay's `cancelTurn`. */
  cancelTurn?: (tenantId: string, turnId: string) => Promise<AcpCancelOutcome>;
}) {
  const { database, profiles, devices, requireUser, quota } = deps;
  const routes = new Hono<Ctx>();

  /** The person's paired computer by its device id, read in their own frame. */
  const deviceOf = async (actor: AgentActor, deviceId: string) =>
    (await devices.list(actor.id)).find(
      (device) => device.deviceId === deviceId,
    );

  /**
   * Why this computer cannot take this employee, or null: it must be the person's own pairing, and
   * its folder (and own agent) must be one its latest heartbeat offered.
   */
  const refusal = (
    actor: AgentActor,
    device: DeviceRecord | undefined,
    run: { harness: AcpHarness; workdirRef: string; appRef?: string },
  ): { status: 400 | 403 | 404; error: string } | null => {
    if (!device) return { status: 404, error: "找不到这台电脑。" };
    if (device.pairedByUserId === null)
      return {
        status: 403,
        error:
          "这台电脑还没认主人，在桌面端重新登录一次即可认领，之后才能在上面招外部员工。",
      };
    if (device.pairedByUserId !== actor.id)
      return { status: 403, error: "只能在你自己配对的电脑上招。" };
    if (!device.roots.some((root) => root.ref === run.workdirRef))
      return {
        status: 400,
        error:
          "这个工作文件夹不在这台电脑共享的文件夹里。要用新文件夹，请先在桌面端添加。",
      };
    if (
      run.harness === "custom" &&
      !device.apps.some((app) => app.ref === run.appRef)
    )
      return {
        status: 400,
        error: "这个智能体不在这台电脑登记的本机智能体里，请先在桌面端添加。",
      };
    return null;
  };

  const record = async (
    actor: AgentActor,
    eventType: "bot.created" | "bot.updated",
    agentId: string,
    payload: Record<string, unknown>,
  ) => {
    if (!deps.auditStore) return;
    await recordAuditEvent(deps.auditStore, {
      eventType,
      targetType: "agent",
      targetId: agentId,
      actorUserId: actor.id,
      payload: { bot: agentId, external: true, ...payload },
    }).catch(() => undefined);
  };

  /**
   * 8.3: hire an employee onto its own XiongBao computer. Only Claude Code runs there (Codex is refused
   * with the same sentence the store gives, 409; Hermes and the person's own agent with 400). The
   * employee's cloud device and fixed folder are made by the store from its own id, so the body names
   * neither, and the answer is read back from what was saved rather than from the placeholders.
   */
  const hireInCloud = async (
    context: Context<Ctx>,
    actor: AgentActor,
    raw: unknown,
  ): Promise<Response> => {
    const parsed = cloudHireSchema.safeParse(raw);
    if (!parsed.success)
      return context.json(
        {
          error: parsed.error.issues.some(
            (issue) =>
              issue.code === "unrecognized_keys" &&
              (issue.keys.includes("deviceId") ||
                issue.keys.includes("workdirRef") ||
                issue.keys.includes("appRef")),
          )
            ? "在云电脑上干活的员工没有电脑和工作文件夹可选。"
            : invalid(parsed.error),
        },
        400,
      );
    const body = parsed.data;
    if (codexCannotRunInCloud(body.harness, "cloud"))
      return context.json({ error: ACP_CODEX_CLOUD_REFUSAL }, 409);
    if (body.harness !== "claude-code")
      return context.json({ error: CLOUD_CLAUDE_CODE_ONLY }, 400);
    if (quota) {
      try {
        await quota.assertCapacity(actor.id, "wakers");
      } catch (thrown) {
        if (thrown instanceof QuotaExceeded)
          return context.json(thrown.body, 402);
        throw thrown;
      }
    }
    // The device and folder here are placeholders: `externalConfiguration` replaces both for `cloud`.
    const run: ExternalAgentRun = {
      deviceId: "",
      harness: body.harness,
      workdirRef: "",
      permissions: withRules(ACP_RULE_DEFAULTS, body.rules),
      runtime: "cloud",
    };
    const label = HARNESS_LABEL[body.harness];
    try {
      const agent = await profiles.create(
        actor,
        {
          name: body.name,
          title: `外部员工 · ${label}`,
          roleDescription: `在你的云电脑上干活的 ${label}。`,
          visibility: "private",
          ...(body.department ? { department: body.department } : {}),
          external: run,
        },
        quota
          ? (transaction) =>
              quota.assertCapacityWithin(transaction, actor.id, "wakers")
          : undefined,
      );
      const saved = (await savedRun(database, actor.id, agent.id)) ?? run;
      await record(actor, "bot.created", agent.id, {
        name: body.name,
        visibility: "private",
        harness: body.harness,
        runtime: "cloud",
      });
      return context.json({ agent: externalDto(agent, saved) }, 201);
    } catch (error) {
      return refusedBy(context, error);
    }
  };

  routes.post("/", requireUser, async (context) => {
    const actor = context.var.actor;
    const raw: unknown = await context.req.json().catch(() => null);
    // Hired to run on its own cloud computer: no computer or folder of the hirer's to check (8.3).
    if (
      typeof raw === "object" &&
      raw !== null &&
      (raw as { runtime?: unknown }).runtime === "cloud"
    )
      return hireInCloud(context, actor, raw);
    const parsed = hireSchema.safeParse(raw);
    if (!parsed.success)
      return context.json({ error: invalid(parsed.error) }, 400);
    const body = parsed.data;
    if (body.harness === "custom" && !body.appRef)
      return context.json({ error: "请选择这台电脑上登记的本机智能体。" }, 400);
    /*
     * Review Focus 5: an agent of the person's own may never ask before it acts, and then XiongBao
     * can neither see nor stop what it does. It is hired only once the person has said they know.
     */
    if (body.harness === "custom" && body.acknowledgeNoPermission !== true)
      return context.json(
        {
          error: `这个智能体可能从不请求许可，${shortName()}拦不住它的动作。确认知道这一点后再招。`,
        },
        400,
      );
    const device = await deviceOf(actor, body.deviceId);
    const refused = refusal(actor, device, body);
    if (refused || !device)
      return context.json(
        { error: refused?.error ?? "找不到这台电脑。" },
        refused?.status ?? 404,
      );
    if (quota) {
      try {
        await quota.assertCapacity(actor.id, "wakers");
      } catch (thrown) {
        if (thrown instanceof QuotaExceeded)
          return context.json(thrown.body, 402);
        throw thrown;
      }
    }
    const run: ExternalAgentRun = {
      deviceId: device.deviceId,
      harness: body.harness,
      workdirRef: body.workdirRef,
      ...(body.harness === "custom" && body.appRef
        ? { appRef: body.appRef, noPermissionAcknowledged: true as const }
        : {}),
      permissions: withRules(ACP_RULE_DEFAULTS, body.rules),
    };
    const label =
      body.harness === "custom"
        ? (device.apps.find((app) => app.ref === body.appRef)?.name ??
          "本机智能体")
        : HARNESS_LABEL[body.harness];
    try {
      const agent = await profiles.create(
        actor,
        {
          name: body.name,
          title: `外部员工 · ${label}`,
          roleDescription: `在你的电脑上干活的 ${label}。`,
          visibility: "private",
          ...(body.department ? { department: body.department } : {}),
          external: run,
        },
        quota
          ? (transaction) =>
              quota.assertCapacityWithin(transaction, actor.id, "wakers")
          : undefined,
      );
      await record(actor, "bot.created", agent.id, {
        name: body.name,
        visibility: "private",
        harness: body.harness,
        deviceId: device.deviceId,
      });
      return context.json(
        {
          agent: externalDto(agent, run),
          ...(body.harness === "hermes"
            ? { warnings: [HERMES_CANNOT_GUARANTEE_ASK] }
            : {}),
        },
        201,
      );
    } catch (error) {
      return refusedBy(context, error);
    }
  });

  routes.patch("/:agentId", requireUser, async (context) => {
    const actor = context.var.actor;
    const agentId = context.req.param("agentId");
    const hirer = await externalHirerOf(database, agentId);
    if (!hirer) return context.json({ error: "找不到这位外部员工。" }, 404);
    if (hirer !== actor.id)
      return context.json({ error: "只有招它的人能改它的配置。" }, 403);
    const parsed = editSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success)
      return context.json({ error: invalid(parsed.error) }, 400);
    const body = parsed.data;
    const [profile, current] = await Promise.all([
      profiles.get(actor, agentId),
      savedRun(database, actor.id, agentId),
    ]);
    if (!profile || !current)
      return context.json({ error: "找不到这位外部员工。" }, 404);
    /*
     * Where it runs: its own cloud computer or the hirer's (8.3). Only Claude Code runs in the cloud.
     * Moving to the cloud takes no computer or folder, and moving back takes both: the person's own
     * computer and a folder it shares.
     */
    const was: AcpRuntime = current.runtime === "cloud" ? "cloud" : "device";
    const now: AcpRuntime = body.runtime ?? was;
    if (now === "cloud") {
      if (codexCannotRunInCloud(current.harness, "cloud"))
        return context.json({ error: ACP_CODEX_CLOUD_REFUSAL }, 409);
      if (current.harness !== "claude-code")
        return context.json({ error: CLOUD_CLAUDE_CODE_ONLY }, 400);
      // An employee in the cloud has no computer or folder of the hirer's to change.
      if (body.deviceId || body.workdirRef || body.appRef)
        return context.json(
          { error: "在云电脑上干活的员工没有电脑和工作文件夹可改。" },
          400,
        );
    }
    const movesHome = was === "cloud" && now === "device";
    if (movesHome && !(body.deviceId && body.workdirRef))
      return context.json(
        { error: "切到你自己的电脑，要选一台电脑和它上面的工作文件夹。" },
        400,
      );
    const run: ExternalAgentRun = {
      ...current,
      ...(body.deviceId ? { deviceId: body.deviceId } : {}),
      ...(body.workdirRef ? { workdirRef: body.workdirRef } : {}),
      ...(current.harness === "custom" && body.appRef
        ? { appRef: body.appRef }
        : {}),
      permissions: withRules(current.permissions, body.rules),
      runtime: now,
    };
    // Where it runs is checked again only when it moves: a change of rules needs no heartbeat.
    if (
      now === "device" &&
      (movesHome || body.deviceId || body.workdirRef || body.appRef)
    ) {
      const refused = refusal(actor, await deviceOf(actor, run.deviceId), run);
      if (refused)
        return context.json({ error: refused.error }, refused.status);
    }
    try {
      const agent = await profiles.update(actor, agentId, {
        name: body.name ?? profile.name,
        title: profile.title,
        roleDescription: profile.roleDescription,
        visibility: "private",
        ...(body.department === undefined
          ? {}
          : { department: body.department }),
        external: run,
      });
      await record(actor, "bot.updated", agent.id, {
        name: agent.name,
        visibility: "private",
        deviceId: run.deviceId,
        ...(was === now ? {} : { runtime: now }),
      });
      // What was saved, since a cloud employee's device and folder are made by the store.
      return context.json({
        agent: externalDto(
          agent,
          now === "cloud"
            ? ((await savedRun(database, actor.id, agentId)) ?? run)
            : run,
        ),
      });
    } catch (error) {
      return refusedBy(context, error);
    }
  });

  routes.post(
    "/:agentId/turns/:turnId/cancel",
    requireUser,
    async (context) => {
      const actor = context.var.actor;
      const agentId = context.req.param("agentId");
      const turnId = context.req.param("turnId");
      const missing = () =>
        context.json({ error: "找不到这件活。" }, 404 as const);
      if (!deps.turns || !deps.cancelTurn) return missing();
      // Nobody but its hirer learns the employee or the turn exists.
      if ((await externalHirerOf(database, agentId)) !== actor.id)
        return missing();
      const row = await runAsTenant(actor.id, () =>
        (deps.turns as Pick<AcpTurnStore, "get">).get(actor.id, turnId),
      );
      if (!row || row.agentId !== agentId) return missing();
      const outcome = await deps.cancelTurn(actor.id, turnId);
      if (outcome === "missing") return missing();
      if (outcome === "over")
        return context.json({ error: "这件活已经结束了。" }, 409);
      return context.json({ turnId, status: "cancelled" });
    },
  );

  return routes;
}

/** What an external employee's routes answer with: its profile and how it runs, by reference. */
function externalDto(agent: AgentProfile, run: ExternalAgentRun) {
  return {
    id: agent.id,
    name: agent.name,
    title: agent.title,
    avatarSeed: agent.avatarSeed,
    department: agent.department ?? null,
    visibility: agent.visibility,
    ownerUserId: agent.ownerUserId,
    type: "device_acp" as const,
    external: {
      deviceId: run.deviceId,
      harness: run.harness,
      workdirRef: run.workdirRef,
      ...(run.appRef ? { appRef: run.appRef } : {}),
      rules: run.permissions,
      ...(run.runtime === "cloud" ? { runtime: "cloud" as const } : {}),
      ...(run.noPermissionAcknowledged
        ? { noPermissionAcknowledged: true }
        : {}),
    },
  };
}

/** How the employee runs now, read in its hirer's frame; null when it is not an external employee. */
async function savedRun(
  database: Database,
  tenantId: string,
  agentId: string,
): Promise<ExternalAgentRun | null> {
  const [row] = await runAsTenant(tenantId, () =>
    database
      .select({ type: agents.type, configuration: agents.configuration })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1),
  );
  if (row?.type !== "device_acp") return null;
  const saved = (row.configuration ?? {}) as Record<string, unknown>;
  const harness = saved.harness;
  if (
    typeof saved.deviceId !== "string" ||
    typeof saved.workdirRef !== "string" ||
    !HARNESSES.includes(harness as AcpHarness)
  )
    return null;
  return {
    deviceId: saved.deviceId,
    harness: harness as AcpHarness,
    workdirRef: saved.workdirRef,
    ...(typeof saved.appRef === "string" ? { appRef: saved.appRef } : {}),
    permissions: acpRulesOf(saved),
    // Only a cloud employee says where it runs; the rest are exactly what they were.
    ...(acpRuntimeFrom(saved) === "cloud" ? { runtime: "cloud" as const } : {}),
    ...(saved.noPermissionAcknowledged === true
      ? { noPermissionAcknowledged: true as const }
      : {}),
  };
}

function refusedBy(context: Context<Ctx>, error: unknown): Response {
  if (error instanceof QuotaExceeded) return context.json(error.body, 402);
  if (error instanceof AgentNotFoundError)
    return context.json({ error: "找不到这位外部员工。" }, 404);
  if (error instanceof AgentNotManageableError)
    return context.json({ error: "只有招它的人能改它的配置。" }, 403);
  if (error instanceof ExternalAgentRefusedError)
    return context.json({ error: error.message }, 409);
  throw error;
}
