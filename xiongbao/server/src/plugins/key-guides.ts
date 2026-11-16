import { shortName } from "../brand";
import type { BrokerField, FieldScheme } from "./broker";

/**
 * Where a person gets the key an app asks for, and the boxes of its form in words they can follow.
 *
 * Ported from upstream #1297 (d38dfbd2). The wording a person reads is Chinese, as everywhere else
 * a person reads this fork; product and menu names stay as the provider spells them, because that
 * is what the person will see on the provider's own page.
 *
 * WHY THIS EXISTS. Most of the broker's catalogue has no sign-in it can send somebody to: of 1,723
 * apps read on 2026-11-08, 126 had a sign-in the broker runs itself and 1,344 only took a key or a
 * token typed in. The form for those draws the provider's own field names and descriptions, which
 * are written for a developer ("Bearer Token", "Service Account Token (ops_* prefix), Connect
 * Server Access Token, or Events API Bearer Token"), and says nothing about where to go. A person
 * who expected a sign-in met a form and no way forward.
 *
 * THE LINK COMES FROM THE BROKER FIRST. Composio publishes an `auth_hint_url` on a connection mode
 * and an `auth_guide_url` on the app. Both are empty for nearly every app, so the map below is what
 * most key apps get. Every link in it was opened upstream on 2026-11-08 and lands on the provider's
 * own page for making the key, or on its documentation for it.
 *
 * THE MAP IS THE MOST-USED KEY-ONLY APPS, NOT ALL OF THEM. An app missing from it still gets the
 * plain explanation and the provider's own field help; it gets no link, because a guessed link is
 * worse than none. Add an app by its catalogue slug.
 */
export type KeyGuide = {
  /** What to do at the provider, in one or two sentences a person can follow. */
  steps: string;
  /** The provider's own page for making the key, or its documentation for it. */
  url: string;
  /**
   * Boxes whose published label or help does not serve a person, rewritten, keyed by the field's
   * published `name`. The provider's specifics (a prefix, a menu path) are kept in the rewrite.
   */
  fields?: Record<string, { label?: string; help?: string }>;
};

