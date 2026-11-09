/**
 * The catalogue of MCP servers this deployment will talk to, and the rule that decides admissibility.
 *
 * First-party only, and the list is frozen in code. A remote MCP server is a piece of somebody
 * else's software that our Bots hand credentials to and take instructions from, so "which servers"
 * is a decision to make once, in review, rather than one to leave to whoever is typing a URL into an
 * admin page at the time. Only servers the vendor themselves maintains are here. A community server
 * that wraps the same API is not equivalent: it is an extra party in the trust path with none of the
 * accountability, and the answer for a vendor without an official server is to wait for one.
 *
 * Every host and path here comes from the vendor's published documentation. They are pinned rather
 * than discovered, because a URL this deployment will hand a credential to is a reviewed source
 * contract.
 *
 * Admissibility is fail-closed and checked against the pinned host, never against what a caller
 * supplied. A URL that does not exactly match a pinned host, or match one anchored per-instance
 * pattern, is refused. This is the control that stops "add an MCP server" from being a request
 * forgery primitive pointed at the deployment's own network.
 */

/**
 * How a server is authenticated, and whose credential does it.
 *
 * The OAuth addresses are pinned here beside the MCP host, for the same reason and with the same
 * rule: they come from the vendor's published documentation and are never taken from a caller.
 * These are where this deployment sends a person's authorization code and receives the refresh
 * token that stands in for their access, so they are a reviewed source contract too.
 */
// The one place browsing and this check agree on: the addresses that hold the deployment's own
// cloud credentials. `target.ts` imports nothing itself, so asking it here adds no dependency.
import { isNeverAllowedHostname } from "../computer/target";
// Type-only, so naming the transport here creates no import cycle with the registry that resolves it.
import type { CuratedTransportKind } from "./transport";

export type CatalogueAuth =
  /** Answers without any credential at all. */
  | { kind: "none" }
  /** One token, held by the deployment, used for everybody. */
  | { kind: "deployment-bearer" }
  /**
   * First-party and in-process. There is no credential, because there is nothing to authenticate
   * to: the call runs against this deployment's own tables, as the person whose turn it is.
   */
  | { kind: "builtin" }
  /**
   * The asker's own grant. The deployment registers an OAuth client; each person consents once and
   * the call runs on their token, so the vendor decides what comes back.
   */
  | {
      kind: "user-oauth";
      authorizationUrl: string;
      tokenUrl: string;
      /** Where a disconnect is sent, so revocation happens at the vendor and not just here. */
      revokeUrl: string;
      /**
       * What to ask a person to consent to. Narrow on purpose: a scope granted by everybody who
       * connects and used by nothing is a permission nobody remembers agreeing to. Empty for a
       * vendor whose consent screen itself is the scoping (Notion), where scope strings would
       * assert a control that does not exist.
       */
      scopes: readonly string[];
      /**
       * How the deployment gets its OAuth client. Absent means an administrator registers one at
       * the vendor and pastes it in. `dynamic` means the deployment registers ITSELF (RFC 7591)
       * on first connect — no admin step, no client secret; PKCE carries the proof instead.
       */
      clientRegistration?: "dynamic";
      /** The RFC 7591 endpoint. Pinned https, required when `clientRegistration` is `dynamic`. */
      registrationUrl?: string;
      /**
       * Vendor-specific consent-URL parameters. Google's offline/consent pair lives HERE rather
       * than in `authorizationUrlFor`, so one vendor's requirements are never sent to another —
       * an unknown parameter is a thing a strict vendor may refuse the whole request over.
       */
      authorizationParams?: Readonly<Record<string, string>>;
    };

