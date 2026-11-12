import { and, eq, inArray } from "drizzle-orm";
import { cutAtCodeUnits } from "../channels/text";
import type { Database } from "../db/client";
import { pluginGrants, skills as skillTable } from "../db/schema";
import {
  MAX_RESULT_CHARS,
  type McpCallResult,
  type McpTool,
} from "../plugins/mcp";
import {
  isSafeSkillAssetPath,
  listSkillAssets,
  readSkillAsset,
  SKILL_ASSET_TOOL_NAMES,
} from "./assets-store";

/**
 * The `skills` builtin server: reading a skill's attached files, step by step (4c-C2).
 *
 * Shape follows `plugins/builtin-staffing.ts`: a module-resolved builtin transport with a static
 * tool list, a one-time dependency hand-over (`useSkillAssetTools`), and a `callTool` that turns
 * every refusal into an `isError` result rather than a throw. The transport seam
 * (`plugins/transport.ts`) resolves `"builtin-skills"` here, and the catalogue entry (`key: "skills"`)
 * is what an administrator grants like any other connector.
 *
 * TWO GATES, ON PURPOSE (progressive disclosure must not become a side door).
 *
 * The offer gate is the deployment's ordinary one: the tools appear in `mcp_tools` under the
 * `skills` server, and a Bot sees them only once it holds the matching `mcp` grants — exactly how
 * 「招聘与组群」is offered. Being granted the TOOL, though, is not being granted the FILES: the tool
 * takes a skill id, and a Bot that holds the tool for one skill could name another. So `callTool`
 * re-checks, per call, that the Bot holds a `plugin_grants` row of kind `skill` naming the skill it
 * asked about (by row id — for a package skill that is the slug — or by slug, the shape a tenant
 * skill's grant is written in). The check runs here rather than only in the store's `decide`, which
 * answers for the `mcp` ref and cannot answer for the argument.
 *
 * The connection's `botId` is the only identity read. A model that could pass the skill id of its
 * run still passes through this gate; one that could pass a BOT id would be a different bug
 * altogether, the same one every other transport declines by taking identity off the arguments.
 */

/** The two tools this server offers: the names live in `assets-store.ts` (see the note there). */
export { SKILL_ASSET_TOOL_NAMES };

export type SkillAssetToolDeps = {
  database: Database;
};

let installed: SkillAssetToolDeps | null = null;

/**
 * Hand the module its dependencies, once (same seam as `useStaffingTools`): `transportFor` builds
 * the registry at import, before a database exists. `null` lets a test uninstall again.
 */
export function useSkillAssetTools(deps: SkillAssetToolDeps | null): void {
  installed = deps;
}

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "list_skill_assets",
    description: [
      "列出一个技能随附的参考文件：文件名、类型和大小。",
      "技能说明里指了参考文件时先调它；再用 read_skill_asset 按需读取，一次只读当前这一步需要的文件。",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        skillId: {
          type: "string",
          description: "技能的 id（即技能的 slug）。",
        },
      },
      required: ["skillId"],
    },
  },
  {
    name: "read_skill_asset",
    description: [
      "读一个技能随附的某一个文件。path 取自 list_skill_assets 的清单，逐个按步读取，不要一次全读。",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        skillId: {
          type: "string",
          description: "技能的 id（即技能的 slug）。",
        },
        path: {
          type: "string",
          description: "文件在技能里的路径，取自 list_skill_assets。",
        },
      },
      required: ["skillId", "path"],
    },
  },
]);

/** The list is this file; no credential, no store (same answer as `builtin-staffing`). */
export async function listTools(): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

export const listNeedsCredential = false;

export const listIsThisCode = true;

type Connection = {
  url: string;
  token?: string;
  actorId?: string;
  botId?: string;
  threadId?: string;
};

const failure = (message: string): McpCallResult => ({
  text: message,
  isError: true,
  truncated: false,
});