export const KEY_GUIDES: Record<string, KeyGuide> = {
  _1password: {
    steps:
      "1Password 要通过你们 1Password 管理员运行的 Connect 服务器连接。管理员在 1Password.com 的 Developer 里创建它，并为它生成一个访问令牌。",
    url: "https://www.1password.dev/connect/get-started",
    fields: {
      full: {
        label: "Connect 服务器地址",
        help: "你们 Connect 服务器的网址，例如 https://connect.example.com。可以问 1Password 管理员。",
      },
      generic_api_key: {
        label: "访问令牌",
        help: "为这台 Connect 服务器生成的访问令牌。1Password 管理员可以在 1Password.com 的 Developer → Connect servers 里找到。",
      },
    },
  },
  openai: {
    steps: "在 OpenAI 账号的 API keys 页面创建一个 secret key。",
    url: "https://platform.openai.com/api-keys",
  },
  posthog: {
    steps:
      "在 PostHog 打开 Settings → Personal API keys，创建一个密钥。PostHog 只显示一次，请立刻复制。",
    url: "https://posthog.com/docs/api",
  },
  sendgrid: {
    steps:
      "在 SendGrid 打开 Settings → API Keys，创建一个 Full Access 的密钥。SendGrid 只显示一次，请立刻复制。",
    url: "https://www.twilio.com/docs/sendgrid/ui/account-and-settings/api-keys",
  },
  elevenlabs: {
    steps: "在 ElevenLabs 账号里创建一个 API 密钥。它只显示一次，请立刻复制。",
    url: "https://elevenlabs.io/app/developers/api-keys",
  },
  firecrawl: {
    steps: "登录 Firecrawl，在 API Keys 页面复制你的密钥。",
    url: "https://www.firecrawl.dev/app/api-keys",
  },
  tavily: {
    steps: "登录 Tavily，在 API Keys 区域复制一个密钥。",
    url: "https://app.tavily.com/home",
  },
  serpapi: {
    steps: "登录 SerpApi，复制你的私有 API 密钥。",
    url: "https://serpapi.com/manage-api-key",
  },
  perplexityai: {
    steps: "在 Perplexity 账号里创建一个 API 密钥。它只显示一次，请立刻复制。",
    url: "https://www.perplexity.ai/account/api/keys",
  },
  exa: {
    steps: "登录 Exa，在 API keys 页面创建或复制一个密钥。",
    url: "https://dashboard.exa.ai/api-keys",
  },
  cloudflare: {
    steps:
      "在 Cloudflare 个人资料里复制 Global API Key，并填写你登录 Cloudflare 用的邮箱。",
    url: "https://developers.cloudflare.com/fundamentals/api/get-started/keys/",
  },
  pandadoc: {
    steps: "在 PandaDoc 账号里创建一个 API 密钥，链接里有具体做法。",
    url: "https://developers.pandadoc.com/reference/api-key-authentication-process",
  },
  mixpanel: {
    steps:
      "在 Mixpanel 打开 Organization Settings → Service Accounts，创建一个服务账号。它的 secret 只显示一次，请立刻复制。",
    url: "https://developer.mixpanel.com/reference/service-accounts",
  },
  algolia: {
    steps:
      "在 Algolia 控制台复制 Application ID 和一个 API 密钥。只读的话，search-only 密钥就够了。",
    url: "https://www.algolia.com/doc/guides/security/api-keys/",
  },
  apify: {
    steps:
      "在 Apify Console 打开 Settings → API & Integrations，复制你的 API 令牌。",
    url: "https://console.apify.com/settings/integrations",
  },
  apollo: {
    steps:
      "在 Apollo 打开 Settings → Integrations → API Keys，创建一个密钥，并打开 Set as master key，这样所有操作都能用。",
    url: "https://docs.apollo.io/docs/create-api-key",
  },
  replicate: {
    steps: "登录 Replicate，在 API tokens 页面复制一个令牌。",
    url: "https://replicate.com/account/api-tokens",
  },
  deepgram: {
    steps: "在 Deepgram 控制台创建一个 API 密钥。",
    url: "https://developers.deepgram.com/docs/create-additional-api-keys",
  },
  datadog: {
    steps:
      "在 Datadog 打开 Organization Settings，从 API Keys 复制一个 API 密钥，再从 Application Keys 复制一个应用密钥。",
    url: "https://docs.datadoghq.com/account_management/api-app-keys/",
  },
  telegram: {
    steps:
      "在 Telegram 里给 @BotFather 发 /newbot，创建一个机器人并拿到它的令牌。连接的是这个机器人，不是你自己的 Telegram 账号。",
    url: "https://core.telegram.org/bots/tutorial#obtain-your-bot-token",
  },
  shortcut: {
    steps: "在 Shortcut 设置里创建一个 API 令牌。",
    url: "https://developer.shortcut.com/api/rest/v3",
  },
  toggl: {
    steps: "在 Toggl Track 的个人资料设置里复制 API 令牌。",
    url: "https://track.toggl.com/profile",
  },
  cloudinary: {
    steps: "在 Cloudinary 控制台复制 cloud name、API key 和 API secret。",
    url: "https://console.cloudinary.com/settings/api-keys",
  },
  postmark: {
    steps:
      "在 Postmark 打开你的 server，进入 API Tokens 标签，复制 Server API token。",
    url: "https://postmarkapp.com/support/article/1008-what-are-the-account-and-server-api-tokens",
  },
  amplitude: {
    steps: "在 Amplitude 复制项目的 API key 和 secret key。",
    url: "https://amplitude.com/docs/apis/authentication",
  },
  segment: {
    steps: "在 Segment 工作区创建一个 Public API 令牌。",
    url: "https://twilio.com/docs/segment/api/public-api",
  },
  close: {
    steps:
      "在 Close 打开 Settings → Developer → API Keys，创建一个密钥。完整密钥只显示一次，请立刻复制。",
    url: "https://help.close.com/integrations/api-keys-oauth",
  },
  ashby: {
    steps:
      "由 Ashby 管理员在 Admin → Integrations → API Keys 里创建密钥。它只显示一次，请立刻复制。",
    url: "https://developers.ashbyhq.com/docs/authentication",
  },
  assemblyai: {
    steps:
      "在 AssemblyAI 控制台打开 Workspace → Manage → API Keys，复制你要用的项目的密钥。",
    url: "https://www.assemblyai.com/app/api-keys",
  },
  freshdesk: {
    steps: "在 Freshdesk 点你的头像 → Profile Settings，选择 View API key。",
    url: "https://support.freshdesk.com/support/solutions/articles/215517-how-to-find-your-api-key",
  },
  heygen: {
    steps: "在 HeyGen 打开 Settings → API，复制你的密钥。",
    url: "https://app.heygen.com/settings?nav=API",
  },
  mem0: {
    steps: "在 Mem0 设置里复制一个 API 密钥。",
    url: "https://app.mem0.ai/dashboard/api-keys",
  },
  browserbase_tool: {
    steps: "登录 Browserbase，在 Settings 里复制你的 API 密钥。",
    url: "https://www.browserbase.com/settings",
  },
};