export type CatalogueEntry = {
  /** Stable slug. Prefixes every tool name, so tools from two servers can never collide. */
  key: string;
  title: string;
  vendor: string;
  summary: string;
  /**
   * The one host this server lives on. Null for a vendor that gives every customer their own
   * hostname, where {@link CatalogueEntry.hostPattern} decides instead.
   */
  host: string | null;
  /**
   * Anchored pattern for a per-instance vendor. Only consulted when `host` is null, and written
   * anchored at both ends so it cannot match a host that merely ends in the vendor's domain.
   */
  hostPattern?: string;
  /** The path the MCP endpoint is served at. Frozen here, never taken from a caller. */
  path: string;
  /**
   * Whose credential this server is reached with.
   *
   * This used to be `needsCredential: boolean`, which said that a credential was required and not
   * whose it was. That is the one thing about a connector worth being unambiguous about: a reader
   * who has to guess guesses the deployment's, and a deployment-wide credential pointed at a
   * per-person system means everybody's question is answered from what one account can see. So the
   * shape names it, and every entry states it.
   *
   * `deployment-bearer` is a token an administrator holds on behalf of everybody. `user-oauth` is
   * the person's own grant, where the deployment holds only the OAuth client and each person
   * consents for themselves. `builtin` is neither: there is nothing to authenticate to, because the
   * call runs in this process against this deployment's own tables as the person whose turn it is.
   */
  auth: CatalogueAuth;
  /** Reviewed owner assembly opt-in; credential and provenance gates still apply. */
  ownerAssembly?: boolean;
  /**
   * The tools this vendor's server exposes that change something.
   *
   * Kept so the policy can be written about effect rather than about tool names a rule author would
   * have to look up. Known-incomplete for some vendors, which is why {@link classifyTool} treats an
   * unknown tool as a write rather than as a read: a tool the server never advertised, so nothing
   * here could have named it, is safe to over-scrutinize as a write. The opposite direction is the
   * one that matters for this list: a tool the server DOES advertise but that is missing from here
   * classifies as a read unless the vendor itself recorded an effect for it, so for a vendor that
   * records nothing — which is every one here today — an incomplete list is the failure mode rather
   * than a safe default, and this list has to lean over-inclusive.
   *
   * Nothing outside review can shorten it, either. A name this list holds is a write no matter what
   * a vendor recorded for that action, because this list is what a person read and the recorded
   * effect is whatever was last written into an unconstrained column.
   */
  writeTools: readonly string[];
  /**
   * Which protocol reaches this vendor. Absent means MCP, which is what every entry was.
   *
   * A field rather than an inference, because the answer is not derivable from the host: Google
   * serves Drive over both an MCP endpoint and an ordinary REST API, and which one this deployment
   * uses is a decision about availability and risk rather than a property of the vendor. Naming it
   * here keeps that decision beside the host it applies to, and makes reversing it a one-line diff.
   *
   * NOT EVERY KIND, and the narrowing is the point: see {@link CuratedTransportKind}. The broker's
   * transport is reached from a row's provenance and its url, never from an entry, and an entry
   * naming it resolves to a Composio dial with no app and no brokered gate.
   */
  transport?: CuratedTransportKind;
  docsUrl: string;
};

/**
 * A short list, deliberately.
 *
 * Atlassian, Box, Slack, Salesforce and ServiceNow were here and were removed: each was a reviewed
 * source contract for a vendor nobody had connected, and a screen offering five untried connectors
 * asserts more than this deployment can stand behind. They are in the history if they are wanted
 * back, and re-adding one is a review of that vendor rather than a revert.
 *
 * The MCP market's first batch (below the Parallel entries) is the same rule applied forwards rather
 * than an exception to it: nine servers, each vendor-hosted, each answered from this deployment's own
 * network before it was entered, and each offering only lookups. "Short" was never a number; it is
 * that every entry is one somebody tried, and those nine were.
 *
 * `deployment-bearer` is used by the keyed Parallel entry and by the two Alibaba Cloud Model Studio
 * entries, each reached with one key the deployment holds for public-web lookups that answer the same
 * whoever asks. The shape is also the branch a server an administrator added by URL falls into, since
 * that has no catalogue entry at all.
 *
 * Routines is the first entry here that is not a remote vendor at all — no host to dial, nothing
 * outside this process to trust. It is in the catalogue anyway, on purpose rather than by oversight:
 * the catalogue is where a deployment decides which Bots may do what, and a Bot that can schedule its
 * own future runs is a capability worth that same deliberate grant, even though there is no vendor on
 * the other end of it.
 */
