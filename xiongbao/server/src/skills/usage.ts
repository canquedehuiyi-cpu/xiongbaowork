import { SKILL_STALE_DAYS } from "@openbot/shared/self-skills";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { learnedSkills } from "../db/schema";
import { currentTenant } from "../tenant/context";

/**
 * 最近 30 天没用过的技能，在挑选时降权（期 2 · Task 2.4）。
 *
 * 「用过」是：这位员工用 `refine_skill` 读过或修正过它，或者人用 `/命令` 点过它（`learning/retrospect.ts`
 * 的轮次观察者记下）。从没用过的技能从它写下来那天算起。降权不是删除：这条技能还在清单里，只是排在新鲜的
 * 后面，摘要后面加一句说明，让挑选的模型只在明显对得上时才选它。
 *
 * 只管员工自己写的技能（`learned_skills` 里有账的）：人写的、部署自带的不在这里。挑选那一步本身（
 * `routing/model.ts`）不动，这里改的是交给它的清单。
 */

/** 摘要后面加的那句话。 */
export const STALE_SKILL_NOTE = `（${SKILL_STALE_DAYS} 天没用过，只在明显对得上时才选）`;

/** 一条员工自己写的技能最近的使用情况。 */
export type SkillUsage = { lastUsedAt: Date | null; createdAt: Date };

/** 这条技能到 `now` 为止有没有过时：最近用过的时间（没用过就是写下的时间）早于 30 天前。 */
export function isStale(
  usage: SkillUsage,
  now: Date,
  days = SKILL_STALE_DAYS,
): boolean {
  const last = usage.lastUsedAt ?? usage.createdAt;
  return now.getTime() - last.getTime() > days * 86_400_000;
}

/**
 * 把过时的技能排到后面、摘要后加一句说明。其余原样、原来的顺序；没有账的技能（人写的、自带的）不动。
 * 不改传进来的数组。
 */
export function demoteStaleSkills<T extends { slug: string; summary?: string }>(
  held: readonly T[],
  usage: ReadonlyMap<string, SkillUsage>,
  now: Date,
): T[] {
  const fresh: T[] = [];
  const stale: T[] = [];
  for (const skill of held) {
    const used = usage.get(skill.slug);
    if (used && isStale(used, now))
      stale.push({
        ...skill,
        summary: `${skill.summary ?? ""}${STALE_SKILL_NOTE}`,
      });
    else fresh.push(skill);
  }
  return [...fresh, ...stale];
}

/**
 * 这个人名下员工自己写的技能的使用情况，按技能命令名。在本人帧里调用。按人而不是按员工取：清单里
 * 只有这位员工持有的技能，多取几条没有账可对的行无害。
 */
export async function learnedUsageOf(
  database: Database,
): Promise<Map<string, SkillUsage>> {
  const rows = await database
    .select({
      slug: learnedSkills.skillSlug,
      lastUsedAt: learnedSkills.lastUsedAt,
      createdAt: learnedSkills.createdAt,
    })
    .from(learnedSkills)
    .where(eq(learnedSkills.tenantId, currentTenant()));
  return new Map(
    rows.map((row) => [
      row.slug,
      { lastUsedAt: row.lastUsedAt, createdAt: row.createdAt },
    ]),
  );
}
