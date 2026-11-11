import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { BotAccessCheck } from "../agents/profile-policy";
import type { AdminScope } from "../auth/admin-scope";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import {
  type AccountModeSwitch,
  AccountModeRefusedError,
} from "./account-mode";
import { reasonWithoutStatement } from "../db/query-failure";
import {
  appsPage,
  appsPageZh,
  askAdminTo,
  askAdminToZh,
  currentEdition,
} from "../edition";
import {
  capabilityFor,
  currentTenant,
  isPersonTenant,
  runAsTenant,
} from "../tenant/context";
import { type BrokerProvider, toolkitOfFor } from "./access";
import {
  adminInputFor,
  mountAppAccessRoutes,
  unavailableSentence,
} from "./app-access-routes";
import {
  arcadeConnectionSiblings,
  clearEndedArcadeSiblings,
  mountArcadeRoutes,
  startArcadeAuthorization,
} from "./arcade-routes";
import {
  type ArcadeBroker,
  type BrokerApp,
  type BrokerField,
  BrokerUnconfiguredError,
  brokerReturnUrl,
  brokerSentence,
  type ComposioBroker,
  type Decides,
  isFieldScheme,
  type KeyGuideSource,
  type SchemeKind,
  schemeKind,
} from "./broker";
import { CATALOGUE, type CatalogueEntry, catalogueEntry } from "./catalogue";
import { vendorSentence } from "./composio";
import {
  adminConnectOnly,
  adminConnectOnlySentence,
  CLIENT_ID_MAX,
  CLIENT_SECRET_MAX,
  DEPLOYMENT_CLIENT_SLUG_MAX,
  deploymentClientFrom,
  deploymentClientSlug,
  withDeploymentClients,
} from "./deployment-clients";
import { fieldsForPerson, keyGuideFor } from "./key-guides";
import {
  ALWAYS_ON_REFUSAL,
  alwaysOnHere,
  personalRevokeRefusalFor,
} from "./personal-defaults";
import { approveOwnersSharedUse } from "./owner-grants";
import {
  asSharedUseApproval,
  exposureOf,
  type SharedUseApproval,
} from "./shared-use";
import { mountSharedUseRoutes, sharedGrantApproval } from "./shared-use-routes";
import {
  type SharedAudience,
  SharedUseFrameError,
  SharedUseNotSharedError,
  type SharedUseStore,
} from "./shared-use-store";
import {
  authorizationUrlFor,
  type ConnectOrigin,
  challengeFor,
  connectedAccountsUrlFor,
  createVerifier,
  desktopReturnUrlFor,
  readConnectState,
  redeemAuthorizationCode,
  redirectUriFor,
  sealConnectState,
} from "./oauth";
import { personAccount } from "./shared-accounts";
import {
  type AppAccessRequestRecord,
  CatalogueEntryUnknownError,
  CustomServerRefusedError,
  deploymentFaultSentence,
  isDeploymentFault,
  isServerWriteRefusal,
  isUuid,
  type OAuthClient,
  OAuthClientReadError,
  type PluginKind,
  PluginRefusedError,
  type PluginStore,
  type ServerAddress,
} from "./store";

/**
 * Whether the person a consent was started for still has access to this deployment.
 *
 * A seam rather than an import, because these routes have no business knowing what a person is or
 * where the deny list lives — and because the answer has to come from the deployment as it is when
 * the callback lands, not from what was true when the flow started.
 *
 * False for somebody who was removed while they were away at the vendor's consent screen, and false
 * for a user id that names nobody at all. Both are the same refusal: there is no live person for
 * this grant to belong to.
 */
export type ConnectingPersonCheck = (userId: string) => Promise<boolean>;

/**
 * What the Plugins page is told about how an entry is reached: the question it has to ask an
 * administrator, and the words to ask it in.
 *
 * THE PLACED KINDS ARE `deployment-bearer` TO THE PAGE, deliberately. What the page decides from
 * `auth` is whose credential it collects — one an administrator types once for everybody — and for
 * a key that goes into a query parameter, a vendor header or a per-customer address the answer is
 * the same. Where the key sits on the request is the server's business (`placeCredential`), and a
 * browser has no more use for the parameter or header name than for a vendor's OAuth addresses.
 * What does differ is what to call the thing, so the reviewed label and hint travel beside it;
 * neither ever holds a value.
 */
function pageAuth(entry: CatalogueEntry): {
  auth: "none" | "deployment-bearer" | "user-oauth" | "builtin";
  credentialLabel?: string;
  credentialHint?: string;
} {
  const auth = entry.auth;
  switch (auth.kind) {
    case "none":
    case "deployment-bearer":
    case "user-oauth":
    case "builtin":
      return { auth: auth.kind };
    case "deployment-query":
    case "deployment-header":
    case "deployment-address":
      return {
        auth: "deployment-bearer",
        credentialLabel: auth.credentialLabel,
        credentialHint: auth.credentialHint,
      };
    default: {
      const unknown: never = auth;
      throw new Error(
        `Unknown catalogue auth kind ${(unknown as { kind?: unknown }).kind}`,
      );
    }
  }
}

/**
 * What somebody is told when the broker itself failed, and what is deliberately kept out of it.
 *
 * EVERY BROKERED ROUTE NEEDS THIS AND NONE OF THEM USED TO HAVE IT. A listing, a connect, a confirm
 * and a disconnect all end in a call to another company's API, and an unhandled rejection out of any
 * of them is a bare 500 with the vendor's thrown object on this deployment's console. That object is
 * the whole HTTP response — headers, trace ids, rate-limit counters — and the person reading the 500
 * gets none of it and no sentence either. A wrong `COMPOSIO_API_KEY` is the first failure a new
 * operator meets, and it is the one this used to answer worst.
 *
 * `vendorSentence` IS THE SAME ONE THE TRANSPORT USES, for the same reason it exists there: the
 * useful sentence — "Invalid API key", "No connected account found for user …" — is nested two
 * levels inside `cause` beside everything that must not be shown, so this reaches in for that one
 * string and takes nothing else. Null from it is a failure this deployment cannot explain, and the
 * caller's own generic sentence is what a reader gets instead of the vendor's placeholder.
 *
 * NOTHING FROM THE REQUEST OR THE ANSWER TRAVELS WITH IT. Not the API key, which never leaves the
 * adapter; not a connect link, which is a bearer capability handed to one browser; and not the
 * thrown object, whether by spreading it, stringifying it or logging it.
 *
 * 502 RATHER THAN 500, because nothing here broke: this deployment asked a third party and the third
 * party did not answer usefully, which is the same reading the dynamic-registration failure below
 * already gives.
 *
 * `./broker`'s `BrokerRefusalError` IS THE EXCEPTION, AND IT IS A WIDER ONE THAN IT WAS. It used to
 * be the one no-key state; it is now every refusal the broker layer AUTHORED — no key, an app whose
 * authorization config this deployment never created or cannot use, a consent the vendor answered
 * with nowhere to send anybody, a catalogue too large to be sure of. All of them share the property
 * that made the first one special: Composio answered, this deployment decided, and the sentence
 * already names the step that fixes it. So the message is passed through and the status stays 503,
 * which reads correctly for every one of them — the brokered surface is unavailable for this app
 * until somebody changes something here, rather than unavailable because a third party is down. The
 * generic sentence below is for failures this deployment genuinely cannot explain, and answering one
 * of these with it would tell an administrator to check a key that is fine.
 */
function brokerRefusal(
  error: unknown,
  generic: string,
): { error: string; status: 502 | 503 } {
  const authored = brokerSentence(error);
  if (authored) return { error: authored, status: 503 };
  return { error: vendorSentence(error) ?? generic, status: 502 };
}

/**
 * The broker's name, in whatever case a sentence spells it.
 *
 * A person connects their work apps through 熊宝 and is never told which company sits behind it
 * (upstream #1223). Most of the broker layer's sentences were written for an operator who can open
 * that company's dashboard, so they name it. Case-insensitive, so `composio://linear` is caught as
 * well as "Composio"; `COMPOSIO_API_KEY` is left alone by the word boundary (the underscore is part
 * of the word), because that is the setting an admin sets and naming it is how a person knows what
 * to ask for.
 */
// X5：Arcade 与 Composio 一样不在成员看到的句子里点名（#1223）。
const NAMES_THE_BROKER = /\b(composio|arcade)\b/i;
const NAMES_THE_BROKER_EVERYWHERE = /\b(composio|arcade)\b/gi;

/**
 * A refusal the STORE wrote for the person, with only the broker's name taken out.
 *
 * The store's sentences say what is now true (an account left standing and recorded as unchecked, a
 * key the app rejected, a check that wrote a new verdict), and that is what the person needs to act
 * on. Swapping the whole sentence for a route's generic one told somebody whose account was in fact
 * made that it was not (review M-7), so here the facts stay and the name goes.
 */
export function withoutBrokerName(sentence: string): string {
  return sentence.replace(
    NAMES_THE_BROKER_EVERYWHERE,
    "the connection service",
  );
}

/**
 * A broker-layer refusal a person reads, kept free of the broker's name.
 *
 * Those sentences were written for the operator, and their remedy is somewhere a person cannot go
 * (a dashboard, a setting), so the person gets the route's own sentence instead, which says what
 * failed and who to ask. The status is unchanged: only the words differ.
 *
 * NOTHING OF THE ORIGINAL SENTENCE IS LOGGED (review M-8). On the key flow it can carry the vendor's
 * own words about what was typed, so the log line says only that a sentence was kept back, on which
 * route, about which app; the operator reproduces the failure from there.
 */
export function forPerson(
  sentence: string,
  generic: string,
  where: { route: string; toolkit?: string } = { route: "unknown" },
): string {
  if (!NAMES_THE_BROKER.test(sentence)) return sentence;
  console.error(
    JSON.stringify({
      type: "broker-sentence-kept-from-person",
      route: where.route,
      ...(where.toolkit ? { toolkit: where.toolkit } : {}),
    }),
  );
  return generic;
}

/** {@link brokerRefusal} for a route a person calls: see {@link forPerson}. */
function personRefusal(
  error: unknown,
  generic: string,
  where?: { route: string; toolkit?: string },
): { error: string; status: 502 | 503 } {
  const refusal = brokerRefusal(error, generic);
  return { ...refusal, error: forPerson(refusal.error, generic, where) };
}

/**
 * What a person is told on a route they call when this deployment has no broker at all.
 *
 * {@link BrokerUnconfiguredError}'s own message is written for an operator and names the provider;
 * a person reads this instead. It still names the setting, because that is what they ask an admin
 * to set. The admin directory keeps the operator's sentence.
 */
const PERSON_UNCONFIGURED =
  "这个部署还没有设置好连接应用（需要管理员设置 COMPOSIO_API_KEY），所以什么也没有问。请联系管理员。";

/**
 * What a reader is told when Composio would not answer with its directory.
 *
 * One constant because two routes make that call — browsing the catalogue and enabling an app out of
 * it — and a reader meeting the same failure through two doors should not meet two sentences. It
 * names the setting rather than quoting it: a key that was pasted with a space in it, or one for
 * another project, is the likeliest reason Composio will not talk to this deployment at all.
 */
const DIRECTORY_UNAVAILABLE =
  "Composio would not answer with its app directory, and said nothing about why. Check that COMPOSIO_API_KEY is this project's key, and check Composio's status if it persists.";

/**
 * The catalogue entry the server at an address instantiates.
 *
 * READ OFF THE ROW, NEVER OFF THE ADDRESS. Since G01-E a curated row is called `team:<key>`, which
 * is the id the server list hands the browser, and no catalogue entry is spelled that way: looked up
 * by the address, `team:notion` named nothing and its connect was refused as "not connected as an
 * individual person". The row's `catalogue_key` is the entry, its own id where it has none — the
 * rule the store reads entries by everywhere. With no row, the address is all there is to ask about,
 * which keeps "a catalogue vendor nobody has added" reaching the refusal written for it.
 */
function catalogueEntryAt(
  row: ServerAddress | undefined,
  address: string,
): CatalogueEntry | null {
  return catalogueEntry(row ? (row.catalogueKey ?? row.id) : address);
}

/**
 * The Plugins surface: what this deployment has added, and which Bots may use it.
 *
 * What a Bot can reach is an administrator's; what it is told is not. Adding an MCP server stores a
 * credential and opens a path into another company's system, and enabling one on a Bot is the same
 * decision one step later, so both are an administrator's. A skill only ever asks for tools the Bot
 * already holds, and every one of those calls is still decided, policy-checked and audited, so
 * anybody may write one for themselves and put it on a Bot they own.
 *
 * Reading is open to any signed-in person either way: what a Bot can reach is not a secret from the
 * person talking to it.
 *
 * The call endpoint asks again. The list of tools a run was offered is a snapshot taken when the run
 * started, so a grant revoked a second later is still in the model's hands. Deciding at call time is
 * what makes revocation immediate rather than nearly immediate, and it is where a refusal becomes a
 * row somebody can read.
 */