export const CATALOGUE: readonly CatalogueEntry[] = Object.freeze([
  {
    key: "parallel",
    ownerAssembly: true,
    title: "Parallel Search",
    vendor: "Parallel",
    summary:
      "Public-web search and source extraction. Free anonymous access for light use.",
    host: "https://search.parallel.ai",
    path: "/mcp",
    auth: { kind: "none" },
    writeTools: Object.freeze([]),
    docsUrl: "https://docs.parallel.ai/integrations/mcp/search-mcp",
  },
  {
    key: "parallel-authenticated",
    title: "Parallel Search (API key)",
    vendor: "Parallel",
    summary:
      "Public-web search and extraction using this deployment's Parallel API key.",
    host: "https://search.parallel.ai",
    path: "/mcp",
    auth: { kind: "deployment-bearer" },
    writeTools: Object.freeze([]),
    docsUrl: "https://docs.parallel.ai/integrations/mcp/search-mcp",
  },

  /*
   * MCP MARKET, FIRST BATCH. Nine vendor-hosted remote servers, every one reviewed on the same
   * evidence: an anonymous read-only handshake plus `tools/list`, run on 2026-11-09 from the JD Cloud
   * network this deployment is served from — so "reachable" below is measured, not inferred. Each
   * entry's host and path are the endpoint the vendor's own documentation publishes, and each server
   * is run by the vendor itself, not a community wrapper of the vendor's API.
   *
   * THE WRITE LISTS ARE EMPTY, AND THAT IS A REVIEWED STATEMENT RATHER THAN AN OMISSION. Every tool
   * the handshake listed is a lookup — search, fetch, read — and where the server annotated them they
   * carry `readOnlyHint`. That hint is NOT what makes them reads here (`declaredEffect` in mcp.ts
   * deliberately ignores it): an advertised name this list declines to call a write is a read by
   * {@link classifyTool}, and the hint only corroborates that the decision is right. Empty also means
   * `unlistedAdvertisedTools` in store.ts names nothing for these entries, so the reconciliation it
   * does for Notion is a person's job here: on the first Refresh tools, compare the live listing
   * against the names in each entry's comment, and any tool that was not there on 2026-11-09 is
   * reviewed before it is granted, and added to `writeTools` if it changes anything. Reads only does
   * not mean ungoverned, either: a grant and the action policy still decide whether a Bot may call
   * each one.
   *
   * None of these opts into owner assembly. `ownerAssembly` is its own reviewed decision, taken for
   * Parallel alone, and is not implied by a server being anonymous.
   *
   * No credential goes into a URL. Every host is a bare https origin, no path carries a key or a
   * query string, and every resolved URL passes the same static refusals an administrator's typed URL
   * would (`customUrlRefusal` below and the outbound guard's `checkOutboundUrl`) — asserted per entry
   * in plugin-catalogue-market.test.ts. A vendor that publishes its optional key as a query
   * parameter (Exa) is entered keyless for exactly that reason.
   */
  {
    key: "context7",
    title: "Context7 技术文档",
    vendor: "Upstash",
    summary: "按库名检索编程库与框架的最新官方文档和代码示例，免登录。",
    /*
     * Upstash's own hosted server, documented in the official upstash/context7 repository. Anonymous
     * use is rate-limited; an API key raises the quota and would be a separate deployment-bearer
     * entry, not a flag on this one. Listed on 2026-11-09: `resolve-library-id`, `query-docs`, both
     * annotated read-only.
     */
    host: "https://mcp.context7.com",
    path: "/mcp",
    auth: { kind: "none" },
    writeTools: Object.freeze([]),
    docsUrl: "https://github.com/upstash/context7",
  },
  {
    key: "deepwiki",
    title: "DeepWiki 代码仓库问答",
    vendor: "Cognition（Devin）",
    summary: "浏览公开 GitHub 仓库的 AI 生成文档并就仓库提问，免登录。",
    /*
     * Cognition's hosted server; Devin's documentation states it is free, unauthenticated and covers
     * public repositories only. Listed on 2026-11-09: `ask_wiki_question`, `read_wiki_contents`,
     * `read_wiki_structure`. The server carries no annotations at all — these are reads on their
     * names and on Devin's documentation, which describes all three as reading a repository's wiki.
     * That makes this the entry where the first-refresh check above matters most.
     */
    host: "https://mcp.deepwiki.com",
    path: "/mcp",
    auth: { kind: "none" },
    writeTools: Object.freeze([]),
    docsUrl: "https://docs.devin.ai/work-with-devin/deepwiki-mcp",
  },
  {
    key: "microsoft-learn",
    title: "Microsoft Learn 文档",
    vendor: "Microsoft",
    summary: "搜索并读取 Microsoft Learn 官方技术文档与代码示例，免登录。",
    /*
     * Microsoft's own endpoint, which its documentation states needs no authentication. Listed on
     * 2026-11-09: `microsoft_docs_search`, `microsoft_code_sample_search`, `microsoft_docs_fetch`,
     * all annotated read-only.
     */
    host: "https://learn.microsoft.com",
    path: "/api/mcp",
    auth: { kind: "none" },
    writeTools: Object.freeze([]),
    docsUrl: "https://learn.microsoft.com/training/support/mcp",
  },
  {
    key: "aws-knowledge",
    title: "AWS 知识库",
    vendor: "AWS",
    summary: "搜索并读取 AWS 官方文档、区域与服务可用性信息，免登录。",
    /*
     * AWS's hosted knowledge server, documented by awslabs; no AWS account is needed. The endpoint
     * is served at the origin itself, so the path is the root and `resolveServerUrl` dials the bare
     * host. Listed on 2026-11-09: `aws___read_documentation`, `aws___search_documentation`,
     * `aws___list_regions`, `aws___get_regional_availability`, `aws___retrieve_skill`, all annotated
     * read-only. The triple underscore is AWS's own spelling; a tool ref is split at the FIRST `__`
     * after the `mcp__` prefix (`refFromToolName` in store.ts), and no catalogue key contains one,
     * so the tool half keeps it intact.
     */
    host: "https://knowledge-mcp.global.api.aws",
    path: "/",
    auth: { kind: "none" },
    writeTools: Object.freeze([]),
    docsUrl: "https://awslabs.github.io/mcp/servers/aws-knowledge-mcp-server",
  },
  {
    key: "cloudflare-docs",
    title: "Cloudflare 开发者文档",
    vendor: "Cloudflare",
    summary: "检索 Cloudflare 官方开发者文档，免登录。",
    /*
     * One of the servers Cloudflare runs from its official mcp-server-cloudflare repository, which
     * lists this host as active. Answered without a credential on 2026-11-09 and listed
     * `search_cloudflare_documentation` and `migrate_pages_to_workers_guide`, both annotated
     * read-only. Cloudflare's other servers in the same repository (Workers, DNS and so on) take an
     * account grant and can write; each is its own entry if wanted, not a widening of this one.
     */
    host: "https://docs.mcp.cloudflare.com",
    path: "/mcp",
    auth: { kind: "none" },
    writeTools: Object.freeze([]),
    docsUrl: "https://github.com/cloudflare/mcp-server-cloudflare",
  },
  {
    key: "exa",
    title: "Exa 网页搜索",
    vendor: "Exa",
    summary: "面向 AI 的公开网页搜索与网页正文抓取。免 Key 档，有限速。",
    /*
     * Exa's hosted server on its keyless tier. Exa accepts an optional key, documented as an
     * `exaApiKey` query parameter or a header; the query form is a credential in a URL, which this
     * catalogue does not pin, so the entry is keyless. Listed on 2026-11-09: `web_search_exa`,
     * `web_fetch_exa`, both annotated read-only. Exa also publishes an agent tool for keyed callers;
     * if one ever appears on this keyless endpoint it is reviewed, not inherited.
     */
    host: "https://mcp.exa.ai",
    path: "/mcp",
    auth: { kind: "none" },
    writeTools: Object.freeze([]),
    docsUrl: "https://exa.ai/docs",
  },
  {
    key: "firecrawl-keyless",
    title: "Firecrawl 网页抓取（免 Key）",
    vendor: "Firecrawl",
    summary: "抓取与解析公开网页，并做网页搜索。免 Key 档，有限速。",
    /*
     * Firecrawl's hosted v2 server on its documented keyless tier. The legacy form that put the key
     * in the path is deliberately not used. Listed on 2026-11-09: `firecrawl_scrape`,
     * `firecrawl_search`, `firecrawl_parse`, all annotated read-only.
     *
     * The keyed tier offers more, and some of it is not a read: Firecrawl documents an interactive
     * browser tool (clicking, filling forms) and an agent tool there. Neither is advertised here, so
     * neither can be called; if either appears on a refresh it belongs in `writeTools` before it is
     * granted, and a keyed Firecrawl is a separate entry.
     */
    host: "https://mcp.firecrawl.dev",
    path: "/v2/mcp",
    auth: { kind: "none" },
    writeTools: Object.freeze([]),
    docsUrl: "https://docs.firecrawl.dev/mcp-server/keyless",
  },
  {
    key: "bailian-websearch",
    title: "阿里云百炼联网搜索",
    vendor: "阿里云（百炼）",
    summary:
      "百炼官方托管的联网搜索，查询新闻、百科、天气等实时信息。按量计费。",
    /*
     * Alibaba Cloud Model Studio's own hosted server, on its mainland DashScope host. Reached with
     * the deployment's DashScope API key as `Authorization: Bearer`, which is what
     * `deployment-bearer` sends: one key an administrator holds for everybody, billed per call to
     * the deployment's Model Studio account. That is acceptable here because a web search answers
     * from the public web, the same for whoever asks; nothing per-person sits behind the key.
     *
     * Measured on 2026-11-09 without a key: reachable, and refused with 401, so the tool listing was
     * not seen. The handshake is the first Refresh tools after the key is set, and that listing is
     * reviewed then. Model Studio's documentation describes a single web-search tool; anything else
     * it lists that changes something goes into `writeTools` before it is granted.
     */
    host: "https://dashscope.aliyuncs.com",
    path: "/api/v1/mcps/WebSearch/mcp",
    auth: { kind: "deployment-bearer" },
    writeTools: Object.freeze([]),
    docsUrl: "https://help.aliyun.com/zh/model-studio/mcp-external-calls",
  },
  {
    key: "bailian-enhanced-search",
    title: "阿里云百炼增强搜索",
    vendor: "阿里云（百炼）",
    summary: "百炼托管的增强联网搜索，可能仅限特定套餐。按量计费。",
    /*
     * The same vendor, host and credential shape as `bailian-websearch`, on the path Model Studio's
     * Token Plan tool documentation publishes. Its own entry rather than a variant because it is a
     * different service at Alibaba: it is documented under Token Plan, and whether an ordinary
     * DashScope key is entitled to it was not established — a key without the plan may be refused
     * by Alibaba even though the server row and the key look correct here. Each server row holds
     * its own credential pointer, so the key is entered for this entry separately even when it is
     * the same key.
     *
     * Measured on 2026-11-09 without a key: reachable, and refused with 401; tools were not listed,
     * so the first Refresh tools is the review of what it offers.
     */
    host: "https://dashscope.aliyuncs.com",
    path: "/api/v1/mcps/EnhancedSearch/mcp",
    auth: { kind: "deployment-bearer" },
    writeTools: Object.freeze([]),
    docsUrl: "https://help.aliyun.com/zh/model-studio/token-plan-harness-tool",
  },

  {
    key: "google-drive",
    title: "Google Drive",
    vendor: "Google",
    summary: "Files in the Drive of whoever is asking.",
    /*
     * Google publishes one MCP server per Workspace product, each on its own host: Gmail, Docs,
     * Sheets, Slides, Calendar, Chat and People have their own. Drive is here because it is the one
     * a question about a document needs. Each of the others is a further entry, not a flag on this
     * one, so adding Gmail stays a reviewed decision about Gmail.
     */
    /*
     * The GA REST API, not `drivemcp.googleapis.com`.
     *
     * The MCP server was the original choice and is the better one on paper: vendor-maintained, no
     * Drive-specific code here at all. It is gated behind the Google Workspace Developer Preview
     * Program, and an unenrolled project is refused with `The caller does not have permission` —
     * which describes the project, not the credential, so every check available locally reports a
     * correct setup. Enrolment is a Workspace-account application with a stated turnaround of days.
     *
     * This host has been generally available since 2015. The MCP entry is one line away: set
     * `transport` back to `mcp` and restore the host and path above. Tool names match Google's MCP
     * server exactly, so grants survive the swap in either direction.
     */
    host: "https://www.googleapis.com",
    path: "/drive/v3",
    transport: "google-drive-rest",
    /*
     * The first vendor here that cannot be reached with a token an administrator pastes. Google
     * issues no such token: access is an authorization-code grant belonging to a person. That is
     * not a limitation to work around, it is the property this connector exists for — two people
     * asking the same question should get the answers their own accounts can see.
     */
    auth: {
      kind: "user-oauth",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      revokeUrl: "https://oauth2.googleapis.com/revoke",
      // Read-only, because nothing in this slice writes to anybody's Drive.
      scopes: Object.freeze(["https://www.googleapis.com/auth/drive.readonly"]),
      /*
       * `offline` and `consent` are both load bearing FOR GOOGLE. Without `access_type=offline`
       * Google returns no refresh token; without `prompt=consent` a reconnect returns none either.
       * They are Google parameters, so they live on Google's entry.
       */
      authorizationParams: Object.freeze({
        access_type: "offline",
        prompt: "consent",
      }),
    },
    /*
     * Named writes even though the scope above makes Google refuse them.
     *
     * Belt and braces on purpose. The scope is what stops them; this list is what keeps a boundary
     * written about writes covering them, so widening the scope later cannot quietly turn a write
     * into something the policy engine has never heard of.
     */
    writeTools: Object.freeze(["create_file", "copy_file"]),
    docsUrl:
      "https://developers.google.com/workspace/guides/configure-mcp-servers",
  },
  {
    key: "baidu-netdisk",
    title: "百度网盘",
    vendor: "百度",
    summary: "提问的人自己百度网盘里的文件（只读）。",
    /*
     * Baidu's xpan REST API, the only interface Baidu publishes for a netdisk: there is no MCP
     * server to prefer. The adapter is modelled on Drive's and offers only reads. Every request
     * carries the person's token as Baidu's `access_token` query parameter, and file downloads go
     * to the `dlink` address Baidu returns, which the adapter only fetches on Baidu's own download
     * hosts (`d.pcs.baidu.com`, `*.baidupcs.com`) — see `baidu-netdisk-rest.ts`.
     */
    host: "https://pan.baidu.com",
    path: "/rest/2.0/xpan",
    transport: "baidu-netdisk-rest",
    /*
     * The person's own grant, as for Drive: the deployment registers one app at 百度网盘开放平台
     * (AppKey as the client id, SecretKey as the client secret) and each person consents for
     * themselves. Baidu issues a refresh token on every authorization-code grant, so no
     * Google-style offline/consent parameters are needed, and rotates it on every refresh, which
     * the store already handles.
     *
     * PKCE: the shared flow always sends `code_challenge` and, at redemption, `code_verifier`.
     * Baidu documents neither and, as OAuth 2.0 requires of an authorization server, ignores
     * parameters it does not recognise. The code is still bound to this deployment by the
     * SecretKey, which Baidu does check, and the request by the sealed state.
     */
    auth: {
      kind: "user-oauth",
      authorizationUrl: "https://openapi.baidu.com/oauth/2.0/authorize",
      tokenUrl: "https://openapi.baidu.com/oauth/2.0/token",
      /*
       * Baidu's "revoke this user's authorization" endpoint. Recorded for review like every
       * entry's, but NOTHING in this deployment calls any entry's `revokeUrl` today: disconnecting
       * deletes the stored token here and leaves the grant at the vendor, for Baidu as for Google.
       * A person who wants Baidu to forget it too removes the app in their Baidu account settings.
       */
      revokeUrl:
        "https://openapi.baidu.com/rest/2.0/passport/auth/revokeAuthorization",
      /*
       * One string, sent verbatim. Baidu's netdisk documentation fixes the value as exactly
       * `basic,netdisk`, comma-joined, while the shared flow joins entries with a space. Baidu has
       * no read-only netdisk scope, so `writeTools` below is what names writes; the adapter offers
       * none.
       */
      scopes: Object.freeze(["basic,netdisk"]),
      // Baidu's own consent page layout. Not a security parameter, and Google's pair is not sent.
      authorizationParams: Object.freeze({ display: "page" }),
    },
    /*
     * Named although the adapter implements none of them, because unlike Drive there is no
     * read-only scope behind this list: `basic,netdisk` can write, so this list is what keeps a
     * write added to the adapter later from classifying as a read.
     */
    writeTools: Object.freeze([
      "create_folder",
      "upload_file",
      "copy_file",
      "move_file",
      "rename_file",
      "delete_file",
    ]),
    docsUrl: "https://pan.baidu.com/union/doc/",
  },
  {
    key: "notion",
    title: "Notion",
    vendor: "Notion",
    summary: "Pages and databases of whoever is asking.",
    /*
     * The hosted MCP server Notion runs, on the default MCP transport — the first entry to use
     * it. Drive's REST adapter is a workaround for a preview-gated vendor; Notion's server is
     * generally available, so this entry is the shape the catalogue was designed for.
     */
    host: "https://mcp.notion.com",
    path: "/mcp",
    auth: {
      kind: "user-oauth",
      // From https://mcp.notion.com/.well-known/oauth-authorization-server, verified live.
      authorizationUrl: "https://mcp.notion.com/authorize",
      tokenUrl: "https://mcp.notion.com/token",
      // Notion's published revocation_endpoint IS its token endpoint — not a copy-paste mistake.
      revokeUrl: "https://mcp.notion.com/token",
      /*
       * Notion has no scope strings and no read-only scope: access is per-page, chosen on the
       * consent screen. `writeTools` below plus the action policy are the ENTIRE write barrier —
       * there is no vendor-side scope backing them up.
       */
      scopes: Object.freeze([]),
      clientRegistration: "dynamic",
      registrationUrl: "https://mcp.notion.com/register",
    },
    /*
     * The writing tools as the hosted server advertises them today. The hosted server advertises
     * its tools, so a name here that does not match an advertised tool is not the risk — an
     * advertised tool that is missing from this list is: {@link classifyTool} reads an unlisted
     * but advertised name as a read, never as a write. Notion's MCP listing carries no per-action
     * effect, so this list is the only thing that can say otherwise and nothing backstops it. That
     * makes under-inclusion the failure mode, so this list has to lean over-inclusive rather than
     * minimal, and reconciling it against the live tool list on the first Refresh tools is
     * required, not cosmetic.
     */
    writeTools: Object.freeze([
      "notion-convert-page-to-skill",
      "notion-create-attachment",
      "notion-create-comment",
      "notion-create-database",
      "notion-create-file-upload",
      "notion-create-folder",
      "notion-create-pages",
      "notion-create-view",
      "notion-duplicate-page",
      "notion-move-pages",
      "notion-update-data-source",
      "notion-update-folder",
      "notion-update-page",
      "notion-update-view",
    ]),
    docsUrl: "https://developers.notion.com/guides/mcp/build-mcp-client",
  },
  {
    key: "routines",
    title: "Routines",
    vendor: "OpenBot",
    summary:
      "Standing instructions a Bot runs on a schedule, as whoever scheduled them.",
    /*
     * First-party and in-process: no host to dial, no credential to hold. In the catalogue anyway,
     * because the catalogue is where a deployment decides WHICH Bots may do WHAT — and scheduling
     * future work is a capability an administrator should grant as deliberately as a vendor.
     */
    host: "builtin://routines",
    path: "/",
    transport: "builtin-routines",
    auth: Object.freeze({ kind: "builtin" }),
    writeTools: Object.freeze([
      "create_routine",
      "update_routine",
      "delete_routine",
      "create_trigger",
      "pause_trigger",
      "resume_trigger",
      "delete_trigger",
    ]),
    docsUrl: "https://github.com/CopilotKit/OpenBot/blob/main/docs/routines.md",
  },
]);

