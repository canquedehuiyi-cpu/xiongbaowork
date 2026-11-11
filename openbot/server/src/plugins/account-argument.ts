/**
 * broker 应用的工具可选的 `account` 参数：让 Bot 在本人的多个账号里挑一个（上游 `account-argument.ts`）。
 *
 * 只按名字，从不按 id。模型被告知的是 vendor 为每个账号报出的邮箱或登录名，它回答其中之一；调用路径只在
 * 本次会话那个人自己的账号里按名字查找，所以模型借这个参数最多只能在这个人自己的账号之间挑选，查不到的
 * 一律拒绝。
 *
 * 只有应用自己的 schema 没有用到这个名字时才归我们。动作参数里本来就有 `account` 的，原样交给 vendor，
 * 调用照旧进这个人的默认账号。{@link accountArgumentFor} 是两边都问的唯一判断，所以模型看到的工具和调用
 * 路径不会对「这个 `account` 是谁的」有分歧。
 *
 * 给模型看的描述保留英文（与工具 schema 的其余部分一致）；给人看的拒绝在 store 里，用中文。
 */
export const ACCOUNT_ARG = "account";

/** 这个动作的 schema 是否把 `account` 留给了账号选择。 */
export function accountArgumentFor(
  inputSchema: Record<string, unknown> | null | undefined,
): typeof ACCOUNT_ARG | null {
  const properties = inputSchema?.properties;
  if (
    properties &&
    typeof properties === "object" &&
    Object.hasOwn(properties, ACCOUNT_ARG)
  )
    return null;
  return ACCOUNT_ARG;
}

/** 一个人在某应用上的一个账号，按模型被告知的样子。 */
export type AccountChoice = { label: string; isDefault: boolean };

/**
 * 加上 `account` 参数之后的 schema，列出这个人的账号。
 *
 * 只在真有选择时才加：只有一个账号或一个都没记下时，schema 就是应用自己的，调用照旧。
 */
export function withAccountArgument(
  inputSchema: Record<string, unknown>,
  appTitle: string,
  choices: readonly AccountChoice[],
): Record<string, unknown> {
  if (choices.length < 2 || accountArgumentFor(inputSchema) === null)
    return inputSchema;
  const fallback = choices.find((choice) => choice.isDefault) ?? choices[0];
  const properties =
    inputSchema.properties && typeof inputSchema.properties === "object"
      ? (inputSchema.properties as Record<string, unknown>)
      : {};
  return {
    ...inputSchema,
    type: "object",
    properties: {
      ...properties,
      [ACCOUNT_ARG]: {
        type: "string",
        enum: choices.map((choice) => choice.label),
        description: `Which of the person's ${appTitle} accounts to use: ${choices
          .map((choice) =>
            choice.isDefault ? `${choice.label} (default)` : choice.label,
          )
          .join(
            ", ",
          )}. Pick the one the request is about, for example their work or personal account. Leave it out to use ${fallback?.label}.`,
      },
    },
  };
}
