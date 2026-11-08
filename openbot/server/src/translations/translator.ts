/**
 * Asking the deployment's model for Chinese versions of display text.
 *
 * One request carries a small batch and asks for one JSON object back, the same shape every other
 * background model call here uses. The model is told what must survive untouched — names of products
 * and vendors, code, commands, URLs, placeholders, Markdown — because these are labels and help text
 * for things a person will then go and use, and a translated command name is a broken one.
 */
export type Translate = (texts: string[]) => Promise<string[]>;

export function translationPrompt(texts: string[]): string {
  return [
    "你是软件界面的本地化译者。把下面 JSON 数组里的每一段英文界面文字翻译成简体中文。",
    "要求：",
    "- 用自然、简洁的中文，像产品界面文案，不要逐字硬译。",
    "- 保留原样：产品名和公司名（如 Google Drive、GitHub、Slack、Notion）、代码、命令、文件名、URL、",
    "  形如 {name}、$VAR、/command 的占位符和命令，以及 Markdown 结构（标题、列表、代码块、链接）。",
    "- 已经是中文的部分保持不变。不要添加解释。",
    '- 只返回一个 JSON 对象：{"translations": [...]}，数组长度和顺序与输入完全一致。',
    "",
    JSON.stringify(texts),
  ].join("\n");
}

export function parseTranslations(answer: string, expected: number): string[] {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("译文不是 JSON 对象");
  const parsed = JSON.parse(answer.slice(start, end + 1)) as {
    translations?: unknown;
  };
  const list = parsed.translations;
  if (
    !Array.isArray(list) ||
    list.length !== expected ||
    list.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error("译文数量或格式不对");
  }
  return list as string[];
}

export function createTranslator(
  complete: (prompt: string) => Promise<string>,
): Translate {
  return async (texts) =>
    parseTranslations(await complete(translationPrompt(texts)), texts.length);
}
