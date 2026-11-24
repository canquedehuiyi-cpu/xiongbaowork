/**
 * Guided review of a code change (XIONGBAO_PILOT_INBOX_NOTES): the files of a change sorted into
 * three chapters by their path, so a long change is read core first, then what it touches, then the
 * plumbing. Fixed rules, no model: the same files always fall into the same chapters.
 */

export const REVIEW_CHAPTER_IDS = ["core", "impact", "glue"] as const;
export type ReviewChapterId = (typeof REVIEW_CHAPTER_IDS)[number];

/** Each chapter's title and the one sentence that says what to look for in it. */
export const REVIEW_CHAPTERS: Record<
  ReviewChapterId,
  { title: string; summary: string }
> = {
  core: {
    title: "核心改动",
    summary: "先看这里：业务逻辑和功能本身的源码改动。",
  },
  impact: {
    title: "影响",
    summary: "再看这里：测试、文档和数据库迁移，说明改动影响到哪、有没有验证。",
  },
  glue: {
    title: "胶水代码",
    summary:
      "最后扫一眼：配置、依赖、入口汇总和生成文件，通常只是把改动接起来。",
  },
};

/** Source code, by extension. A path with none of these is not a code change on its own. */
export const SOURCE_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".rb",
  ".php",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".vue",
  ".svelte",
  ".sh",
];

/** Dependency lists: plumbing even where the extension (`.txt`) would read as documentation. Checked first. */
export const DEPENDENCY_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)requirements[^/]*\.txt$/,
  /(^|\/)(go\.mod|gemfile|gemfile\.lock|pyproject\.toml|cargo\.toml)$/,
];

/** Matched against the whole path, lower-cased, with `/` separators. */
export const IMPACT_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)(tests?|__tests__|spec|specs|e2e)\//,
  /\.(test|spec)\.[a-z0-9]+$/,
  /(^|\/)docs\//,
  /^doc\//,
  /\.(md|mdx|rst|txt)$/,
  /(^|\/)(drizzle|migrations?)\//,
  /\.sql$/,
  /(^|\/)__snapshots__\//,
];

export const GLUE_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)(bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|cargo\.lock|go\.sum)$/,
  /(^|\/)package\.json$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)[^/]*\.config\.[a-z]+$/,
  /(^|\/)(biome\.json|dockerfile|\.gitignore|\.dockerignore|\.env[^/]*)$/,
  /\.(ya?ml|toml|ini)$/,
  /(^|\/)\.github\//,
  /(^|\/)(scripts|generated|dist|build)\//,
  /\.(generated|gen)\.[a-z0-9]+$/,
  /\.d\.ts$/,
  /(^|\/)index\.(ts|tsx|js|jsx|mjs)$/,
];

const tidy = (path: string) =>
  path.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();

const isSource = (path: string) =>
  SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));

/**
 * The chapter one path belongs in. The order is the rule: a test is impact even though it is source,
 * and a config script is glue even though it is source. Whatever is neither, and is source code,
 * is core; any other file (an image, a data file) is glue.
 */
export function chapterOf(path: string): ReviewChapterId {
  const clean = tidy(path);
  if (DEPENDENCY_PATH_PATTERNS.some((pattern) => pattern.test(clean)))
    return "glue";
  if (IMPACT_PATH_PATTERNS.some((pattern) => pattern.test(clean)))
    return "impact";
  if (GLUE_PATH_PATTERNS.some((pattern) => pattern.test(clean))) return "glue";
  return isSource(clean) ? "core" : "glue";
}

/** A change is code when any of its files is source: a docs-only change gets no guided review. */
export const isCodeChange = (files: readonly string[]) =>
  files.some((file) => isSource(tidy(file)));

export type GuidedReview = {
  id: ReviewChapterId;
  title: string;
  summary: string;
  files: string[];
}[];

/** The three chapters, in reading order, each with its files in the order they were given. Null for a change that is not code. */
export function guidedReview(files: readonly string[]): GuidedReview | null {
  // One file under two spellings (case, separators) is listed once, as first written.
  const seen = new Set<string>();
  const unique = files
    .map((file) => file.trim())
    .filter((file) => {
      const key = tidy(file);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (!isCodeChange(unique)) return null;
  return REVIEW_CHAPTER_IDS.map((id) => ({
    id,
    ...REVIEW_CHAPTERS[id],
    files: unique.filter((file) => chapterOf(file) === id),
  }));
}
