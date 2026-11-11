import type { Persona } from "../agents/profile-types";
import { PORTRAIT_PRESETS } from "../portraits/store";
import { nextOccurrence } from "../routines/schedule";
import type {
  EmployeeChangeDraft,
  EmployeeDraft,
  GroupChangeDraft,
  GroupDraft,
  PortraitPreset,
  ProposalDraft,
  ProposalKind,
  RoutineDraft,
} from "./types";

/**
 * 草稿只在这里做形状与限长校验，不查库：员工、应用、群聊存不存在，要等执行时才能知道。
 * 限长沿用 `CreateAgentInput` 那条路径，免得草稿通过了、真正创建时才被拒。
 */

export type DroppedItem = { field: string; value: string; reason: string };

export type ParsedDraft =
  | { ok: true; draft: ProposalDraft; dropped: DroppedItem[] }
  | { ok: false; error: string };

const NAME_MAX = 80;
const TITLE_MAX = 120;
const ROLE_MAX = 1000;
const INSTRUCTIONS_MAX = 1000;
const BIBLE_MAX = 8000;
const PERSONA_PART_MAX = 2000;
const ROUTINE_INSTRUCTION_MAX = 2000;
const ROUTINE_TITLE_MAX = 100;
const ROUTINES_MAX = 20;
const LIST_MAX = 50;
const GROUP_MIN = 2;
const GROUP_MAX = 20;
const DEFAULT_TIMEZONE = "UTC";

class Refusal extends Error {}

const refuse = (message: string): never => {
  throw new Refusal(message);
};

const length = (value: string) => [...value].length;

/**
 * 去掉控制字符。多行文字保留换行与制表符；名字之类的单行文字连这两个也去掉，
 * 否则一个换行就能把名字顶成两行。
 */
function clean(value: string, multiline: boolean): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const keep = multiline && (code === 0x0a || code === 0x09);
    if (!keep && (code < 0x20 || (code >= 0x7f && code <= 0x9f))) continue;
    out += char;
  }
  return out.trim();
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return refuse(`${label}的格式不对。`);
  }
  return value as Record<string, unknown>;
}

function text(
  value: unknown,
  label: string,
  max: number,
  options: { multiline?: boolean; required?: boolean } = {},
): string {
  if (typeof value !== "string") return refuse(`${label}必须是文字。`);
  const cleaned = clean(value, options.multiline ?? false);
  if (options.required && cleaned === "") return refuse(`${label}不能为空。`);
  if (length(cleaned) > max) return refuse(`${label}不能超过 ${max} 字。`);
  return cleaned;
}

function id(value: unknown, label: string): string {
  return text(value, label, 200, { required: true });
}

function idList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return refuse(`${label}必须是列表。`);
  if (value.length > LIST_MAX) return refuse(`${label}最多 ${LIST_MAX} 项。`);
  return value.map((item) => id(item, label));
}

function distinct(items: string[], label: string): string[] {
  if (new Set(items).size !== items.length) {
    return refuse(`${label}里有重复。`);
  }
  return items;
}

function persona(value: unknown): Persona {
  const given = record(value, "人设");
  const part = (key: keyof Persona) => {
    const entry = given[key];
    if (entry === undefined || entry === null) return "";
    return text(entry, `人设的 ${key}`, PERSONA_PART_MAX, { multiline: true });
  };
  return {
    tone: part("tone"),
    principles: part("principles"),
    habits: part("habits"),
  };
}

function avatar(value: unknown): NonNullable<EmployeeDraft["avatar"]> {
  const given = record(value, "头像");
  if (given.preset !== undefined) {
    const preset = given.preset as PortraitPreset;
    if (!PORTRAIT_PRESETS.includes(preset)) {
      return refuse(`头像只能是 ${PORTRAIT_PRESETS.join("、")} 之一。`);
    }
    return { preset };
  }
  return { seed: text(given.seed, "头像种子", NAME_MAX, { required: true }) };
}

function model(value: unknown): NonNullable<EmployeeDraft["model"]> {
  const given = record(value, "模型");
  const hasOwn = typeof given.modelRef === "string";
  const hasPlatform = typeof given.platformModelRef === "string";
  if (hasOwn === hasPlatform) {
    return refuse("模型只能指定 modelRef 或 platformModelRef 其中一个。");
  }
  return hasOwn
    ? { modelRef: id(given.modelRef, "模型") }
    : { platformModelRef: id(given.platformModelRef, "模型") };
}

function appEntries(value: unknown, label: string) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return refuse(`${label}必须是列表。`);
  if (value.length > LIST_MAX) return refuse(`${label}最多 ${LIST_MAX} 项。`);
  return value.map((entry) => {
    const given = record(entry, label);
    return {
      app: id(given.app, `${label}的应用`),
      actions: idList(given.actions, `${label}的动作`),
    };
  });
}

/** 一条定时任务不合格只丢这一条并说明原因，不拖垮整份草稿。 */
function routines(
  value: unknown,
  dropped: DroppedItem[],
  field: string,
): RoutineDraft[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return refuse("定时任务必须是列表。");
  const kept: RoutineDraft[] = [];
  for (const entry of value) {
    const given =
      entry !== null && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : {};
    const shown = typeof given.cron === "string" ? given.cron : "";
    try {
      if (kept.length >= ROUTINES_MAX) {
        refuse(`定时任务最多 ${ROUTINES_MAX} 条。`);
      }
      const routine: RoutineDraft = {
        instruction: text(
          given.instruction,
          "定时任务的指令",
          ROUTINE_INSTRUCTION_MAX,
          { multiline: true, required: true },
        ),
        cron: text(given.cron, "定时任务的时间", 100, { required: true }),
      };
      if (given.title !== undefined) {
        routine.title = text(given.title, "定时任务的标题", ROUTINE_TITLE_MAX);
      }
      if (given.timezone !== undefined) {
        routine.timezone = text(given.timezone, "定时任务的时区", 64, {
          required: true,
        });
      }
      nextOccurrence(
        routine.cron,
        routine.timezone ?? DEFAULT_TIMEZONE,
        new Date(),
      );
      kept.push(routine);
    } catch (error) {
      dropped.push({
        field,
        value: shown,
        reason: error instanceof Error ? error.message : "定时任务不合格。",
      });
    }
  }
  return kept;
}

