import { appsPageZh } from "../edition";
import type { BrokerConnection } from "./broker";

/**
 * The OAuth clients this deployment registered itself, for the brokered apps that need one.
 *
 * Ported from upstream #950 (2178a386) and reshaped for this fork's custody of secrets.
 *
 * SERVER-TO-SERVER ONLY, AND THAT IS THE WHOLE OF THE SCOPE. `S2S_OAUTH2` is a client-credentials
 * grant: Composio exchanges the client id and secret for a token at connect time, with no consent
 * screen and no redirect, so the one thing the deployment has to hold is the pair itself. Shopify
 * publishes exactly this for a Dev Dashboard app installed on a store its organization owns. An
 * app's ordinary `OAUTH2` still needs a redirect this deployment does not run, and stays refused.
 *
 * HELD IN THE VAULT, NOT IN THE ENVIRONMENT. Upstream reads the pair from
 * `COMPOSIO_<SLUG>_CLIENT_ID` / `_SECRET`. Here an administrator stores it through
 * `PUT /api/plugins/composio/clients/:slug`, and it is sealed like every other OAuth client this
 * deployment holds: kind `mcp_oauth_client`, sealed to `team` with a v2 envelope bound to its row,
 * readable only by the store, never returned by any route, never written to the trail. The only
 * place it ever leaves sealed is the authorization config created at Composio, which is the point.
 */
export type DeploymentClient = { client_id: string; client_secret: string };

export const DEPLOYMENT_CLIENT_SCHEME = "S2S_OAUTH2";

/** The vault key one app's client is stored under. Never a server id: it exists before any row. */
export function deploymentClientKey(toolkit: string): {
  kind: "mcp_oauth_client";
  provider: string;
  keyId: string;
} {
  return {
    kind: "mcp_oauth_client",
    provider: DEPLOYMENT_CLIENT_PROVIDER,
    keyId: `${DEPLOYMENT_CLIENT_KEY_PREFIX}${toolkit}`,
  };
}

/** The vault `provider` every deployment client is filed under, so they list together. */
export const DEPLOYMENT_CLIENT_PROVIDER = "composio";
const DEPLOYMENT_CLIENT_KEY_PREFIX = "composio-s2s-client:";

/** The toolkit a vault key names, or null for a key that is not a deployment client's. */
export function toolkitOfDeploymentClientKey(keyId: string): string | null {
  return keyId.startsWith(DEPLOYMENT_CLIENT_KEY_PREFIX)
    ? keyId.slice(DEPLOYMENT_CLIENT_KEY_PREFIX.length) || null
    : null;
}

/** The longest client id and secret a pair may carry (review M-3). Well past any vendor's. */
export const CLIENT_ID_MAX = 512;
export const CLIENT_SECRET_MAX = 4096;
/** The longest app name a client may be stored under, as the catalogue spells slugs. */
export const DEPLOYMENT_CLIENT_SLUG_MAX = 64;

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * A pair as an administrator typed it, or null when it is not one. Both halves, trimmed: half a
 * pair is no client, and an app offered on half a pair fails at the first connect. Bounded and free
 * of control characters, because the id is written into the row's metadata, the trail and the
 * listing, and neither half is ever a page of text (review M-3).
 */
export function deploymentClientFrom(value: unknown): DeploymentClient | null {
  if (typeof value !== "object" || value === null) return null;
  const { client_id, client_secret } = value as Record<string, unknown>;
  if (typeof client_id !== "string" || typeof client_secret !== "string") {
    return null;
  }
  const id = client_id.trim();
  const secret = client_secret.trim();
  if (!id || !secret) return null;
  if (id.length > CLIENT_ID_MAX || secret.length > CLIENT_SECRET_MAX) {
    return null;
  }
  if (CONTROL_CHARACTERS.test(id) || CONTROL_CHARACTERS.test(secret)) {
    return null;
  }
  return { client_id: id, client_secret: secret };
}

