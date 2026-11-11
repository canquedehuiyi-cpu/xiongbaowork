import type { DesktopAiConnection } from "./queries";

/** One line of the AI model dialog: what it is, and this installation's answer. */
export type AiConnectionDetail = { label: string; value: string };

/** The AI connection in a person's words: who provides it, how OpenBot signs in, and the model. */
export type AiConnectionSummary = {
  provider: string;
  /** The row's second line: how OpenBot signs in, and the model when one was named. */
  summary: string;
  details: AiConnectionDetail[];
};

/**
 * The addresses the setup window fills in for a provider's own row (`endpointPresets` in
 * desktop/src/ProviderPicker.tsx), by host. Any other address is the person's own.
 */
const PRESET_HOSTS: Record<string, string> = {
  "generativelanguage.googleapis.com": "Google Gemini",
  "api.x.ai": "xAI",
  "api.unbiased.ai": "Unbiased AI",
};

function signedIn(
  kind: NonNullable<DesktopAiConnection["kind"]>,
  host: string | null,
): { provider: string; signIn: string; said: string } {
  switch (kind) {
    case "claude-plan":
      return {
        provider: "Anthropic",
        signIn: "Claude 套餐",
        said: "已用你的 Claude 套餐登录。",
      };
    case "chat-gpt-plan":
      return {
        provider: "OpenAI",
        signIn: "ChatGPT 套餐",
        said: "已用你的 ChatGPT 套餐登录。",
      };
    case "anthropic-api-key":
      return {
        provider: "Anthropic",
        signIn: "API 密钥",
        said: "使用你的 Anthropic API 密钥。",
      };
    case "open-ai-api-key":
      return {
        provider: "OpenAI",
        signIn: "API 密钥",
        said: "使用你的 OpenAI API 密钥。",
      };
    case "google-oauth":
      return {
        provider: "Google Gemini",
        signIn: "Google 账号",
        said: "已用你的 Google 账号登录。",
      };
    case "xai-oauth":
      return {
        provider: "xAI",
        signIn: "xAI 账号",
        said: "已用你的 xAI 账号登录。",
      };
    case "compatible-endpoint": {
      const preset = host ? PRESET_HOSTS[host] : undefined;
      if (preset)
        return {
          provider: preset,
          signIn: "API 密钥",
          said: `使用你的 ${preset} API 密钥。`,
        };
      return {
        provider: "OpenAI 兼容接口",
        signIn: host ?? "你自己的地址",
        said: host ? `已连接到 ${host}。` : "已连接到你自己的地址。",
      };
    }
  }
}

/** What Settings says about the AI connection; null when none has been chosen yet. */
export function describeAiConnection(
  connection: DesktopAiConnection,
): AiConnectionSummary | null {
  if (!connection.kind) return null;
  const { provider, signIn, said } = signedIn(
    connection.kind,
    connection.endpointHost,
  );
  const details: AiConnectionDetail[] = [
    { label: "提供方", value: provider },
    {
      label:
        connection.kind === "compatible-endpoint" && signIn !== "API 密钥"
          ? "地址"
          : "登录方式",
      value: signIn,
    },
  ];
  if (connection.model)
    details.push({ label: "模型", value: connection.model });
  return {
    provider,
    summary: connection.model ? `${said}模型：${connection.model}` : said,
    details,
  };
}
