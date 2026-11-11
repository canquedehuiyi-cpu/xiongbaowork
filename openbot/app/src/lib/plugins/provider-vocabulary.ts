import { isBrokeredProvenance } from "./brokered";
import type { PluginsPage } from "./queries";

/**
 * The words an admin Plugins screen uses for the ACTIVE broker, and nothing of the other's (spec D11).
 *
 * TWO DIFFERENT QUESTIONS, AND CONFLATING THEM IS THE TRAP. A screen that FILTERS by brokered-ness
 * needs no provider name: one provider holds rows at a time (spec D3), so {@link brokeredProvenance}
 * answers it from the row. A screen that NAMES a vendor cannot derive the name from a row that
 * happens to exist — a deployment with the key set and no app enabled yet has no row at all — so it
 * reads {@link pluginsProvider} and asks this module for the words.
 *
 * Pure functions, so the vocabulary is pinned without a DOM. Nothing here carries a key or a
 * capability: the provider is a NAME.
 */
export type PluginsProvider = "composio" | "arcade";

/**
 * The provider a payload names, `"composio"` when the server did not say.
 *
 * 上游从 `./queries` 的 `pluginsProvider` 读，并把 `provider` 写进 `PluginsPage` 类型。fork 的
 * queries.ts 还没有这两样（fork 服务端的 `GET /api/plugins` 也还不下发 `provider`），所以先在这里
 * 就地读，缺省 `composio`。第二阶段 queries.ts 补上后改回 `pluginsProvider`。
 */
function providerOf(page: PluginsPage): PluginsProvider {
  const named = (page as { provider?: unknown }).provider;
  return named === "arcade" ? "arcade" : "composio";
}

/**
 * Which edition reads the sentence. The team edition's words are for an admin and for each person
 * in a team; the personal edition has one person, on their own computer, and is spoken to as "you".
 * `managePaths(...).edition` carries it, read from the deployment's capabilities.
 */
export type Edition = "team" | "personal";

/**
 * What this person actually does to connect: click through a consent screen, type a secret, or
 * nothing at all. See `kindOf` in `brokered-account-row.tsx`, which reads it off the app's scheme.
 */
export type BrokeredAccountKind = "consent" | "fields" | "no-auth";

/** The app a personal sentence names, and how it is connected. */
export type BrokeredApp = { title: string; kind: BrokeredAccountKind };

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Whether a row came through a broker, whichever one. Filters; never names.
 *
 * 熊宝统一用 `./brokered` 的 `isBrokeredProvenance` 判断（同时认 composio 和 arcade），这里只是
 * 上游名字的别名，留给沿用上游写法的调用方。
 */
export function brokeredProvenance(provenance: string): boolean {
  return isBrokeredProvenance(provenance);
}

/*
 * NO VENDOR NAME IN ANY OF IT. A person connects their work apps through OpenBot, and the broker
 * behind it (Composio or Arcade) is never named on a screen, the admin's included. The one vendor
 * word left is the environment variable an admin sets, because that name is the whole remedy.
 */
export type ProviderVocabulary = {
  /** The directory entry's label, as the "More apps" row and the picker title say it. */
  directoryLabel: string;
  /** The environment variable an operator sets to turn the broker on. */
  envVar: string;
  /*
   * No route path here. Where the directory screen lives depends on the edition (under Admin, or
   * under Settings), so `managePaths(...).brokerDirectory(provider)` names it, from the same
   * generated route tree: a path no route file answers still stops compiling.
   */
  /**
   * What the "More apps" row says once the key is set.
   *
   * A FIELD rather than a `provider === "composio"` branch. Composio's sentence counts its
   * directory ("a few hundred apps") and that count is Composio's, measured by nobody here; Arcade's
   * says the same thing about reach without claiming a size this deployment has not counted.
   */
  directoryDescription: string;
};

const VOCABULARY: Record<PluginsProvider, ProviderVocabulary> = {
  composio: {
    directoryLabel: "浏览应用",
    envVar: "COMPOSIO_API_KEY",
    directoryDescription:
      "几百个应用，以提问者的身份连接。每个人连接自己的账号。",
  },
  arcade: {
    directoryLabel: "浏览应用",
    envVar: "ARCADE_API_KEY",
    directoryDescription: "这里没有人审核过的应用。每个人连接自己的账号。",
  },
};