const BY_KEY = new Map(CATALOGUE.map((entry) => [entry.key, entry]));

/** Compiled once from the frozen source strings above. Never from anything a caller supplied. */
const PATTERNS = new Map(
  CATALOGUE.filter((entry) => entry.hostPattern !== undefined).map((entry) => [
    entry.key,
    new RegExp(entry.hostPattern as string),
  ]),
);

/**
 * Which kind of credential this entry's server record may be pointed at, or null when it takes none
 * from the caller.
 *
 * Beside the entry rather than at the call site, because it is a property of the vendor's auth and
 * not of the request. `deployment-bearer` is the only kind that means "one token this deployment
 * holds for this server", which is what `mcp` names in the vault. A `user-oauth` server is answered
 * with the asker's own grant and its OAuth client is registered through its own call, which mints
 * the credential itself, so an id offered when the server is added is never the right one whatever
 * kind it names. A server needing no credential takes none.
 */
export function serverCredentialKind(entry: CatalogueEntry): "mcp" | null {
  return entry.auth.kind === "deployment-bearer" ? "mcp" : null;
}

export function catalogueEntry(key: string): CatalogueEntry | null {
  return BY_KEY.get(key) ?? null;
}

/**
 * Is this host one this entry is allowed to be pointed at?
 *
 * Compares the RAW host string, case-sensitively, and returns false for anything it does not
 * positively recognise. Every branch that cannot prove admissibility returns false rather than
 * falling through, because the failure mode of the opposite arrangement is a deployment reaching an
 * address nobody chose.
 */