/**
 * Labels the catalogue publishes again and again, in the words a person here reads.
 *
 * Only the generic ones. A label naming the app ("Postmark Server API Token") already says what
 * it is and is left alone.
 */
const PLAIN_LABELS: Record<string, string> = {
  "API Key": "API 密钥",
  "Api Key": "API 密钥",
  "API key": "API 密钥",
  "API Token": "API 令牌",
  "API Secret": "API Secret",
  "Bearer Token": "访问令牌",
  "Base URL": "网址",
  "API URL": "API 网址",
  "Sub Domain": "子域名",
  Subdomain: "子域名",
  Username: "用户名",
  Password: "密码",
};

/**
 * The broker's own name, which a person never reads: they connect through 熊宝. A provider's help
 * sentence sometimes names it ("lets Composio access your campaigns"), and that is the sentence's
 * one word about who is asking, so it becomes 熊宝.
 */
const BROKER_NAME = /\bcomposio\b/gi;

function forPerson(text: string): string {
  return text.replace(BROKER_NAME, shortName());
}

/** The form's boxes, each labelled and explained for a person. Names and order are untouched. */
export function fieldsForPerson(
  toolkit: string,
  fields: BrokerField[],
): BrokerField[] {
  const rewrites = Object.hasOwn(KEY_GUIDES, toolkit)
    ? (KEY_GUIDES[toolkit]?.fields ?? {})
    : {};
  return fields.map((field) => {
    const rewrite = Object.hasOwn(rewrites, field.name)
      ? rewrites[field.name]
      : undefined;
    const label =
      rewrite?.label ??
      (Object.hasOwn(PLAIN_LABELS, field.label)
        ? PLAIN_LABELS[field.label]
        : undefined) ??
      field.label;
    return {
      ...field,
      label: forPerson(label),
      help: forPerson(rewrite?.help ?? field.help),
    };
  });
}

/** What the connect dialog says above the form: what to do, and the page to do it on. */
export type ConnectionGuide = {
  steps: string;
  url: string | null;
};

/**
 * A link the broker published is used only when it is a provider's page: https, and not the
 * broker's own site, which would put the broker's name in front of a person and is not where a key
 * is made.
 */
function providerLink(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (/(^|\.)composio\.dev$/i.test(parsed.hostname)) return null;
  return parsed.toString();
}

/**
 * The guide for one app: the broker's own link where it published one, else the map's, and the
 * map's steps where the app is in it.
 */
export function connectionGuide(input: {
  toolkit: string;
  title: string;
  /** The link the broker published for this app's key, if any. */
  published: string | null;
}): ConnectionGuide {
  const mapped = Object.hasOwn(KEY_GUIDES, input.toolkit)
    ? KEY_GUIDES[input.toolkit]
    : undefined;
  return {
    steps:
      mapped?.steps ??
      `登录 ${input.title}，在它的设置或开发者页面里找 API 密钥（API key）。`,
    url: providerLink(input.published) ?? mapped?.url ?? null,
  };
}

/**
 * How long the key form waits for the broker's own link before answering without it.
 *
 * The link is a nicety beside the form a person came for, so a broker that is slow or failing
 * costs only the link: the map above answers instead.
 */
export const GUIDE_LINK_TIMEOUT_MS = 5_000;

/**
 * The guide the key form's first press answers with: the broker asked for its own link, and any
 * failure or delay there read as "no link" (upstream #1297 swallows it the same way).
 *
 * NOTHING ABOUT THE FAILURE IS SAID OR KEPT. The person came for the form, and an operator has
 * every other vendor call on this route to learn the key is wrong from; this one is a link.
 */
export async function keyGuideFor(input: {
  /** The broker's `connectionGuideUrl`, when it has one. */
  ask?: (request: {
    toolkit: string;
    authScheme: FieldScheme;
  }) => Promise<string | null>;
  toolkit: string;
  authScheme: FieldScheme;
  title: string;
  afterMs?: number;
}): Promise<ConnectionGuide> {
  const { ask, toolkit, authScheme, title } = input;
  let published: string | null = null;
  if (ask) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(
        () => resolve(null),
        input.afterMs ?? GUIDE_LINK_TIMEOUT_MS,
      );
    });
    try {
      published = await Promise.race([
        Promise.resolve()
          .then(() => ask({ toolkit, authScheme }))
          .then((link) => (typeof link === "string" ? link : null))
          .catch(() => null),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  return connectionGuide({ toolkit, title, published });
}
