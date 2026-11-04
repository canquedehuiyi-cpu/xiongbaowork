import type { Persona } from "./persona";

/**
 * A role profile (story ROLE1, spec §3.1): what a role template holds and what it hands a coworker.
 *
 * Three parts. The identity is the job (a title and what it is for), the persona is who does it, and
 * the Bible (工作手册) is the long-form background, procedures or glossary the job needs. A coworker's
 * name, avatar, model and skills are its own and are never part of a role.
 *
 * Shared by the server, which validates every write, and the app, which parses and writes the fixed
 * Markdown format in the browser. Pure functions only.
 */
export type RoleProfile = {
  identity: { title: string; roleDescription: string };
  persona: Persona;
  bible: string;
};

export const ROLE_LIMITS = {
  templateName: 80,
  title: 80,
  roleDescription: 500,
  personaPart: 2000,
  bible: 8000,
} as const;

export const emptyRoleProfile = (): RoleProfile => ({
  identity: { title: "", roleDescription: "" },
  persona: { tone: "", principles: "", habits: "" },
  bible: "",
});

/** Characters as the database counts them (code points), so a limit here is the limit there. */
export const characterCount = (text: string): number => [...text].length;

export type RoleProfileResult =
  | { ok: true; profile: RoleProfile }
  | { ok: false; section: string; message: string; line?: number };

const PARTS: { key: keyof Persona; zh: string; en: string }[] = [
  { key: "tone", zh: "性格语气", en: "Tone" },
  { key: "principles", zh: "工作守则", en: "Principles" },
  { key: "habits", zh: "口头约束", en: "Habits" },
];

function fail(
  section: string,
  message: string,
  line?: number,
): RoleProfileResult {
  return line === undefined
    ? { ok: false, section, message }
    : { ok: false, section, message, line };
}

/**
 * Check and normalise a role profile from anywhere (a request body, a model's answer, a parsed
 * file): every field text, trimmed, within its limit, and the title on one line. Missing fields are
 * empty; anything else is refused with the section it is in.
 */
export function validateRoleProfile(value: unknown): RoleProfileResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("角色", "角色档案必须是一个对象。");
  }
  const given = value as Record<string, unknown>;
  const text = (
    raw: unknown,
    section: string,
    limit: number,
  ): string | RoleProfileResult => {
    if (raw === undefined || raw === null) return "";
    if (typeof raw !== "string")
      return fail(section, `「${section}」必须是文字。`);
    const trimmed = raw.replace(/\r\n?/g, "\n").trim();
    if (characterCount(trimmed) > limit) {
      return fail(section, `「${section}」不能超过 ${limit} 字。`);
    }
    return trimmed;
  };
  const object = (raw: unknown) => {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== "object" || Array.isArray(raw)) return null;
    return raw as Record<string, unknown>;
  };

  const identity = object(given.identity);
  if (!identity) return fail("身份", "「身份」必须是一个对象。");
  const title = text(identity.title, "头衔", ROLE_LIMITS.title);
  if (typeof title !== "string") return title;
  if (title.includes("\n")) return fail("头衔", "「头衔」只能写一行。");
  const roleDescription = text(
    identity.roleDescription,
    "职责",
    ROLE_LIMITS.roleDescription,
  );
  if (typeof roleDescription !== "string") return roleDescription;

  const persona = object(given.persona);
  if (!persona) return fail("人设", "「人设」必须是一个对象。");
  const parts: Partial<Persona> = {};
  for (const part of PARTS) {
    const written = text(persona[part.key], part.zh, ROLE_LIMITS.personaPart);
    if (typeof written !== "string") return written;
    parts[part.key] = written;
  }

  const bible = text(given.bible, "手册", ROLE_LIMITS.bible);
  if (typeof bible !== "string") return bible;

  return {
    ok: true,
    profile: {
      identity: { title, roleDescription },
      persona: {
        tone: parts.tone ?? "",
        principles: parts.principles ?? "",
        habits: parts.habits ?? "",
      },
      bible,
    },
  };
}

/** Whether two profiles say the same thing, after the normalisation every write goes through. */
export function sameRoleProfile(a: RoleProfile, b: RoleProfile): boolean {
  return (
    a.identity.title === b.identity.title &&
    a.identity.roleDescription === b.identity.roleDescription &&
    PARTS.every((part) => a.persona[part.key] === b.persona[part.key]) &&
    a.bible === b.bible
  );
}

/*
 * THE MARKDOWN FORMAT (spec §3.6), fixed and locked by a round-trip test:
 *
 *   # 身份            (or # Identity)
 *   头衔：<one line>  (or Title:)
 *   ## 职责           (or ## Responsibilities)
 *   # 人设            (or # Persona)
 *   ## 性格语气 / ## 工作守则 / ## 口头约束   (or ## Tone / ## Principles / ## Habits)
 *   # 手册            (or # Bible)
 *   <any Markdown, to the end of the file>
 *
 * The handbook is last and runs to the end, so its own headings are its own. In every other field a
 * line that would read as a heading (or already starts with a backslash) is written with one leading
 * backslash, and the parser takes one off: that is what makes export then import give back exactly
 * what was exported.
 */