export function providerVocabulary(
  provider: PluginsProvider,
): ProviderVocabulary {
  return VOCABULARY[provider];
}

/**
 * What a failed directory read says when the server sent no message of its own.
 *
 * ONE SENTENCE FOR BOTH THE QUERY AND THE SCREEN, so the two layers cannot drift: the query layer's
 * fallback once spelled a vendor on its own and printed Composio's name on an Arcade deployment.
 */
export function directoryReadFailure(_provider: PluginsProvider): string {
  return "读不到可以连接的应用。请刷新页面。";
}

/**
 * The directory screen's own two sentences: its description and its search section's.
 *
 * Adding an app there connects nobody, in either edition. In the team edition each person connects
 * their own account afterwards; in the personal one, the one person does, on the app's page.
 */
export function directoryDescriptions(edition: Edition = "team"): {
  page: string;
  search: string;
} {
  return edition === "personal"
    ? {
        page: "添加一个应用并连接你的账号，你的员工就能用它。",
        search: "按名字搜索。熊宝没有审核过这些应用。",
      }
    : {
        page: "添加一个应用后就能把它的工具授予员工；每个人仍要先连接自己的账号，员工才能读到任何东西。",
        search: "按名字搜索。这里的应用都没有经过本部署审核。",
      };
}

/**
 * The "More apps" section's own sentence. Admin's Plugins list only: the personal edition lists its
 * apps under Connections, with the directory as one more tile ({@link moreAppsRow}).
 */
export function moreAppsSectionDescription(_provider: PluginsProvider): string {
  return "更多可以通过熊宝连接的应用，这里没有人审核过它们。";
}

/**
 * The one row under "More apps".
 *
 * `linked` is whether the row goes anywhere. Both providers have a directory screen, so the row
 * links exactly when the key is configured — and the function tests the configuration and never the
 * vendor. An unconfigured row states its setting and links nowhere, because there is nowhere to go
 * until the key is set.
 */
export type MoreAppsRow = {
  title: string;
  description: string;
  linked: boolean;
};

/**
 * The "More apps" row's sentence in the personal edition, where the one person reading it is the
 * only one who connects anything. The same split as {@link ProviderVocabulary.directoryDescription}:
 * Composio's counts its directory and Arcade's claims no size.
 */
const PERSONAL_DIRECTORY_DESCRIPTION: Record<PluginsProvider, string> = {
  composio: "还有几百个你可以连接的应用。",
  arcade: "更多你可以连接的应用。",
};

/** Where the personal edition's one person turns connecting apps on: Settings, Setup. */
const PERSONAL_SET_UP = "请到「设置」里的「部署设置」完成设置。";

export function moreAppsRow(
  provider: PluginsProvider,
  configured: boolean,
  edition: Edition = "team",
): MoreAppsRow {
  const { directoryLabel, envVar, directoryDescription } = VOCABULARY[provider];
  if (!configured) {
    return {
      title: directoryLabel,
      description:
        edition === "personal"
          ? `还没有设置。${PERSONAL_SET_UP}`
          : `还没有设置。请在这个部署上设置 ${envVar} 后再浏览这些应用。`,
      linked: false,
    };
  }
  return {
    title: directoryLabel,
    description:
      edition === "personal"
        ? PERSONAL_DIRECTORY_DESCRIPTION[provider]
        : directoryDescription,
    linked: true,
  };
}

/**
 * The Connection card's sentence for a brokered app.
 *
 * `personal` is the app, given only by the personal edition's page: there is one person there, so
 * the sentence names their own account in the app, and an app with no account says so.
 */
export function brokeredConnectionDescription(
  _provider: PluginsProvider,
  personal?: BrokeredApp,
): string {
  if (!personal) return "每个人通过熊宝连接自己的账号。";
  if (personal.kind === "no-auth")
    return `${capitalised(personal.title)} 不需要账号，通过熊宝直接可用。`;
  return `通过熊宝连接你的 ${personal.title} 账号。`;
}

/**
 * The "How this is reached" row for a brokered app: its sentence and its badge.
 *
 * `personal` as above. What it says is what happens at sign-in: a consent app sends you to the
 * app's own sign-in page in your browser (`useBrokeredAccount` leaves for the broker's
 * authorization URL), so OpenBot never holds the password; a key app takes a key you paste, so
 * that sentence promises nothing about passwords; and an app with no account has nothing to sign
 * in to.
 *
 * `takesKey` is the team edition's key app, read by the same page. "There is no token to paste"
 * was said on those too, right above a Connect that asks for one.
 */