/**
 * The app a client is stored under, as the catalogue spells it, or null (review M-3).
 *
 * Lower-cased, because the catalogue's slugs are, and a client stored under `Shopify` would never
 * meet the directory's `shopify`: stored, and silently never used. Letters, digits, underscores and
 * hyphens, at most {@link DEPLOYMENT_CLIENT_SLUG_MAX}, which is also what a `composio://` url reads.
 */
export function deploymentClientSlug(raw: string): string | null {
  const slug = raw.trim().toLowerCase();
  return slug.length <= DEPLOYMENT_CLIENT_SLUG_MAX && /^[a-z0-9_-]+$/.test(slug)
    ? slug
    : null;
}

/**
 * Whether an app connected under this scheme may only be connected by an administrator.
 *
 * A PERSON'S ACCOUNT ON THE DEPLOYMENT'S CLIENT WOULD BE THE ORGANIZATION'S ACCESS UNDER THAT
 * PERSON'S NAME. Somebody connecting a server-to-server app types only what the connection names,
 * a store subdomain, and the credential Composio exchanges is the client above, so whoever could
 * see the app enabled could hold the store's full access as "their own" account, granted by nobody.
 * Upstream answers this with a Shared account that only an administrator connects; this fork has no
 * shared accounts, so the same line is drawn at the person: only an administrator, who holds the
 * client already, connects such an app. Read by the connect route and the store before anything is
 * sent, and by the screens through `adminConnectOnly` on the listing.
 */
export function adminConnectOnly(authScheme: string | null): boolean {
  return authScheme === DEPLOYMENT_CLIENT_SCHEME;
}

/** The refusal a person's connect to such an app meets, in one place for both readers of it. */
export function adminConnectOnlySentence(title: string): string {
  return `${title} 用的是这个部署自己的应用凭据，不是你自己的账号，所以只有管理员能连接它。没有建立任何连接。请联系管理员。`;
}

/**
 * The refusal a call through such an account meets once the person it was made by is no longer an
 * administrator (review I-1). Said to whoever's Bot made the call, which may be a teammate's.
 */
export function adminConnectionLapsedSentence(title: string): string {
  return `${title} 的连接用的是这个部署自己的应用凭据，只能由管理员持有；建立这个连接的人现在已经不是管理员，所以这次没有调用。请管理员重新连接 ${title}。`;
}

/** What an administrator is told when enabling such an app with no client stored for it. */
export function deploymentClientMissingSentence(toolkit: string): string {
  return `${toolkit} 通过服务器到服务器授权（S2S_OAUTH2）连接，要用这个部署自己在 ${toolkit} 注册的 OAuth 客户端，而这个部署还没有保存它，所以没有创建授权配置，应用也没有启用。请先在${appsPageZh()}为 ${toolkit} 保存客户端 ID 和密钥，再启用一次。`;
}

/**
 * The directory as this deployment can drive it, given which apps it holds a client for.
 *
 * {@link connectionOf} in `composio-adapter.ts` is synchronous and reads only the catalogue row, and
 * the directory it builds is held for ten minutes; whether this deployment holds a client is a vault
 * read that changes the moment an administrator stores one. So the row marks an app that a client
 * WOULD make connectable (`awaitsClient`), and this turns exactly those into the field scheme, per
 * request, from the set the store reads. An app with no client stored stays `unsupported`, hidden
 * from the picker and refused at enable, as before.
 */
export function withDeploymentClients<
  App extends { slug: string; connection: BrokerConnection },
>(apps: readonly App[], held: ReadonlySet<string>): App[] {
  return apps.map((app) =>
    app.connection.kind === "unsupported" &&
    app.connection.awaitsClient === true &&
    held.has(app.slug)
      ? {
          ...app,
          connection: { kind: "fields", authScheme: DEPLOYMENT_CLIENT_SCHEME },
        }
      : app,
  );
}
