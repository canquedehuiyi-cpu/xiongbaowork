import { createHash, randomUUID } from "node:crypto";
import {
  REFINE_SKILL_TOOL,
  SAVE_SKILL_TOOL,
  SELF_SKILL_SLUG_PREFIX,
  SKILL_FIELD_LIMITS,
  SKILL_SCOPES,
  SKILLS_PER_EMPLOYEE_DEFAULT,
  type SkillScope,
} from "../../../shared/self-skills";
import { and, count, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import {
  type LearnedSkillOrigin,
  learnedSkills,
  localSkillCandidates,
  skills,
} from "../db/schema";
import { findOverreach, findSensitive, hasUrl } from "../learning/sensitive";
import { similarity } from "../memory/extract";
import { REFUSAL_MARKER } from "../plugins/tools";
import type { GrantedTool } from "../plugins/tools";
import type { PluginStore } from "../plugins/store";
import { currentTenant } from "../tenant/context";

/**
 * The two tools an employee writes its own skills with (期 2 · Task 2.4): `save_learned_skill` stores the way a
 * piece of work was done as a skill, `refine_skill` corrects it later (or, with no `change`, reads it
 * back). The spec: 2026-11-20-employee-depth-optimization, sub-project 2.
 *
 * WHO IS ALLOWED TO WHAT (生效方式 C). A skill meant for this employee alone (`scope: "self"`) is saved
 * as the person's own skill and granted to this employee at once. A skill meant for other employees or
 * the team (`scope: "shared"`) is only a candidate in the person's review list
 * (`local_skill_candidates`): nothing is granted until the person saves it and approves it there, the
 * same path the daily local learning's drafts take. A wrong skill therefore reaches one employee, never
 * a crowd.
 *
 * A skill adds no capability: it only asks the employee to use tools it already holds, and each of
 * those calls is still granted, policy-checked and audited.
 *
 * REFUSED BEFORE IT IS WRITTEN, not cleaned afterwards: whatever the model wrote goes through the
 * sensitive-content and overreach checks (`learning/sensitive.ts`), and a skill with a key, a token, an
 * e-mail address, a phone number or a step that tells the employee to get around approvals is not saved.
 * Whatever is saved is read into later turns again and again, so a secret in it would leak again and
 * again.
 */

export const SAVE_SKILL_REF = `bot/${SAVE_SKILL_TOOL}`;
export const REFINE_SKILL_REF = `bot/${REFINE_SKILL_TOOL}`;

const L = SKILL_FIELD_LIMITS;

/** What a skill is written from, before it is rendered into the skill's instructions. */
export type SkillDraft = {
  name: string;
  when: string;
  steps: string[];
  pitfalls: string[];
  verify: string;
  scope: SkillScope;
};

/** `XIONGBAO_SKILLS_PER_EMPLOYEE`: how many skills one employee may keep. Default 50; a bad value is the default. */
export function skillsPerEmployee(
  environment: Record<string, string | undefined> = process.env,
): number {
  const value = Number(environment.XIONGBAO_SKILLS_PER_EMPLOYEE);
  return Number.isInteger(value) && value >= 1
    ? value
    : SKILLS_PER_EMPLOYEE_DEFAULT;
}

const line = (max: number) => z.string().trim().min(1).max(max);

/** What the model is offered. Limits are said in the descriptions and enforced here, in the person's language. */
export const saveParameters = z
  .object({
    name: line(L.name).describe(`技能名，不超过 ${L.name} 字`),
    when: line(L.when).describe("什么情况下用这条技能，一两句话"),
    steps: z
      .array(line(L.step))
      .min(1)
      .max(L.steps)
      .describe(
        "步骤，一步一条，用祈使句，写通用的做法，不写具体的人名、账号、文件内容",
      ),
    pitfalls: z
      .array(line(L.pitfall))
      .max(L.pitfalls)
      .default([])
      .describe("踩过的坑和怎么避开，可以没有"),
    verify: line(L.verify).describe("怎么确认这件事做对了"),
    scope: z
      .enum(SKILL_SCOPES)
      .default("self")
      .describe(
        "self：只你自己用，存下就生效。shared：给别的员工或团队用，要本人批准，批准前不生效。",
      ),
  })
  .strict();

const refineParameters = z
  .object({
    id: line(80).describe(
      "技能的 id，取自 save_learned_skill 的结果或你手上的技能清单里的命令名（不带 /）",
    ),
    change: line(L.change)
      .optional()
      .describe("要改什么，一两句话；不带就只读出这条技能的全文"),
  })
  .strict();

/** The slug an employee's skill of this name has: stable, so writing it again updates it rather than adding another. */
export function slugFor(agentId: string, name: string): string {
  const digest = createHash("sha256")
    .update(`${agentId}\n${name.normalize("NFKC").trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 10);
  return `${SELF_SKILL_SLUG_PREFIX}${digest}`;
}

/** The text the Bot is given when the skill is picked. Fixed headings, so a later correction can find its place. */
export function renderSkill(draft: SkillDraft): {
  title: string;
  summary: string;
  instructions: string;
} {
  const pitfalls =
    draft.pitfalls.length > 0
      ? `\n\n注意（踩过的坑）：\n${draft.pitfalls.map((item) => `- ${item}`).join("\n")}`
      : "";
  return {
    title: draft.name,
    summary:
      draft.when.length > 120 ? `${draft.when.slice(0, 120)}…` : draft.when,
    instructions: [
      `适用场景：${draft.when}`,
      `步骤：\n${draft.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`,
    ]
      .join("\n\n")
      .concat(pitfalls, `\n\n怎么确认做对了：${draft.verify}`),
  };
}

const REVISIONS = "\n\n修正记录：\n";

/**
 * One correction as it is written into the record: on one line, with no leading bullet, no longer than
 * the limit. A change that comes in as several lines or as a list is one entry, so a single call can
 * neither add many records nor forge a heading of its own inside the skill's text.
 */
export function cleanChange(change: string): string {
  const flat = change
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:[-*•]\s*)+/, "");
  return flat.slice(0, L.change).trim();
}

/** Adds one correction to the skill's text, keeping the most recent few. */
export function withRevision(
  instructions: string,
  change: string,
  at: Date,
): string {
  const at10 = at.toISOString().slice(0, 10);
  const marked = instructions.indexOf(REVISIONS);
  const body = marked === -1 ? instructions : instructions.slice(0, marked);
  const previous =
    marked === -1
      ? []
      : instructions
          .slice(marked + REVISIONS.length)
          .split("\n")
          .filter((item) => item.startsWith("- "));
  const kept = [...previous, `- ${at10} ${cleanChange(change)}`].slice(
    -L.revisions,
  );
  return `${body}${REVISIONS}${kept.join("\n")}`;
}

/** The text of a draft, every field, as the checks read it. */
const textOfDraft = (draft: SkillDraft) =>
  [
    draft.name,
    draft.when,
    ...draft.steps,
    ...draft.pitfalls,
    draft.verify,
  ].join("\n");

/** Why a draft cannot be saved, in the person's language, or undefined when it can. */
export function draftProblem(
  draft: SkillDraft,
  options: { allowOverreach?: boolean } = {},
): string | undefined {
  const text = textOfDraft(draft);
  const sensitive = findSensitive(text);
  if (sensitive.length > 0)
    return `技能里不能有${sensitive.join("、")}。去掉它们（写成「对方」「这份文件」「你的密钥」这样的说法）再存。`;
  const overreach = options.allowOverreach ? [] : findOverreach(text);
  if (overreach.length > 0)
    return `技能里不能有这样的内容：${overreach.join("、")}。技能只能请你用已经授予你的工具，不能让你绕过审批和规则。`;
  return undefined;
}

/**
 * Why a skill the retrospective wrote for the employee alone still waits for the person, or undefined
 * when it may take effect at once. What the retrospective read is data (a request, tool results, a
 * page): something in it may have been written to get a skill saved, so a skill with an address in it,
 * or a step that gets around a rule, is held for the person instead of being granted.
 */
export function heldForReview(draft: SkillDraft): string | undefined {
  const text = textOfDraft(draft);
  const overreach = findOverreach(text);
  if (overreach.length > 0) return `含越权的步骤（${overreach.join("、")}）`;
  if (hasUrl(text)) return "含网址或域名";
  return undefined;
}

export type SelfSkillDeps = {
  database: Database;
  plugins: Pick<PluginStore, "installSkill" | "grant" | "uninstallSkill">;
  ownerUserId: string;
  agentId: string;
  /** The cap on skills one employee keeps; read from the environment when absent. */
  maxSkills?: () => number;
  now?: () => Date;
};

export type SaveSkillResult =
  | {
      ok: true;
      id: string;
      /** `active`: granted to the employee. `pending_approval`: waiting for the person; nobody has it yet. */
      status: "active" | "pending_approval";
      updated: boolean;
    }
  | { ok: false; reason: string };

/** Every skill this employee keeps or has waiting: the ones counted against the cap. */
async function kept(deps: SelfSkillDeps): Promise<number> {
  const tenant = currentTenant();
  const [own] = await deps.database
    .select({ total: count() })
    .from(learnedSkills)
    .where(
      and(
        eq(learnedSkills.tenantId, tenant),
        eq(learnedSkills.agentId, deps.agentId),
      ),
    );
  const [waiting] = await deps.database
    .select({ total: count() })
    .from(localSkillCandidates)
    .where(
      and(
        eq(localSkillCandidates.tenantId, tenant),
        eq(localSkillCandidates.agentId, deps.agentId),
        eq(localSkillCandidates.status, "pending_review"),
      ),
    );
  return (own?.total ?? 0) + (waiting?.total ?? 0);
}

/**
 * Save a skill an employee wrote: from `save_learned_skill`, or from the retrospective after a long piece of
 * work (`origin: "retrospect"`). Both take the same road: the checks, the cap, then the rule for
 * `scope`. Never throws for a draft it cannot take: it says why.
 */
export async function saveSkill(
  deps: SelfSkillDeps,
  draft: SkillDraft,
  origin: LearnedSkillOrigin,
): Promise<SaveSkillResult> {
  // The retrospective's draft that gets around a rule is held for the person, not refused: it may be
  // what the employee really did, and the person decides. A secret is refused either way.
  const problem = draftProblem(draft, {
    allowOverreach: origin === "retrospect",
  });
  if (problem) return { ok: false, reason: problem };
  const held = origin === "retrospect" ? heldForReview(draft) : undefined;
  const scope: SkillScope = held ? "shared" : draft.scope;
  const tenant = currentTenant();
  const slug = slugFor(deps.agentId, draft.name);
  const rendered = renderSkill(draft);
  const at = (deps.now ?? (() => new Date()))();

  const [existing] = await deps.database
    .select({ agentId: learnedSkills.agentId })
    .from(learnedSkills)
    .where(
      and(
        eq(learnedSkills.tenantId, tenant),
        eq(learnedSkills.skillSlug, slug),
      ),
    )
    .limit(1);
  if (existing && existing.agentId !== deps.agentId)
    return { ok: false, reason: "已经有一条同名的技能，换一个名字。" };
  // The name hashes to a slug of somebody else's skill: a skill this table does not know is not ours to overwrite.
  if (!existing) {
    const [taken] = await deps.database
      .select({ id: skills.id })
      .from(skills)
      .where(and(eq(skills.tenantId, tenant), eq(skills.slug, slug)))
      .limit(1);
    if (taken)
      return { ok: false, reason: "已经有一条同名的技能，换一个名字。" };
  }
  if (
    !existing &&
    (await kept(deps)) >= (deps.maxSkills ?? skillsPerEmployee)()
  )
    return {
      ok: false,
      reason: `你已经有 ${(deps.maxSkills ?? skillsPerEmployee)()} 条自己写的技能，到上限了。先用 ${REFINE_SKILL_TOOL} 改进已有的，别再新增。`,
    };

  if (scope === "shared") {
    // Waiting for the person: the same list the daily local learning's drafts go to. Nothing is granted.
    const [pending] = await deps.database
      .select({ id: localSkillCandidates.id })
      .from(localSkillCandidates)
      .where(
        and(
          eq(localSkillCandidates.tenantId, tenant),
          eq(localSkillCandidates.agentId, deps.agentId),
          eq(localSkillCandidates.slug, slug),
          eq(localSkillCandidates.status, "pending_review"),
        ),
      )
      .limit(1);
    const reason = (
      held
        ? `复盘得出，${held}，等你看过再生效：${rendered.summary}`
        : `员工自己写下来、想共享：${rendered.summary}`
    ).slice(0, 200);
    if (pending)
      await deps.database
        .update(localSkillCandidates)
        .set({
          title: rendered.title,
          summary: rendered.summary,
          instructions: rendered.instructions,
          reason,
        })
        .where(eq(localSkillCandidates.id, pending.id));
    else
      await deps.database.insert(localSkillCandidates).values({
        tenantId: tenant,
        id: randomUUID(),
        runId: "employee-written",
        agentId: deps.agentId,
        slug,
        title: rendered.title,
        summary: rendered.summary,
        instructions: rendered.instructions,
        reason,
        evidence: [],
        createdAt: at,
      });
    return {
      ok: true,
      id: slug,
      status: "pending_approval",
      updated: Boolean(pending),
    };
  }

  await deps.plugins.installSkill({
    slug,
    title: rendered.title,
    summary: rendered.summary,
    instructions: rendered.instructions,
    ownerUserId: deps.ownerUserId,
    by: `employee:${deps.agentId}`,
  });
  try {
    await deps.plugins.grant(
      "skill",
      slug,
      deps.agentId,
      `employee:${deps.agentId}`,
      {
        as: "owner",
      },
    );
  } catch (error) {
    // A skill nobody holds is clutter: take it back out, and say why it could not be given.
    if (!existing)
      await deps.plugins
        .uninstallSkill(slug, `employee:${deps.agentId}`)
        .catch(() => undefined);
    return {
      ok: false,
      reason: `这条技能没能交给你：${error instanceof Error ? error.message : "授予失败"}`,
    };
  }
  await deps.database
    .insert(learnedSkills)
    .values({
      tenantId: tenant,
      agentId: deps.agentId,
      skillSlug: slug,
      origin,
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: [learnedSkills.tenantId, learnedSkills.skillSlug],
      set: { updatedAt: at },
    });
  return { ok: true, id: slug, status: "active", updated: Boolean(existing) };
}

/** A skill of this employee's own: found by its id, and only if the employee wrote it. */
async function ownSkill(deps: SelfSkillDeps, id: string) {
  const tenant = currentTenant();
  const [row] = await deps.database
    .select({
      slug: skills.slug,
      title: skills.title,
      summary: skills.summary,
      instructions: skills.instructions,
    })
    .from(learnedSkills)
    .innerJoin(
      skills,
      and(
        eq(skills.tenantId, learnedSkills.tenantId),
        eq(skills.slug, learnedSkills.skillSlug),
      ),
    )
    .where(
      and(
        eq(learnedSkills.tenantId, tenant),
        eq(learnedSkills.agentId, deps.agentId),
        eq(learnedSkills.skillSlug, id),
      ),
    )
    .limit(1);
  return row;
}

/** The skill was used: read, picked, or corrected. Lowers nothing by itself; it is what keeps it from going stale. */
export async function markSkillsUsed(
  database: Database,
  slugs: readonly string[],
  at: Date,
): Promise<void> {
  if (slugs.length === 0) return;
  const tenant = currentTenant();
  for (const slug of new Set(slugs))
    await database
      .update(learnedSkills)
      .set({
        useCount: sql`${learnedSkills.useCount} + 1`,
        lastUsedAt: at,
      })
      .where(
        and(
          eq(learnedSkills.tenantId, tenant),
          eq(learnedSkills.skillSlug, slug),
        ),
      );
}

export type RefineSkillResult =
  | {
      ok: true;
      id: string;
      title: string;
      instructions: string;
      changed: boolean;
    }
  | { ok: false; reason: string };

/** Correct a skill this employee wrote, or read it back when there is no change. */
export async function refineSkill(
  deps: SelfSkillDeps,
  input: { id: string; change?: string },
): Promise<RefineSkillResult> {
  const row = await ownSkill(deps, input.id);
  if (!row)
    return {
      ok: false,
      reason: `找不到你自己写的技能 ${input.id}。只能读和改你自己用 ${SAVE_SKILL_TOOL} 存下的技能；共享的技能要等本人批准后，由本人管理。`,
    };
  const at = (deps.now ?? (() => new Date()))();
  await markSkillsUsed(deps.database, [row.slug], at);
  if (input.change === undefined)
    return {
      ok: true,
      id: row.slug,
      title: row.title,
      instructions: row.instructions,
      changed: false,
    };
  const change = cleanChange(input.change);
  if (!change)
    return { ok: false, reason: "change 写一两句话，说明哪里要改。" };
  const problem = draftProblem({
    name: row.title,
    when: change,
    steps: [],
    pitfalls: [],
    verify: "",
    scope: "self",
  });
  if (problem) return { ok: false, reason: problem };
  const instructions = withRevision(row.instructions, change, at);
  await deps.plugins.installSkill({
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    instructions,
    ownerUserId: deps.ownerUserId,
    by: `employee:${deps.agentId}`,
  });
  await deps.database
    .update(learnedSkills)
    .set({ updatedAt: at })
    .where(
      and(
        eq(learnedSkills.tenantId, currentTenant()),
        eq(learnedSkills.skillSlug, row.slug),
      ),
    );
  return {
    ok: true,
    id: row.slug,
    title: row.title,
    instructions,
    changed: true,
  };
}

/**
 * Whether a skill about to be written is the same as one this employee already kept under another name:
 * the retrospective asks this before it saves, so a second long turn of the same kind improves the skill
 * it has rather than adding a near copy.
 */
export async function similarSkillOf(
  deps: Pick<SelfSkillDeps, "database" | "agentId">,
  draft: Pick<SkillDraft, "name" | "when">,
  threshold = 0.75,
): Promise<string | undefined> {
  const tenant = currentTenant();
  const rows = await deps.database
    .select({ slug: skills.slug, title: skills.title, summary: skills.summary })
    .from(learnedSkills)
    .innerJoin(
      skills,
      and(
        eq(skills.tenantId, learnedSkills.tenantId),
        eq(skills.slug, learnedSkills.skillSlug),
      ),
    )
    .where(
      and(
        eq(learnedSkills.tenantId, tenant),
        eq(learnedSkills.agentId, deps.agentId),
      ),
    );
  const mine = `${draft.name} ${draft.when}`;
  return rows.find(
    (row) => similarity(`${row.title} ${row.summary}`, mine) >= threshold,
  )?.slug;
}

const answer = (value: unknown) => JSON.stringify(value);
const refused = (reason: string) => `${REFUSAL_MARKER} ${reason}`;

/** `save_learned_skill` and `refine_skill`, for one employee of one person. */
export function selfSkillTools(deps: SelfSkillDeps): GrantedTool[] {
  return [
    {
      name: SAVE_SKILL_TOOL,
      ref: SAVE_SKILL_REF,
      description:
        "把你刚做成的一件事的做法存成一条技能，以后遇到同类任务可以照着做。只在做法可复用时存（步骤多、踩过坑才做成的活）；一次性的事和常识不要存。技能里不能有密钥、令牌、邮箱、手机号等，也不能有绕过审批的步骤。scope 为 self 时只你自己用、存下就生效；shared 要本人批准。",
      parameters: saveParameters,
      async execute(args) {
        const parsed = saveParameters.safeParse(args);
        if (!parsed.success)
          return refused(
            `技能的字段不合要求：${parsed.error.issues[0]?.path.join(".") || "参数"} ${parsed.error.issues[0]?.message ?? ""}`.trim(),
          );
        const result = await saveSkill(deps, parsed.data, "tool");
        if (!result.ok) return refused(result.reason);
        return answer(
          result.status === "active"
            ? {
                saved: true,
                id: result.id,
                updated: result.updated,
                note: `已存成技能「${parsed.data.name}」，已交给你，马上生效。用 ${REFINE_SKILL_TOOL} 带上 id 可以读出或修正它。`,
              }
            : {
                saved: true,
                id: result.id,
                updated: result.updated,
                note: `已提交给本人审批：批准之前这条技能不会生效，也不会给其他员工用。`,
              },
        );
      },
    },
    {
      name: REFINE_SKILL_TOOL,
      ref: REFINE_SKILL_REF,
      description:
        "读出或修正你自己写的一条技能。只带 id：读出全文，遇到同类任务时先读它再照着做。带上 change（一两句话）：把哪里要改记进这条技能的修正记录。只能动你自己用 save_learned_skill 存下的技能。",
      parameters: refineParameters,
      async execute(args) {
        const parsed = refineParameters.safeParse(args);
        if (!parsed.success)
          return refused("需要技能的 id；change 是一两句话。");
        const result = await refineSkill(deps, parsed.data);
        if (!result.ok) return refused(result.reason);
        return answer({
          id: result.id,
          title: result.title,
          changed: result.changed,
          instructions: result.instructions,
        });
      },
    },
  ];
}