/** 新员工与员工改动共用的字段；`partial` 为真时只处理给出的字段。 */
function employeeFields(
  given: Record<string, unknown>,
  partial: boolean,
  dropped: DroppedItem[],
): Partial<EmployeeDraft> {
  const out: Partial<EmployeeDraft> = {};
  const has = (key: string) => given[key] !== undefined;
  if (has("name") || !partial) {
    out.name = text(given.name, "名字", NAME_MAX, { required: true });
  }
  if (has("title") || !partial) {
    out.title = has("title") ? text(given.title, "头衔", TITLE_MAX) : "";
  }
  if (has("roleDescription") || !partial) {
    out.roleDescription = text(given.roleDescription, "职责描述", ROLE_MAX, {
      multiline: true,
      required: true,
    });
  }
  if (has("avatar")) out.avatar = avatar(given.avatar);
  if (has("instructions")) {
    out.instructions = text(given.instructions, "指令", INSTRUCTIONS_MAX, {
      multiline: true,
    });
  }
  if (has("persona")) out.persona = persona(given.persona);
  if (has("bible")) {
    out.bible = text(given.bible, "工作手册", BIBLE_MAX, { multiline: true });
  }
  if (has("model")) out.model = model(given.model);
  if (has("skills") || !partial) {
    out.skills = distinct(idList(given.skills, "技能"), "技能");
  }
  if (has("apps") || !partial) out.apps = appEntries(given.apps, "应用");
  if (has("routines") || !partial) {
    out.routines = routines(given.routines, dropped, "routines");
  }
  if (has("visibility") || !partial) {
    const visibility = given.visibility ?? "private";
    if (visibility !== "private" && visibility !== "public") {
      return refuse("可见范围只能是 private 或 public。");
    }
    out.visibility = visibility;
  }
  return out;
}

function employee(input: unknown, dropped: DroppedItem[]): EmployeeDraft {
  const given = record(input, "员工草稿");
  const fields = employeeFields(given, false, dropped);
  const draft = fields as EmployeeDraft;
  if (given.roleTemplate !== undefined) {
    const template = record(given.roleTemplate, "角色模板");
    if (!Number.isInteger(template.version)) {
      refuse("角色模板的版本必须是整数。");
    }
    draft.roleTemplate = {
      id: id(template.id, "角色模板"),
      version: template.version as number,
    };
  }
  draft.staffingTools = given.staffingTools === true;
  return draft;
}

function employeeChange(
  input: unknown,
  dropped: DroppedItem[],
): EmployeeChangeDraft {
  const given = record(input, "员工改动");
  const set = employeeFields(
    given.set === undefined ? {} : record(given.set, "改动内容"),
    true,
    dropped,
  ) as EmployeeChangeDraft["set"];
  const draft: EmployeeChangeDraft = {
    agentId: id(given.agentId, "员工"),
    set,
    appsRemove: appEntries(given.appsRemove, "要移除的应用"),
    routinesRemove: idList(given.routinesRemove, "要移除的定时任务"),
  };
  if (
    Object.keys(set).length === 0 &&
    draft.appsRemove.length === 0 &&
    draft.routinesRemove.length === 0
  ) {
    refuse("没有任何要改的内容。");
  }
  return draft;
}

function group(input: unknown): GroupDraft {
  const given = record(input, "群聊草稿");
  const members = distinct(idList(given.members, "成员"), "成员");
  if (members.length < GROUP_MIN || members.length > GROUP_MAX) {
    refuse(`群聊需要 ${GROUP_MIN} 到 ${GROUP_MAX} 位不重复的成员。`);
  }
  return {
    name: text(given.name, "群名", NAME_MAX, { required: true }),
    members,
  };
}

function groupChange(input: unknown): GroupChangeDraft {
  const given = record(input, "群聊改动");
  const draft: GroupChangeDraft = {
    channelId: id(given.channelId, "群聊"),
    add: distinct(idList(given.add, "要加的成员"), "要加的成员"),
    remove: distinct(idList(given.remove, "要移的成员"), "要移的成员"),
  };
  if (given.name !== undefined) {
    draft.name = text(given.name, "群名", NAME_MAX, { required: true });
  }
  if (given.order !== undefined) {
    draft.order = distinct(idList(given.order, "顺序"), "顺序");
  }
  if (draft.add.some((member) => draft.remove.includes(member))) {
    refuse("同一位成员不能既加又移。");
  }
  if (
    draft.name === undefined &&
    draft.order === undefined &&
    draft.add.length === 0 &&
    draft.remove.length === 0
  ) {
    refuse("没有任何要改的内容。");
  }
  return draft;
}

export function parseDraft(kind: ProposalKind, input: unknown): ParsedDraft {
  const dropped: DroppedItem[] = [];
  try {
    const draft: ProposalDraft =
      kind === "employee"
        ? employee(input, dropped)
        : kind === "employee_change"
          ? employeeChange(input, dropped)
          : kind === "group"
            ? group(input)
            : groupChange(input);
    return { ok: true, draft, dropped };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, error: error.message };
    throw error;
  }
}