export function hostAdmissible(entry: CatalogueEntry, host: string): boolean {
  if (entry.host !== null) return entry.host === host;
  const pattern = PATTERNS.get(entry.key);
  if (!pattern) return false;
  return pattern.test(host);
}

/**
 * The URL this server is reached at, or null if the request is not admissible.
 *
 * `instanceHost` is only consulted for a per-instance vendor, and only after the pattern accepts it.
 * The path is always the catalogue's, never the caller's, so an admissible host cannot reach some
 * other endpoint on the same machine.
 */
export function resolveServerUrl(
  key: string,
  instanceHost?: string,
): { url: string; entry: CatalogueEntry } | null {
  const entry = catalogueEntry(key);
  if (!entry) return null;

  const host = entry.host ?? instanceHost ?? null;
  if (host === null) return null;
  if (!hostAdmissible(entry, host)) return null;

  // The path is joined rather than concatenated blindly so a root path does not produce a double
  // slash, which some servers treat as a different route.
  const path = entry.path === "/" ? "" : entry.path;
  return { url: `${host}${path}`, entry };
}

/** A source opt-in never authorizes use of a deployment credential. */
export function ownerAssemblySource(entry: CatalogueEntry | null): boolean {
  return entry?.ownerAssembly === true && entry.auth.kind === "none";
}