function asResult(text: string): McpCallResult {
  if (text.length <= MAX_RESULT_CHARS)
    return { text, isError: false, truncated: false };
  return {
    text: `${cutAtCodeUnits(text, MAX_RESULT_CHARS)}\n\n[结果太长，已截断：原文 ${text.length} 个字符]`,
    isError: false,
    truncated: true,
  };
}

const SKILL_ID_CHARS = 80;

/** A model-supplied skill id is data, not identity: flattened and bounded before it reaches SQL. */
function cleanSkillId(value: unknown): string {
  if (typeof value !== "string") return "";
  return [...value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").trim()]
    .slice(0, SKILL_ID_CHARS)
    .join("");
}

/**
 * The per-call grant re-check: does THIS Bot hold this skill? Satisfied by a grant naming the skill's
 * row id (what the package sync writes; for a catalogue skill that is the slug) or its slug (what a
 * grant on a tenant skill is written against). Both name the same instruction from two tables' points
 * of view; either holding means the Bot was deliberately given the skill.
 */
async function skillGranted(
  database: Database,
  botId: string,
  skillId: string,
): Promise<boolean> {
  const [skill] = await database
    .select({ id: skillTable.id, slug: skillTable.slug })
    .from(skillTable)
    .where(eq(skillTable.id, skillId))
    .limit(1);
  if (!skill) return false;
  const rows = await database
    .select({ ref: pluginGrants.ref })
    .from(pluginGrants)
    .where(
      and(
        eq(pluginGrants.kind, "skill"),
        eq(pluginGrants.agentId, botId),
        inArray(pluginGrants.ref, [skill.id, skill.slug]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * 调用一个读工具。拒绝与意外都作为 `isError` 结果返回、不抛出（同其他传输层）；技能只取自参数，
 * Bot 只取自连接。技能层授予在这里复查——见本文件顶部的「两层闸门」。
 */
export async function callTool(
  connection: Connection,
  toolName: string,
  args: unknown,
): Promise<McpCallResult> {
  const botId = connection.botId?.trim();
  if (!botId)
    return failure("读附件要知道是哪位员工在读，可这次运行没有说是哪位员工。");
  const deps = installed;
  if (!deps) return failure("这个部署没有接上技能附件。");
  if (!(SKILL_ASSET_TOOL_NAMES as readonly string[]).includes(toolName))
    return failure(`技能附件里没有叫 ${toolName} 的工具。`);
  const given =
    args !== null && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  const skillId = cleanSkillId(given.skillId);
  if (!skillId)
    return failure(
      `${toolName} 需要一个 skillId 参数，指明读哪个技能的附件。技能的 id 见它的说明。`,
    );
  if (!(await skillGranted(deps.database, botId, skillId)))
    return failure(
      `这位员工没有持有技能 ${skillId}，所以读不到它的附件。先给这位员工授予这个技能，再用这两个工具。`,
    );
  try {
    if (toolName === "list_skill_assets") {
      const assets = await listSkillAssets(deps.database, skillId);
      if (assets.length === 0)
        return asResult(`技能 ${skillId} 没有随附任何文件。`);
      return asResult(
        [
          `技能 ${skillId} 随附 ${assets.length} 个文件：`,
          ...assets.map(
            (asset) =>
              `- ${asset.path}（${(asset.bytes / 1024).toFixed(1)}KB，${asset.mediaType}）`,
          ),
          "用 read_skill_asset 按需读取，一次只读当前这一步需要的文件。",
        ].join("\n"),
      );
    }
    const path = cleanSkillId(given.path);
    if (!path)
      return failure("read_skill_asset 需要一个 path 参数，指明读哪个文件。");
    if (!isSafeSkillAssetPath(path))
      return failure(`路径 "${path}" 不是技能内的文件路径，所以没有读取。`);
    const asset = await readSkillAsset(deps.database, skillId, path);
    if (!asset)
      return asResult(
        `技能 ${skillId} 没有名为 ${path} 的文件。用 list_skill_assets 看有哪些文件。`,
      );
    return asResult(asset.content);
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "skill-asset-tool-failed",
        tool: toolName,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return failure("出了点问题，这次没有读成，可以稍后再试。");
  }
}