export function brokeredReach(
  _provider: PluginsProvider,
  personal?: BrokeredApp,
  takesKey = false,
): {
  description: string;
  badge: string;
} {
  const badge = "通过熊宝";
  if (!personal) {
    return {
      description: takesKey
        ? "每个人用这个应用给的密钥连接自己的账号，员工只看得到这个人能看到的东西。"
        : "这个部署为这类应用统一持有一把密钥。每个人连接自己的账号，员工只看得到这个人能看到的东西，不需要粘贴令牌。",
      badge,
    };
  }
  const { title, kind } = personal;
  return {
    description:
      kind === "consent"
        ? `你在浏览器里登录 ${title}，熊宝永远看不到你的密码。`
        : kind === "fields"
          ? `你用 ${title} 账号里的密钥连接，你的员工以你的身份使用它。`
          : "不需要登录。",
    badge,
  };
}

/** What disconnecting a brokered account does, said where the button is. */
export function brokeredDisconnectNote(_provider: PluginsProvider): string {
  return "断开后，熊宝也就不能再访问你的账号。";
}

/**
 * What is said where the deployment has no key for the active broker.
 *
 * `reader` is who can act on it, in the team edition. An admin's page names the variable they set; a
 * person's own Connections page names neither the variable nor the vendor in it, and says who to
 * ask, in the server's words for the same state (`BrokerUnconfiguredError`'s person sentence).
 *
 * The personal edition has no admin to ask and no grants to keep, whichever page it is: the one
 * person sets it up themselves, on Settings' Setup page, whose "More apps" row names what to set.
 */
export function brokeredKeyMissing(
  provider: PluginsProvider,
  edition: Edition = "team",
  reader: "admin" | "person" = "admin",
): string {
  if (edition === "personal")
    return `连接应用还没有设置好，所以这个账号在这里既连不上也断不开。${PERSONAL_SET_UP}`;
  if (reader === "person")
    return "连接应用还没有设置好，所以这个账号在这里既连不上也断不开。请联系管理员设置。";
  return `请在这个部署上设置 ${VOCABULARY[provider].envVar}。没有它就连不到中转服务，所以这个账号在这里既连不上也断不开。应用仍保持启用，它工具上的授权也都还在。`;
}

/**
 * What a Disconnect would also end, said beside the Disconnect, from the server's computed answer.
 *
 * NULL WHEN THERE IS NOTHING TO SAY. An app with no siblings gets no warning block at all, not an
 * empty one: a warning about apps that will not be touched teaches people to dismiss the one that
 * matters. `unanswered` is a COUNT and never names, because an app that could not be asked about
 * has no name this deployment could vouch for.
 *
 * It names the apps and promises nothing about confinement (D30): which other apps a consent covers
 * is the provider's property, and this sentence reports what the server counted rather than what it
 * hopes.
 */
export function disconnectSiblingsNotice(answer: {
  siblings: readonly string[];
  unanswered: number;
}): string | null {
  const { siblings, unanswered } = answer;
  const parts: string[] = [];
  if (siblings.length > 0) {
    parts.push(
      `断开后，你对 ${joinNames(siblings)} 的访问也会一起结束，它们和这个应用共用这个连接。`,
    );
  }
  if (unanswered > 0) {
    parts.push(
      siblings.length > 0
        ? `另有 ${unanswered} 个应用没能查到，也可能受影响。`
        : `这个连接上有 ${unanswered} 个应用没能查到，断开后它们也可能一起结束。`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 2) return names.join("和");
  return `${names.slice(0, -1).join("、")}和${names[names.length - 1]}`;
}

/**
 * Whether a directory route may answer on this deployment.
 *
 * `pending` until the page has said which provider this is: the default of `"composio"` is right for
 * a label and wrong for a gate, because acting on it would fire a Composio request against an Arcade
 * project in the moment before the answer arrives.
 */
export function directoryRouteDecision(
  routeProvider: PluginsProvider,
  page: PluginsPage | undefined,
): "pending" | "render" | "redirect" {
  if (!page) return "pending";
  return providerOf(page) === routeProvider ? "render" : "redirect";
}