/**
 * What this tool does, in the only two categories a policy author cares about.
 *
 * A RECORDED EFFECT MAY NARROW WHAT A BOT MAY DO AND MAY NEVER WIDEN IT. That is the criterion the
 * order below is built from, and it is why the reviewed write list is consulted FIRST. Both sources
 * are trusted to make an action a write; only the reviewed one is trusted to make an action a read
 * where the other says write. `writeTools` was read by a person before it shipped. A recorded effect
 * arrives from a vendor listing into a plain `text` column with no check constraint, so it is
 * whatever was last written there, by a refresh or by a hand on a psql prompt. A value in that column
 * therefore cannot take an action off the reviewed list.
 *
 * THREE SOURCES, CONSULTED IN THIS ORDER. Whether the server advertised the name at all: it did not,
 * the name came from a model and the answer is write, and nothing later overrides that. Then the
 * reviewed write list, which settles a name it holds as a write. Then what the vendor recorded, where
 * exactly `read` is a read and every other value it holds — a recorded write, an unrecognised label,
 * a different case, the empty string — is a write. Where the column holds nothing at all the reviewed
 * list finishes the job: an advertised name it declines to call a write is a read.
 *
 * Unknown counts as a write throughout. A server with no catalogue entry behind it is a write unless
 * the vendor recorded a read for that action — there is no reviewed list to consult, so an unlabelled
 * action of theirs has nothing saying it is safe.
 *
 * So there are two ways to earn a read, and both require somebody to have said so. Either the vendor
 * labelled the action a read and no reviewed list contradicts them, or the server advertised it and a
 * reviewed list declined to call it a write. Guessing permissively is recoverable only in those two
 * cases; everywhere else the answer is a write.
 */