export function createPluginRoutes(
  store: PluginStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /**
   * Whether the caller may act as the Bot they named. Required rather than optional, so a deployment
   * cannot end up calling somebody else's tools by leaving an argument off.
   */
  canUseBot: BotAccessCheck,
  /**
   * What the connect flow needs that the store does not hold: the key its state is sealed with, the
   * address a vendor sends people back to, and who still has access when they come back.
   *
   * Optional, so a deployment with no public URL configured simply cannot start a connect flow and
   * says so, rather than building a redirect URI out of a request header and failing at the vendor.
   *
   * Last, and after every required parameter, because that is the only position an optional argument
   * can hold. Both of these arrived on separate branches as "one more parameter", which is how a
   * positional list becomes a trap: every argument from here on is optional, so a misplaced one
   * typechecks and simply does nothing.
   */
  connect?: {
    encryptionKey: string;
    /**
     * Whether the person a state names may still connect an account here.
     *
     * Required rather than optional, unlike everything else that arrived on this object as "one more
     * parameter". The callback is sessionless on purpose, so this is the ONLY thing asking whether
     * the identity in the state is still one this deployment recognises — and a deployment that
     * forgot to pass it would complete a consent for somebody who was removed ten minutes ago and
     * write a live refresh token nothing will ever revoke.
     */
    personHasAccess: ConnectingPersonCheck;
    /**
     * Whether this deployment holds a shared secret a Bot may present when calling a tool back.
     *
     * A boolean about configuration, never the secret. Without it, a Bot can only call back if it
     * holds a credential issued to it alone, and a Bot with neither is refused before the call ever
     * reaches the grant, the boundary or the trail. The Bots screen needs this to stop promising a
     * grant the deployment cannot honour.
     */
    botsMayCallBack?: boolean;
    publicUrl: string | undefined;
    /**
     * Where the app is, which is not where this API is.
     *
     * The callback lands here and has to send the person back to a page. A relative redirect would
     * put them on this server's origin, which locally is a Vite-less port that serves no pages at
     * all — so the flow would complete correctly and end on a 404.
     */
    appUrl: string | undefined;
  },
  /**
   * The broker this deployment talks to when an app is connected for somebody rather than
   * registered by an administrator.
   *
   * Its own parameter rather than a field on `connect`, because nothing on that object applies
   * here. `connect` is the OAuth consent flow this deployment runs itself: the key its state is
   * sealed with, the redirect URI a vendor sends people back to, the access check the sessionless
   * callback asks. A brokered app uses none of it — the vendor holds the consent, so there is no
   * state to seal, no callback to land here and no redirect URI to publish. Folding it in would put
   * a field on an object whose every other field is about a flow it never enters.
   *
   * Optional, and last for the same reason `connect` is: a deployment with no Composio API key
   * configured simply has no broker, and the surface says so rather than pretending one exists. The
   * trap `connect` documents applies here with one more argument in it — every parameter from that
   * position on is optional, so a misplaced one typechecks and quietly does nothing.
   */
  composio?: {
    broker: ComposioBroker;
    guides?: KeyGuideSource;
    /**
     * 活动的提供商（X5）。不给时是 Composio。Arcade 时 `arcade` 是它的 broker：连接走带发起人绑定的
     * 授权尝试与回程验证（`./arcade-routes`），而不是 Composio 的确认。
     */
    provider?: BrokerProvider;
    arcade?: ArcadeBroker;
    /** 共享使用批准（X3，`./shared-use-store`）。没给时共享使用路由不挂，团队账号照样一律拒绝。 */
    sharedUse?: { store: SharedUseStore; audience: SharedAudience };
  },
  /**
   * `createAdminScope(...)`: its `adminCapability` is mounted on the grant routes (G01-E P8b) and on
   * every route that writes the deployment's servers, their OAuth clients and their secrets (P10):
   * those are `team` rows, and row security admits the write only for an administrator holding the
   * capability, so without it the write is refused: fail closed, never wider. `adminActAsOwner` and
   * `asAdminPlatform` are how an administrator's grant on somebody else's Bot runs in that Bot's
   * owner's frame (I6).
   */
  adminScope?: Pick<
    AdminScope,
    "adminCapability" | "adminActAsOwner" | "asAdminPlatform"
  >,
  /** 应用账号模式的切换（X1，`./account-mode`）。没给时账号模式路由答 503。 */
  accountModes?: AccountModeSwitch,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  /** broker 应用的 url 说的是哪个应用，按活动提供商的解析器（X5；Composio 时与以前一样）。 */
  const toolkitOf = (url: string) =>
    toolkitOfFor(composio?.provider ?? "composio", url);
  const sharedUse = composio?.sharedUse;
  const adminCapability = adminScope?.adminCapability;
  const signedInWithCapability: MiddlewareHandler<{
    Variables: AppVariables;
  }> = (context, next) =>
    requireUser(context, async () => {
      await (adminCapability ?? ((_context, inner) => inner()))(context, next);
    });
  /**
   * The same, for the routes that write the deployment's servers, their OAuth clients and their
   * secrets (G01-E P10). A member passes through it unchanged, and the handler decides as before.
   */
  const capable = signedInWithCapability;

  const actorEmail = (context: { var: AppVariables }) =>
    context.var.actor?.email ?? "unknown";

  const skillActor = (context: { var: AppVariables }) => ({
    id: context.var.actor.id,
    isAdmin: context.var.actor.role === "admin",
  });

  /**
   * May this person write, edit or delete this skill?
   *
   * An administrator may touch anything. Everybody else may touch their own and nothing else, which
   * includes not editing a deployment skill an administrator wrote for everyone.
   */
  async function skillRefusal(
    context: { var: AppVariables },
    slug: string,
  ): Promise<string | null> {
    const actor = skillActor(context);
    if (actor.isAdmin) return null;
    const owner = await store.skillOwner(slug);
    if (owner === undefined) return null; // A new skill. Ownership is decided on the way in.
    if (owner === null) {
      return `${slug} belongs to this deployment. An administrator looks after it.`;
    }
    return owner === actor.id ? null : `${slug} is somebody else's skill.`;
  }

  /** Everything the Plugins page draws: the catalogue, what is added, and the skills. */
  routes.get("/", capable, async (context) =>
    context.json({
      catalogue: CATALOGUE.map((entry) => ({
        key: entry.key,
        title: entry.title,
        vendor: entry.vendor,
        summary: entry.summary,
        docsUrl: entry.docsUrl,
        /*
         * The kind, not the whole thing. The page needs to know what to ask an administrator for;
         * it has no use for the vendor's OAuth addresses, and a URL this deployment sends an
         * authorization code to is not improved by also existing in every browser that opens the
         * Plugins page.
         */
        ...pageAuth(entry),
        perInstance: entry.host === null,
        /*
         * 连接之前不用先填任何东西（上游的 `oneStep`）：不需要账号，或 OAuth 客户端由这个部署自己注册。
         * 个人版的连接页只列这些。按条目自己的认证方式判断，不看 `pageAuth` 归并后的名字：要管理员先
         * 存一份密钥的几种（query、header、address）在页面上都叫 deployment-bearer，没有一种是一步。
         */
        oneStep:
          entry.host !== null &&
          (entry.auth.kind === "none" ||
            entry.auth.kind === "builtin" ||
            (entry.auth.kind === "user-oauth" &&
              entry.auth.clientRegistration === "dynamic")),
      })),
      /*
       * Whether a Bot with no credential of its own can still call a tool back.
       *
       * The grant switch decides whether a tool is offered to a model; this decides whether any
       * call it makes can be authenticated at all. They are different questions and the screen used
       * to answer only the first, so a grant could read "May call this tool" on a deployment where
       * every call was refused before it reached the boundary.
       */
      botsMayCallBack: connect?.botsMayCallBack === true,
      /*
       * Whether this deployment has a broker at all, so the page knows whether brokered apps are
       * on offer.
       *
       * A boolean about configuration, never the key. The API key that builds the broker is a
       * deployment credential and the Plugins page is reachable by any signed-in person; what the
       * screen needs is whether to draw the app directory, which is a yes or a no.
       */
      composioConfigured: Boolean(composio),
      /*
       * broker 是不是逐个动作授权（上游的 `authorizesPerAction`）。这里恒为 false，即使活动的 broker 声明了
       * 授权流程（Arcade 的 `authorizations`）：页面按这个字段画逐个动作的授权列表，列表背后是
       * `GET /servers/:id/grants` 和 `POST /servers/:id/authorize` 两条路由，fork 没有并入它们。答 true 会
       * 画出一排每按一次都失败的按钮。fork 的 Arcade 连接是整个应用一次授权（`./arcade-routes`），页面按
       * 普通的「连接」画就对。并入那两条路由时，这里改回上游的 `Boolean(broker.authorizations)`。
       */
      authorizesPerAction: false,
      /*
       * 这个部署的连接应用由哪一家提供（上游的 `provider`），是个名字，不是密钥，也不是能力。页面上写出
       * 厂商名字的地方（「浏览 Composio」、密钥是哪一项设置）从一行应用上推不出来，只有它能回答；按是不是
       * 连接应用来筛选的地方不需要它。没有接 broker 时答 composio，那样的部署和以前画得一样。和下面按地址
       * 认应用的解析器（`toolkitOf`）读的是同一个值，所以页面显示的名字和路由用的解析器不会分开。
       */
      provider: composio?.provider ?? "composio",
      /*
       * `canConnect` 是针对这次请求者的判断：只有管理员能连接的应用（`adminConnectOnly`），成员看到
       * false，其余为 true。前端照它渲染「连接」，不用自己拿角色去拼。连接路由和 store 照旧各自拒绝，
       * 这个字段只是把同一条规则提前告诉页面。
       */
      /*
       * 团队账号是哪位管理员连接的（`sharedAccount.connectedBy`）只告诉持有能力的管理员，和
       * `GET /connections?shared=1` 里团队账号那一行同一条规则；其余的人拿到 null，连没连上照样看得到。
       * 所以这条路由挂在带能力的入口上：成员原样通过，管理员的角色在这里重新读过。
       */
      servers: (await store.listServers()).map((server) => ({
        ...server,
        ...(server.sharedAccount && decisionRefusal(context) !== null
          ? { sharedAccount: { ...server.sharedAccount, connectedBy: null } }
          : {}),
        // 和连接路由同一个判断：持有能力的管理员。会话里还写着 admin、角色已被收回的人按成员答。
        canConnect:
          decisionRefusal(context) === null ||
          (!server.adminConnectOnly && server.accountMode !== "shared"),
      })),
      // Scoped: the deployment's skills plus this person's own. An administrator sees them all.
      skills: await store.listSkills(skillActor(context)),
      /*
       * What an administrator has to register with the vendor, character for character.
       *
       * Served rather than assembled in the browser, so what is displayed is exactly what the
       * callback will present. A mismatch here fails at the vendor with a message that does not name
       * us, which is a bad afternoon for whoever is setting it up.
       *
       * Null means this deployment has no public URL, so it cannot complete a consent flow at all.
       */
      redirectUri: connect?.publicUrl
        ? redirectUriFor(connect.publicUrl)
        : null,
    }),
  );

  /** Add a curated server. The URL comes from the catalogue, never from the request. */
  routes.post("/servers", capable, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const body = (await context.req.json().catch(() => null)) as {
      key?: unknown;
      instanceHost?: unknown;
      credentialId?: unknown;
    } | null;
    const key = typeof body?.key === "string" ? body.key.trim() : "";
    if (!key) {
      return context.json({ error: "A catalogue key is required." }, 400);
    }
    // Optional fields travel to `input.credentialId?.trim()` in the store, where a number or
    // object throws a TypeError that escapes as a 500. A string that is only whitespace would
    // silently become `undefined` there, so it is refused here instead of being coerced.
    if (
      body?.instanceHost !== undefined &&
      (typeof body.instanceHost !== "string" || !body.instanceHost.trim())
    ) {
      return context.json(
        { error: "An instance host must be a non-empty string." },
        400,
      );
    }
    if (
      body?.credentialId !== undefined &&
      (typeof body.credentialId !== "string" || !body.credentialId.trim())
    ) {
      return context.json(
        { error: "A credential id must be a non-empty string." },
        400,
      );
    }

    try {
      const server = await store.addServer({
        key,
        instanceHost:
          typeof body?.instanceHost === "string"
            ? body.instanceHost.trim()
            : undefined,
        credentialId:
          typeof body?.credentialId === "string"
            ? body.credentialId.trim()
            : undefined,
        by: actorEmail(context),
      });
      return context.json({ server });
    } catch (error) {
      // 这次请求没有管理员能力：store 在动手之前就拒绝了。是「谁在问」的拒绝，所以答 403。
      if (isServerWriteRefusal(error))
        return context.json({ error: CAPABILITY_UNCONFIRMED }, 403);
      // A refused credential is the administrator's mistake to correct, so it comes back as a
      // refusal with its reason rather than as a 500 the way an unmapped throw would.
      if (
        error instanceof CatalogueEntryUnknownError ||
        error instanceof CustomServerRefusedError
      ) {
        return context.json({ error: error.message }, 400);
      }
      /*
       * The same mapping the refresh route makes, on the routes that call the same method.
       *
       * CRITERION. Every admin route whose store call can reach a fault on the
       * `isDeploymentFault` shelf answers with the sentence rather than leaving it to the default
       * handler.
       *
       * REASON. Adding a server REFRESHES it before answering — deliberately, so a bad credential
       * is reported now rather than the first time a Bot uses it — so every fault `refreshTools`
       * raises arrives here too, and a vendor listing one action twice or a query of ours failing
       * is exactly that. Mapped on one route and not on its siblings, the same fault is a named
       * sentence or "That did not work" depending on which button was pressed, which is the shape
       * that made this class hard to see the first time.
       */
      if (isDeploymentFault(error)) {
        return context.json({ error: deploymentFaultSentence(error) }, 409);
      }
      throw error;
    }
  });

  /**
   * Add a server by URL.
   *
   * Its own endpoint rather than a flag on the one above, so that "an administrator pointed this
   * deployment at an address of their own" is a distinct act in the code, in the audit trail and in
   * anything that reads either.
   */
  routes.post("/servers/custom", capable, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const body = (await context.req.json().catch(() => null)) as {
      id?: unknown;
      title?: unknown;
      url?: unknown;
      credentialId?: unknown;
      entraScope?: unknown;
    } | null;
    if (
      typeof body?.id !== "string" ||
      !body.id.trim() ||
      typeof body?.title !== "string" ||
      !body.title.trim() ||
      typeof body?.url !== "string" ||
      !body.url.trim()
    ) {
      return context.json(
        { error: "A name, a title and a URL are required." },
        400,
      );
    }
    // `addCustomServer` dereferences `input.credentialId?.trim()`, so a number or object here
    // throws a TypeError that escapes as a 500 instead of a 400.
    if (
      body.credentialId !== undefined &&
      (typeof body.credentialId !== "string" || !body.credentialId.trim())
    ) {
      return context.json(
        { error: "A credential id must be a non-empty string." },
        400,
      );
    }
    /*
     * Marks the server as reached as the signed-in person through Microsoft, with this scope
     * (上游 #931). Null puts it back on the deployment's credential; absent leaves it as it is.
     */
    if (
      body.entraScope !== undefined &&
      body.entraScope !== null &&
      (typeof body.entraScope !== "string" || !body.entraScope.trim())
    ) {
      return context.json(
        {
          error:
            "Entra scope 必须是非空字符串；传 null 表示不再以登录人的身份访问这个服务器。",
        },
        400,
      );
    }

    try {
      const server = await store.addCustomServer({
        id: body.id.trim(),
        title: body.title.trim(),
        url: body.url.trim(),
        credentialId:
          typeof body.credentialId === "string"
            ? body.credentialId.trim()
            : undefined,
        entraScope:
          typeof body.entraScope === "string"
            ? body.entraScope.trim()
            : body.entraScope === null
              ? null
              : undefined,
        by: actorEmail(context),
        actorId: context.var.actor.id,
      });
      return context.json({ server });
    } catch (error) {
      // 这次请求没有管理员能力：store 在动手之前就拒绝了。是「谁在问」的拒绝，所以答 403。
      if (isServerWriteRefusal(error))
        return context.json({ error: CAPABILITY_UNCONFIRMED }, 403);
      if (
        error instanceof CustomServerRefusedError ||
        error instanceof CatalogueEntryUnknownError
      ) {
        return context.json({ error: error.message }, 400);
      }
      // As on the curated add above, and for the same reason: this path refreshes before it
      // answers.
      if (isDeploymentFault(error)) {
        return context.json({ error: deploymentFaultSentence(error) }, 409);
      }
      throw error;
    }
  });

  /**
   * Replace the deployment token of a server that is already added, and point the server at it.
   *
   * Its own endpoint rather than `POST /api/admin/credentials` followed by a re-add, because those
   * are two requests and the first revokes the token the server is using: a failure between them
   * left the server on a revoked credential. The store writes both in one transaction — see
   * `replaceServerToken`. Nothing else about the server is taken from the request.
   */
  routes.post("/servers/:id/token", capable, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const body = (await context.req.json().catch(() => null)) as {
      token?: unknown;
    } | null;
    if (typeof body?.token !== "string" || !body.token.trim()) {
      return context.json({ error: "A token is required." }, 400);
    }

    try {
      const server = await store.replaceServerToken({
        serverId: context.req.param("id"),
        token: body.token,
        by: actorEmail(context),
      });
      return context.json({ server });
    } catch (error) {
      // 这次请求没有管理员能力：store 在动手之前就拒绝了。是「谁在问」的拒绝，所以答 403。
      if (isServerWriteRefusal(error))
        return context.json({ error: CAPABILITY_UNCONFIRMED }, 403);
      if (
        error instanceof CatalogueEntryUnknownError ||
        error instanceof CustomServerRefusedError
      ) {
        return context.json({ error: error.message }, 400);
      }
      // As on the add routes: this refreshes before it answers, over a row that now holds the token.
      if (isDeploymentFault(error)) {
        return context.json({ error: deploymentFaultSentence(error) }, 409);
      }
      throw error;
    }
  });

  /**
   * Register this deployment's OAuth client for a server reached as the person asking.
   *
   * Its own endpoint rather than a field on `POST /servers`, because it is a separate act with a
   * separate lifetime: a client is rotated without the server being re-added, and re-adding a server
   * should not require re-typing a client. An administrator's, like everything else that decides what
   * a Bot can reach.
   */
  routes.post("/servers/:id/oauth-client", capable, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const body = (await context.req.json().catch(() => null)) as {
      clientId?: unknown;
      clientSecret?: unknown;
    } | null;
    /*
     * `typeof` before `.trim()`, as `POST /servers` and `/servers/custom` do: the body is JSON, so
     * `{"clientId": 12345}` or a secret of `{}` used to reach `.trim()` here, outside the try, and
     * answer 500 for what is a person's malformed request.
     */
    if (
      typeof body?.clientId !== "string" ||
      typeof body.clientSecret !== "string" ||
      !body.clientId.trim() ||
      !body.clientSecret.trim()
    ) {
      return context.json(
        { error: "A client id and a client secret are both required." },
        400,
      );
    }

    try {
      await store.registerOAuthClient({
        serverId: context.req.param("id"),
        client: {
          clientId: body.clientId.trim(),
          clientSecret: body.clientSecret.trim(),
        },
        by: actorEmail(context),
      });
      return context.json({ ok: true });
    } catch (error) {
      // 这次请求没有管理员能力：store 在动手之前就拒绝了。是「谁在问」的拒绝，所以答 403。
      if (isServerWriteRefusal(error))
        return context.json({ error: CAPABILITY_UNCONFIRMED }, 403);
      if (
        error instanceof CatalogueEntryUnknownError ||
        error instanceof CustomServerRefusedError
      ) {
        return context.json({ error: error.message }, 400);
      }
      // Registering a client resolves the row first, so a row this deployment cannot say how to
      // reach refuses here as well.
      if (isDeploymentFault(error)) {
        return context.json({ error: deploymentFaultSentence(error) }, 409);
      }
      throw error;
    }
  });

  /**
   * Take a server away, and answer for a removal that did not finish.
   *
   * CRITERION. The same one the add routes above state, on the route that needed it most: every
   * refusal `removeServer` can raise comes back as a body naming what was left standing, rather
   * than reaching the framework's default handler.
   *
   * REASON. THIS MAPPED NOTHING AT ALL, and what it calls is the loudest method in the store.
   * `removeServer` withdraws every person's brokered account at Composio and drops this
   * deployment's auth configs BEFORE it deletes the row, deliberately — the argument is made
   * there, and it ends "WHICH MAKES THE FAILURE LOUD. Nothing is caught around the revokes". The
   * refusals it raises are written for exactly this reader: how many of this deployment's configs
   * went and how many are still standing, or a config row Composio described with no id and no
   * name. All of it reached Hono's default handler, which answers a bodyless 500, so an
   * administrator who had just half-withdrawn an app from everybody was told nothing whatever —
   * on the one act in this file whose half-done state somebody has to go and finish by hand.
   * `PluginInvariantError` out of `accessFor` arrived the same way, and it is the one that names
   * which of this deployment's own rows is wrong.
   *
   * THE SHELF FIRST, THEN THE BROKER, which is the order the enable route below pins and for its
   * reason: a contradiction between two of this deployment's columns is not Composio being down,
   * and answering it through the broker mapping would send an operator to check a key that is
   * fine. This route is `requireAdmin`, which is what makes showing that sentence here safe.
   *
   * AND THE GENERIC SENTENCE BLAMES NEITHER SIDE. Half of what this call path does is local — the
   * vault revokes, the trail writes, the deletes — and half of it is the broker, so a failure that
   * neither `brokerSentence` nor `vendorSentence` put words to is one where which half failed is
   * precisely what nobody said. What a reader needs is the button, and the store's own order is
   * what makes pressing it safe: nothing here is deleted until the withdrawals have been asked
   * for, so a second press asks only for what is left.
   */
  routes.delete("/servers/:id", capable, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const serverId = context.req.param("id");
    // 个人版的 Routines 一直开着（见 `./personal-defaults`）；团队版里它和别的应用一样可以关。
    if (alwaysOnHere(serverId))
      return context.json({ error: ALWAYS_ON_REFUSAL }, 403);
    try {
      await store.removeServer(serverId, actorEmail(context));
    } catch (error) {
      // 这次请求没有管理员能力：store 在动手之前就拒绝了。是「谁在问」的拒绝，所以答 403。
      if (isServerWriteRefusal(error))
        return context.json({ error: CAPABILITY_UNCONFIRMED }, 403);
      if (isDeploymentFault(error)) {
        return context.json({ error: deploymentFaultSentence(error) }, 409);
      }
      // Without the capability (a role removed since sign-in): refused before anything was touched.
      if (error instanceof CustomServerRefusedError) {
        return context.json({ error: error.message }, 403);
      }
      /*
       * WHAT THE MAPPING COST, PUT BACK, exactly as the enable route below does it. An unhandled
       * throw was a bad answer and a good log: the administrator got nothing, but the stack was
       * printed where an operator could find it. Catching everything fixes the answer and would
       * silence that, and the failure that needs the log most is the one left here — neither a
       * refusal this deployment authored, which `brokerSentence` names, nor a sentence Composio
       * wrote, which `vendorSentence` reaches for. The row, because it is the app an operator is
       * about to be asked about, and the error read through {@link reasonWithoutStatement}, never
       * spread, logged as an object or reached into.
       *
       * AND THAT DOOR RATHER THAN `String(error)`, BECAUSE THE TWO SENTENCE TESTS ARE NOT A GUARD
       * AGAINST THIS. A `DrizzleQueryError` has neither a broker sentence nor a vendor one, so it
       * lands in exactly this branch — which is what removing a server raises when a delete fails
       * mid-way — and its own message is the statement plus every value bound to it.
       */
      if (brokerSentence(error) === null && vendorSentence(error) === null) {
        console.error(
          JSON.stringify({
            type: "mcp-server-not-removed",
            server: serverId,
            note: "Removing a server failed for a reason neither this deployment nor Composio put a sentence to. The administrator was answered 502 with the generic sentence, and the server row is still there.",
            error: reasonWithoutStatement(error),
          }),
        );
      }

      const refusal = brokerRefusal(
        error,
        "Removing this app did not finish, and neither this deployment nor Composio said why, so the app is still here rather than gone with grants of its own left live at the vendor. Press Remove again: every account is withdrawn at Composio before anything here is deleted, so repeating it is safe and asks only for what is left. Check this deployment's Composio key if it persists.",
      );
      return context.json({ error: refusal.error }, refusal.status);
    }
    return context.json({ ok: true });
  });

  /** Ask a server what it offers now. Reported rather than thrown, so the page can say what broke. */
  routes.post("/servers/:id/refresh", capable, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    try {
      const result = await store.refreshTools(
        context.req.param("id"),
        context.var.actor.id,
      );
      const servers = await store.listServers();
      return context.json({
        tools: result.tools,
        server: servers.find((server) => server.id === context.req.param("id")),
      });
    } catch (error) {
      // 这次请求没有管理员能力：store 在动手之前就拒绝了。是「谁在问」的拒绝，所以答 403。
      if (isServerWriteRefusal(error))
        return context.json({ error: CAPABILITY_UNCONFIRMED }, 403);
      if (error instanceof CatalogueEntryUnknownError) {
        return context.json({ error: error.message }, 404);
      }
      // Without the capability (a role removed since sign-in): the servers are `team` rows (P10).
      if (error instanceof CustomServerRefusedError) {
        return context.json({ error: error.message }, 403);
      }
      /*
       * The one audience the sentence was written for, and the only route that may show it.
       *
       * CRITERION. A contradiction between this deployment's own columns comes back to an
       * administrator as itself: a body, naming the row and what to do about it.
       *
       * REASON. Unmapped, it reached the framework's default handler — a 500 with no JSON at all,
       * which the admin page reads as "That did not work", the fallback it uses when a response
       * carries no message. So the one refusal that names exactly which row is wrong and how to
       * correct it was the one an operator could not see, while the same sentence WAS reaching a
       * model on the tool-call path. This route is `requireAdmin`, which is what makes showing it
       * here safe and showing it anywhere else not.
       *
       * 409 rather than 500: nothing broke, and nothing about the request was malformed. Two rows
       * of ours disagree, and the request cannot be answered until one of them changes — which is
       * what the sentence tells the reader to go and do.
       */
      if (isDeploymentFault(error)) {
        // `deploymentFaultSentence` rather than `error.message`: the shelf now includes a query
        // this database refused, and that one's message is the statement and every value bound to
        // it. An administrator is entitled to the reason, not to the dump.
        return context.json({ error: deploymentFaultSentence(error) }, 409);
      }
      throw error;
    }
  });

  /**
   * Which brokered apps this deployment holds its own OAuth client for (upstream #950), as a set of
   * app names for `withDeploymentClients`. A vault that cannot be read leaves every such app as it
   * was without one, `unsupported`, rather than failing the directory: nothing is offered that the
   * enable below could not then carry out.
   */
  const heldClients = async (): Promise<ReadonlySet<string>> => {
    try {
      return await store.deploymentClientToolkits();
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "composio-deployment-clients-unreadable",
          error: error instanceof Error ? error.name : "UnknownError",
        }),
      );
      return new Set();
    }
  };

  /** What the client routes answer an administrator whose request holds no capability (M-2). */
  const CLIENTS_NEED_CAPABILITY =
    "保存、查看或删除部署自己的应用客户端，需要以管理员身份在管理页面操作。";
  const BAD_CLIENT_SLUG = `应用名只能包含字母、数字、下划线和连字符，最长 ${DEPLOYMENT_CLIENT_SLUG_MAX} 个字符。`;

  /**
   * The OAuth clients this deployment holds for brokered apps that connect with a server-to-server
   * grant (upstream #950; Shopify is one). Administrator only. The id and when it was stored come
   * back; the secret never does, from this route or any other.
   */
  routes.get("/composio/clients", capable, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;
    try {
      return context.json({ clients: await store.listDeploymentClients() });
    } catch (error) {
      if (isServerWriteRefusal(error)) {
        return context.json({ error: CLIENTS_NEED_CAPABILITY }, 403);
      }
      if (isDeploymentFault(error)) {
        return context.json({ error: deploymentFaultSentence(error) }, 409);
      }
      throw error;
    }
  });

  /**
   * Store this deployment's own OAuth client for one brokered app, into the vault. Body:
   * `{ "client_id": "...", "client_secret": "..." }`, both required. Administrator only.
   */
  routes.put("/composio/clients/:slug", capable, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;
    if (composio?.arcade) {
      return context.json(
        {
          error:
            "当前的连接应用提供商是 Arcade。部署自己的 OAuth 客户端只适用于 Composio，Arcade 的客户端在 Arcade 后台配置。",
        },
        409,
      );
    }
    const toolkit = deploymentClientSlug(context.req.param("slug"));
    if (!toolkit) return context.json({ error: BAD_CLIENT_SLUG }, 400);
    const client = deploymentClientFrom(
      await context.req.json().catch(() => null),
    );
    if (!client) {
      return context.json(
        {
          error: `客户端 ID 和客户端密钥都要填写，ID 不超过 ${CLIENT_ID_MAX} 个字符、密钥不超过 ${CLIENT_SECRET_MAX} 个字符，且不能包含控制字符。`,
        },
        400,
      );
    }
    try {
      const { replaced } = await store.storeDeploymentClient({
        toolkit,
        client,
        by: actorEmail(context),
      });
      return context.json({ toolkit, clientId: client.client_id, replaced });
    } catch (error) {
      if (isServerWriteRefusal(error)) {
        return context.json({ error: CLIENTS_NEED_CAPABILITY }, 403);
      }
      if (error instanceof CustomServerRefusedError) {
        return context.json({ error: error.message }, 400);
      }
      if (isDeploymentFault(error)) {
        return context.json({ error: deploymentFaultSentence(error) }, 409);
      }
      throw error;
    }
  });

  /** Retire this deployment's own OAuth client for one brokered app. Administrator only. */
  routes.delete("/composio/clients/:slug", capable, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;
    const toolkit = deploymentClientSlug(context.req.param("slug"));
    if (!toolkit) return context.json({ error: BAD_CLIENT_SLUG }, 400);
    try {
      const removed = await store.removeDeploymentClient({
        toolkit,
        by: actorEmail(context),
      });
      return context.json({
        ...removed,
        ...(removed.stillInUseByEnabledApp
          ? {
              note: `删除只影响以后的启用：已经启用的 ${toolkit} 仍在用这个客户端。要停用它，请移除这个应用，并在 ${toolkit} 后台轮换客户端密钥。`,
            }
          : {}),
      });
    } catch (error) {
      if (isServerWriteRefusal(error)) {
        return context.json({ error: CLIENTS_NEED_CAPABILITY }, 403);
      }
      if (error instanceof CustomServerRefusedError) {
        return context.json({ error: error.message }, 400);
      }
      if (isDeploymentFault(error)) {
        return context.json({ error: deploymentFaultSentence(error) }, 409);
      }
      throw error;
    }
  });

  /**
   * The broker's catalogue, as an administrator chooses an app out of it.
   *
   * THE SEARCH IS OURS, AND HAS TO BE. `@composio/core`'s toolkit listing forwards category,
   * managed_by, sort_by, cursor and limit, and takes no search term at all — a term handed to it is
   * dropped without a word, and what comes back is an unfiltered first page that looks exactly like
   * a result. So the whole directory is read and filtered in this process, over the three fields an
   * administrator would actually be typing at: the slug, the name and the description. A few
   * hundred rows is a list, not a query.
   *
   * NO BROKER IS A 503 NAMING THE SETTING, not an empty list. An empty directory and an absent one
   * are different facts: the first says Composio has nothing to offer, the second says nobody was
   * asked. Answered as `{ apps: [] }`, a deployment with no key draws "no apps available" over a
   * remedy that is one environment variable long, which is why
   * {@link BrokerUnconfiguredError}'s own message is what is sent rather than a sentence written
   * here.
   *
   * `enabled` comes off `toolkitOf(url)` and never off the row's id. The url is where the
   * transport reads which app a call is against, so it is the only reading that decides anything;
   * the id names the row — `composio-linear` — and reading one as the other would quietly work
   * until somebody renamed a row. `serverUrls` hands over the urls and nothing else, which is that
   * property made structural: there is no id here to read by mistake.
   */
  routes.get("/composio/apps", capable, async (context) => {
    /*
     * INSIDE THE HANDLER, and the response returned. `requireAdmin` is a function that answers a
     * response, not Hono middleware: put in the middleware position it typechecks against Hono's
     * variadic signature, runs, and gates nothing at all, because nobody reads what it returned.
     */
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    if (!composio) {
      return context.json(
        { error: new BrokerUnconfiguredError().message },
        503,
      );
    }

    let directory: BrokerApp[];
    try {
      directory = await composio.broker.listApps();
    } catch (error) {
      // The vendor's own sentence where there is one, because "invalid api key" is the diagnosis
      // and a 500 is not. See {@link brokerRefusal} for what is kept out of the answer.
      const refusal = brokerRefusal(error, DIRECTORY_UNAVAILABLE);
      return context.json({ error: refusal.error }, refusal.status);
    }
    // An app awaiting this deployment's own client is connectable once one is stored (#950).
    directory = withDeploymentClients(directory, await heldClients());
    /*
     * AN APP THAT CANNOT BE CONNECTED IS NOT AN APP TO OFFER. Every kind but this one ends at a
     * person with a working account; `unsupported` ends at an administrator pressing Add and
     * meeting Composio's refusal, because the OAuth client it wants is one this deployment has
     * nowhere to hold. Hidden here rather than at the vendor: the filter is a fact about what this
     * deployment can drive, not about what Composio publishes.
     */
    const connectable = directory.filter(
      (candidate) => candidate.connection.kind !== "unsupported",
    );
    const term = (context.req.query("q") ?? "").trim().toLowerCase();
    const matches = (app: BrokerApp) =>
      !term ||
      [app.slug, app.name, app.description].some((field) =>
        field.toLowerCase().includes(term),
      );
    const matched = connectable.filter(matches);
    /*
     * 在等这个部署自己客户端的应用（#950，例如 Shopify）：不进 `apps`，因为现在还连不上；单独列出名字，
     * 管理员在「部署专属客户端」里从这里挑，不用手填应用名。保存客户端以后，它就进 `apps`。
     */
    const awaitingClient = directory
      .filter(
        (candidate) =>
          candidate.connection.kind === "unsupported" &&
          candidate.connection.awaitsClient === true &&
          matches(candidate),
      )
      .map((candidate) => ({ slug: candidate.slug, name: candidate.name }));

    /*
     * THE ONE CALL ON THIS ROUTE THAT IS NOT THE VENDOR'S, AND IT WAS THE ONE NOTHING ANSWERED FOR.
     *
     * CRITERION. The same one the add routes state: every admin route whose store call can reach a
     * fault on the `isDeploymentFault` shelf answers with the sentence rather than leaving it to
     * the default handler.
     *
     * REASON. The `try` above wraps `listApps` because that is where a wrong key shows itself, and
     * this read sat outside it with no mapping at all — so a query this database refused while
     * marking which apps are already enabled gave an administrator the framework's bodyless 500,
     * on the one screen where a Composio key has just been set. That is the reading most likely to
     * send somebody back to a key that is fine, over a fault Composio had no part in. The same 409
     * and the same sentence the sibling admin routes give the shelf; a failure that is not on it
     * still throws, which is what keeps the stack in the log.
     */
    let urls: string[];
    try {
      urls = await store.serverUrls();
    } catch (error) {
      if (isDeploymentFault(error)) {
        return context.json({ error: deploymentFaultSentence(error) }, 409);
      }
      throw error;
    }

    const enabled = new Set(
      urls
        .map((url) => toolkitOf(url))
        .filter((toolkit): toolkit is string => toolkit !== null),
    );
    return context.json({
      apps: matched.map((app) => ({ ...app, enabled: enabled.has(app.slug) })),
      awaitingClient,
    });
  });

  /**
   * Enable one app of that catalogue, which is a third way for a server to arrive.
   *
   * THE SLUG VALIDATION IS THE WHOLE ROUTE. `addBrokeredApp` composes `composio://<slug>`, and that
   * url is what every future call for the app is resolved against — so a slug the directory never
   * answered with is a row pointing at an app that does not exist: added, grantable, enabled on a
   * Bot, and dead at the first call, with nothing on the page saying so. The live directory is what
   * it is checked against rather than a pattern, because the question is not whether the text is
   * well formed but whether Composio has such an app right now.
   *
   * The title comes off the directory entry too. The caller chose an app; they did not choose a
   * name for it.
   */
  routes.post("/composio/apps", capable, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    if (!composio) {
      return context.json(
        { error: new BrokerUnconfiguredError().message },
        503,
      );
    }

    const body = (await context.req.json().catch(() => null)) as {
      slug?: unknown;
    } | null;
    /*
     * ASKED WITH `typeof` RATHER THAN OFF THE ANNOTATION, which is the same hazard the skill routes
     * below spell out twice (`:2064`, and again at the grant route): the body is JSON, so the type
     * above is a wish. `{"slug":123}` made `(123).trim()` a `TypeError` thrown out of the handler —
     * and this statement sits outside every `try` here, so Hono's default handler answered a
     * bodyless 500 and the admin page fell back to "That app could not be added". Admin-gated, so
     * what it cost was an operator's diagnosis rather than anything they should not have had.
     *
     * A non-string is simply no slug, and the not-found refusal below already says the true thing
     * about that, so the narrowing answers with `undefined` rather than a second sentence.
     */
    const slug = typeof body?.slug === "string" ? body.slug.trim() : undefined;
    let directory: BrokerApp[] = [];
    if (slug) {
      try {
        directory = withDeploymentClients(
          await composio.broker.listApps(),
          await heldClients(),
        );
      } catch (error) {
        /*
         * The same failure the directory route answers, in the same words, because it is the same
         * call. Unhandled it was the worst 500 of the three: an administrator pressing Add on a
         * deployment whose key is wrong was told nothing at all, on the one screen where the key
         * had just been set.
         */
        const refusal = brokerRefusal(error, DIRECTORY_UNAVAILABLE);
        return context.json({ error: refusal.error }, refusal.status);
      }
    }
    const app = directory.find((candidate) => candidate.slug === slug);
    if (!app) {
      return context.json(
        {
          error: slug
            ? `${slug} is not an app Composio lists for this deployment.`
            : "An app is required.",
        },
        400,
      );
    }

    /*
     * AN APP THIS DEPLOYMENT CANNOT CONNECT IS NOT AN APP TO ADD, and the GET half above is not
     * enough on its own: it hides every `unsupported` app from the picker, so nobody presses Add on
     * one, but this route validates against the unfiltered `directory` — so a request that names
     * one by hand arrives here past that filter.
     *
     * WHAT IT WOULD REACH IS A STORE METHOD THAT RECORDS A MISLEADING ROW. `schemeFor` writes
     * `null` on `auth_scheme` for an unsupported connection, and a null there is read everywhere
     * else as "not a brokered row at all" — so the row enabling would write is one whose recorded
     * kind contradicts what it is.
     *
     * A SECOND GUARD RATHER THAN A REPLACEMENT: the adapter keeps its own refusal, and the two
     * catch different things. This one stops a CALLER OF THIS ROUTE reaching a store method that
     * would write that row — which is a fact about `addBrokeredApp`, and holds for whatever broker
     * is behind it, including one that would happily create the config. The adapter's stops ANY
     * caller at all — this route, a script, a future path — from reaching the vendor for an app
     * this deployment has nowhere to hold an OAuth client for. Neither subsumes the other, and the
     * store itself still has no guard, which is precisely why the cheap one here is worth having.
     *
     * The derivation's own `reason` is the sentence, because it names what is missing for this app
     * rather than for unsupported apps in general. 503 because this is a refusal this deployment
     * authored — the same status `brokerRefusal` gives an authored refusal raised a layer down, and
     * for the same reading: the brokered surface is unavailable for this app until somebody here
     * changes something, rather than unavailable because a third party is down. Not the 400 above,
     * which says the app does not exist; this one does exist, and this deployment cannot drive it.
     */
    if (app.connection.kind === "unsupported") {
      return context.json({ error: app.connection.reason }, 503);
    }

    try {
      const server = await store.addBrokeredApp({
        slug: app.slug,
        title: app.name,
        logo: app.logo,
        by: actorEmail(context),
        // Off the directory entry the administrator chose, never derived a second time here: a
        // second derivation is a second answer, which is the one thing `BrokerConnection` exists to
        // prevent. It decides what config the store creates at the vendor, and what the row records.
        connection: app.connection,
      });
      return context.json({ server }, 201);
    } catch (error) {
      // 这次请求没有管理员能力：store 在动手之前就拒绝了。是「谁在问」的拒绝，所以答 403。
      if (isServerWriteRefusal(error))
        return context.json({ error: CAPABILITY_UNCONFIRMED }, 403);
      // The same mapping the add routes above make, for the same reason: a refusal an
      // administrator can correct comes back as itself rather than as a 500.
      if (
        error instanceof CustomServerRefusedError ||
        error instanceof PluginRefusedError
      ) {
        return context.json({ error: error.message }, 400);
      }
      // And, as on those routes, enabling refreshes before it answers, so every fault
      // `refreshTools` raises arrives here as well. Its sentence blames nobody and names the row,
      // which is the honest answer whichever side of the insert the fault arrived on.
      if (isDeploymentFault(error)) {
        return context.json({ error: deploymentFaultSentence(error) }, 409);
      }
      /*
       * THE ONE REFUSAL THIS ROUTE CAN ONLY MEET AFTER THE ROW IS COMMITTED, and the only one its
       * three sibling add routes map and it did not.
       *
       * CRITERION. A failure thrown after `addBrokeredApp` has written and audited the row is not
       * reported as an app that was not enabled, and is not reported as Composio's doing.
       *
       * WHERE IT ARRIVES FROM. `addBrokeredApp` creates the auth config, inserts the row and files
       * its `configuration.changed` entry, and only THEN refreshes and reads the row back out of
       * `listServers` — raising this when it is not there, as `requireServer` does one call
       * deeper. Every one of those steps has already committed by then.
       *
       * WHAT IT USED TO BE ANSWERED WITH. Nothing caught it, so it fell through to the broker tail
       * below and an administrator was told "Slack could not be enabled, and Composio said nothing
       * about why. Try again, and check this deployment's Composio key if it persists." That is
       * wrong three times over: the app WAS enabled, Composio had no part in the step that failed,
       * and the one thing the reader now holds — a row on their Plugins page — went unmentioned
       * while they were sent to check a key that is fine.
       *
       * 409 RATHER THAN THE 400 ITS SIBLINGS GIVE THIS CLASS, because it is not the same fact
       * wearing the same class. On the add routes above, an unknown key is a caller naming a
       * server this deployment will not connect to, which is a malformed request. Here the row was
       * written and this deployment cannot see it: two of its own reads disagree, and the request
       * cannot be answered until one of them changes — the reading the refresh route's own 409
       * spells out. The message is written here rather than passed through, because
       * {@link CatalogueEntryUnknownError}'s own sentence is the one for the other case.
       */
      if (error instanceof CatalogueEntryUnknownError) {
        return context.json(
          {
            error: `${app.name} was added, and then could not be read back out of this deployment's own servers — so the row and its trail entry stand, and what is on this page may be missing it. Reload the ${appsPage()} page: if ${app.name} is there it is enabled and there is nothing to redo, and if it is not, adding it again is safe.`,
          },
          409,
        );
      }
      /*
       * THE SAME MAPPING THE DIRECTORY READ ABOVE MAKES, FOR THE SAME REASON, and its absence here
       * is what left an administrator with nothing. Composio's own sentence — "Default auth config
       * not found for toolkit linear_mcp. Composio does not have managed credentials for this
       * toolkit." — travelled as an unhandled throw, so the route answered a bodyless 500 and the
       * browser fell back to its own "That app could not be added". Everything that explains the
       * failure existed; nothing carried it the last step.
       */
      /*
       * WHAT THE MAPPING COST, PUT BACK. A throw used to reach Hono's default handler, which is a
       * bad answer and a good log: the administrator got a bodyless 500, but the stack was printed
       * where an operator could find it. Catching everything fixed the answer and silenced the log,
       * and the failure that needs the log most is the one left here — not a refusal this
       * deployment authored, which `brokerSentence` names and `isDeploymentFault` already took one
       * branch above, and not a sentence Composio wrote, which `vendorSentence` reaches for. Both
       * null is a fault nobody has explained, most often a programmer error on this side, and it
       * would otherwise leave only the generic "Composio said nothing about why" in a browser
       * nobody is reading a console from.
       *
       * The same shape and the same restraint as the connection-not-recorded log below: the slug,
       * because it is the app an operator is about to be asked about; what the person was told, so
       * the console line and the support request can be matched up; and the error read through
       * {@link reasonWithoutStatement}, never spread, logged as an object or reached into. No key,
       * no vendor response, no request body, and no statement — the two sentence tests below do not
       * exclude a query failure, they are the branch one arrives in.
       *
       * AND THE NAME ON IT IS TRUE OF EVERY FAILURE THAT STILL REACHES IT. The two branches above
       * take the whole of what `addBrokeredApp` can raise once the row is committed — the shelf,
       * and the read-back that could not find it — so what is left arrives from the steps before
       * the insert, where nothing was written and the app really was not enabled. The generic
       * sentence below names Composio for the same reason: the one call in front of the insert is
       * `ensureAuthConfig`, which is a call to the vendor.
       */
      if (brokerSentence(error) === null && vendorSentence(error) === null) {
        console.error(
          JSON.stringify({
            type: "composio-app-not-enabled",
            slug: app.slug,
            note: "Enabling a brokered app failed for a reason neither this deployment nor Composio put a sentence to. The administrator was answered 502 with the generic sentence.",
            error: reasonWithoutStatement(error),
          }),
        );
      }

      const refusal = brokerRefusal(
        error,
        `${app.name} could not be enabled, and Composio said nothing about why. Try again, and check this deployment's Composio key if it persists.`,
      );
      return context.json({ error: refusal.error }, refusal.status);
    }
  });

  /**
   * Where a person's own connections are, and how to start a new one.
   *
   * Not admin-only, and that is the point: an administrator registers the connector once, and then
   * everybody connects their own account. Somebody can only ever see or start their own.
   */
  routes.get("/connections", capable, async (context) => {
    /*
     * BOTH TABLES, ONE LIST, because the person asking has one question.
     *
     * "Am I connected to this?" is the same question whether the grant is a refresh token in this
     * deployment's vault or an account Composio holds on our behalf. Which table a connection lives
     * in is a fact about how the vendor is reached — the transport, the credential, who keeps the
     * secret — and none of that is something a settings page should have to know in order to draw a
     * word beside a row. Answering out of `connectionsFor` alone left the brokered half invisible,
     * so the page could only either say "Not connected" over a live account or say nothing at all,
     * and it chose to say nothing.
     *
     * CONCATENATED WITHOUT REWRITING, because the fields a settings page draws from — the server
     * id, the scope, the date — line up across the two reads, and one row template can draw either
     * kind. What does not line up is what `brokeredConnectionsFor` adds — `verified`, `verifiedAt`,
     * `probe` and `checkable` — so the list that leaves here is not uniform. Those travel because a
     * brokered row is the only one with anything to re-check: this deployment holds no secret for
     * it, only a note that Composio said yes, and that note can drift when somebody ends the
     * connection in Composio's own dashboard. `probe` rides with the first two because the flag
     * cannot be read alone — three situations share one `verified: false`, and which action the
     * check actually SPENT is what separates them on a page that has done nothing but load.
     *
     * `probe` AND `checkable` ARE TWO ANSWERS AND NOT ONE SENT TWICE, and a caller that treats them
     * as interchangeable breaks the page in one of two opposite ways. `probe` is a record of the
     * check that was made; `checkable` is whether the app has anything to check with NOW. They
     * agreed while the first was derived, and an administrator's press of Refresh moved what the
     * app publishes without touching what the check spent — so the page accused a key nobody had
     * tried. Recording the first fixed that and deadlocked the other half: a key nothing was spent
     * on reads null for good, and the button that is the only way to ever spend one was gated on
     * that null. So the sentence is drawn off `probe` and the button off `checkable`; see
     * `brokeredConnectionsFor`, which sets both failures out in full. A held connection has no
     * equivalent question, so its rows carry none of these fields, and their absence is what tells
     * the two READS apart. It is not how a reader learns how an app connects: that is the app's
     * recorded `authScheme`, and a page asking this list instead would be deriving a second answer
     * to a question the row already carries.
     *
     * SORTED, so two requests answer in the same order. Each read is ordered by server id within
     * its own table, and concatenating two sorted lists is not a sorted list. Compared as plain
     * strings rather than by `localeCompare`, because the order only has to be the SAME one every
     * time, and a collation that varies with the deployment's locale is not that.
     */
    /*
     * `?shared=1`：每个 Shared 应用的团队账号也列出来，带 `holder: "deployment"`，本人自己的行带
     * `holder: "person"`（上游的 `GET /connections` 一直这样列）。
     *
     * 要带参数才列，因为不带参数的答案一直是「每一行都是我自己的连接」，读它的页面也这样用：多出一行团队
     * 账号，还没连接的 Shared 应用会被画成这个人已经连上了。照上游读法写的页面带上参数，并用 `holder` 把
     * 团队账号的行分出去。
     *
     * 团队账号是哪个账号、谁连接的，只告诉持有能力的管理员（`decisionRefusal`，和处理申请同一个判断，
     * 所以这条路由挂在带能力的入口上）：`displayName` 是厂商给这个账号起的名字，常常就是一个邮箱，小团队
     * 里往往是管理员自己的；`connectedBy` 是连接它的管理员的邮箱。成员和队友两样都拿到 null，仍然知道这个
     * 应用连没连上。上游对每个登录的人都给这两样。团队账号在厂商那边的身份不在这些行里。
     *
     * 只认识自己连接的 store（没有账号模式的装配、老的测试替身）没有这个方法，就没有可列的。
     */
    const withShared = context.req.query("shared") === "1";
    const [held, brokered, shared] = await Promise.all([
      store.connectionsFor(context.var.actor.id),
      store.brokeredConnectionsFor(context.var.actor.id),
      withShared && typeof store.sharedConnections === "function"
        ? store.sharedConnections({
            details: decisionRefusal(context) === null,
          })
        : [],
    ]);
    // 带参数时本人的行写明 `holder: "person"`（上游每一行都带）；不带参数的答案一个键都不多。
    const own = [...held, ...brokered];
    const connections = [
      ...(withShared
        ? own.map((row) => ({ ...row, holder: "person" as const }))
        : own),
      ...shared,
    ].sort((left, right) => {
      if (left.serverId < right.serverId) return -1;
      return left.serverId > right.serverId ? 1 : 0;
    });

    return context.json({
      connections,
      // Shown to an administrator so they can register the client at the vendor with the exact value
      // this deployment will send. Null means the deployment has no public URL and cannot connect.
      redirectUri: connect?.publicUrl
        ? redirectUriFor(connect.publicUrl)
        : null,
    });
  });

  /**
   * Begin connecting one person's own account.
   *
   * Answers with a URL rather than redirecting, so the browser decides when to leave the page. The
   * state is minted here, from the session, and the person's identity never comes off the callback.
   */
  routes.post("/servers/:id/connect", capable, async (context) => {
    const serverId = context.req.param("id");

    /*
     * A BROKERED APP IS ANSWERED HERE AND GOES NO FURTHER DOWN THIS HANDLER.
     *
     * Everything below this branch belongs to the consent flow THIS deployment runs: a public URL
     * to build a redirect URI out of, a catalogue entry naming the vendor's authorization
     * endpoint, an OAuth client an administrator registered, a sealed state the callback reads
     * back. A brokered app has none of it. Composio holds the consent, so no authorization code
     * ever comes back to us, no refresh token is stored here, and no redirect URI of ours is
     * registered with anybody — there is nothing for those checks to be about.
     *
     * WHICH IS WHY THE ORDER IS THE WHOLE POINT AND NOT A TIDINESS. Falling through, a brokered
     * row met `catalogueEntry`, which has never heard of `composio-linear`, and the person
     * pressing Connect was told the app "is not connected as an individual person" — the exact
     * opposite of true about the one kind of row that is ONLY ever connected as an individual
     * person. On a deployment with no `OPENBOT_PUBLIC_URL` it failed one step earlier still,
     * refusing for want of a setting that has no bearing on a flow it does not enter.
     *
     * The app comes off the row's url via `toolkitOf` rather than off its id, for the reason the
     * directory route says: the url is where the transport reads which app a call is against, and
     * the id is a row name that happens to look similar.
     *
     * ONE ROW, BY ID. Every request to this route pays for this read, including the ones that fall
     * through to the OAuth flow below, because the branch cannot be taken until the row is in hand
     * — so what it costs has to be a lookup of three columns rather than the whole plugin surface.
     * `serverAddress` answering `undefined` is an id naming no row, which falls through exactly as
     * a missing row did when this was a `.find`.
     */
    const row = await store.serverAddress(serverId);
    const toolkit = row ? toolkitOf(row.url) : null;
    if (row && toolkit) {
      if (!composio) {
        return context.json({ error: PERSON_UNCONFIGURED }, 503);
      }

      /*
       * SHARED 应用连的是部署的团队账号（X1，上游 #757）：只有管理员能连，账号身份是应用行上铸好的团队
       * 身份，不是谁的会话；一个应用只有一个团队账号，已连接就先断开。和下面一样，路由里没有一处从请求读
       * 账号身份。
       */
      const app = await appAccountOf(toolkit);
      const shared =
        app?.mode === "shared" && schemeKind(row.authScheme) !== "none";
      if (shared) {
        /*
         * 会话里的角色是登录时定的；真正的门是管理员能力（重新读过角色）。在把团队身份交给 vendor 之前问
         * （评审 I1），降权管理员的会话因此碰不到团队账号。
         */
        let writer = context.var.actor.role === "admin";
        if (writer) {
          try {
            store.requireTeamAccountWriter();
          } catch (error) {
            if (!isServerWriteRefusal(error)) throw error;
            writer = false;
          }
        }
        if (!writer) {
          return context.json(
            {
              error: `${row.title} 用的是一个共享的团队账号，只有管理员能连接它。没有建立任何连接。`,
            },
            403,
          );
        }
        if (!app?.shared) {
          return context.json(
            {
              error: `${row.title} 是共享账号应用，却没有团队身份。请把它切回个人账号再切回共享账号。`,
            },
            409,
          );
        }
        if (app.shared.connectedAt) {
          return context.json(
            {
              error: `${row.title} 已经连接了一个团队账号。要换一个，先断开它。`,
            },
            409,
          );
        }
      }
      const holderId =
        shared && app?.shared ? app.shared.vendorUserId : context.var.actor.id;

      /*
       * THE PERSON IS THE SESSION'S, HERE AND IN THE READ ABOVE IT.
       *
       * Nothing in this branch reads a user id out of the body or the query, and that is the
       * property rather than an implementation detail: the link minted below attaches an account
       * to whichever person it names, so a user id a caller could choose would let one POST hang
       * somebody else's mailbox off this deployment. It is the defect the prior art this design
       * follows shipped three separate times, and it is structural here — there is no line that
       * could break it.
       */
      const existing = shared
        ? null
        : await store.brokeredConnection({
            toolkit,
            userId: context.var.actor.id,
          });
      /*
       * 「再连一个账号」（上游 #1298）：一个人可以在同一个应用上有两个邮箱，调用按名字指定用哪个（见
       * `./brokered-accounts`），所以第二个账号不再由 vendor 替谁选。只在明确要求时（`?another=1`，应用
       * 页面上的「再连一个账号」按钮）、且只对同意屏幕类的应用开放：平常按 Connect 仍按下面的规则拒绝，
       * 输入密钥的应用仍是一人一个账号。
       */
      const another =
        existing !== null &&
        existing !== undefined &&
        context.req.query("another") === "1" &&
        schemeKind(row.authScheme) === "consent" &&
        Boolean(composio.broker.accountsOf);
      if (existing && !another) {
        /*
         * Named with the step to take rather than only refused: a second link would attach a
         * second account behind a row that already says connected, and the way to a new one is
         * through the connection they have.
         *
         * THE APP'S TITLE, NOT THE ROW'S ID. `composio-linear` is this deployment's name for a
         * table row; "Linear" is the name of the thing the person connected and the only one of
         * the two they have ever seen on a screen. An internal key in a sentence addressed to a
         * person is both unhelpful and a small leak of how the rows are keyed.
         */
        return context.json(
          {
            error: `You already have an account connected to ${row.title}. Disconnect it first if you want to connect a different one.`,
          },
          409,
        );
      }

      /*
       * AN APP WHOSE SECRET THE PERSON HOLDS IS ANSWERED HERE AND NEVER SENT AT A CONSENT SCREEN.
       *
       * Most of Composio's catalogue connects this way rather than through a consent screen: the
       * person already holds an API key, so there is nothing to consent to, no url to mint and no
       * return leg to build — the press that opens a vendor page for a consent app has to answer
       * with a form instead, and the press after it carries what was typed into it. One route
       * serves all three arms because the browser asks the same question every time: connect me to
       * this app. The third is below: an app that needs no credential at all, which is answered
       * with the fact rather than with either flow.
       *
       * THE FORK IS THE SCHEME RECORDED ON THE ROW AT ENABLE TIME, which is what this deployment's
       * authorization config was actually created as — never a fresh catalogue read and never
       * anything the request said. {@link isFieldScheme} is asked rather than the string compared,
       * for the reason that function exists: one list, read by the guard and by the type, so the
       * schemes admitted here cannot come apart from the ones the broker's signature takes.
       *
       * AFTER THE ONE-ACCOUNT GUARD RATHER THAN BESIDE IT, and the order is a decision. Somebody
       * who already has an account attached has no business in front of a form: drawing one invites
       * them to type a key that would be refused once they had entered it, and even the first press
       * would spend a call at Composio on behalf of a request that is going to be refused anyway.
       * The refusal above names the step to take, and it is the same step for every kind of app.
       *
       * THE PERSON IS STILL THE SESSION'S, as everywhere else in this branch. Nothing below reads
       * a user id out of the body — and nothing below logs the body either, which matters more
       * here than anywhere else in this file: it is the one request this deployment handles that
       * carries somebody's own credential.
       */
      const authScheme = row.authScheme;

      /**
       * WHAT THIS FORK ANSWERS FOR EACH KIND OF APP, AND EVERY ARM IS REACHED BY DECIDING.
       *
       * Type-only and erased; see {@link Decides} in `./broker`. A fourth {@link SchemeKind} fails
       * `tsc` here by name, which is what this roster is for: the fork below reads a three-member
       * vocabulary with a chain of `if`s, and an `if` chain has no opinion about the answers it was
       * not written for.
       *
       * CRITERION. Every arm below is entered because {@link schemeKind} said so. No arm is the
       * fall-through of the others.
       *
       * REASON. This file used to import {@link isFieldScheme} and not `schemeKind`, and compare one
       * raw literal beside it — so the fork was two tests and a fall-through, and the fall-through
       * was the consent arm. A scheme this deployment cannot read — a null, or a literal nothing
       * here writes, which the row that ANSWERS for an app is free to carry because
       * `mcp_servers.url` has no unique index — therefore landed in the arm that mints an
       * authorization link at Composio for an app with no consent config behind it. That is a real
       * act performed at the vendor on behalf of an answer nobody decided, and its only possible end
       * is a link the person cannot complete. The three readers of this column in `./store` already
       * fail closed on that value; this one was the last that did not.
       */
      type _ConnectForkDecides = Decides<
        SchemeKind,
        {
          key: "answers with the form the app publishes, and connects what is typed into it";
          consent: "mints a link at Composio for the person to finish at the vendor's own screen";
          none: "refuses with the fact about the app — there is no account to connect and nothing is asked of Composio";
          unreadable: "refuses, and asks Composio nothing — it is not a consent app and there is no link to mint";
        }
      >;
      const kind = schemeKind(authScheme);

      /*
       * AN APP THAT NEEDS NO CREDENTIAL IS ANSWERED WITH WHAT IS TRUE OF IT, AND ASKS COMPOSIO
       * NOTHING.
       *
       * ITS OWN KIND, AND THE ONE THIS FORK USED TO HAVE NO ARM FOR. `NO_AUTH` is what
       * `connectionOf` resolves thirty-four of Composio's toolkits to and what `addBrokeredApp`
       * records on their rows. It is not a field scheme, so without this it fell through into the
       * consent arm below and met one of two dead ends: a 503 demanding `OPENBOT_APP_URL` for a
       * return leg this flow does not have, or `broker.authorize` — which can only fail, because
       * `ensureAuthConfig` deliberately creates NO authorization config for a no-auth app, Composio
       * having refused to hold one. The sentence that failure produces tells the person to remove
       * the app and add it again, and adding it again writes the identical row and fails
       * identically. That is one of the five connection kinds broken end to end, in the arm reached
       * by elimination rather than by decision.
       *
       * ASKED OF {@link schemeKind} RATHER THAN COMPARED AS A STRING, which is the second half of
       * that fix and arrived later than the first. The literal comparison here was right about the
       * app and silent about the vocabulary: `schemeKind` went on calling `NO_AUTH` a CONSENT
       * scheme, so this route and the per-person gate disagreed with the classifier — and with the
       * one consumer that did ask it, which wrote a `verified: true` connection row on every page
       * load for exactly the apps this branch refuses to make one for. `none` is now its own member
       * and this reads it.
       *
       * REFUSED RATHER THAN ANSWERED `connected`, AND THE DIFFERENCE IS A ROW. `composio_connections`
       * is the whole of the permission for a brokered call, and every row in it means one thing: this
       * person granted this deployment access to their account at this app. There is no account here
       * and there is no consent, so nothing may be written — which is exactly what
       * the store's own `connectionTokenFor` already acts on, letting a `NO_AUTH` call through with
       * no connection row at all rather than looking for one. A 200 claiming a connection would put
       * this app in front of every reader of that table — offboarding, the trail, the Disconnect
       * button — as an account somebody has to end.
       *
       * AND THE SENTENCE NAMES NO REMEDY, BECAUSE NOTHING IS WRONG. It says what the app is and that
       * its tools already work, which is the whole of what the person can act on. 400 for the reason
       * the OAuth branch below gives a row that is not connected as an individual person one: the act
       * does not apply to this kind of row.
       *
       * THE APP'S TITLE, NOT THE ROW'S ID, for the reason the one-account refusal above says it:
       * `composio-hackernews` is how this deployment keys a table and "Hacker News" is the name of
       * the thing on the screen.
       */
      if (kind === "none") {
        return context.json(
          {
            error: `${row.title} needs no account, so there is nothing to connect. A Bot granted its tools can use it as it is.`,
          },
          400,
        );
      }

      /*
       * AN APP ON THE DEPLOYMENT'S OWN CLIENT IS NEVER A PERSON'S ACCOUNT, AND IS REFUSED BEFORE THE
       * FORM IS EVEN ASKED FOR (upstream #950). What a person would type is a store subdomain; what
       * Composio would exchange is the client this deployment registered, so their account would
       * be the organization's access under their name, granted by nobody. Only an administrator,
       * who holds that client already, connects it (`adminConnectOnly`). 403, because the person
       * pressing Connect cannot make this request succeed by changing what they send.
       */
      if (
        !shared &&
        adminConnectOnly(authScheme) &&
        // 会话给出的角色不够；要的是这次请求重新读过 `user_roles` 之后拿到的管理员能力。
        decisionRefusal(context) !== null
      ) {
        return context.json(
          { error: adminConnectOnlySentence(row.title) },
          403,
        );
      }

      if (isFieldScheme(authScheme)) {
        /*
         * A SUBMISSION IS AN OBJECT OF VALUES, AND ANYTHING ELSE IS THE FIRST PRESS. The browser
         * sends no body at all when it is asking what the app wants, so an absent, empty or
         * unparseable one is that question rather than a malformed answer to it, and the worst a
         * caller gets for sending something stranger is the form back.
         */
        const body = (await context.req.json().catch(() => null)) as {
          values?: unknown;
          guide?: unknown;
        } | null;
        const submitted =
          typeof body?.values === "object" &&
          body.values !== null &&
          !Array.isArray(body.values)
            ? (body.values as Record<string, unknown>)
            : null;

        /*
         * ASKED OF THE VENDOR ON BOTH PRESSES, because it is the answer to both questions. On the
         * first it is the form itself; on the second it is the list the submission is checked
         * against, and reading it from anywhere else — a cached copy, the fields the form was drawn
         * from — would be checking a body against what the app used to ask for.
         */
        let published: BrokerField[];
        try {
          published = await composio.broker.connectionFields({
            toolkit,
            authScheme,
          });
        } catch (error) {
          const refusal = personRefusal(
            error,
            `没能查到连接 ${row.title} 需要填写什么。请重试；如果一直这样，请联系管理员。`,
            { route: "connect.form", toolkit },
          );
          return context.json({ error: refusal.error }, refusal.status);
        }

        /*
         * THE FIRST PRESS, ASKED FOR THE GUIDE, ANSWERS THE FORM A PERSON CAN FOLLOW (upstream
         * #1297): the same boxes under the same names, labelled and explained in their words, and a
         * guide saying where the key comes from. The names are untouched, so the second press is
         * checked against `published` exactly as before. The broker's own link is asked for and a
         * failure there costs only the link: the form is what the person came for, and
         * `./key-guides` has the fallback.
         *
         * ASKED FOR WITH `{ "guide": true }`, which is the fork's one difference from upstream: a
         * first press without it is answered exactly as it always was, the vendor's form verbatim,
         * so a browser that predates the guide reads what it has always read.
         */
        if (submitted === null && body?.guide === true) {
          return context.json({
            fields: fieldsForPerson(toolkit, published),
            guide: await keyGuideFor({
              ask: composio.guides?.connectionGuideUrl.bind(composio.guides),
              toolkit,
              authScheme,
              title: row.title,
            }),
          });
        }

        if (submitted === null) return context.json({ fields: published });

        /*
         * AN APP WITH NO BOXES CANNOT BE CONNECTED BY SOMEBODY TYPING, WHICH IS THE ONLY WAY THIS
         * BRANCH CONNECTS ANYBODY.
         *
         * {@link isFieldScheme} admits exactly the schemes whose secret a PERSON holds, so an
         * empty published list is not a short form — it is a form with nowhere to put the one
         * thing the scheme is for. Every check below passes such a submission for want of anything
         * to check, and what it makes is an account Composio marks `ACTIVE` because Composio does
         * not grade what it is handed. An app with no probeable action then has that row written
         * and drawn as connected on every screen here.
         *
         * ON THE SUBMISSION AND NOT ON THE PRESS ABOVE IT. The empty list is a true answer to
         * "what does this app ask for" — {@link ComposioBroker.connectionFields} says so, and
         * distinguishes it there from the scheme the app no longer publishes at all, which refuses.
         * What is false is the account the next press would make, so that is the press that is
         * refused.
         *
         * THE REMEDY IS AN ADMINISTRATOR'S, because nothing the person pressing Connect can do
         * changes what the app publishes or which scheme this deployment recorded for it.
         */
        if (published.length === 0) {
          return context.json(
            {
              // A person reads this (upstream #1223): no connector provider named.
              error: `${row.title} 没有要填写的内容，所以没有建立任何连接。${askAdminToZh(`在${appsPageZh()}移除它，再重新添加`)}。`,
            },
            400,
          );
        }

        /*
         * AND AN APP THAT PUBLISHES BOXES BUT REQUIRES NONE OF THEM IS THE SAME ACCOUNT WITH A FORM
         * IN FRONT OF IT.
         *
         * THE GUARD BELOW READS `required` ON THE NAMES THAT ARRIVED; THIS ONE READS THE LIST. A
         * published list with no required field in it leaves that guard nothing to be about, so
         * `{"values":{}}` passes it vacuously — and so does a box holding spaces, and so does the
         * default the form seeded itself from. What each of the three makes is an account carrying
         * no credential, which Composio answers `ACTIVE` for because it does not grade what it is
         * handed, and which an app with no probeable action leaves recorded and drawn as connected:
         * the very end state the required guard exists to prevent, reached down the one path that
         * guard cannot see.
         *
         * THE CLAIM THIS RESTS ON, STATED RATHER THAN ASSUMED: EVERY FIELD SCHEME IN COMPOSIO'S
         * CATALOGUE PUBLISHES AT LEAST ONE REQUIRED FIELD, BECAUSE A FIELD SCHEME IS COMPOSIO'S OWN
         * STATEMENT THAT THE PERSON HOLDS A CREDENTIAL. What makes it a claim about the catalogue
         * rather than a guess is that "this app needs nothing" already has its own name there:
         * `NO_AUTH` sits beside `API_KEY`, `BASIC`, `BEARER_TOKEN` and `BASIC_WITH_JWT` in the
         * vendor's own scheme enum (`@composio/core` 0.18.1, `src/types/authConfigs.types.ts:9-24`),
         * and this route answers it in its own branch a few lines above — so an app that reached
         * HERE has told Composio it needs SOMETHING, and a field list requiring nothing is not that
         * app saying it needs nothing after all.
         *
         * AND THE SDK SAYS WHAT THE SOMETHING IS, PER SCHEME. `connectedAccountAuthStates.types.ts`
         * declares the shape of an ACTIVE account one scheme at a time: `BASIC` and `BASIC_WITH_JWT`
         * require `username` and `password`, `BEARER_TOKEN` requires `token`, and `NO_AUTH` requires
         * nothing at all — an ACTIVE no-auth account is the base row and no credential beside it.
         * `API_KEY` is the one that marks `api_key` and `generic_api_key` optional, and it does so
         * because the NAME of the box varies across the catalogue and both spellings occur in it,
         * not because an API_KEY account may hold no key: the same declaration keeps a `catchall`
         * for the third spelling. Three of the four field schemes therefore say in the vendor's own
         * types that an account of theirs carries a credential, and the fourth says which credential
         * it cannot name.
         *
         * WHAT WAS NOT DONE, AND IT IS THE HONEST LIMIT OF THE CLAIM: the live catalogue was not
         * enumerated. There is no network and no Composio key on this path, so "no toolkit publishes
         * a field scheme with an empty required list" is ARGUED from the vendor's own package rather
         * than counted across its apps. The guard is written to fail in the safe direction for that
         * reason. If such an app does exist, it becomes an app this deployment will not connect and
         * SAYS SO, with a remedy addressed to the one person who could change it — which is the
         * direction the empty-list guard directly above already chose, and the opposite of the
         * silent credential-less account that is the alternative.
         *
         * THE STATE UNDER THIS GUARD IS ONE STATE AND NOT TWO, WHICH IS WHAT MAKES IT DECIDABLE AT
         * ALL. "An app whose required flags we could not read" used to be indistinguishable from
         * "an app that requires nothing", and it is no longer: {@link ComposioBroker.connectionFields}
         * reads each flag through `flagOf`, which answers the caller's default for an ABSENT flag
         * and refuses one that is PRESENT and not a boolean. So a list arriving here with every
         * `required` false is the vendor's own no on every row — never a shape this deployment
         * failed to read, because that shape never gets past the adapter.
         *
         * ON THE APP AND NOT ON THE SUBMISSION, AND THE SEEDED DEFAULT IS WHY. A guard that demanded
         * one non-blank value would be satisfied by the form's own work: the form draws each box
         * holding the default the app published and posts every published name back whether or not
         * anybody touched it, so a person who types nothing at an app publishing an optional
         * `base_url` submits that default — non-blank, unchosen, and a credential in no sense. The
         * thing that is false here is the app's field list, so the app is what is refused.
         *
         * ON THE SUBMISSION AND NOT ON THE PRESS ABOVE IT, for the empty-list guard's reason: the
         * list is a true answer to "what does this app ask for", and what is false is the account
         * the next press would make.
         *
         * THE SENTENCE NAMES THE BOXES THE APP DOES PUBLISH AND NO VALUE OF ANY KIND. These names
         * are the VENDOR's, read off the list just fetched rather than off the request, and they are
         * the whole of what an administrator needs to see what the app is publishing now. Nothing
         * submitted appears — not even a value that merely matches a published default, because on
         * this request that value is the caller's text rather than the vendor's.
         */
        if (published.every((field) => !field.required)) {
          const optional = published.map((field) => field.name).join(", ");
          return context.json(
            {
              // A person reads this (upstream #1223): no connector provider named.
              error: `${row.title} 没有标出必须填写的项（只有 ${optional}），所以没有建立任何连接。${askAdminToZh(`在${appsPageZh()}移除它，再重新添加`)}。`,
            },
            400,
          );
        }

        /*
         * WHAT THE APP PUBLISHED, AND A NAME IT DID NOT IS REFUSED RATHER THAN QUIETLY DROPPED.
         *
         * ONE GUARD, THREE HOLES. What is submitted is spread into the field object the adapter
         * hands Composio, beside the literal `status: "ACTIVE"` that call sets — so an unfiltered
         * body lets a caller write over it. Anything else invented travels to the vendor
         * unexamined. And a field this deployment recorded that the app has stopped publishing
         * shows up here, at the request, rather than as a connection made without the value nobody
         * was asked for and a first tool call that discovers it.
         *
         * REFUSED, BECAUSE A PERSON CANNOT TYPE A NAME THE FORM DID NOT DRAW. The form is drawn
         * from this same list a moment earlier, so every name in an ordinary submission is one of
         * these; a name that is not leaves exactly two readings, and dropping it silently is the
         * wrong answer to both. If the app's published fields have moved, the person is holding a
         * stale form and the honest thing is to send them back for the current one — connecting
         * them with the part that still matches makes a credential-less account that every screen
         * here draws as connected. And if it is a caller reaching past the form on purpose,
         * "connected" is the one answer they must not get for a request this deployment edited
         * behind their back. Pressing Connect again costs a person one press and redraws the form
         * from what the app asks for now.
         *
         * THE VALUES ARE BUILT FROM THE NAMES THAT PASSED rather than the request object forwarded
         * once the check is done, so what reaches the store is the published subset by
         * construction and not on the strength of the loop above having run.
         *
         * A VALUE THAT IS NOT TEXT IS THE SAME REFUSAL. The store's signature promises strings, and
         * a number or an object under a published name is a lie told to that signature that reaches
         * Composio as whatever JSON makes of it.
         *
         * AND THE BAG HOLDS ONLY WHAT WAS PUT IN IT, WHICH `{}` DOES NOT. Every name here is the
         * VENDOR's — chosen by whoever publishes the app at Composio and never by this deployment —
         * and a plain object literal answers for names nobody submitted: `values.constructor` and
         * `values.toString` come back as functions off `Object.prototype`, so the required guard
         * below calls `.trim()` on a function and answers a person who typed nothing wrong with a
         * 500. A prototype value that happened to be TEXT would be worse still, because that guard
         * would count a credential nobody supplied and connect the account anyway. The other
         * direction fails silently: `values["__proto__"] = "acme"` on a literal reaches the
         * prototype setter, which ignores a string, so a value somebody typed is dropped between
         * the check that admitted it and the store that was meant to receive it — an account made
         * at Composio without one of the values the app publishes, marked `ACTIVE` because Composio
         * does not grade what it is handed, and drawn as connected on every screen here.
         *
         * A NULL-PROTOTYPE BAG IS THE WHOLE FIX AND IT IS THE SAME ONE THE FORM USES. Nothing is
         * inherited, so a read answers `undefined` exactly when nobody submitted that name and a
         * write stores what it was given under whatever name it was given. `Object.keys` — which is
         * what the audit row is built from one layer down — reads the same either way, and the
         * names are all this object's contents may ever appear as.
         */
        const names = new Set(published.map((field) => field.name));
        const values: Record<string, string> = Object.create(null);
        for (const [name, value] of Object.entries(submitted)) {
          if (!names.has(name) || typeof value !== "string") {
            /*
             * THE SENTENCE CARRIES NOTHING THAT WAS SUBMITTED — not the value, which is somebody's
             * own credential and belongs in no message, and not the name either, which on this
             * request is the caller's own text rather than the vendor's. It names the app and the
             * press that fixes it, which is the whole of what the person needs.
             */
            return context.json(
              {
                error: `That is not the form ${row.title} publishes, so nothing was sent to Composio. Press Connect again to draw it from what the app asks for now, and fill in the boxes it shows; each one holds text.`,
              },
              400,
            );
          }
          values[name] = value;
        }

        /*
         * AND WHAT THE APP SAID IT CANNOT DO WITHOUT HAS TO BE THERE, WHICH THE LOOP ABOVE NEVER
         * ASKED. That loop checks every name that ARRIVED; `required` is a fact about a name that
         * did not. A body of `{"values":{}}` passes it vacuously — no name is unpublished, no value
         * is not text — and what that connects is an account carrying no credential at all, which
         * Composio accepts because it does not grade what it is handed and which an app with
         * nothing safe to probe leaves recorded and drawn as connected.
         *
         * `required` HAD ONE READER AND IT WAS THE BROWSER. It rode the field out to the form and
         * became an HTML attribute, which is a courtesy to somebody filling boxes in and no kind of
         * guard: this route is reachable without that form, and the form itself accepts a space.
         *
         * BLANK IS ABSENT, AND WHITESPACE IS BLANK. The person's claim is that they filled the box
         * in, and a box holding spaces is one they did not — no vendor reads a key made of
         * whitespace, so admitting it buys exactly the account this guard exists to refuse, with a
         * value in it that makes the state harder to read rather than easier. The JUDGEMENT is made
         * on the trimmed text; what travels is what was typed, because trimming somebody's
         * credential on its way out is editing it, and a key that really does carry padding is the
         * vendor's to reject in its own words.
         *
         * OPTIONAL BOXES ARE UNTOUCHED BY THIS, and the distinction is the whole of why it reads
         * `required` rather than counting values. The form seeds each box from the default the app
         * published and posts every published name back whether or not anybody touched it, so a
         * blank optional value is what an ordinary submission carries.
         *
         * THE SENTENCE NAMES THE FIELDS AND NOTHING ELSE. These names are the VENDOR's, read off
         * the list this deployment just fetched rather than off the request — which is what sets
         * them apart from the refusal above, where the offending name is the caller's own text —
         * and no value of any kind appears here, for the reason the whole of this branch is built
         * around: a submitted value is somebody's own credential and belongs in no message, no log
         * and no row.
         */
        const missing = published
          .filter(
            (field) => field.required && !(values[field.name] ?? "").trim(),
          )
          .map((field) => field.name);
        if (missing.length > 0) {
          return context.json(
            {
              error: `${row.title} cannot be connected without ${missing.join(", ")}, so nothing was sent to Composio. Fill in every box the form marks required — a box holding only spaces is an empty one — and press Connect again.`,
            },
            400,
          );
        }

        try {
          /*
           * THE STORE'S ANSWER, WHOLE. `connected`, `verified` and `probe` are three facts and not
           * one dressed up: a null probe with `verified: false` is an app that publishes nothing
           * safe to check a key against, and a named probe with the same flag is a key the vendor
           * rejected on an account this deployment could not take back. A route that forwarded the
           * boolean alone would leave the row to infer which of those two it was, and it would tell
           * the second person that nothing had ever been tried.
           */
          return context.json(
            shared
              ? await store.connectSharedWithFields({
                  toolkit,
                  values,
                  by: context.var.actor.id,
                })
              : await store.connectBrokeredWithFields({
                  toolkit,
                  userId: context.var.actor.id,
                  values,
                }),
          );
        } catch (error) {
          /*
           * A REFUSAL THE STORE AUTHORED IS PASSED THROUGH AS ITSELF, BEFORE THE BROKER MAPPING.
           *
           * A mistyped key is the ordinary failure on this path — a token from the wrong workspace,
           * a key pasted with a newline — and the store's sentence for it already carries the
           * vendor's own words and the step to take. `brokerRefusal` cannot see that: a
           * {@link PluginRefusedError} is neither an authored broker refusal nor a vendor object,
           * so it would come back as "Composio said nothing about why", sending somebody whose key
           * was rejected to ask an administrator about this deployment's Composio key. 400 for the
           * reason the skills route gives its own refusal one: it is something the person who made
           * the request can fix, and the message says what to fix.
           */
          const generic = `没能用你填写的内容连接 ${row.title}。请重试；如果一直这样，请联系管理员。`;
          if (error instanceof PluginRefusedError) {
            return context.json(
              { error: withoutBrokerName(error.message) },
              400,
            );
          }
          const refusal = personRefusal(error, generic, {
            route: "connect.fields",
            toolkit,
          });
          return context.json({ error: refusal.error }, refusal.status);
        }
      }

      /*
       * A SCHEME THIS DEPLOYMENT CANNOT READ IS REFUSED, AND IS NOT WALKED INTO THE CONSENT FLOW.
       *
       * `unreadable` is a null column or a literal nothing here writes — which is an ordinary row
       * rather than a corrupt one: `mcp_servers.url` carries no unique index, so the row that
       * answers for an app is not always the row an enable wrote a scheme onto, and a row may have
       * been inserted by hand or restored from a deployment that knew other names. Reached by
       * elimination, it arrived at the arm below and minted an authorization link at Composio for an
       * app this deployment holds no consent config for — a call spent at the vendor, and a link
       * whose only possible end is the person failing to complete it at a screen that has nothing
       * to ask them.
       *
       * THE REMEDY IS AN ADMINISTRATOR'S, because nothing the person pressing Connect can do
       * changes which scheme this deployment recorded for the app. Re-adding it is what writes the
       * column again, which is the same remedy the field branch above names for its own two
       * unreadable-app states. 400 rather than 503: it is a fact about this one app's row and not
       * about the deployment's settings.
       */
      if (kind === "unreadable") {
        return context.json(
          {
            // English, because the route's tests pin "cannot tell how"; no provider named (upstream #1223).
            error: `OpenBot cannot tell how ${row.title} connects, so nothing was sent and no account was made. ${askAdminTo(`remove it on the ${appsPage()} page and add it again`)}.`,
          },
          400,
        );
      }

      /*
       * NO APP URL IS A REFUSAL, NOT A LINK WITH NO WAY BACK.
       *
       * The address below is where Composio sends this person once they have consented, and it has
       * to be absolute: the consent screen is on another company's origin, so a relative path
       * resolves against theirs. A deployment that cannot say where its own pages are cannot
       * produce one — and minting the link anyway would leave somebody stranded on Composio's
       * hosted page having just granted access, with no route back to the deployment that asked
       * for it and nothing here knowing it happened.
       *
       * The OAuth flow below refuses for its missing `OPENBOT_PUBLIC_URL` in these same terms and
       * for this same reason. `OPENBOT_APP_URL` is the setting here because the two addresses are
       * genuinely different: the API is one origin and the browser app is another, and it is a
       * page this person is coming back to rather than an endpoint.
       *
       * BELOW BOTH BRANCHES ABOVE AND NOT IN FRONT OF THEM, FOR THE REASON THIS BRANCH'S OWN HEADER
       * GIVES ONE GUARD EARLIER. Neither an app whose secret the person types nor one that needs no
       * credential at all mints a link or has a return leg, so this setting has no bearing on either
       * flow — and standing before the fork, this guard meant no key app and no no-auth app could be
       * connected on a deployment without `OPENBOT_APP_URL`, refused in the name of a remedy that
       * would not have helped. It stays after the one-account guard for
       * the reason that guard's own comment gives: somebody who already has an account attached is
       * told the step to take, rather than handed an operator's configuration complaint about a
       * link that was never going to be minted for them.
       */
      if (!connect?.appUrl) {
        return context.json(
          {
            error:
              "This deployment has no app URL configured, so Composio would have nowhere to send you back to. Set OPENBOT_APP_URL.",
          },
          503,
        );
      }

      /*
       * WHERE THE CONSENT COMES BACK TO, BUILT HERE AND NEVER READ OFF THE REQUEST.
       *
       * Composio sends the person to this address when they are done, so whoever chooses it
       * chooses where somebody lands holding a just-completed consent. A url taken from the body,
       * the query or a header would therefore be an open redirect with a consent screen in front
       * of it — the exact thing {@link ConnectOrigin} exists to stop on the OAuth flow below, and
       * it is narrowed here in the same way: the caller may name one of two PAGES, and the origin
       * underneath them is this deployment's configured app URL in both cases.
       *
       * Both pages confirm on load, which is what makes either of them a correct destination: the
       * return trip carries nothing signed, so arriving proves nothing, and the page asks Composio
       * whether the account is really attached before anything here says it is.
       */
      const returnTo: ConnectOrigin =
        context.req.query("returnTo") === "admin" ? "admin" : "settings";

      /*
       * THE URL IS A BEARER CAPABILITY. Whoever opens it attaches an account to this person's
       * connection, so it is answered to the browser that asked and to nothing else: not logged,
       * not audited, not put in an error body. A redirect url in a log line is somebody else's
       * mailbox for as long as it stays valid — which is why the failure below answers with the
       * vendor's sentence and never with what was being minted when it failed.
       */
      // X5：Arcade 的连接先在发起人名下认领一次尝试，回程由 `/arcade/verify` 核对并记录。
      if (composio.arcade) {
        if (another) {
          return context.json(
            {
              error: `用 Arcade 连接时，一个人在 ${row.title} 上暂时只能连接一个账号。没有建立任何连接。`,
            },
            409,
          );
        }
        let returnUrl: string;
        try {
          returnUrl = brokerReturnUrl(
            connectedAccountsUrlFor(connect.appUrl, { serverId }, returnTo),
          );
        } catch (error) {
          const refusal = personRefusal(
            error,
            `没能开始连接 ${row.title}。请重试；如果一直这样，请联系管理员。`,
            { route: "connect.consent", toolkit },
          );
          return context.json({ error: refusal.error }, refusal.status);
        }
        return startArcadeAuthorization(
          context,
          { store, arcade: composio.arcade, appUrl: connect.appUrl },
          {
            serverId,
            account:
              shared && app?.shared
                ? { holder: "deployment", vendorUserId: holderId }
                : personAccount(holderId, null),
            toolkit,
            title: row.title,
            returnUrl,
          },
        );
      }

      let redirectUrl: string;
      try {
        ({ redirectUrl } = await composio.broker.authorize({
          userId: holderId,
          toolkit,
          ...(another ? { another: true } : {}),
          /*
           * THE REFUSAL ABOVE CHECKS THAT A SETTING IS SET; THIS CHECKS THAT IT IS AN ADDRESS.
           * `appUrl` is an environment string — `OPENBOT_APP_URL`, or the first `TRUSTED_ORIGINS`
           * entry — and nothing between there and Composio has ever looked at it, so
           * `openbot.example.com` with the scheme left off builds a callback that is not a
           * callback. That failure lands after somebody has consented, on the vendor's page, where
           * this deployment cannot tell them anything; the guard moves it to before the link is
           * minted, where the sentence reaches an operator who can set the variable.
           */
          /*
           * `?from=desktop` is the press's own: the sign-in was started in OpenBot Desktop's window
           * and runs in the person's browser, so it comes back to the page that hands them back to
           * the window ({@link desktopReturnUrlFor}). Anybody can send it, and all it changes is which
           * of this OpenBot's own pages the browser lands on.
           */
          returnUrl: brokerReturnUrl(
            context.req.query("from") === "desktop"
              ? desktopReturnUrlFor(connect.appUrl, serverId)
              : connectedAccountsUrlFor(connect.appUrl, { serverId }, returnTo),
          ),
        }));
      } catch (error) {
        const refusal = personRefusal(
          error,
          `没能开始连接 ${row.title}。请重试；如果一直这样，请联系管理员。`,
          { route: "connect.consent", toolkit },
        );
        return context.json({ error: refusal.error }, refusal.status);
      }
      return context.json({ authorizationUrl: redirectUrl });
    }

    if (!connect?.publicUrl) {
      return context.json(
        {
          error:
            "This deployment has no public URL configured, so it cannot complete a consent flow. Set OPENBOT_PUBLIC_URL.",
        },
        503,
      );
    }

    const entry = catalogueEntryAt(row, serverId);
    if (entry?.auth.kind !== "user-oauth") {
      return context.json(
        { error: `${serverId} is not connected as an individual person.` },
        400,
      );
    }

    /*
     * A dynamic entry introduces the deployment itself on first use; a manual one still waits
     * for an administrator. Registration lives here, on the one handler that already refuses
     * without OPENBOT_PUBLIC_URL — the redirect URI it registers is guaranteed to exist.
     */
    /*
     * A vendor in the catalogue that nobody has added to this deployment reaches here, gets past
     * every check above — the entry is real — and then asks the store for a client it cannot have,
     * because there is no server row to hold one. `ensureOAuthClient` says so by throwing, and
     * unhandled that was a 500 on the one path where a person is trying to connect their account.
     *
     * The same 409 as a vendor whose client an administrator has not pasted in yet, because it is
     * the same situation: the person pressing Connect has no step to take, and an administrator has
     * one. The sentence names the step rather than the exception.
     */
    let client: OAuthClient | null;
    try {
      client =
        (await store.oauthClientFor(serverId)) ??
        (entry.auth.clientRegistration === "dynamic"
          ? await store.ensureOAuthClient(serverId, actorEmail(context))
          : null);
    } catch (error) {
      if (error instanceof CatalogueEntryUnknownError) {
        return context.json(
          {
            error: `${entry.title} has not been added to this deployment yet. An administrator has to add it first.`,
          },
          409,
        );
      }
      /*
       * A first connect to a self-registering vendor by somebody who may not store the deployment's
       * client (G01-E P10): an administrator's connect registers it. The same 409 as a client nobody
       * has pasted in, for the same reason: an administrator has the step to take.
       */
      if (error instanceof PluginRefusedError) {
        return context.json({ error: error.message }, 409);
      }
      /*
       * The deployment holds a client and this replica could not read it: a vault fault, or a key
       * that will not decrypt it. Nothing was registered over it, because that would replace the
       * client for every replica that still can. Recorded, and answered as a fault rather than as a
       * missing client: there is nothing for the person to fix, and nothing of the fault is said.
       */
      if (error instanceof OAuthClientReadError) {
        await store.recordOAuthClientReadFailure({
          serverId,
          actorId: context.var.actor.id,
        });
        return context.json(
          {
            error: `暂时无法连接 ${entry.title}。请稍后重试；如果一直这样，请联系管理员。`,
          },
          503,
        );
      }
      throw error;
    }
    if (!client) {
      if (entry.auth.clientRegistration === "dynamic") {
        return context.json(
          {
            error: `${entry.title} would not register this deployment, or could not be reached. Try again, and check the vendor's status if it persists.`,
          },
          502,
        );
      }
      return context.json(
        {
          error: `${entry.title} has no OAuth client registered yet. An administrator has to add one first.`,
        },
        409,
      );
    }

    /*
     * Where to come back to, as one of two names rather than a URL the caller chose.
     *
     * Read from the query and narrowed immediately, so an unrecognised value is the default rather
     * than something carried into a sealed state. See {@link ConnectOrigin}: a destination that could
     * name another origin is an open redirect with a consent screen in front of it.
     */
    const returnTo =
      context.req.query("returnTo") === "admin" ? "admin" : "settings";

    const verifier = createVerifier();
    return context.json({
      authorizationUrl: authorizationUrlFor({
        auth: entry.auth,
        clientId: client.clientId,
        redirectUri: redirectUriFor(connect.publicUrl),
        state: await sealConnectState(
          { userId: context.var.actor.id, serverId, verifier, returnTo },
          connect.encryptionKey,
        ),
        codeChallenge: challengeFor(verifier),
      }),
    });
  });

  /**
   * Which app one of the three routes below is about, or the refusal that ends it.
   *
   * Each of them acts on a brokered connection and on nothing else, so each asks the same two
   * questions in the same order and answers them in the same words. It is one function because the
   * sentence somebody reads when they aim any of those routes at an ordinary OAuth row should not
   * be able to drift into three sentences.
   *
   * THE APP COMES OFF THE ROW'S URL AND NEVER OFF ITS ID, for the reason the directory route and
   * the connect branch above both give: the url is where the transport reads which app a call is
   * against, and the id is a row name that happens to look similar.
   *
   * ONE ROW, BY ID, AND CONFIRM IS WHY. Both brokered account screens call that route from an
   * effect when they mount, so this read runs on every page load — and it used to be
   * `listServers`, which materialises every tool and every grant in the deployment to answer
   * whether one row is brokered.
   *
   * A ROW THAT IS NOT BROKERED IS REFUSED IN SO MANY WORDS. The id may well name a server this
   * deployment really has — what is wrong is that its connection does not live at Composio, and
   * there is nothing for either route to confirm or to end. `null` from `toolkitOf` also covers an
   * id naming no row at all, which is the same answer from the caller's side.
   *
   * NO BROKER IS A 503 NAMING THE SETTING, as it is on the directory and on connect, and it is
   * {@link BrokerUnconfiguredError}'s own message rather than a sentence written here.
   *
   * The connect route's brokered branch does not come through this function, deliberately: a row
   * that is not brokered has an OAuth flow below it to fall through to, so refusing there would be
   * wrong.
   */
  /*
   * 应用的账号模式与团队账号（X1）。只认识地址的 store（老的测试替身、没有账号模式的装配）没有这个方法，
   * 那就当作 Personal，与 0180 之前一样。
   */
  const appAccountOf = (toolkit: string) =>
    typeof store.appAccount === "function"
      ? store.appAccount(toolkit)
      : Promise.resolve(null);

  /** 会话里写着管理员、但这次请求没有拿到管理员能力（角色已被收回，或这个部署没有接能力）时答的话。 */
  const CAPABILITY_UNCONFIRMED = "你的管理员身份没能确认，没有改变任何东西。";

  /** 一行应用所属的那个应用现在的账号模式（读应答行）；不是 broker 应用、或没有这一行为 null。 */
  const accountModeOfServer = async (
    serverId: string,
  ): Promise<"personal" | "shared" | null> => {
    const row = await store.serverAddress(serverId);
    const toolkit = row ? toolkitOf(row.url) : null;
    return toolkit ? ((await appAccountOf(toolkit))?.mode ?? null) : null;
  };

  const brokeredAppFor = async (
    serverId: string,
  ): Promise<
    | { toolkit: string; shared: boolean; refusal?: undefined }
    | { toolkit?: undefined; refusal: { error: string; status: 400 | 503 } }
  > => {
    const row = await store.serverAddress(serverId);
    const toolkit = row ? toolkitOf(row.url) : null;
    if (!toolkit) {
      return {
        refusal: {
          error: "That app is not reached through a broker.",
          status: 400,
        },
      };
    }
    if (!composio) {
      return {
        refusal: { error: PERSON_UNCONFIGURED, status: 503 },
      };
    }
    const app = await appAccountOf(toolkit);
    return {
      toolkit,
      shared:
        app?.mode === "shared" &&
        schemeKind(row?.authScheme ?? null) !== "none",
    };
  };

  /*
   * Shared 应用的团队账号（X1）：确认、重新检查与断开都只由管理员做，作用在应用行上，不碰任何人的
   * `composio_connections`。重新检查对团队账号就是再问一次 vendor（与确认相同）。
   */
  const sharedAccountAct = async (
    context: Context<{ Variables: AppVariables }>,
    toolkit: string,
    act: "confirm" | "disconnect",
  ) => {
    if (context.var.actor.role !== "admin") {
      return context.json(
        { error: "这个应用用的是共享的团队账号，只有管理员能管理它。" },
        403,
      );
    }
    try {
      return context.json(
        act === "confirm"
          ? await store.confirmSharedConnection({
              toolkit,
              by: context.var.actor.id,
            })
          : await store.disconnectShared({
              toolkit,
              by: context.var.actor.id,
              reason: "self",
            }),
      );
    } catch (error) {
      if (isServerWriteRefusal(error)) {
        return context.json(
          { error: "这个应用用的是共享的团队账号，只有管理员能管理它。" },
          403,
        );
      }
      if (error instanceof PluginRefusedError) {
        return context.json({ error: withoutBrokerName(error.message) }, 400);
      }
      const refusal = personRefusal(
        error,
        act === "confirm"
          ? "没能确认团队账号。请重试；如果一直这样，请检查代理服务的配置。"
          : "没能断开团队账号。请再按一次「断开」，重复按是安全的。",
        { route: `shared.${act}`, toolkit },
      );
      return context.json({ error: refusal.error }, refusal.status);
    }
  };

  /**
   * Ask Composio whether this person's account is really attached, and write the answer down.
   *
   * THE ROUTE EXISTS SO THAT THE VENDOR IS ASKED. The return trip from a consent screen is an
   * ordinary redirect with nothing signed in it, so a browser landing back on the settings page
   * proves nothing: not that the flow finished, and not that it finished with the account a row
   * would go on to claim. Composio tells this deployment nothing by itself — there is no callback
   * of ours in that flow — so unless something asks, all that stands behind the gate every later
   * brokered call passes through is a guess about what a redirect meant.
   *
   * AND IT IS MEANT TO BE CALLED AGAIN, on any page load, which is the other half of why it is
   * here. The row is only a cache of the vendor's last answer, so it drifts by construction — an
   * account ended in Composio's own dashboard, a consent this deployment never saw finish — and
   * calling this heals it in whichever direction it went: written where the vendor says yes,
   * deleted where it says no. Repeating it files no trail rows and moves no timestamps; the store
   * is where that is settled.
   *
   * BEHIND `requireUser` AND NOT ADMIN-GATED. An administrator adds the app once; confirming one's
   * own connection to it is not an administrative act.
   */
  routes.post("/servers/:id/connection/confirm", capable, async (context) => {
    const resolved = await brokeredAppFor(context.req.param("id"));
    if (resolved.refusal) {
      return context.json(
        { error: resolved.refusal.error },
        resolved.refusal.status,
      );
    }
    if (resolved.shared)
      return sharedAccountAct(context, resolved.toolkit, "confirm");

    /*
     * THE PERSON IS THE SESSION'S, AND THERE IS NO SECOND SOURCE FOR THEM. Nothing here reads a
     * user id out of the body or the query, and that is the property rather than an
     * implementation detail: a confirm writes the row every later brokered call is gated on, so
     * a caller who could name somebody else would be one POST away from recording a connection
     * under a person who never made one — or, the same defect turned around, from deleting the
     * row of a person the vendor answers no for.
     *
     * The store's answer is passed straight back rather than restated here. `connected` is what
     * Composio said, and a shape invented at this layer would be a second opinion about a fact
     * only the vendor holds.
     */
    try {
      return context.json(
        await store.confirmBrokeredConnection({
          toolkit: resolved.toolkit,
          userId: context.var.actor.id,
        }),
      );
    } catch (error) {
      /*
       * A BROKER THAT WOULD NOT ANSWER IS NOT A CONNECTION THAT IS ABSENT.
       *
       * This route is called on every page load, so the tempting answer to a failure is
       * `{ connected: false }` — and that would be this deployment inventing a fact only Composio
       * holds, drawing "Not connected" over a live account and, one step on, deleting the row
       * that says otherwise. The store deletes on a NO from the vendor, and a failure is not a
       * no. So the page is told the ask failed, and what it goes on showing is the last answer
       * Composio gave rather than a guess about this one.
       */
      const refusal = personRefusal(
        error,
        /*
         * English, because the route's existing tests pin "last answer"; upstream #1223's own
         * wording, which names no broker.
         */
        "Couldn't check whether this account is connected. This shows the last answer. Try again, or ask an admin if it keeps happening.",
        { route: "connection.confirm", toolkit: resolved.toolkit },
      );
      return context.json({ error: refusal.error }, refusal.status);
    }
  });

  /**
   * Try this person's key against the app, because they pressed the button that asks.
   *
   * A BUTTON, AND NEVER A PAGE-LOAD EFFECT, which is the one thing a caller of this route has to
   * know. Composio never re-checks a key — it accepts one when it is typed and says nothing about it
   * again — so this is the only thing in the product that can correct a row whose key was rotated,
   * revoked or left to expire. That is also the argument somebody will make for calling it from an
   * effect on mount, and it is wrong: the call goes out to the app on the person's OWN account and
   * against their own rate limit at the vendor, so verifying on every render would spend somebody's
   * quota at Linear to redraw one word on a settings page. The confirm route above is the one that
   * runs on mount; it asks Composio about its own records and costs the person nothing.
   *
   * AND IT IS NOT A CONNECT. The store's argument is made there in full: the account already exists,
   * so nothing here creates one, nothing withdraws one when the key turns out to be bad — their
   * account stays, it is their key that is wrong — and nothing changes but the verification and its
   * date.
   *
   * A PROBE THAT RAN AND FAILED COMES BACK AS A FAILURE, never as a 200 saying `verified: false`.
   * That flag is also what an app publishing nothing safe to call produces, and the row drawing this
   * answer cannot tell the two apart — so an answer would quietly drop the Re-check button in
   * exactly the state somebody needs it, having just fixed their key, while telling them nothing had
   * ever been checked. The store raises with Composio's own sentence in it, and this passes that
   * through as a refusal the browser surfaces. The only `verified: false` that arrives as an answer
   * is the one carrying `probe: null`, which says there was nothing to check with.
   *
   * THE PERSON IS THE SESSION'S, as on the two routes around it and for the sharper reason this one
   * adds: a user id a caller could name would let one POST spend a stranger's rate limit at the
   * vendor and rewrite the verification on their row. Nothing here reads a user id out of the body
   * or the query.
   *
   * BEHIND `requireUser` AND NOT ADMIN-GATED, for confirm's reason: this is somebody checking their
   * own account, not an administrator checking anybody's.
   */
  routes.post("/servers/:id/connection/recheck", capable, async (context) => {
    const resolved = await brokeredAppFor(context.req.param("id"));
    if (resolved.refusal) {
      return context.json(
        { error: resolved.refusal.error },
        resolved.refusal.status,
      );
    }
    if (resolved.shared)
      return sharedAccountAct(context, resolved.toolkit, "confirm");

    try {
      // The store's answer, whole. `verified` is the flag, `verifiedAt` is the date the row's
      // sentence is drawn from, and `probe` is what says a call was really made — three facts,
      // and a route that forwarded the boolean alone would leave the row to guess the other two.
      return context.json(
        await store.recheckBrokeredConnection({
          toolkit: resolved.toolkit,
          userId: context.var.actor.id,
        }),
      );
    } catch (error) {
      /*
       * A REFUSAL THE STORE AUTHORED IS PASSED THROUGH AS ITSELF, BEFORE THE BROKER MAPPING, for
       * the reason the connect route's field branch gives: a key the vendor rejected is the
       * ordinary failure on this path, and the store's sentence for it already carries Composio's
       * own words and the step to take. `brokerRefusal` cannot see that — a
       * {@link PluginRefusedError} is neither an authored broker refusal nor a vendor object — so
       * it would answer somebody whose key is wrong with "Composio said nothing about why" and
       * send them to an administrator about this deployment's key. 400 because it is theirs to
       * fix and the message says what to fix.
       */
      const generic =
        "没能检查这个连接是否还能用，这里显示的是上一次检查的结果。请再按一次重新检查；如果一直这样，请联系管理员。";
      if (error instanceof PluginRefusedError) {
        return context.json({ error: withoutBrokerName(error.message) }, 400);
      }
      /*
       * And a failure this deployment cannot explain says what is on the screen instead of
       * guessing. Nothing was written on the way out of the store here, so the row still carries
       * the last answer anybody earned rather than a verdict invented by a call that failed.
       */
      const refusal = personRefusal(error, generic, {
        route: "connection.recheck",
        toolkit: resolved.toolkit,
      });
      return context.json({ error: refusal.error }, refusal.status);
    }
  });

  /**
   * End this person's own brokered account, at the vendor first and here after.
   *
   * The order is the store's and the argument for it is made there: the row is the only thing that
   * says which app this person connected, so a delete that ran before the revoke could leave a live
   * grant on somebody's mailbox that nothing here can reach. What comes back is what was asked for
   * — `vendorRevocationRequested` false is a grant that was already gone — and it is passed through
   * rather than rewritten, because telling those two apart is the whole value of the field.
   *
   * `reason` IS "self" BECAUSE OF WHO IS ASKING. The other word the store takes is
   * `person_removed`, which belongs to an administrator offboarding somebody from the People
   * screen. The trail tells the two acts apart by this word and by whether `by` and the owner
   * differ, and on this route they are the same person by construction.
   *
   * BEHIND `requireUser` AND NOT ADMIN-GATED, for the reason confirm gives: this is somebody
   * ending their own account, not an administrator ending anybody's.
   */
  routes.delete("/servers/:id/connection", capable, async (context) => {
    const resolved = await brokeredAppFor(context.req.param("id"));
    if (resolved.refusal) {
      return context.json(
        { error: resolved.refusal.error },
        resolved.refusal.status,
      );
    }
    if (resolved.shared)
      return sharedAccountAct(context, resolved.toolkit, "disconnect");

    /*
     * WHOSE ACCOUNT THIS IS COMES FROM THE SESSION, here as on confirm and for a sharper reason: a
     * user id a caller could name would be a DELETE that revokes somebody else's grant at the
     * vendor. It is read once, from `context.var.actor`, and used for both the owner and the actor
     * — nothing in the body or the query is looked at at all.
     */
    try {
      const disconnected = await store.disconnectBrokered({
        toolkit: resolved.toolkit,
        userId: context.var.actor.id,
        by: context.var.actor.id,
        reason: "self",
      });
      /*
       * X5：Arcade 按认证提供商存连接，同一提供商下厂商那边也结束了的兄弟应用一并结束本地行。每一次断开
       * 成功都做，厂商那边本来就没有连接（`vendorRevocationRequested` 为 false）时也做：上一次断开时对账
       * 没做完（例如问不到认证提供商），再按断开就是补做的机会，不能因为这次没有可撤销的就跳过。
       */
      if (composio?.arcade) {
        const siblings = await clearEndedArcadeSiblings({
          store,
          arcade: composio.arcade,
          userId: context.var.actor.id,
          toolkit: resolved.toolkit,
        });
        return context.json({ ...disconnected, siblings });
      }
      return context.json(disconnected);
    } catch (error) {
      /*
       * REPEATING IT IS THE RECOVERY, AND THE SENTENCE SAYS SO RATHER THAN GUESSING HOW FAR IT GOT.
       *
       * The revoke runs before anything here is deleted, which is what makes a second press safe:
       * whatever this failed at, the state it leaves is access dead or access untouched, never
       * access live with nothing here able to reach it. Claiming "nothing was changed" would be a
       * guess — a delete that succeeded and an audit write that did not is the same throw — and the
       * one thing a person needs is the button to press, not this deployment's theory of where it
       * stopped.
       */
      const refusal = personRefusal(
        error,
        // English for the same reason as confirm's: the route's tests pin "Disconnect again".
        "Couldn't disconnect this account. Press Disconnect again. It's safe to repeat. Ask an admin if it keeps happening.",
        { route: "connection.disconnect", toolkit: resolved.toolkit },
      );
      return context.json({ error: refusal.error }, refusal.status);
    }
  });

  /**
   * 断开这个应用还会连带结束哪些应用，给确认框在按下之前显示（上游的
   * `GET /servers/:id/connection/siblings`）。答 `{ siblings, unanswered }`：别的应用的名字（排好序），和
   * 同一个身份下问不出认证提供商、因而没法判断的应用个数（只是个数，从不给名字）。只回答，不撤销、不
   * 删行、不写轨迹。
   *
   * 名单是上面那次断开用的同一套（`./arcade-routes`）：断开之后收拾兄弟应用看的，和这里预告的，是这个人
   * 持有的同一批应用、同一个「认证提供商是不是同一个」的判断，所以预告和级联不会说出两份名单。
   *
   * 谁能问，和它预告的那次断开同一道门：应用按地址认、没有 broker 答 503，都是 `brokeredAppFor` 的答案；
   * 个人账号应用问的是会话里这个人自己的连接，请求里没有任何东西能指到别人；Shared 应用的团队账号只有
   * 管理员能断开，所以也只有管理员能问。
   *
   * 团队账号总是答空：每个 Shared 应用的团队身份是切换时各铸各的，两个 Shared 应用即使同在一个认证提供商
   * 下也不共用连接。Composio 一个应用一个账号，同样总是空。
   */
  routes.get(
    "/servers/:id/connection/siblings",
    requireUser,
    async (context) => {
      const resolved = await brokeredAppFor(context.req.param("id"));
      if (resolved.refusal) {
        return context.json(
          { error: resolved.refusal.error },
          resolved.refusal.status,
        );
      }
      if (resolved.shared && context.var.actor.role !== "admin") {
        return context.json(
          { error: "这个应用用的是共享的团队账号，只有管理员能管理它。" },
          403,
        );
      }
      if (resolved.shared || !composio?.arcade) {
        return context.json({ siblings: [], unanswered: 0 });
      }
      try {
        return context.json(
          await arcadeConnectionSiblings({
            store,
            arcade: composio.arcade,
            userId: context.var.actor.id,
            toolkit: resolved.toolkit,
          }),
        );
      } catch (error) {
        const refusal = personRefusal(
          error,
          "没能判断还有哪些应用共用这个连接，请重试。",
          { route: "connection.siblings", toolkit: resolved.toolkit },
        );
        return context.json({ error: refusal.error }, refusal.status);
      }
    },
  );

  /**
   * Where the vendor sends somebody back.
   *
   * Deliberately not behind `requireUser`. The person arrives on a redirect from another company's
   * server, and whose connection this is comes from the sealed state rather than from whatever
   * session the browser happens to be carrying — which is what stops a callback delivered to the
   * wrong browser from attaching one person's Google account to another person's row.
   *
   * Having no session is what makes the access check below necessary. Every other route asks the
   * question by being behind a guard; this one has to ask it out loud.
   *
   * Every failure ends the same way: back at Settings with a word about what happened, and nothing
   * written. There is no useful distinction here for the person between a forged state and an expired
   * one, and spelling out which is which tells anybody probing this endpoint how far they got.
   */
  /*
   * 一个人在一个 broker 应用上的多个账号（上游 #1298）。账号永远是会话里那个人的：路由里没有一处从请求
   * 里读用户 id，所以一个人只能列出、设默认、断开他自己的账号。账号 id 对浏览器不透明，不是 vendor 的 id。
   *
   * GET 每次按 vendor 现在列出的重建（`syncBrokeredAccounts`），所以页面上列出的从来不只是这里的一行记录。
   */
  const brokeredAccountsAt = async (
    serverId: string,
  ): Promise<
    | { toolkit: string; title: string; refusal?: undefined }
    | {
        toolkit?: undefined;
        refusal: { error: string; status: 400 | 503 };
      }
  > => {
    const row = await store.serverAddress(serverId);
    const resolved = await brokeredAppFor(serverId);
    if (resolved.refusal) return { refusal: resolved.refusal };
    const title = row?.title ?? serverId;
    // Shared 应用只有一个团队账号，没有个人账号可列、可设默认、可单个断开（X1）。
    if (resolved.shared)
      return {
        refusal: {
          error: `${title} 用的是一个共享的团队账号，没有个人账号。`,
          status: 400,
        },
      };
    return { toolkit: resolved.toolkit, title };
  };

  routes.get("/servers/:id/accounts", requireUser, async (context) => {
    const shared = await brokeredAppFor(context.req.param("id"));
    if (!shared.refusal && shared.shared)
      return context.json({ accounts: [], canAddAnother: false });
    const resolved = await brokeredAccountsAt(context.req.param("id"));
    if (resolved.refusal) {
      return context.json(
        { error: resolved.refusal.error },
        resolved.refusal.status,
      );
    }
    try {
      const accounts = await store.syncBrokeredAccounts({
        toolkit: resolved.toolkit,
        userId: context.var.actor.id,
      });
      return context.json({
        accounts,
        canAddAnother: Boolean(composio?.broker.accountsOf),
      });
    } catch (error) {
      const refusal = personRefusal(
        error,
        `没能列出你的 ${resolved.title} 账号。请刷新页面。`,
        { route: "accounts.list", toolkit: resolved.toolkit },
      );
      return context.json({ error: refusal.error }, refusal.status);
    }
  });

  routes.post(
    "/servers/:id/accounts/:accountId/default",
    requireUser,
    async (context) => {
      const resolved = await brokeredAccountsAt(context.req.param("id"));
      if (resolved.refusal) {
        return context.json(
          { error: resolved.refusal.error },
          resolved.refusal.status,
        );
      }
      const changed = await store.setDefaultBrokeredAccount({
        toolkit: resolved.toolkit,
        userId: context.var.actor.id,
        id: context.req.param("accountId"),
      });
      if (!changed) {
        return context.json({ error: "这个账号没有连接。请刷新页面。" }, 404);
      }
      return context.json({ ok: true });
    },
  );

  routes.delete(
    "/servers/:id/accounts/:accountId",
    requireUser,
    async (context) => {
      const resolved = await brokeredAccountsAt(context.req.param("id"));
      if (resolved.refusal) {
        return context.json(
          { error: resolved.refusal.error },
          resolved.refusal.status,
        );
      }
      try {
        const ended = await store.disconnectBrokeredAccount({
          toolkit: resolved.toolkit,
          userId: context.var.actor.id,
          id: context.req.param("accountId"),
          by: context.var.actor.id,
        });
        if (ended === null) {
          return context.json({ error: "这个账号没有连接。请刷新页面。" }, 404);
        }
        // 最后一个账号：整个连接一起断开，走这个应用一直以来的那条路径。
        if ("only" in ended) {
          return context.json(
            await store.disconnectBrokered({
              toolkit: resolved.toolkit,
              userId: context.var.actor.id,
              by: context.var.actor.id,
              reason: "self",
            }),
          );
        }
        return context.json(ended);
      } catch (error) {
        const refusal = personRefusal(
          error,
          "没能断开这个账号。请再按一次「断开」，重复按是安全的；如果一直这样，请联系管理员。",
          { route: "accounts.disconnect", toolkit: resolved.toolkit },
        );
        return context.json({ error: refusal.error }, refusal.status);
      }
    },
  );

  /*
   * 应用的账号模式（X1，上游 #757）：Personal（每个人自己的账号）⇄ Shared（部署的一个团队账号）。只有
   * 管理员能看预览和切换。切换先在 vendor 处撤销旧模式的每个账号，全部成功才改模式；见
   * `./account-mode`。没有接线（`accountModes` 未给）的部署答 503。
   *
   * GET  /servers/:id/account-mode?mode=shared|personal → { mode, current, wouldRevoke: { holder, count }, bots }
   * PUT  /servers/:id/account-mode { mode, confirm, approvals? }
   *        → { changed, revoked } | { changed, revoked, approved, approvalsFailed? }（送了 approvals 时）|
   *          { changed: false, preview } | { changed: false, failures: [{ account, error }] }
   */
  const accountModeOf = (value: unknown) =>
    value === "personal" || value === "shared" ? value : null;

  /*
   * 切到 Shared 时管理员在同一步里定下哪些员工可以用团队账号（上游 `account-mode.ts` 的 `bots` 与
   * `approvals`）。
   *
   * 预览里的 `bots`：持有这个应用的每位有主人的员工，和它此刻的开放范围（`exposureOf`），也就是管理员照单
   * 批准时会记下的那一条。谁持有，经 store 那道跨主人的门读（`botsHolding`，先要管理员能力）；每位员工的
   * 开放范围在它主人的帧里读（`asBotOwner`）。没有主人的员工不列：fork 的批准记在员工主人名下，它没有
   * 地方记。没有共享使用、或这次请求没有管理员能力时为空。
   *
   * 确认时的 `approvals`（按员工 id）：只为点到的、而且在这份名单里的员工记批准。没点到的员工不记，它对
   * 团队账号的调用照旧被拒绝，直到有人批准——上游在这里会替没点到的员工按开放范围自动批准，fork 留着
   * 「没有批准就拒绝」这条线，要照单全批的页面把预览里的 `exposure` 原样送回来即可。
   *
   * 顺序：批准写在切换完成之后。切换在应用的排他锁下把模式改成 Shared 并结束旧批准（`setAccountModeColumns`），
   * 写批准拿同一把锁的共享锁、在锁里重读模式（`setApproval`）；先写的批准会被切换删掉，而且应用还不是
   * Shared 时根本写不进去。两步之间只有一个「已经是 Shared、还没有批准」的时刻，那一刻每次调用都被拒绝，
   * 是关着的方向。这期间应用被别人切走，写入读到新模式就不写。
   */
  const sharedBotsOf = async (
    context: { var: AppVariables },
    serverId: string,
  ): Promise<{ botId: string; exposure: SharedUseApproval }[]> => {
    if (
      !sharedUse ||
      typeof store.botsHolding !== "function" ||
      decisionRefusal(context) !== null
    )
      return [];
    const shared = sharedUse;
    const appId = await shared.store.appIdOf(serverId);
    const bots: { botId: string; exposure: SharedUseApproval }[] = [];
    for (const botId of await store.botsHolding(appId)) {
      try {
        if (!(await shared.audience.ownerOf(botId))) continue;
        const facts = await asBotOwner(context, botId, () =>
          shared.store.botFacts(botId),
        );
        // 在主人的帧里也读不到资料（已删除）的员工，开放范围说不准，不列。
        if (facts.ownerUserId === null) continue;
        bots.push({ botId, exposure: exposureOf(facts) });
      } catch (error) {
        // 一位员工读不出来不拖垮整份名单：它不列，也就不会被批准，调用照旧被拒绝。
        console.error(
          JSON.stringify({
            type: "account-mode-bot-not-listed",
            app: appId,
            bot: botId,
            note: "This Bot's exposure could not be read, so it is left out of the list and gets no approval from this switch.",
            error: reasonWithoutStatement(error),
          }),
        );
      }
    }
    return bots;
  };

  /**
   * 管理员定下的一条批准：写在员工主人名下，再写一行轨迹。答批准有没有记上。调用方已经确认过送的人持有
   * 管理员能力，并且已经在员工主人的帧里（`asBotOwner`）。
   *
   * 没有地方记（员工没有主人，或应用在这之间不再是 Shared）答 false：没有批准是关着的方向，闸门拒绝团队
   * 账号，和一次保存几个动作的那条路由答同一种情况时一样。
   *
   * 批准和轨迹是两步，分开对待：批准已经提交之后轨迹没写上，批准是生效的，答 true，另记一条日志说明
   * 「批准已生效、轨迹缺这一行」。把这种情况报成没记上，页面和日志都会说一件相反的事。
   */
  const recordAdminApproval = async (
    context: { var: AppVariables },
    shared: NonNullable<typeof sharedUse>,
    input: {
      botId: string;
      appId: string;
      approval: SharedUseApproval;
      reason?: string;
    },
  ): Promise<boolean> => {
    try {
      await shared.store.setApproval({
        botId: input.botId,
        serverId: input.appId,
        approval: input.approval,
        by: context.var.actor.id,
      });
    } catch (error) {
      if (
        error instanceof SharedUseFrameError ||
        error instanceof SharedUseNotSharedError
      )
        return false;
      throw error;
    }
    try {
      await shared.audience.record({
        eventType: "shared_use.approved",
        targetId: input.appId,
        actorUserId: context.var.actor.id,
        payload: {
          bot: input.botId,
          server: input.appId,
          audience: input.approval.audience,
          outsideInput: input.approval.outsideInput,
          ...(input.reason ? { reason: input.reason } : {}),
        },
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "shared-use-approval-not-on-trail",
          app: input.appId,
          bot: input.botId,
          by: context.var.actor.id,
          audience: input.approval.audience,
          outsideInput: input.approval.outsideInput,
          note: "The approval was written and is in force; its shared_use.approved row could not be written.",
          error: reasonWithoutStatement(error),
        }),
      );
    }
    return true;
  };

  const SWITCH_APPROVALS_MAX = 2_000;

  /** 请求体里的 `approvals`：按员工 id 的批准。没送为 null；读不懂时给出要答的那句话。 */
  const switchApprovalsFrom = (
    sent: unknown,
  ):
    | { approvals: Map<string, SharedUseApproval> | null }
    | { error: string } => {
    if (sent === undefined) return { approvals: null };
    if (!sent || typeof sent !== "object" || Array.isArray(sent))
      return {
        error:
          "approvals 要按员工 id 给出每位员工的共享使用批准，这一份读不懂，所以什么都没有改。",
      };
    const approvals = new Map<string, SharedUseApproval>();
    const entries = Object.entries(sent);
    // 一次切换批准的员工不会比持有这个应用的员工多；设个上限，不让一份请求体无界地长。
    if (entries.length > SWITCH_APPROVALS_MAX)
      return {
        error: `approvals 一次最多 ${SWITCH_APPROVALS_MAX} 位员工，所以什么都没有改。`,
      };
    for (const [botId, value] of entries) {
      const approval = asSharedUseApproval(value);
      if (!approval)
        return {
          error: `给 ${botId.slice(0, 80)} 的共享使用批准这个部署读不懂，所以什么都没有改。`,
        };
      approvals.set(botId, approval);
    }
    return { approvals };
  };

  /**
   * 切换完成后，为点到的员工记下批准，答记下了哪几位。`fill` 为真时只补缺：应用本来就是 Shared，已经有的
   * 批准是之前的决定，不被这一步改写。一位员工没记上（没有主人、应用又被切走、写入出错）不影响别的，也
   * 不把已经完成的切换说成失败；它没有批准，调用被拒绝。
   */
  const recordSwitchApprovals = async (
    context: { var: AppVariables },
    serverId: string,
    approvals: Map<string, SharedUseApproval>,
    fill: boolean,
  ): Promise<string[]> => {
    if (!sharedUse || approvals.size === 0) return [];
    const shared = sharedUse;
    const appId = await shared.store.appIdOf(serverId);
    const approved: string[] = [];
    for (const { botId } of await sharedBotsOf(context, serverId)) {
      const approval = approvals.get(botId);
      if (!approval) continue;
      try {
        const written = await asBotOwner(context, botId, async () => {
          if (fill && (await shared.store.approvalFor(botId, appId)))
            return false;
          return recordAdminApproval(context, shared, {
            botId,
            appId,
            approval,
            reason: "account_mode_switched",
          });
        });
        if (written) approved.push(botId);
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "account-mode-approval-not-recorded",
            app: appId,
            bot: botId,
            note: "The app is Shared; writing this Bot's approval failed, so it has none and its calls on the team account are refused.",
            error: reasonWithoutStatement(error),
          }),
        );
      }
    }
    return approved;
  };

  routes.get("/servers/:id/account-mode", capable, async (context) => {
    const forbidden = requireAdmin(context) ?? staleAdminRefusal(context);
    if (forbidden) return forbidden;
    if (!accountModes)
      return context.json({ error: "这个部署没有启用账号模式切换。" }, 503);
    const mode = accountModeOf(context.req.query("mode"));
    if (!mode)
      return context.json({ error: "mode 只能是 personal 或 shared。" }, 400);
    try {
      const serverId = context.req.param("id");
      const preview = await accountModes.preview(serverId, mode);
      return context.json({
        ...preview,
        bots: mode === "shared" ? await sharedBotsOf(context, serverId) : [],
      });
    } catch (error) {
      if (error instanceof AccountModeRefusedError)
        return context.json({ error: error.message }, 400);
      throw error;
    }
  });
  routes.put("/servers/:id/account-mode", capable, async (context) => {
    const forbidden = requireAdmin(context) ?? staleAdminRefusal(context);
    if (forbidden) return forbidden;
    if (!accountModes)
      return context.json({ error: "这个部署没有启用账号模式切换。" }, 503);
    const body = (await context.req.json().catch(() => null)) as {
      mode?: unknown;
      confirm?: unknown;
      approvals?: unknown;
    } | null;
    const mode = accountModeOf(body?.mode);
    if (!mode)
      return context.json({ error: "mode 只能是 personal 或 shared。" }, 400);
    // 读不懂的批准先拒绝，在任何账号被结束之前。
    const sent = switchApprovalsFrom(body?.approvals);
    if ("error" in sent) return context.json({ error: sent.error }, 400);
    const serverId = context.req.param("id");
    let outcome: Awaited<ReturnType<typeof accountModes.switchModeTelling>>;
    try {
      outcome = await accountModes.switchModeTelling({
        serverId,
        mode,
        by: context.var.actor.id,
        confirm: body?.confirm === true,
      });
    } catch (error) {
      if (error instanceof AccountModeRefusedError)
        return context.json({ error: error.message }, 400);
      const refusal = personRefusal(
        error,
        "没能切换账号模式，什么都没有改变。请重试。",
        { route: "account-mode.switch", toolkit: context.req.param("id") },
      );
      return context.json({ error: refusal.error }, refusal.status);
    }
    const { result } = outcome;
    if ("failures" in result) return context.json(result, 409);
    if ("preview" in result) {
      try {
        return context.json({
          ...result,
          preview: {
            ...result.preview,
            bots:
              mode === "shared" ? await sharedBotsOf(context, serverId) : [],
          },
        });
      } catch (error) {
        // 只是预览：名单没读出来，什么都还没有改，照实说。
        const refusal = personRefusal(
          error,
          "没能读出切换会影响哪些员工，什么都没有改变。请重试。",
          { route: "account-mode.preview", toolkit: serverId },
        );
        return context.json({ error: refusal.error }, refusal.status);
      }
    }
    /*
     * 从这里往下，切换已经完成（或应用本来就是这个模式）。之后再出错，不能答「什么都没有改变」：人们的
     * 账号已经在厂商那边结束了。
     */
    // 没送 `approvals` 的切换答的和以前一样，也不记任何批准。
    if (sent.approvals === null) return context.json(result);
    if (mode !== "shared") return context.json({ ...result, approved: [] });
    /*
     * 这次切换真的把应用改成了 Shared 时，送来的批准就是这次切换的批准，照写。应用本来就是 Shared 时只
     * 补缺：已经有的批准是之前的决定。看的是切换自己说的「这次有没有改模式」，不是切换之前另读的一次：
     * 两位管理员同时切换时，后到的那位读到的「还是 Personal」已经过时，照它去覆盖会改写先到的那位刚定
     * 下的批准。
     */
    try {
      return context.json({
        ...result,
        approved: await recordSwitchApprovals(
          context,
          serverId,
          sent.approvals,
          !outcome.switched,
        ),
      });
    } catch (error) {
      /*
       * 名单没算出来（读库出错）。切换已经完成，应用是 Shared、这一步一条批准都没记，没有批准的员工每次
       * 调用都被拒绝。再送一次同样的请求会走「本来就是 Shared」的那一支把批准补上，`approvalsFailed`
       * 告诉页面要这样做。
       */
      console.error(
        JSON.stringify({
          type: "account-mode-approvals-not-recorded",
          app: serverId,
          note: "The switch finished; the approvals sent with it could not be recorded. Sending the same request again records them.",
          error: reasonWithoutStatement(error),
        }),
      );
      return context.json({ ...result, approved: [], approvalsFailed: true });
    }
  });

  // X5：Arcade 的回程验证与取消，只在 Arcade 是活动提供商时有作用。
  mountArcadeRoutes(routes, capable, () =>
    composio?.arcade
      ? { store, arcade: composio.arcade, appUrl: connect?.appUrl }
      : null,
  );

  routes.get("/oauth/callback", async (context) => {
    const failed = connectedAccountsUrlFor(connect?.appUrl, {
      failed: true,
    });
    if (!connect?.publicUrl) return context.redirect(failed);

    /*
     * EVERY WAY OUT OF THIS HANDLER IS A REDIRECT, AND THE `try` IS WHAT MAKES THAT TRUE.
     *
     * CRITERION. No request to this endpoint ends without a `Location`.
     *
     * REASON. The header above says every failure ends the same way, and that was true of
     * every failure this handler ASKED for and of none of the failures its questions could
     * raise. `personHasAccess` reaches the people store and `oauthClientFor` reaches the
     * vault, and either of them throwing put somebody who had just consented at another
     * company on a bodyless 500 with no `Location` at all — no page, no notice, nothing to
     * press, and a browser left on this API's origin, which locally serves no pages at all.
     * It is the exact answer this route exists to make impossible: `redeemAuthorizationCode`
     * guards its own `fetch` against it in as many words, and the vault write below was given
     * a `catch` for it — one call at a time, which is the shape that keeps leaving one out.
     *
     * SO IT IS THE WHOLE BODY RATHER THAN EACH CALL. A blanket `catch` is a promise about the
     * route; a per-call one is a promise about the calls somebody remembered. Nothing is
     * written before the vault, so a failure anywhere above it leaves the same nothing behind
     * as an unreadable state does, and the person is told the same sentence either way.
     *
     * THE PERSON LEARNS NOTHING NEW FROM IT, deliberately, for the reason the header gives:
     * there is no useful distinction here between a forged state and a store that would not
     * answer, and spelling out which is which tells anybody probing this endpoint how far they
     * got. The console is where the difference survives, and it carries the error stringified
     * and nothing else — not the state, which names a person, and not the code, which is one
     * redemption away from a refresh token.
     */
    try {
      const code = context.req.query("code");
      const state = await readConnectState(
        context.req.query("state") ?? "",
        connect.encryptionKey,
      );
      if (!code || !state) return context.redirect(failed);

      /*
       * WHOSE FRAME THIS RUNS IN IS THE SEALED STATE'S PERSON, AND NOBODY ELSE'S (G01).
       *
       * There is no session here, so no guard opened a tenant frame, and without one every read and
       * write below ran as `system`: the person's refresh token and their connection row were filed
       * where every tenant can read them, and the swap looked for their existing grant in a partition
       * it is not in. The state was sealed by this deployment for one person at connect time, so it
       * is the trusted claim, and everything that touches the database runs as that person — exactly
       * the frame the connect route that sealed it ran in. A state naming nobody (`system`,
       * `platform`, empty) cannot have been sealed by that route, and fails like a forged one.
       */
      const userId = state.userId;
      if (!isPersonTenant(userId)) return context.redirect(failed);
      const asPerson = <T>(work: () => Promise<T>) => runAsTenant(userId, work);

      /*
       * Is the person in the state still somebody here?
       *
       * Asked here, before the code is redeemed and before anything is written, because a state is
       * good for ten minutes and access can end inside them. Removing somebody deny-lists their
       * address, deletes their sessions and retires the credentials they had already granted — and
       * none of that reaches a consent already in flight at the vendor. Without this, that consent
       * comes back and writes a fresh, live refresh token belonging to somebody who no longer has
       * access, which nothing downstream will ever revoke because nothing knows it was created.
       *
       * The same anonymous failure as an unreadable state. Whether an address is deny-listed is not a
       * fact this endpoint owes an unauthenticated caller.
       */
      if (!(await asPerson(() => connect.personHasAccess(userId)))) {
        return context.redirect(failed);
      }

      /*
       * The entry connect found, resolved the way connect resolved it: the sealed address is the one
       * the person connected with, which may be a `team:<key>` row id. See {@link catalogueEntryAt}.
       */
      const entry = catalogueEntryAt(
        await asPerson(() => store.serverAddress(state.serverId)),
        state.serverId,
      );
      if (entry?.auth.kind !== "user-oauth") return context.redirect(failed);

      const client = await asPerson(() => store.oauthClientFor(state.serverId));
      if (!client) return context.redirect(failed);

      const grant = await redeemAuthorizationCode({
        tokenUrl: entry.auth.tokenUrl,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        code,
        redirectUri: redirectUriFor(connect.publicUrl),
        verifier: state.verifier,
      });
      if (!grant) return context.redirect(failed);

      /*
       * The last thing that can fail, answered the same way as everything before it.
       *
       * A vault that will not take the grant is this deployment's problem, not the person's, and they
       * have already done their part at the vendor. Unhandled, this threw past the handler and gave
       * them the bare 500 that every other failure on this route was written to avoid, on the one
       * path where they had most reason to think it had worked.
       *
       * Told, because unlike the refusals above this one is nobody's fault but ours, and the person's
       * sentence deliberately says nothing about which failure it was. The refresh token is not
       * logged: it is the one thing here worth stealing, and the row it belonged to was never written.
       */
      try {
        await asPerson(() =>
          store.recordConnection({
            serverId: state.serverId,
            userId,
            refreshToken: grant.refreshToken,
            scope: grant.scope,
          }),
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "oauth-connection-not-recorded",
            serverId: state.serverId,
            note: "A person consented and the grant could not be stored. They were sent back to Settings with a failure and will have to connect again.",
            /*
             * READ THROUGH {@link reasonWithoutStatement}, BECAUSE THE FAILURE THIS LINE EXISTS FOR
             * IS THE ONE WHOSE MESSAGE CARRIES THE REFRESH TOKEN.
             *
             * `recordConnection` runs `swapUserCredential` → `credentials.create/rotate`, whose
             * bound parameters include the refresh token's sealed envelope (`sealCredential`).
             * drizzle wraps a driver failure as a `DrizzleQueryError` whose own message is
             * `Failed query: insert into "credentials" … params: …, <the envelope>, …`, so
             * `String(error)` here put the envelope on this deployment's stdout and into whatever
             * sink collects it — for a person who was correctly told nothing was saved. Two consent
             * callbacks for one `(serverId, userId)` landing together, or a statement timeout on
             * the insert, is all it takes.
             *
             * The helper answers the driver's own complaint instead — `duplicate key value violates
             * unique constraint`, `canceling statement due to statement timeout` — which is the
             * useful half and names nothing anybody sent.
             */
            error: reasonWithoutStatement(error),
          }),
        );
        return context.redirect(failed);
      }

      /*
       * 应用提供什么，以刚连接的这个人的身份问（上游 #1073）。
       *
       * 只能按个人凭据列出工具的应用，在有人连接之前一个工具也没有，而这是第一个有人连接的时刻。
       * 等它做完再跳转，这样这个人回到的页面已经列出工具，下一次 Bot 运行也拿得到。见
       * `discoverToolsOnConnect`：只在一个工具都没有时才列，在这个人的帧里调用。
       *
       * 连接已经写下，这里的任何失败都不会把它变成连接失败。vendor 不肯回答，会在刷新里落到应用的
       * `lastError`；我们自己的故障只记日志，应用页上的「刷新工具」还可以再问一次。
       */
      try {
        await asPerson(() =>
          store.discoverToolsOnConnect(state.serverId, userId),
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "oauth-connection-tools-not-listed",
            serverId: state.serverId,
            note: "A person connected and their account was recorded, but asking the app what it offers failed. Refresh tools on the app's page asks again.",
            error: reasonWithoutStatement(error),
          }),
        );
      }

      return context.redirect(
        connectedAccountsUrlFor(
          connect.appUrl,
          { serverId: state.serverId },
          // From the sealed state, so the destination is one this deployment chose, not the browser.
          state.returnTo,
        ),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "oauth-callback-failed",
          note: "A person came back from a consent screen and a check on this route raised instead of answering. They were sent back to Settings with a failure, nothing was written, and they will have to connect again.",
          // The outer catch of the branch above, so it stands over the same write and needs the
          // same door. See the note on `oauth-connection-not-recorded`.
          error: reasonWithoutStatement(error),
        }),
      );
      return context.redirect(failed);
    }
  });

  /**
   * Write a skill.
   *
   * Not admin-only. A skill is an instruction, not a capability: it can only ask a
   * Bot to use tools that Bot was already granted, and every one of those calls is still decided,
   * policy-checked and audited. Adding an MCP server is the opposite, and stays an administrator's.
   *
   * A person's skill is their own. `global` writes one for the whole deployment, which an
   * administrator may do and nobody else.
   */
  routes.post("/skills", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      slug?: unknown;
      title?: unknown;
      summary?: unknown;
      instructions?: unknown;
      global?: boolean;
      tools?: unknown;
    } | null;
    /*
     * The body is JSON, so the annotations are wishes: `{"slug":123}` passes a truthiness
     * check and `RegExp.test` then coerces it to `"123"`, and `{"summary":{}}` reaches the
     * store where the insert throws a 500. A slug, a title and instructions are non-empty
     * strings here, and a summary is absent or a string. Anything else is a 400 before
     * any refusal check, store write, or audit row.
     */
    if (
      typeof body?.slug !== "string" ||
      typeof body?.title !== "string" ||
      !body.title.trim() ||
      typeof body?.instructions !== "string" ||
      !body.instructions.trim()
    ) {
      return context.json(
        { error: "A slug, a title and instructions are required." },
        400,
      );
    }
    if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(body.slug)) {
      return context.json(
        { error: "A slug is lower-case letters, numbers and hyphens." },
        400,
      );
    }
    if (body.summary !== undefined && typeof body.summary !== "string") {
      return context.json(
        { error: "A summary is text when it is present." },
        400,
      );
    }

    const actor = skillActor(context);
    if (body.global && !actor.isAdmin) {
      return context.json(
        { error: "Only an administrator writes a skill for the deployment." },
        403,
      );
    }

    // Editing an existing slug, which is what a repeated save is, needs the right to edit that
    // skill. Without this, saving over somebody else's name would silently take it.
    const refusal = await skillRefusal(context, body.slug);
    if (refusal) return context.json({ error: refusal }, 403);

    /*
     * Absent leaves the declarations alone, so a caller that predates this field does not silently
     * clear one. An array, including an empty one, says what the skill needs now.
     *
     * Every entry must be a non-empty string: silently dropping mistyped entries would turn a
     * client bug into a skill that declares nothing and answers success. `global` must be a
     * boolean when present, so the string `"yes"` cannot create a deployment-wide skill.
     */
    if (body.global !== undefined && typeof body.global !== "boolean") {
      return context.json(
        { error: "Global must be true or false when it is present." },
        400,
      );
    }
    if (body.tools !== undefined) {
      if (
        !Array.isArray(body.tools) ||
        body.tools.some((ref) => typeof ref !== "string" || !ref.trim())
      ) {
        return context.json(
          { error: "Tools are a list of serverId/toolName references." },
          400,
        );
      }
    }
    const tools = Array.isArray(body.tools)
      ? (body.tools as string[]).map((ref) => ref.trim())
      : undefined;

    try {
      await store.installSkill({
        slug: body.slug,
        title: body.title.trim(),
        summary: body.summary ?? "",
        instructions: body.instructions.trim(),
        /*
         * 只在有别人时才是所有人的（上游 #1273）：个人版只有一个人，设置 › 技能就是管理 › 技能，也带
         * `global` 保存；存成谁的都不是，员工的「你的技能」里就没有它。个人版里它归这个人，之前存下的在
         * 启动时给他（`ensurePersonalSkillsOwned`）。
         */
        ownerUserId:
          body.global && currentEdition() !== "personal" ? null : actor.id,
        ...(tools === undefined ? {} : { tools }),
        by: actorEmail(context),
      });
    } catch (error) {
      // A ref naming no tool this deployment has seen. Answered rather than thrown, because it is
      // something the person writing the skill can fix and the message says what to fix.
      if (error instanceof PluginRefusedError) {
        return context.json({ error: error.message }, 400);
      }
      throw error;
    }
    return context.json({ skills: await store.listSkills(actor) });
  });

  routes.delete("/skills/:slug", requireUser, async (context) => {
    const slug = context.req.param("slug");
    const refusal = await skillRefusal(context, slug);
    if (refusal) return context.json({ error: refusal }, 403);

    try {
      await store.uninstallSkill(slug, actorEmail(context));
    } catch (error) {
      // The platform's own row under this name: a workspace may shadow it, never remove it.
      if (error instanceof PluginRefusedError) {
        return context.json({ error: error.message }, 403);
      }
      throw error;
    }
    return context.json({ ok: true });
  });

  /**
   * Grant and revoke, for both kinds, through one pair of endpoints.
   *
   * The store keeps one grant table because the question is the same either way; the API says the
   * same thing, so a reader is never left wondering whether skills are governed differently.
   */

  /**
   * The kinds of grant this API will act on.
   *
   * CHECKED AT RUNTIME, not only in the types. `kind` arrives in a JSON body, so a type annotation
   * on it is a comment: before this, anything at all could be written into the grant table through
   * the ordinary endpoint, and one kind that was never meant to be settable this way already could.
   */
  const GRANT_KINDS = new Set<PluginKind>(["mcp", "skill", "bot"]);
  const asGrantKind = (value: unknown): PluginKind | null =>
    typeof value === "string" && GRANT_KINDS.has(value as PluginKind)
      ? (value as PluginKind)
      : null;

  /**
   * Spec E3 / D11: may the owner of this Waker install (or uninstall) this entry themselves?
   *
   * THE ONE NON-ADMINISTRATOR DOOR ONTO A DEPLOYMENT'S CATALOGUE. An administrator lists (上架) an
   * app or a deployment skill; from then on the person who owns a Waker may put it on that Waker and
   * take it off again without an administrator approving each one. The governance boundary is the
   * listing, not each grant, and every install and uninstall still writes a trail row that says it
   * was self-service.
   *
   * Answers `not-applicable` whenever this door does not open, so the caller falls through to the
   * rules that applied before and every refusal a person saw before is word for word the same:
   *  - an entry nobody listed is still an administrator's (`mcp`) or still refused as the
   *    deployment's (`skill`), and a person's own skill is still decided by the owner rule;
   *  - an uninstall is allowed while the entry is listed, and after it is unlisted only for a grant
   *    this same person made: what an administrator granted stays the administrator's to remove.
   */
  async function selfInstallDecision(
    context: { var: AppVariables },
    kind: "mcp" | "skill",
    ref: string,
    agentId: string,
    intent: "grant" | "revoke",
  ): Promise<"allowed" | "not-applicable" | { refusal: string }> {
    const actor = skillActor(context);
    let listingRef = ref;
    if (kind === "mcp") {
      // A grant names `<app>/<tool>`; the listing names the app.
      listingRef = ref.split("/")[0] ?? "";
    } else if ((await store.skillOwner(ref)) !== null) {
      // Somebody's own skill (or no skill at all) is not a catalogue entry: the owner rule decides.
      return "not-applicable";
    }
    if (!listingRef) return "not-applicable";

    const listed = await store.isInstallListed(kind, listingRef);
    if (!listed && intent === "grant") return "not-applicable";

    /*
     * The Waker has to be the caller's own. One sentence for "not yours" and "no such Waker", so a
     * refusal here says nothing about other people's private Wakers.
     */
    const botOwner = await store.agentOwner(agentId);
    if (botOwner !== actor.id) {
      return listed
        ? { refusal: "You can only install listed entries on Bots you own." }
        : "not-applicable";
    }

    if (intent === "revoke") {
      if (listed) return "allowed";
      const email = context.var.actor?.email;
      if (!email) return "not-applicable";
      return (await store.grantedBy(kind, ref, agentId)) === email
        ? "allowed"
        : "not-applicable";
    }

    // A grant that could never do anything is refused rather than stored, as for an administrator.
    if (!(await store.agentIsRegistered(agentId))) {
      return { refusal: "There is no such Bot." };
    }
    if (kind === "mcp") {
      const tool = ref.slice(listingRef.length + 1);
      if (!ref.startsWith(`${listingRef}/`) || !tool) {
        return { refusal: "A tool is named as app/tool." };
      }
      if (!(await store.serverExists(listingRef))) {
        return {
          refusal: `${listingRef} is not an app this deployment has added, so there is nothing for a Bot to reach. Add it first, and its tools can be granted then.`,
        };
      }
    }
    return "allowed";
  }

  /**
   * Whether this grant or revoke may go ahead, and whether it is an owner's self-service install.
   *
   * Self-service is asked first and only for somebody who is not an administrator; everything it
   * does not decide is decided by {@link enablementRefusal} exactly as before.
   */
  async function enablementDecision(
    context: { var: AppVariables },
    kind: PluginKind,
    ref: string,
    agentId: string,
    intent: "grant" | "revoke",
  ): Promise<{ refusal: string } | { refusal: null; selfService: boolean }> {
    if (!skillActor(context).isAdmin && (kind === "mcp" || kind === "skill")) {
      const self = await selfInstallDecision(
        context,
        kind,
        ref,
        agentId,
        intent,
      );
      if (self === "allowed") return { refusal: null, selfService: true };
      if (self !== "not-applicable") return self;
    }
    const refusal = await enablementRefusal(
      context,
      kind,
      ref,
      agentId,
      intent,
    );
    return refusal === null
      ? { refusal: null, selfService: false }
      : { refusal };
  }

  /**
   * May this person put this on that Bot?
   *
   * MCP is an administrator's, always: it reaches another company's system with a stored credential.
   * A skill is an instruction, so somebody may put their own skill on a Bot they own, and neither
   * half alone is enough. Both are checked here rather than in the store, because this is the only
   * place that knows who is asking.
   */
  async function enablementRefusal(
    context: { var: AppVariables },
    kind: PluginKind,
    ref: string,
    agentId: string,
    /**
     * Which way this is going, because they are not symmetric.
     *
     * TAKING SOMETHING AWAY IS ALWAYS ALLOWED. The checks below decide whether a grant should exist,
     * and applying them to a revoke turns every one of them into a trap: a `bot` grant made before
     * the grantee moved to its own endpoint — or before this check existed — could never be removed,
     * because the reason it is wrong is the same reason the revoke was refused. An administrator
     * looking at a dead row in the UI would have had no way to delete it.
     */
    intent: "grant" | "revoke",
  ): Promise<string | null> {
    const actor = skillActor(context);

    if (kind === "mcp") {
      if (!actor.isAdmin) {
        return "An administrator decides which Bots may reach a tool.";
      }
      // Taking something away is always allowed: see the note on `intent`. It matters more here
      // than anywhere else, because the rows this check exists to prevent are the same shape as the
      // rows #572's migration had to delete, and an administrator has to be able to remove one by
      // hand rather than wait for a migration.
      if (intent === "revoke") return null;

      /*
       * A grant that could never do anything is refused rather than stored, which is the rule the
       * `bot` branch below already states and this one did not follow.
       *
       * Nothing checked that the app existed. `store.grant` is a bare upsert, so a ref naming an
       * app this deployment has not added was stored and then invisible: the surface that reports a
       * grant nothing advertises is built per server row, and there was no row. #572 fixed the way
       * these rows were MADE — a removal used to leave its grants behind — and added the migration
       * that deleted the ones already there. This is the other door into the same room. Add the app
       * afterwards and the id is the same, the action names are the same, and every one of those
       * grants resolves, with nobody having granted anything and no row in the trail saying so.
       *
       * THE SERVER HALF ONLY. A grant naming a tool the server has stopped advertising is a
       * supported state, held and not offered, because what a vendor lists today is not what
       * somebody decided yesterday — checking the tool here would refuse a re-grant of exactly the
       * tool an administrator is trying to restore. A grant naming no app at all is not that state.
       */
      const [serverId] = ref.split("/");
      if (!(await store.serverExists(serverId ?? ""))) {
        return `${serverId} is not an app this deployment has added, so there is nothing for a Bot to reach. Add it first, and its tools can be granted then.`;
      }
      /*
       * The Bot has to exist as well, which the `bot` branch below already says in the same words.
       * `plugin_grants.agent_id` is a foreign key, so a grant naming a Bot nobody has reached the
       * insert and failed there, and a person's mistyped Bot id answered 500 with no body where
       * every other refusal on this route is a 403 with a sentence.
       */
      if (!(await store.agentIsRegistered(agentId)))
        return "There is no such Bot.";
      return null;
    }

    if (kind === "bot") {
      /*
       * THE ROLE IS CHECKED BEFORE ANYTHING IS LOOKED UP, and that ordering is the point.
       *
       * One Bot reaching another lets it spend that Bot's model calls, wake its computer and reach
       * whatever it may reach, so it is an administrator's decision rather than something somebody
       * attaches to a coworker they own. But this route only requires a signed-in user, so every
       * refusal below is readable by anybody: checking whether the Bot exists, and whether it runs
       * here, before this line handed out three distinguishable answers and turned a 403 into an
       * oracle for other people's private Bots. `handoff.ts` in this same feature collapses exactly
       * this, deliberately, and this had it backwards.
       */
      if (!actor.isAdmin) {
        return "An administrator decides which Bots may hand work to another Bot.";
      }
      // Taking something away is always allowed: see the note on `intent`.
      if (intent === "revoke") return null;

      /*
       * A grant that could never do anything is refused rather than stored, from both ends.
       *
       * The GRANTEE must exist. Remote Bots execute through the same signed callback and handoff
       * desk as built-in Bots, so where their model loop runs does not change the grant.
       *
       * The TARGET only has to exist. Being handed work is not the same as being able to hand it on,
       * so a target at its own endpoint is perfectly ordinary — but `ref` is bare text with no
       * foreign key, so a typo stored happily and every hop then refused as not-granted.
       */
      /*
       * A Bot cannot be granted itself. The desk refuses a self-hop outright — "a Bot cannot hand
       * work to itself" — so the row is dead the moment it is written, and reads as configured.
       */
      if (ref === agentId) {
        return "A Bot cannot be granted itself to hand work to.";
      }
      if (!(await store.agentIsRegistered(agentId)))
        return "There is no such Bot.";
      if (!(await store.agentIsRegistered(ref))) {
        return `There is no Bot called ${ref} to hand work to.`;
      }
      return null;
    }

    if (actor.isAdmin) {
      // Taking something away is always allowed: see the note on `intent`.
      if (intent === "revoke") return null;
      /*
       * A grant naming no skill is refused for an administrator too, as the `mcp` branch refuses a
       * grant naming no app. `store.grant` is a bare upsert and a Bot's skills are read by slug
       * alone, so the row sat there granting nothing until somebody wrote a skill under that name,
       * and then that skill was on this Bot with nobody having put it there. On a Bot the
       * deployment shares, that is one person's instructions answering everybody:
       * `skill-uninstall-grants.integration.test.ts` guards the same room from the uninstall side.
       */
      if ((await store.skillOwner(ref)) === undefined) {
        return `There is no skill called ${ref}.`;
      }
      // And the Bot, for the reason the `mcp` branch gives: an administrator's grant naming one
      // nobody has failed on the foreign key. Everybody else is asked below, through `agentOwner`.
      if (!(await store.agentIsRegistered(agentId)))
        return "There is no such Bot.";
      return null;
    }

    const owner = await store.skillOwner(ref);
    if (owner === undefined) return `There is no skill called ${ref}.`;
    if (owner !== actor.id) {
      return owner === null
        ? `${ref} belongs to this deployment. An administrator decides which Bots use it.`
        : `${ref} is somebody else's skill.`;
    }

    const botOwner = await store.agentOwner(agentId);
    if (botOwner === undefined) return "There is no such Bot.";
    if (botOwner !== actor.id) {
      // Including the shared Bots this deployment publishes, which have no owner at all: a skill
      // one person wrote would otherwise change how a Bot answers everybody.
      return "You can only put your own skills on Bots you own.";
    }
    return null;
  }

  /**
   * Where an administrator's grant or revoke on a Bot runs (G01-E P10, I6; carried forward from P8b).
   *
   * On somebody else's Bot (their private Bot, or a team Bot they own) it runs in that owner's frame
   * through `adminActAsOwner`: the existence checks see the Bot the way its owner does, the grant is
   * stamped as its owner's Bot needs (the owner's tenant for a private Bot, `team` for a team Bot;
   * 0127 admits no other stamp) and the trail row lands with the owner. Whose Bot it is is read under
   * `asAdminPlatform`, because the administrator's own frame usually cannot see it. Everybody else,
   * an administrator on their own Bot or an ownerless one, and an administrator without the
   * capability (a role removed since sign-in) act in their own frame, as before.
   */
  async function asBotOwner<T>(
    context: { var: AppVariables },
    agentId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const actor = context.var.actor;
    if (
      actor?.role !== "admin" ||
      !adminScope ||
      capabilityFor(currentTenant()) !== "admin"
    ) {
      return work();
    }
    const owner = await adminScope.asAdminPlatform(actor, () =>
      store.botOwnerTenant(agentId),
    );
    if (!owner || owner === actor.id) return work();
    return adminScope.adminActAsOwner(actor, owner, work);
  }

  routes.post("/grants", signedInWithCapability, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      kind?: unknown;
      ref?: string;
      agentId?: string;
      approval?: unknown;
    } | null;
    const kind = asGrantKind(body?.kind);
    /*
     * The body is JSON, so the annotation is a wish: `{"ref":123,"agentId":[]}` passes a
     * truthiness check and then reaches the store, where Drizzle compares a text column against
     * a number and the request answers 500. A ref and a Bot id are non-empty strings here.
     */
    if (
      !kind ||
      typeof body?.ref !== "string" ||
      !body.ref.trim() ||
      typeof body.agentId !== "string" ||
      !body.agentId.trim()
    ) {
      return context.json(
        { error: "A kind, a ref and a Bot are required." },
        400,
      );
    }
    /*
     * Trimmed before it is checked and before it is stored, the way the DELETE twin below already
     * does. Without this a padded ref refuses with the padding quoted back (`" app" is not an app`),
     * and a grant that did pass would be stored under a ref no revoke could match.
     */
    const grantRef = body.ref.trim();
    const grantAgentId = body.agentId.trim();
    /*
     * 管理员随这次授予送来的共享使用批准（上游 `POST /grants` 的 `approval`）：给出一个 Shared 应用的动作，
     * 同时定下谁可以经这位员工用团队账号。
     *
     * 只有送了才记。没送时和以前一样只写授予，不记批准，团队账号对这位员工的调用照旧被拒绝，直到有人
     * 批准（上游没送时会按员工此刻的开放范围自动批准；fork 在这条路由上留着更严的那条线）。
     *
     * 谁送的才算数，在进员工主人的帧之前判断，因为管理员能力是在管理员自己的帧里持有的：要持有能力的
     * 管理员（`decisionRefusal`，和共享使用那几条路由同一个判断）。只看帧不够：会话里还写着 admin、角色
     * 已被收回的人拿不到能力，请求留在他自己的帧里，而给自己的员工授予时那正是员工主人的帧。这样的人
     * 给 Shared 应用的授予带着批准来，整次拒绝，什么都不写。员工的主人自助安装时送来的不算数（下面的
     * `selfService`），授予照他自己那条路写——主人不能给自己批准团队账号。
     *
     * 送了 `approval` 的答复多一个 `approved`：批准有没有记上。授予可以成功而批准没记上（应用不是 Shared、
     * 员工没有主人、送的人不算数），那时员工对团队账号的调用仍被拒绝，页面不该把它画成已经可用。
     */
    const approvalSent =
      kind === "mcp" && body.approval !== undefined && sharedUse !== undefined
        ? { sent: body.approval, shared: sharedUse }
        : null;
    const holdsCapability = decisionRefusal(context) === null;
    return asBotOwner(context, grantAgentId, async () => {
      const decision = await enablementDecision(
        context,
        kind,
        grantRef,
        grantAgentId,
        "grant",
      );
      if (decision.refusal !== null) {
        return context.json({ error: decision.refusal }, 403);
      }

      // 应用不是 Shared 时没什么要记的；读不懂的批准整次拒绝，什么都不写（`sharedGrantApproval`）。
      const serverId = grantRef.split("/")[0] ?? "";
      let decided: Awaited<ReturnType<typeof sharedGrantApproval>> | null =
        null;
      if (approvalSent && !decision.selfService) {
        const accountMode = await accountModeOfServer(serverId);
        if (accountMode === "shared" && !holdsCapability)
          return context.json({ error: CAPABILITY_UNCONFIRMED }, 403);
        if (holdsCapability)
          decided = await sharedGrantApproval(approvalSent.shared.store, {
            serverId,
            agentId: grantAgentId,
            accountMode,
            sent: approvalSent.sent,
          });
      }
      if (decided === "unreadable")
        return context.json(
          { error: "这份共享使用批准这个部署读不懂，所以什么都没有改。" },
          400,
        );

      try {
        if (decision.selfService) {
          await store.grant(kind, grantRef, grantAgentId, actorEmail(context), {
            selfService: true,
          });
        } else {
          await store.grant(kind, grantRef, grantAgentId, actorEmail(context));
        }
      } catch (error) {
        // A shared Bot's grant that is not this person's to write (see `store.grant`).
        if (error instanceof PluginRefusedError)
          return context.json({ error: error.message }, 403);
        throw error;
      }
      const approved =
        decided?.approval && approvalSent
          ? await recordAdminApproval(context, approvalSent.shared, {
              botId: grantAgentId,
              appId: decided.appId,
              approval: decided.approval,
            })
          : false;
      return context.json({
        ok: true,
        ...(kind === "mcp" && body.approval !== undefined ? { approved } : {}),
      });
    });
  });

  routes.delete("/grants", signedInWithCapability, async (context) => {
    const kind = asGrantKind(context.req.query("kind"));
    const ref = context.req.query("ref");
    const agentId = context.req.query("agentId");
    /*
     * Query params are always strings, so truthiness is not enough: `"   "` is truthy and used
     * to pass this check, delete zero rows by exact match, still write a `plugin_revoked` audit
     * row naming whitespace, and answer `ok:true`. The POST twin already requires non-empty
     * strings; this requires the same and acts on the trimmed values.
     */
    if (
      !kind ||
      typeof ref !== "string" ||
      !ref.trim() ||
      typeof agentId !== "string" ||
      !agentId.trim()
    ) {
      return context.json(
        { error: "A kind, a ref and a Bot are required." },
        400,
      );
    }
    const trimmedRef = ref.trim();
    const trimmedAgentId = agentId.trim();
    // 个人版里个人默认管着的员工持有每个应用、能问每位员工，从一位身上收回会被拒绝；分身和远端员工照常收回
    // （见 `./personal-defaults`）。
    const personalRefusal = await personalRevokeRefusalFor(
      store,
      kind,
      trimmedRef,
      trimmedAgentId,
    );
    if (personalRefusal) return context.json({ error: personalRefusal }, 403);
    return asBotOwner(context, trimmedAgentId, async () => {
      const decision = await enablementDecision(
        context,
        kind,
        trimmedRef,
        trimmedAgentId,
        "revoke",
      );
      if (decision.refusal !== null) {
        return context.json({ error: decision.refusal }, 403);
      }

      try {
        if (decision.selfService) {
          await store.revoke(
            kind,
            trimmedRef,
            trimmedAgentId,
            actorEmail(context),
            { selfService: true },
          );
        } else {
          await store.revoke(
            kind,
            trimmedRef,
            trimmedAgentId,
            actorEmail(context),
          );
        }
      } catch (error) {
        if (error instanceof PluginRefusedError)
          return context.json({ error: error.message }, 403);
        throw error;
      }
      return context.json({ ok: true });
    });
  });

  const grantRefList = z.array(z.string().trim().min(1).max(300)).max(2_000);
  const grantChangeInput = z.strictObject({
    add: grantRefList,
    remove: grantRefList,
    authoring: z
      .strictObject({
        source: z.literal("english"),
        text: z.string().trim().min(1).max(2_000),
      })
      .optional(),
    // 管理员随这次保存为 Shared 应用记下的共享使用批准（{@link sharedGrantApproval}）。
    approval: z.unknown().optional(),
  });

  /**
   * Turn several of one app's actions on and off for one Bot as one change: what the Bot's app page
   * saves once an admin has read a set chosen from their description (upstream #1396).
   *
   * EXACTLY THE CHECKS THE TWO ROUTES ABOVE MAKE, asked of every action before any is written. Each
   * action turned on goes through {@link enablementDecision} as `POST /grants` sends it, and each one
   * turned off as `DELETE /grants` does, in the Bot owner's frame ({@link asBotOwner}). One refusal
   * refuses the whole change, with every action's reason, so nobody is left with half of what they
   * approved. Then each is written by the store as the routes write it, with its own row on the trail,
   * and one more row says they were one change, with the sentence it came from.
   *
   * A SHARED APP'S AUDIENCE IS DECIDED ONCE, as upstream's `POST /grants` decides it for each grant:
   * every action here is the same app's, and {@link sharedGrantApproval} depends on the app and the
   * Bot alone. An admin's save records the approval it sent, or the Bot's exposure now when none was
   * sent and no admin decided one before; an approval this deployment cannot read refuses the save
   * before anything is written. An owner's self-service install (a listed app, `enablementDecision`)
   * sets the owner's audience where the admin lets owners decide ({@link approveOwnersSharedUse}),
   * as `/give` does. A Bot with no owner has nowhere to record either, and its calls stay refused.
   *
   * On the personal edition an action turned off is asked {@link personalRevokeRefusalFor} first, as
   * `DELETE /grants` asks it (X4): a Bot the personal defaults keep whole holds every action of every
   * connected app, so turning one off is refused rather than answered and put back on the next run.
   */
  routes.post(
    "/for/:agentId/apps/:app/grants",
    signedInWithCapability,
    async (context) => {
      // 授予写在请求者自己的帧里，行安全拦不住角色已被收回的人给自己的员工授予，所以在入口问。
      const stale = staleAdminRefusal(context);
      if (stale) return stale;
      const agentId = context.req.param("agentId").trim();
      const app = context.req.param("app").trim();
      const parsed = grantChangeInput.safeParse(
        await context.req.json().catch(() => null),
      );
      if (!parsed.success)
        return context.json(
          {
            error: "请用 add 和 remove 发送要打开和关闭的操作，各是一组引用。",
          },
          400,
        );
      const add = [...new Set(parsed.data.add)];
      const remove = [...new Set(parsed.data.remove)];
      if (add.length + remove.length === 0)
        return context.json({ error: "没有要改的。" }, 400);
      const foreign = [...add, ...remove].find(
        (ref) => !ref.startsWith(`${app}/`),
      );
      if (foreign)
        return context.json({ error: `${foreign} 不是 ${app} 的操作。` }, 400);
      if (add.some((ref) => remove.includes(ref)))
        return context.json(
          { error: "同一个操作不能在一次修改里既打开又关闭。" },
          400,
        );

      // 管理员能力是在管理员自己的帧里持有的，进了员工主人的帧就读不到，所以在这里先读。
      const holdsCapability = decisionRefusal(context) === null;
      return asBotOwner(context, agentId, async () => {
        const problems: { ref: string; error: string }[] = [];
        const selfService = new Map<string, boolean>();
        for (const ref of add) {
          const decision = await enablementDecision(
            context,
            "mcp",
            ref,
            agentId,
            "grant",
          );
          if (decision.refusal !== null)
            problems.push({ ref, error: decision.refusal });
          else selfService.set(ref, decision.selfService);
        }
        for (const ref of remove) {
          // 个人版里个人默认管着的员工每个动作都持有，关掉一个会被拒绝，和 `DELETE /grants` 一样（X4）。
          const personal = await personalRevokeRefusalFor(
            store,
            "mcp",
            ref,
            agentId,
          );
          if (personal) {
            problems.push({ ref, error: personal });
            continue;
          }
          const decision = await enablementDecision(
            context,
            "mcp",
            ref,
            agentId,
            "revoke",
          );
          if (decision.refusal !== null)
            problems.push({ ref, error: decision.refusal });
          else selfService.set(ref, decision.selfService);
        }
        if (problems.length > 0)
          return context.json(
            { error: problems[0]?.error ?? "", problems },
            403,
          );
        /*
         * And the check a set chosen from a description was held to, asked again at the save, as a
         * team rule's is: every action turned on is one the app advertises now. Asked after the
         * permission checks, so somebody who may not change this Bot learns nothing about the app
         * from the answer. Turning off is not held to it: taking away is always allowed.
         */
        const server =
          add.length > 0
            ? (await store.listServers()).find((row) => row.id === app)
            : undefined;
        if (add.length > 0) {
          const offered = new Set(server?.tools.map((tool) => tool.ref) ?? []);
          const unknown = add.filter((ref) => !offered.has(ref));
          if (unknown.length > 0)
            return context.json(
              {
                error: `这个应用现在没有这些操作：${unknown.join("、")}。`,
                problems: unknown.map((ref) => ({
                  ref,
                  error: `这个应用现在没有 ${ref} 这个操作。`,
                })),
              },
              400,
            );
        }

        const asOwner = add.some((ref) => selfService.get(ref) === true);
        /*
         * 管理员这条路上给出一个 Shared 应用的动作，就是在定谁可以用团队账号，所以要持有管理员能力的人
         * 才行（`holdsCapability`，在进员工主人的帧之前读的）。只看帧不够：会话里还写着 admin、角色已被
         * 收回的人拿不到能力，请求留在他自己的帧里，而给自己的员工授予时那正是员工主人的帧，批准写得
         * 进去。这样的保存整次拒绝，什么都不写。
         */
        if (
          add.length > 0 &&
          !asOwner &&
          sharedUse &&
          server?.accountMode === "shared" &&
          !holdsCapability
        )
          return context.json({ error: CAPABILITY_UNCONFIRMED }, 403);
        const decided =
          add.length > 0 && !asOwner && sharedUse
            ? await sharedGrantApproval(sharedUse.store, {
                serverId: app,
                agentId,
                accountMode: server?.accountMode,
                sent: parsed.data.approval,
              })
            : null;
        if (decided === "unreadable")
          return context.json(
            { error: "这份共享使用批准这个部署读不懂，所以什么都没有改。" },
            400,
          );

        const by = actorEmail(context);
        try {
          for (const ref of add)
            await store.grant(
              "mcp",
              ref,
              agentId,
              by,
              selfService.get(ref) ? { selfService: true } : undefined,
            );
          for (const ref of remove)
            await store.revoke(
              "mcp",
              ref,
              agentId,
              by,
              selfService.get(ref) ? { selfService: true } : undefined,
            );
        } catch (error) {
          // A shared Bot's grant that is not this person's to write (see `store.grant`).
          if (error instanceof PluginRefusedError)
            return context.json({ error: error.message }, 403);
          throw error;
        }
        try {
          if (decided?.approval && sharedUse) {
            await sharedUse.store.setApproval({
              botId: agentId,
              serverId: decided.appId,
              approval: decided.approval,
              by: context.var.actor.id,
            });
            await sharedUse.audience.record({
              eventType: "shared_use.approved",
              targetId: decided.appId,
              actorUserId: context.var.actor.id,
              payload: {
                bot: agentId,
                server: decided.appId,
                audience: decided.approval.audience,
                outsideInput: decided.approval.outsideInput,
              },
            });
          }
          if (asOwner && sharedUse)
            await approveOwnersSharedUse(sharedUse.audience, sharedUse.store, {
              botId: agentId,
              serverId: app,
              ownerId: context.var.actor.id,
            });
        } catch (error) {
          /*
           * Nowhere to record it: the Bot has no owner, or the app stopped being Shared in between.
           * No approval is the closed direction (the gate refuses the team account), and the grants
           * the person saved stand, as `/give` answers the same race.
           */
          if (
            !(error instanceof SharedUseFrameError) &&
            !(error instanceof SharedUseNotSharedError)
          )
            throw error;
        }
        await store.recordGrantsChanged({
          app,
          agentId,
          by,
          actorUserId: context.var.actor.id,
          added: add,
          removed: remove,
          ...(parsed.data.authoring
            ? { authoring: parsed.data.authoring }
            : {}),
        });
        return context.json({ ok: true, added: add, removed: remove });
      });
    },
  );

  /**
   * Spec E3 / D11: what an administrator has listed (上架) for owners to install themselves.
   *
   * Readable by any signed-in person, because the 装配页 has to know which switches an owner may
   * flip. Listing and unlisting are an administrator's, and each writes a trail row.
   */
  const LISTING_KINDS = new Set<string>(["mcp", "skill"]);
  const asListingKind = (value: unknown): "mcp" | "skill" | null =>
    typeof value === "string" && LISTING_KINDS.has(value)
      ? (value as "mcp" | "skill")
      : null;

  routes.get("/listings", requireUser, async (context) => {
    const listings = await store.listInstallListings();
    /*
     * The listing is deployment-wide, so every workspace reads it. Which administrator listed an entry
     * is the operator's business, not every tenant's: an owner is told what they may install and
     * since when, and never an operator's address.
     */
    if (skillActor(context).isAdmin) return context.json({ listings });
    return context.json({
      listings: listings.map(({ kind, ref, listedAt }) => ({
        kind,
        ref,
        listedAt,
      })),
    });
  });

  routes.post("/listings", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const body = (await context.req.json().catch(() => null)) as {
      kind?: unknown;
      ref?: unknown;
    } | null;
    const kind = asListingKind(body?.kind);
    const ref = typeof body?.ref === "string" ? body.ref.trim() : "";
    if (!kind || !ref) {
      return context.json(
        { error: "A kind (mcp or skill) and a catalogue key are required." },
        400,
      );
    }

    if (kind === "mcp") {
      // The app, never one of its tools: an owner installs the app's tools on their own Waker.
      if (ref.includes("/")) {
        return context.json(
          { error: "A listing names an app, not one of its tools." },
          400,
        );
      }
      if (catalogueEntry(ref) === null && !(await store.serverExists(ref))) {
        return context.json(
          { error: `${ref} is not an app in this deployment's catalogue.` },
          400,
        );
      }
    } else {
      const owner = await store.skillOwner(ref);
      if (owner === undefined) {
        return context.json({ error: `There is no skill called ${ref}.` }, 400);
      }
      // Listing somebody's own skill would put one person's instructions on everybody's Wakers.
      if (owner !== null) {
        return context.json(
          {
            error: `${ref} is somebody's own skill. Only the deployment's skills can be listed.`,
          },
          400,
        );
      }
    }

    await store.addInstallListing(kind, ref, actorEmail(context));
    return context.json({ listings: await store.listInstallListings() });
  });

  routes.delete("/listings", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;

    const kind = asListingKind(context.req.query("kind"));
    const ref = context.req.query("ref")?.trim() ?? "";
    if (!kind || !ref) {
      return context.json(
        { error: "A kind (mcp or skill) and a catalogue key are required." },
        400,
      );
    }
    // Unlisting stops new installs. What owners already installed stays until they uninstall it.
    if (!(await store.removeInstallListing(kind, ref, actorEmail(context)))) {
      return context.json({ error: "That entry is not listed." }, 404);
    }
    return context.json({ ok: true });
  });

  /** What one Bot holds. The runtime reads this to decide what to offer a model. */
  /**
   * Spec E3: the tools and skills on this Bot that the caller installed themselves.
   *
   * What an owner may still take off after an administrator unlists the entry (see
   * {@link selfInstallDecision}): the assembly page keeps those visible and removable, and nothing
   * else that was unlisted. Gated like `/for/:agentId`, so it says nothing about somebody else's Bot.
   */
  routes.get("/for/:agentId/installed-by-me", requireUser, async (context) => {
    const agentId = context.req.param("agentId");
    if (!(await canUseBot(context.var.actor, agentId))) {
      return context.json({ error: "There is no such Bot." }, 404);
    }
    const email = context.var.actor?.email;
    const grants = email ? await store.grantsWrittenBy(agentId, email) : [];
    return context.json({
      tools: grants.filter((grant) => grant.kind === "mcp").map((g) => g.ref),
      skills: grants
        .filter((grant) => grant.kind === "skill")
        .map((g) => g.ref),
    });
  });

  routes.get("/for/:agentId", requireUser, async (context) => {
    const agentId = context.req.param("agentId");
    // A grant list is a fact about the Bot it belongs to. Left open it says which tools somebody
    // else's private coworker has been given.
    if (!(await canUseBot(context.var.actor, agentId))) {
      return context.json({ error: "There is no such Bot." }, 404);
    }
    return context.json(await store.listForAgent(agentId));
  });

  /**
   * Call a tool, as a Bot.
   *
   * The grant, the policy and the audit row all happen inside the store, so this endpoint cannot
   * accidentally satisfy one of them and skip another. A refusal comes back as 403 with the reason
   * the model and the person are both shown, which is the same sentence written to the trail.
   *
   * NOTHING IN THIS REPOSITORY CALLS IT. It is what the browser used to post to when a Bot's tool
   * loop ran client-side; that loop moved to the server, and the client helper for this went with it.
   * Kept rather than removed, because #37 hardened it with `canUseBot` after that move — so removing
   * it belongs in a change that says so, not in a merge resolution.
   */
  routes.post("/call", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      ref?: string;
      args?: Record<string, unknown>;
      agentId?: string;
    } | null;
    // Same shape lie as `/grants` above: JSON numbers, objects and arrays are truthy, so they
    // must be refused here rather than inside `canUseBot` or the tool call.
    if (
      typeof body?.ref !== "string" ||
      !body.ref.trim() ||
      typeof body.agentId !== "string" ||
      !body.agentId.trim()
    ) {
      return context.json({ error: "A tool and a Bot are required." }, 400);
    }
    // `args` reaches `Object.entries` inside the store, where a string fans out into indexed
    // entries, a number becomes no entries, and an array passes as an object — all escaping as
    // a vendor 502 instead of a 400 for a malformed call.
    if (
      body.args !== undefined &&
      (typeof body.args !== "object" ||
        body.args === null ||
        Array.isArray(body.args) ||
        Object.getPrototypeOf(body.args) !== Object.prototype)
    ) {
      return context.json({ error: "Tool arguments must be an object." }, 400);
    }

    // Asked before the grant is looked up, and before anything reaches a vendor. The grant says this
    // Bot may use the tool; it says nothing about whether this person may act as this Bot, and the
    // call goes out on the deployment's own credential either way.
    if (!(await canUseBot(context.var.actor, body.agentId))) {
      return context.json({ error: "There is no such Bot." }, 404);
    }

    try {
      const result = await store.callTool({
        ref: body.ref,
        args: body.args ?? {},
        botId: body.agentId,
        /*
         * The user id, not the address.
         *
         * `callTool` keys a per-person connection on `users.id`, so an address here finds nothing and
         * every call through this route would be answered "you have not connected your account" —
         * about a connector the person has connected. It never surfaced because a Bot's own tool loop
         * runs on the server and does not come through here.
         *
         * The other uses of `actorEmail` in this file are `by:` on configuration changes, where an
         * address is the useful thing to record. This one is an identity being resolved, not a name
         * being written down, and the two are not interchangeable.
         */
        actorId: context.var.actor.id,
      });
      return context.json(result);
    } catch (error) {
      if (error instanceof PluginRefusedError) {
        return context.json({ error: error.message, rule: error.rule }, 403);
      }
      if (error instanceof CatalogueEntryUnknownError) {
        return context.json({ error: error.message }, 404);
      }
      /*
       * Ours, and so neither the vendor's fault nor this caller's business.
       *
       * CRITERION. A fault on the `isDeploymentFault` shelf is not reported through the branch
       * below, and its sentence does not leave this process by this route.
       *
       * REASON. Two things would be wrong at once. `failed: true` and 502 say somebody else's
       * software did not answer, which is a false statement about a call that never went out —
       * and this route is `requireUser`, not `requireAdmin`, so the sentence naming our columns
       * and the correction to make would be readable by anybody with a session. The operator who
       * can act on it reads it on the refresh route above, which is admin-gated; here the honest
       * answer is that the deployment cannot make this call as it stands.
       */
      if (isDeploymentFault(error)) {
        return context.json(
          {
            error:
              "That tool is not configured in a way this deployment can act on. An administrator has to look at the server it belongs to.",
          },
          500,
        );
      }
      // A server that failed is not a refusal, and saying so matters: one means the deployment
      // decided against it, the other means somebody else's software did not answer.
      return context.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "The server did not answer.",
          failed: true,
        },
        502,
      );
    }
  });

  /**
   * 申请访问（迁移 0153，上游 #814 的收件箱部分）。
   *
   * 申请由员工在对话里调用 `request_app_access` 提出，行属于申请人的租户。申请人在自己的帧里看、撤回自己的
   * 申请；管理员经 `asAdminPlatform` 列出所有人的 pending 申请，处理结果经 `adminActAsOwner` 写回申请人的帧，
   * 轨迹也归申请人。
   *
   * 批准不新增授权路径：`enable` 调用现有的上架（`addInstallListing`，和 POST /listings 同一个），之后员工的
   * 主人按 D08 自己装；`grant` 走现有的授予（`asBotOwner` + `enablementDecision` + `store.grant`，和 POST
   * /grants 同一套），只授予应用标为只读、非破坏性的动作，写操作仍由管理员在插件页逐个授予。任一步失败时
   * 申请保持 pending，并返回中文原因。
   */
  const NO_SUCH_REQUEST = "没有这条申请。";
  const ALREADY_DECIDED = "这条申请已经处理过了。";

  /**
   * 能处理申请的人：现有的插件管理权限，也就是管理员角色加上 `adminCapability` 重新读过角色后给的
   * capability。角色被收回的管理员拿不到 capability，同样被拒。
   */
  const decisionRefusal = (context: { var: AppVariables }): string | null =>
    context.var.actor?.role === "admin" &&
    adminScope &&
    capabilityFor(currentTenant()) === "admin"
      ? null
      : "只有拥有插件管理权限的管理员可以处理访问申请。";

  /**
   * 会话里写着管理员、这次请求却没有拿到管理员能力的人，在管理员的写路径上得到的答复：403 和
   * {@link CAPABILITY_UNCONFIRMED}。会话给出的角色和 `user_roles` 可以不一致：角色已被收回，会话还说是
   * admin。只看会话角色的路径会让这个人继续做管理员的事。判断和 {@link decisionRefusal} 是同一个，只是
   * 不管成员：成员返回 undefined，各路由原有的判断照旧答他。
   *
   * 在路由入口、请求自己的帧里问，因为能力是在管理员自己的帧里持有的，进了员工主人的帧就读不到。
   */
  const staleAdminRefusal = (context: Context<{ Variables: AppVariables }>) =>
    context.var.actor?.role === "admin" && decisionRefusal(context) !== null
      ? context.json({ error: CAPABILITY_UNCONFIRMED }, 403)
      : undefined;

  /** 管理员读一条申请，跨租户，所以在 platform 帧里读；调用前已确认持有 capability。 */
  const requestForAdmin = (context: { var: AppVariables }, id: string) =>
    (adminScope as NonNullable<typeof adminScope>).asAdminPlatform(
      context.var.actor,
      () => store.appAccessRequest(id),
    );

  /** 把处理结果写回申请人的帧（I6）：这次改动和它的轨迹都归申请人。 */
  const decideAsRequester = (
    context: { var: AppVariables },
    request: AppAccessRequestRecord,
    status: "approved" | "dismissed",
  ) =>
    (adminScope as NonNullable<typeof adminScope>).adminActAsOwner(
      context.var.actor,
      request.tenantId,
      () =>
        store.decideAppAccessRequest({
          id: request.id,
          status,
          by: actorEmail(context),
        }),
    );

  /** 批准没有干净地完成时记一行日志：哪条申请、做到哪一步、已写入了哪些授予。 */
  const logApproval = (
    outcome: "refused" | "grant_failed" | "applied_but_closed",
    request: AppAccessRequestRecord,
    granted: string[],
    reason?: string,
  ) =>
    console.warn(
      JSON.stringify({
        type: "app-access-approve",
        outcome,
        request: request.id,
        kind: request.kind,
        app: request.appKey,
        bot: request.botId,
        granted,
        ...(reason ? { reason } : {}),
        timestamp: new Date().toISOString(),
      }),
    );

  /** 申请人自己的 pending 申请，最新的在前。 */
  routes.get("/access-requests/mine", requireUser, async (context) =>
    context.json({
      requests: await store.pendingAppAccessRequests({
        requesterUserId: context.var.actor.id,
      }),
    }),
  );

  /**
   * 管理员收件箱里所有人的待处理申请：应用访问申请，以及共享使用申请（X3）。跨租户，所以在 platform 帧
   * 里读，两种申请是同一次读、同一道门；调用前已确认持有 capability。
   */
  const pendingForAdmin = (context: { var: AppVariables }) =>
    (adminScope as NonNullable<typeof adminScope>).asAdminPlatform(
      context.var.actor,
      async () => ({
        appAccess: await store.pendingAppAccessRequests(),
        sharedUse: sharedUse ? await sharedUse.store.listRequests() : [],
      }),
    );

  /** 所有人的 pending 申请，给管理员收件箱。 */
  routes.get("/access-requests", signedInWithCapability, async (context) => {
    const refusal = decisionRefusal(context);
    if (refusal) return context.json({ error: refusal }, 403);
    const all = (await pendingForAdmin(context)).appAccess;
    // 上游的形状（X2）：`?app=` 只看一个应用的，`counts` 让插件列表给每个应用标数字而不用再读一次。
    const byApp: Record<string, number> = {};
    for (const request of all)
      byApp[request.appKey] = (byApp[request.appKey] ?? 0) + 1;
    const app = context.req.query("app")?.trim();
    return context.json({
      requests: app ? all.filter((request) => request.appKey === app) : all,
      counts: { total: all.length, byApp },
    });
  });

  /** 申请人自己的一条申请，卡片据此显示当前状态。别人的和不存在的一样答 404。 */
  routes.get("/access-requests/:id", requireUser, async (context) => {
    const request = await store.appAccessRequest(context.req.param("id"));
    if (!request || request.requesterUserId !== context.var.actor.id)
      return context.json({ error: NO_SUCH_REQUEST }, 404);
    return context.json({ request });
  });

  /** 申请人撤回自己的一条 pending 申请。别人的读起来和不存在的一样，从这里看不出谁申请了什么。 */
  routes.delete("/access-requests/:id", requireUser, async (context) => {
    const id = context.req.param("id");
    /*
     * 不是申请 id 的，和不存在的一样答 404（fork 测试钉住的答复），不读库、不写轨迹：URL 参数谁都能随手
     * 填，不让它成为往审计里写任意长字符串的入口。
     */
    if (!isUuid(id)) return context.json({ error: NO_SUCH_REQUEST }, 404);
    const cancelled = await store.cancelAppAccessRequest({
      id,
      requesterUserId: context.var.actor.id,
    });
    if (cancelled) {
      await store.recordAppAccessEvent({
        eventType: "app_access.cancelled",
        targetId: cancelled.appKey,
        actorUserId: context.var.actor.id,
        payload: {
          request: cancelled.id,
          app: cancelled.appKey,
          bot: cancelled.botId,
          kind: cancelled.kind,
        },
      });
      return context.json({ request: cancelled });
    }
    const existing = await store.appAccessRequest(id);
    const mine = existing?.requesterUserId === context.var.actor.id;
    await store.recordAppAccessRefusal({
      targetId: mine ? (existing?.appKey ?? "") : "",
      actorUserId: context.var.actor.id,
      payload: {
        app: mine ? (existing?.appKey ?? "") : "",
        request: id,
        reason: mine ? "already_resolved" : "no_such_request",
      },
    });
    if (mine) return context.json({ error: ALREADY_DECIDED }, 409);
    return context.json({ error: NO_SUCH_REQUEST }, 404);
  });

  const composioConfigured = Boolean(composio);
  /** 只为叫出一个这里还没有行的 broker 应用才问目录；适配器会缓存列表。 */
  const appDirectory = composio ? () => composio.broker.listApps() : undefined;

  /** 批准没能做成时写一行 `app_access.refused`，原因是给轨迹读的词，句子是给管理员读的中文。 */
  const approvalRefused = async (
    context: { var: AppVariables },
    request: AppAccessRequestRecord,
    reason: string,
  ) =>
    store.recordAppAccessEvent({
      eventType: "app_access.refused",
      targetId: request.appKey,
      actorUserId: context.var.actor.id,
      payload: {
        app: request.appKey,
        request: request.id,
        bot: request.botId,
        kind: request.kind,
        reason,
      },
    });

  /**
   * 授予之前没有保存任何工具时，先以按下的人的身份再问一次应用（上游 #1277）。添加时保存的清单可能是空的：
   * 当时 vendor 没回答，或者它只对登录了的人列工具。所以批准替管理员做应用页上「刷新」会做的事，而不是叫他
   * 去刷新。在按下的人自己的帧里问（批准要持有能力的管理员，刷新 `team` 行要的正是这个）。团队版里这只改
   * 应用的工具行；个人版里刷新经过 `withPersonalDefaults`，列出的全部工具（会改东西的也在内）随即给了每位
   * 员工，所以个人版里卡片上这一按给出的不只是只读动作，普通写挡在本人的「改动之前先问」后面（个人默认在
   * 给出第一个工具前把它打开）。问不到只记日志，接下来照旧按「没有工具」处理。
   *
   * 答这个应用的工具是不是要随本人登录才来——只在个人版里会是 true：应用跑在本人自己的账号上、靠 OAuth 或
   * 同意页连接、本人还没连上，还是一个工具都没有。那时批准就是把它打开、什么都不给；本人登录时列出工具，
   * `withPersonalDefaults` 把全部工具给每位员工，和在连接页上连接一样。团队版里管理员的批准就是授予本身，
   * 什么都不给的批准仍被拒绝，所以答 false。
   */
  const askForToolsFirst = async (
    context: Context<{ Variables: AppVariables }>,
    request: AppAccessRequestRecord,
  ): Promise<boolean> => {
    if (!request.serverId) return false;
    const saved = async () =>
      (await store.listServers()).find(
        (candidate) => candidate.id === request.serverId,
      )?.tools.length ?? 0;
    if ((await saved()) > 0) return false;
    try {
      // 只为列出工具：vendor 答 `invalid_client` 时不替换部署共用的 OAuth 客户端，那是应用页上的事。
      await store.refreshTools(request.serverId, context.var.actor.id, {
        reRegister: false,
      });
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "app-access-tools-refresh-failed",
          request: request.id,
          app: request.appKey,
          reason: reasonWithoutStatement(error),
          timestamp: new Date().toISOString(),
        }),
      );
    }
    if ((await saved()) > 0 || currentEdition() !== "personal") return false;
    const mine = await store.inspectApp({
      app: request.appKey,
      agentId: request.botId,
      userId: context.var.actor.id,
      composioConfigured,
      directory: appDirectory,
    });
    return (
      mine?.access.account === "personal" &&
      (mine.access.connect === "oauth" || mine.access.connect === "consent") &&
      mine.access.connectedAt === null
    );
  };

  /**
   * 批准一条申请就是做它要的那件事，然后关单（收件箱的批准与卡片上的一按共用，见 `app-access-routes.ts`）。
   *
   * 先改、后关单（fork 的顺序，fork 测试钉住）：改完发现申请在此期间被撤回或驳回，答一个可区分的 409
   * （`applied: true`），写明做了什么。上游先把申请「认领」成 approved 再改；fork 保留原顺序，见报告。
   *
   * - `enable`：应用有行、但缺只有管理员能填的东西（密钥、OAuth 客户端、读不懂的认证方式）时照实拒绝，
   *   申请保持待处理；有行就上架（`addInstallListing`），之后员工的主人按 D08 自己装。还没有行的目录条目
   *   先添加它（`addServer`，与 POST /servers 同一个），再上架；还没打开的 Composio 应用请管理员先在插件页
   *   启用（它要选认证方式，批准替不了）。上架不授予。
   * - `grant`：走现有的授予（`asBotOwner` + `enablementDecision` + `store.grant`）。不带 `refs` 只授予标为
   *   只读、非破坏性的动作；带 `refs` 时只授予这些，且每一个都必须是这个应用的动作。
   */
  const carryOutApproval = async (
    context: Context<{ Variables: AppVariables }>,
    request: AppAccessRequestRecord,
    chosen: string[] | undefined,
    direct = false,
  ): Promise<Response> => {
    const title = request.appTitle;
    const again = direct ? "再试一次" : "再批准这条申请";
    let granted: string[] = [];
    let enabled = false;
    /** 个人版里打开了一个要等本人登录才列工具的应用，什么都没给（轨迹上和「授予了 0 个」分开）。 */
    let opened = false;

    if (request.kind === "enable") {
      const inspected = await store.inspectApp({
        app: request.appKey,
        agentId: request.botId,
        userId: null,
        composioConfigured,
        directory: appDirectory,
      });
      if (inspected?.unavailable && inspected.unavailable !== "absent") {
        await approvalRefused(context, request, inspected.unavailable);
        return context.json(
          { error: unavailableSentence(inspected.unavailable, title, again) },
          inspected.unavailable === "composio_unconfigured" ? 503 : 409,
        );
      }
      if (inspected && inspected.answeringId === null) {
        if (!inspected.entry) {
          await approvalRefused(context, request, "needs_admin_enable");
          return context.json(
            {
              error: `「${title}」还没有在本部署打开。请先在${appsPageZh()}启用它（要选它怎么连接），然后${again}。`,
            },
            409,
          );
        }
        const needed = adminInputFor(inspected.entry);
        if (needed) {
          await approvalRefused(context, request, "needs_admin_input");
          return context.json(
            {
              error: `「${title}」还需要${needed}。请在${appsPageZh()}它的页面上添加，然后${again}。`,
            },
            409,
          );
        }
        try {
          await store.addServer({
            key: inspected.entry.key,
            by: actorEmail(context),
          });
        } catch (error) {
          const sentence =
            error instanceof CatalogueEntryUnknownError ||
            error instanceof CustomServerRefusedError
              ? error.message
              : isDeploymentFault(error)
                ? deploymentFaultSentence(error)
                : null;
          if (sentence === null) throw error;
          await approvalRefused(context, request, "enable_failed");
          return context.json(
            { error: `没能打开「${title}」：${sentence}` },
            409,
          );
        }
        enabled = true;
      } else if (
        // 和 POST /listings 一样的检查：上架的是应用，必须是目录里的条目或本部署已添加的应用。
        catalogueEntry(request.appKey) === null &&
        !(await store.serverExists(request.appKey))
      ) {
        return context.json(
          { error: `「${title}」已经不是本部署的应用，无法上架。` },
          409,
        );
      }
      await store.addInstallListing("mcp", request.appKey, actorEmail(context));
    } else {
      const signInFirst = await askForToolsFirst(context, request);
      const outcome = await asBotOwner(context, request.botId, async () => {
        const server = (await store.listServers()).find(
          (candidate) => candidate.id === request.serverId,
        );
        if (!server)
          return {
            error: `「${title}」已经不是本部署的应用，无法授予。`,
            status: 409 as const,
          };
        if (server.tools.length === 0) {
          // 个人版里随本人登录才列工具的应用：批准就是打开它，什么都不给，登录之后每位员工拿到全部工具。
          if (signInFirst) {
            opened = true;
            return { refs: [] as string[] };
          }
          return {
            error: `「${title}」还没有可以授予的工具。请在${appsPageZh()}打开它的页面看看原因，然后${again}。`,
            status: 409 as const,
            reason: "no_tools",
          };
        }
        const advertised = server.tools.map((tool) => tool.ref);
        const outside = (chosen ?? []).filter(
          (ref) => !advertised.includes(ref),
        );
        if (outside.length > 0)
          return {
            error: `${outside.join("、")} 不是「${title}」的动作。`,
            status: 400 as const,
          };
        const refs =
          chosen ??
          server.tools
            .filter((tool) => tool.effect === "read" && !tool.destructive)
            .map((tool) => tool.ref);
        if (refs.length === 0)
          return {
            error: `「${title}」没有标为只读的动作，在这里批准什么也授予不了。请在${appsPageZh()}为这位员工逐个选择可以使用的动作，再处理这条申请。`,
            status: 409 as const,
          };
        for (const ref of refs) {
          const decision = await enablementDecision(
            context,
            "mcp",
            ref,
            request.botId,
            "grant",
          );
          if (decision.refusal !== null) {
            // 原文是英文、写给开发者的；收件箱里给管理员看中文，原文只进日志（M-2）。
            logApproval("refused", request, [], decision.refusal);
            return {
              error: `无法把「${title}」授予这位员工：员工或应用已不存在，或这项授予不由管理员在这里决定。`,
              status: 403 as const,
              granted: [] as string[],
            };
          }
        }
        /*
         * 逐个写入，记下写成了哪些。中途失败时前面写入的授予会留下（每个都是幂等的 upsert，重试会补齐），
         * 所以响应和日志都写明已写入了哪些，申请保持 pending。
         */
        const written: string[] = [];
        try {
          for (const ref of refs) {
            await store.grant("mcp", ref, request.botId, actorEmail(context));
            written.push(ref);
          }
        } catch (error) {
          logApproval(
            "grant_failed",
            request,
            written,
            error instanceof Error ? error.message : String(error),
          );
          const done = written.length > 0 ? written.join("、") : "无";
          return {
            error: `授予「${title}」时中途失败，申请保持待处理。已写入：${done}。${error instanceof PluginRefusedError ? "其余的这项授予不由管理员在这里决定。" : "其余的没有写入，可以稍后再批准一次补齐。"}`,
            status: (error instanceof PluginRefusedError ? 403 : 500) as
              | 403
              | 500,
            granted: written,
          };
        }
        return { refs };
      });
      if ("error" in outcome) {
        await approvalRefused(
          context,
          request,
          ("reason" in outcome ? outcome.reason : undefined) ??
            `grant_${outcome.status}`,
        );
        return context.json(
          { error: outcome.error, granted: outcome.granted },
          outcome.status,
        );
      }
      granted = outcome.refs;
    }

    const decided = await decideAsRequester(context, request, "approved");
    if (!decided) {
      /*
       * 上架或授予已经生效，但关单时发现申请在此期间已被撤回或驳回（I-1）。这和「什么都没做成」的
       * 409 不是一回事：返回一个可以区分的答复（`applied: true`），写明做了什么、申请状态没改，
       * 由管理员决定要不要到插件页撤销。
       */
      logApproval("applied_but_closed", request, granted);
      const what =
        request.kind === "enable"
          ? `「${title}」已上架`
          : `「${title}」已授予（${granted.join("、")}）`;
      return context.json(
        {
          error: `${what}，但这条申请在此期间已被撤回或驳回，申请状态未改。如不需要，请到插件页${request.kind === "enable" ? "下架" : "撤销"}。`,
          applied: true,
          granted,
        },
        409,
      );
    }
    await store.recordAppAccessEvent({
      eventType: "app_access.approved",
      targetId: decided.appKey,
      actorUserId: context.var.actor.id,
      payload: {
        request: decided.id,
        app: decided.appKey,
        bot: decided.botId,
        kind: decided.kind,
        enabled,
        granted: granted.length,
        ...(opened ? { opened: true } : {}),
        ...(direct ? { direct: true } : {}),
      },
    });
    return context.json({ request: decided, granted, enabled });
  };

  routes.post(
    "/access-requests/:id/approve",
    signedInWithCapability,
    async (context) => {
      const refusal = decisionRefusal(context);
      if (refusal) return context.json({ error: refusal }, 403);
      const body = (await context.req.json().catch(() => null)) as {
        refs?: unknown;
      } | null;
      if (
        body?.refs !== undefined &&
        (!Array.isArray(body.refs) ||
          body.refs.some((ref) => typeof ref !== "string"))
      )
        return context.json({ error: "动作必须是一组 ref。" }, 400);
      const request = await requestForAdmin(context, context.req.param("id"));
      if (!request) return context.json({ error: NO_SUCH_REQUEST }, 404);
      if (request.status !== "pending")
        return context.json({ error: ALREADY_DECIDED }, 409);
      return carryOutApproval(
        context,
        request,
        body?.refs as string[] | undefined,
      );
    },
  );

  if (sharedUse)
    mountSharedUseRoutes({
      routes,
      shared: sharedUse,
      capable: signedInWithCapability,
      decisionRefusal,
      asBotOwner,
      pendingForAdmin: async (context) =>
        (await pendingForAdmin(context)).sharedUse,
    });

  mountAppAccessRoutes({
    routes,
    store,
    requireUser,
    capable: signedInWithCapability,
    canUseBot,
    asBotOwner,
    composioConfigured,
    directory: appDirectory,
    decisionRefusal,
    carryOut: carryOutApproval,
    ...(sharedUse ? { shared: sharedUse } : {}),
  });

  /** 驳回：只关掉这条申请，别的什么也不改。 */
  routes.post(
    "/access-requests/:id/dismiss",
    signedInWithCapability,
    async (context) => {
      const refusal = decisionRefusal(context);
      if (refusal) return context.json({ error: refusal }, 403);
      const request = await requestForAdmin(context, context.req.param("id"));
      if (!request) return context.json({ error: NO_SUCH_REQUEST }, 404);
      if (request.status !== "pending")
        return context.json({ error: ALREADY_DECIDED }, 409);
      const decided = await decideAsRequester(context, request, "dismissed");
      if (!decided) return context.json({ error: ALREADY_DECIDED }, 409);
      await store.recordAppAccessEvent({
        eventType: "app_access.dismissed",
        targetId: decided.appKey,
        actorUserId: context.var.actor.id,
        payload: {
          request: decided.id,
          app: decided.appKey,
          bot: decided.botId,
          kind: decided.kind,
        },
      });
      return context.json({ request: decided });
    },
  );

  return routes;
}
