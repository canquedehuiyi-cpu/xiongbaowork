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
      "文件超过上限时分段返回：按结果末尾提示的 offset 传入继续读，直到读到结尾。",
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
        offset: {
          type: "integer",
          description: "从全文第几个字符开始读（UTF-16 码元计）。缺省为 0；续读用上次结果提示的值。",
        },
        limit: {
          type: "integer",
          description: "本次最多读多少个字符。缺省 20000，即单次返回上限。",
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

/** 一个分页窗口：本段文本、全文字符数，以及尚未读完时的下一个 offset。 */
export type PaginatedAsset = {
  text: string;
  totalChars: number;
  /** 还有后续内容时的下一个 offset（UTF-16 码元计），读到结尾时为 null。 */
  nextOffset: number | null;
};

/**
 * 按 offset/limit 切出一个附件内容的窗口。纯函数，导出供测试固化分页契约。
 *
 * 分页是「能力保留优先」的选择：附件超长时加载与写入照旧，读取端分页取用，后半段不再
 * 永久丢失。默认 offset=0、limit=MAX_RESULT_CHARS，行为与不分页时逐字符相同（向后兼容）。
 */
export function paginateAssetContent(content: string, offset: number, limit: number): PaginatedAsset {
  const totalChars = content.length;
  if (offset < 0 || offset >= totalChars) {
    return { text: "", totalChars, nextOffset: null };
  }
  const text = content.slice(offset, offset + limit);
  const consumed = offset + text.length;
  return {
    text,
    totalChars,
    nextOffset: consumed < totalChars ? consumed : null,
  };
}

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

/**
 * 附件路径的清洗上限，与加载器 `isSafeSkillAssetPath` 的 200 字符上限保持一致。
 *
 * 读取端曾借用技能 id 的 80 字符上限截断路径：81–200 字符的合法附件路径（加载器放行、清单里
 * 就是这个名字）被悄悄截短，读工具于是去查一个不存在的文件。两端必须用同一个数——这里以
 * 加载器为准。
 */
const SKILL_ASSET_PATH_CHARS = 200;

/** A model-supplied skill id is data, not identity: flattened and bounded before it reaches SQL. */
function cleanSkillId(value: unknown): string {
  if (typeof value !== "string") return "";
  return [...value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").trim()]
    .slice(0, SKILL_ID_CHARS)
    .join("");
}

/**
 * 附件路径清洗：与技能 id 同一规则压平控制字符，但上限取 {@link SKILL_ASSET_PATH_CHARS}。
 * 导出供测试固化两端上限一致（加载器 200 / 读取端 200）。
 */
export function cleanSkillAssetPath(value: unknown): string {
  if (typeof value !== "string") return "";
  return [...value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").trim()]
    .slice(0, SKILL_ASSET_PATH_CHARS)
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
 * 解析 read_skill_asset 的 offset/limit 参数。缺省 offset=0、limit=MAX_RESULT_CHARS，
 * 与分页前的行为逐字符相同。返回值是参数二元组或一条拒绝理由。
 */
function readPaginationArgs(
  args: Record<string, unknown>,
): { offset: number; limit: number } | string {
  let offset = 0;
  if (args.offset !== undefined) {
    const value = args.offset;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      return "offset 必须是不小于 0 的整数（与上次结果里的「继续读」提示衔接）。";
    }
    offset = value;
  }
  let limit = MAX_RESULT_CHARS;
  if (args.limit !== undefined) {
    const value = args.limit;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_RESULT_CHARS) {
      return `limit 必须是 1 到 ${MAX_RESULT_CHARS} 之间的整数。`;
    }
    limit = value;
  }
  return { offset, limit };
}

/** 续读提示（含前后缀）预留的字符数，保证提示本身不会被 asResult 截掉。 */
const CONTINUATION_HINT_RESERVE = 120;

/** 组装 read_skill_asset 的结果：分页窗口 + 续读提示，文本总量不超过 MAX_RESULT_CHARS。 */
function assetReadResult(asset: { content: string }, path: string, offset: number, limit: number): McpCallResult {
  const page = paginateAssetContent(asset.content, offset, limit);
  if (page.text === "" && asset.content.length > 0) {
    return failure(`文件 ${path} 共 ${page.totalChars} 个字符，offset ${offset} 超出范围。`);
  }
  let text = page.text;
  let nextOffset = page.nextOffset;
  if (nextOffset !== null || offset > 0) {
    const budget = MAX_RESULT_CHARS - CONTINUATION_HINT_RESERVE;
    if (text.length > budget) {
      text = text.slice(0, budget);
      nextOffset = offset + budget;
    }
    text =
      nextOffset !== null
        ? `${text}\n\n[文件 ${path} 共 ${page.totalChars} 个字符；本段结束于 offset ${nextOffset}，用 offset=${nextOffset} 继续读]`
        : `[续读 offset ${offset}，全文共 ${page.totalChars} 个字符；本次读到结尾]\n\n${text}`;
  }
  return asResult(text);
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
    const path = cleanSkillAssetPath(given.path);
    if (!path)
      return failure("read_skill_asset 需要一个 path 参数，指明读哪个文件。");
    if (!isSafeSkillAssetPath(path))
      return failure(`路径 "${path}" 不是技能内的文件路径，所以没有读取。`);
    const asset = await readSkillAsset(deps.database, skillId, path);
    if (!asset)
      return asResult(
        `技能 ${skillId} 没有名为 ${path} 的文件。用 list_skill_assets 看有哪些文件。`,
      );
    const pagination = readPaginationArgs(given);
    if (typeof pagination === "string")
      return failure(pagination);
    return assetReadResult(asset, path, pagination.offset, pagination.limit);
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