export function classifyTool(
  entry: CatalogueEntry | null,
  toolName: string,
  advertised: boolean,
  /**
   * What the vendor said about this action when it was listed, or null when nothing did.
   *
   * Consulted AFTER the entry's write list, so it can only agree with review or add to it. It is the
   * only source that can exist for a broker's catalogue — Composio labels every one of Gmail's
   * sixty-three actions, and no reviewed list here could keep pace with several hundred apps that
   * change weekly — so where review said nothing it is the whole answer.
   *
   * PRESENCE, NOT TRUTHINESS, is what makes it consulted, and only the exact string `read` produces a
   * read. A recorded write, an unrecognised value, a different case and the EMPTY STRING are all
   * writes: the empty string is a value the column holds rather than a silence, and reading it as
   * "nothing was recorded" would send an advertised action no reviewed list names down the read
   * branch. Null and undefined are the column saying nothing, and fall through to the reviewed list.
   * So a column somebody typed into by hand, or a label a vendor adds later that this code has never
   * heard of, cannot widen what a Bot may do unasked.
   */
  recorded?: string | null,
): "read" | "write" {
  // A name the server never listed came from a model, and nothing reviewed says it only reads —
  // checked first, so neither later source can rescue a name that was never advertised.
  if (!advertised) return "write";
  // The reviewed list outranks the column, and only in this direction: a name a person reviewed as a
  // write stays a write whatever the listing recorded about it.
  if (entry?.writeTools.includes(toolName)) return "write";
  // Anything the column holds settles the rest. `typeof` rather than truthiness so the empty string
  // is treated as the value it is instead of as an absence of one.
  if (typeof recorded === "string")
    return recorded === "read" ? "read" : "write";
  // A server an administrator added by URL has no reviewed tool catalogue behind it, so nothing here
  // can say a tool of theirs only reads. Everything it offers is a write.
  if (!entry) return "write";
  // Advertised, not on the reviewed write list, and nothing recorded. Two sources had the chance to
  // call it a write and neither did.
  return "read";
}

/**
 * Words that make a parameter name a credential, wherever they appear in it.
 *
 * A containment test rather than a list of exact names, because the exact-name version of this rule
 * refused `?token=` and accepted `?auth_token=`, `?api_token=`, `?session_token=` and every other
 * spelling one word away. An operator has no way to know which of those the check happens to hold,
 * so a rule that only refuses the names somebody thought of reads as a guard while behaving like a
 * gap.
 *
 * Not shared with `sensitiveKeys` in `audit.ts`: that module reaches the database and this function
 * deliberately imports nothing that does. The two also want different contents, since audit redacts
 * `content`, `prompt` and `result`, which are payload field names and mean nothing here.
 */
const CREDENTIAL_WORDS = [
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "signature",
  "bearer",
];