const H1: Record<string, "identity" | "persona" | "bible"> = {
  身份: "identity",
  identity: "identity",
  人设: "persona",
  persona: "persona",
  手册: "bible",
  bible: "bible",
};
const H1_LABEL = { identity: "身份", persona: "人设", bible: "手册" } as const;
const RESPONSIBILITIES = new Set(["职责", "responsibilities"]);
const TITLE_LINE = /^(?:头衔|title)\s*[:：]\s*(.*)$/i;

const escapeField = (text: string) =>
  text
    .split("\n")
    .map((line) => (/^\s*[#\\]/.test(line) ? `\\${line}` : line))
    .join("\n");
const unescapeLine = (line: string) =>
  /^\s*\\/.test(line) ? line.replace("\\", "") : line;

/** The profile as the fixed Markdown format. */
export function roleProfileToMarkdown(profile: RoleProfile): string {
  const block = (heading: string, body: string) =>
    body ? `${heading}\n\n${body}\n` : `${heading}\n`;
  return [
    "# 身份\n",
    `头衔：${profile.identity.title}\n`,
    block("## 职责", escapeField(profile.identity.roleDescription)),
    "# 人设\n",
    ...PARTS.map((part) =>
      block(`## ${part.zh}`, escapeField(profile.persona[part.key])),
    ),
    block("# 手册", profile.bible),
  ].join("\n");
}

/**
 * Parse the fixed Markdown format into a profile, or say which part is wrong. Nothing is dropped:
 * text outside a known heading, an unknown heading, a missing section or an over-long field is an
 * error naming its section (and line), never quietly discarded.
 */
export function roleProfileFromMarkdown(markdown: string): RoleProfileResult {
  const lines = markdown.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  type Section = "identity" | "persona";
  const seen = new Set<string>();
  let section: Section | null = null;
  let sub: string | null = null;
  let title: string | null = null;
  const fields: Record<string, string[]> = {};
  let bible: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const number = index + 1;
    const h1 = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (h1 && !line.startsWith("##")) {
      const name = h1[1] ?? "";
      const kind = H1[name.toLowerCase()];
      if (!kind) {
        return fail(name, `未知的一级标题「${name}」。`, number);
      }
      if (seen.has(kind)) {
        return fail(H1_LABEL[kind], `一级标题「${name}」重复。`, number);
      }
      seen.add(kind);
      if (kind === "bible") {
        bible = lines.slice(index + 1).join("\n");
        break;
      }
      section = kind;
      sub = null;
      continue;
    }
    const h2 = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h2 && !line.startsWith("###")) {
      const name = h2[1] ?? "";
      const lower = name.toLowerCase();
      if (section === "identity" && RESPONSIBILITIES.has(lower)) {
        sub = "roleDescription";
      } else if (section === "persona") {
        const part = PARTS.find(
          (candidate) =>
            candidate.zh === name || candidate.en.toLowerCase() === lower,
        );
        if (!part) {
          return fail("人设", `「人设」下未知的二级标题「${name}」。`, number);
        }
        sub = part.key;
      } else {
        const where = section ? H1_LABEL[section] : "文件开头";
        return fail(where, `「${where}」下未知的二级标题「${name}」。`, number);
      }
      if (fields[sub] !== undefined) {
        return fail(name, `二级标题「${name}」重复。`, number);
      }
      fields[sub] = [];
      continue;
    }
    if (!section) {
      if (line.trim()) {
        return fail("文件开头", "这一行不在任何一级标题之下。", number);
      }
      continue;
    }
    if (sub) {
      fields[sub]?.push(unescapeLine(line));
      continue;
    }
    if (!line.trim()) continue;
    const titled = section === "identity" ? TITLE_LINE.exec(line) : null;
    if (titled && title === null) {
      title = titled[1] ?? "";
      continue;
    }
    return section === "identity"
      ? fail("身份", "「身份」里只能写「头衔：」一行和「## 职责」。", number)
      : fail("人设", "「人设」里的内容要写在二级标题之下。", number);
  }

  for (const kind of ["identity", "persona", "bible"] as const) {
    if (!seen.has(kind)) {
      return fail(H1_LABEL[kind], `缺少一级标题「# ${H1_LABEL[kind]}」。`);
    }
  }
  if (title === null) return fail("身份", "「身份」缺少「头衔：」一行。");

  const join = (key: string) => (fields[key] ?? []).join("\n");
  return validateRoleProfile({
    identity: { title, roleDescription: join("roleDescription") },
    persona: {
      tone: join("tone"),
      principles: join("principles"),
      habits: join("habits"),
    },
    bible,
  });
}