/**
 * Names that are a credential on their own but are too short to contain safely.
 *
 * `sig` is the reason this list is separate from the one above: "design" contains it. These are
 * compared whole, so an ordinary word carrying the same three letters is left alone.
 */
const CREDENTIAL_NAMES = new Set([
  "auth",
  "authorization",
  "pass",
  "pwd",
  "sig",
]);

/**
 * Does this parameter name say it holds a credential?
 *
 * Names are compared with their separators dropped, so `api_key`, `apiKey` and `x-api-key` are one
 * question rather than three. A name ending in "key" is a credential and a name merely containing it
 * is not, which is what keeps `keyword` and `monkey` apart; "author" is likewise not "auth".
 *
 * It over-refuses in one direction on purpose. A parameter this rule misreads costs an operator a
 * rename, and one it misses is written to an append-only audit row that cannot be deleted.
 */
function readsAsCredential(name: string): boolean {
  const normalized = name.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
  if (CREDENTIAL_NAMES.has(normalized) || normalized.endsWith("key")) {
    return true;
  }
  return CREDENTIAL_WORDS.some((word) => normalized.includes(word));
}

/**
 * Is this a URL an administrator may point the deployment at?
 *
 * A curated entry is reviewed in code; this is the other path, and it needs its own floor because
 * "add an MCP server" is otherwise a request-forgery primitive aimed at whatever the server can
 * reach: cloud metadata endpoints, databases on the same network, admin panels bound to localhost.
 * The rules are deliberately blunt.
 *
 * HTTPS only, because the credential is a bearer token and plaintext is not negotiable.
 * No address literals, localhost or internal suffixes, because those point at the deployment rather
 * than a vendor service.
 *
 * This is static URL validation: it checks the literal host string and scheme before storage. Where
 * the name resolves is checked on every request instead, by the outbound guard the store attaches to
 * a custom server's connection (see `tenantChosenOutbound` in store.ts), which also refuses redirects.
 */
export function customUrlRefusal(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "That is not a URL.";
  }

  if (url.protocol !== "https:") {
    return "An MCP server must be reached over https.";
  }

  // Userinfo is not part of the host, so none of the host rules below would look at it, and what is
  // typed here is stored verbatim: addCustomServer writes the string into mcp_servers.url and into
  // the configuration.changed audit payload, whose redaction keys on the field name rather than the
  // value. A secret written this way would sit in the trail in clear text. The refusal deliberately
  // does not echo the URL back.
  if (url.username || url.password) {
    return "Put the credential in the token field rather than in the address.";
  }

  /*
   * The query is the other half of the same hole, and the fragment is the half after that.
   *
   * No host rule below reads either one, and both are stored and audited with the rest of the
   * string, so a token written here is as durable and as readable as one written into the userinfo.
   * The fragment never reaches the server at all, which is why it is not a request-forgery concern
   * and is still a disclosure one: what this rule is about is where the string ends up, not where
   * the request goes.
   *
   * The test is on the parameter name rather than on the presence of a query, because vendors
   * legitimately route and version with parameters. A floor that refused every one of them would be
   * one an operator works around rather than with, and an ordinary `#section` is left alone for the
   * same reason.
   */
  const hash = url.hash.replace(/^#/, "");
  const marker = hash.indexOf("?");
  const fragment =
    marker === -1 ? [hash] : [hash.slice(0, marker), hash.slice(marker + 1)];
  const named = [
    ...url.searchParams.keys(),
    ...fragment.flatMap((part) => [...new URLSearchParams(part).keys()]),
  ];
  if (named.some(readsAsCredential)) {
    return "Put the credential in the token field rather than in the address.";
  }

  // A trailing dot is the root-anchored spelling of the same name and resolves to the same place, so
  // they are stripped here rather than added to each comparison below. Without it "localhost."
  // misses the equality test, "vault.internal." misses the suffix tests, and "database." picks up
  // the dot that the single-label test keys on, so the fully qualified form of every name this
  // function refuses walks straight through it.
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");

  // Bracketed IPv6 arrives with the brackets already stripped by URL, so the colon test catches it.
  if (host.includes(":") || /^[0-9.]+$/.test(host)) {
    return "Give a hostname rather than an IP address.";
  }
  /*
   * The cloud metadata endpoint, by name rather than by luck.
   *
   * `metadata.goog` is Google's own short alias for it, published beside `metadata.google.internal`,
   * and it carries a dot and none of the suffixes below, so it read as an ordinary vendor name. The
   * long spelling was refused only incidentally, by the `.internal` test.
   *
   * Asked of the list browsing already uses rather than a second copy here. That list holds the
   * aliases somebody has already had to think about, including the ones Alibaba and ECS answer on,
   * and a new alias added there should not have to be remembered here as well.
   */
  if (isNeverAllowedHostname(host)) {
    return "That address holds this deployment's own cloud credentials.";
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    return "That address is local to the deployment.";
  }
  if (
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host.endsWith(".localdomain") ||
    // How a Kubernetes service is addressed from inside the cluster. It carries dots and none of
    // the suffixes above, so without this it reads as an ordinary vendor name.
    host.endsWith(".svc") ||
    !host.includes(".")
  ) {
    return "That address is not reachable from outside this network.";
  }

  return null;
}
