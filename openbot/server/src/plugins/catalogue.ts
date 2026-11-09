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
// The static half of the outbound guard. It reaches no database and no network, so the rule that
// this module imports nothing that does still holds.
import { checkOutboundUrl } from "../net/outbound-guard";
// Type-only, so naming the transport here creates no import cycle with the registry that resolves it.
import type { CuratedTransportKind } from "./transport";

/**
 * What every deployment credential that is NOT a bearer token carries: the words an administrator
 * is asked for, in the language of the screen that asks.
 *
 * `credentialLabel` names the thing ("高德 Web 服务 Key"), `credentialHint` says where it comes
 * from. Both are reviewed copy, never a value: nothing here can hold a key, and the catalogue test
 * asserts no entry's copy looks like one.
 */
type CredentialCopy = {
  credentialLabel: string;
  credentialHint: string;
  /**
   * The shortest key this vendor issues, when that is shorter than the default floor of sixteen.
   * Taken from the vendor's own published format and never below twelve (see `MIN_PLACED_FLOOR`):
   * a short key is a weak one, and a scrub has to be able to recognise it in a message.
   */
  credentialMinLength?: number;
};

export type CatalogueAuth =
  /** Answers without any credential at all. */
  | { kind: "none" }
  /** One token, held by the deployment, used for everybody. */
  | { kind: "deployment-bearer" }
  /*
   * THE THREE PLACED KINDS. Each is a `deployment-bearer` in every way that matters to who may do
   * what — one credential an administrator stores once, sealed in the vault exactly as a bearer
   * token is (kind `mcp`, the server's own row), used for everybody, audited as the deployment — and
   * differs only in WHERE the vendor wants it on the request. They are kinds rather than a flag on
   * `deployment-bearer` so that every branch on `auth.kind` has to answer for them: a placement
   * dropped on the way to the dial would otherwise send the key as `Authorization: Bearer` to the
   * vendor and look, from every screen, like a working connector.
   *
   * WHAT THE PLACEMENT MAY NOT DO is the security property, and it is the same for all three: the
   * credential is a VALUE put into one pinned slot. It can never choose the scheme, the host, the
   * port or the path (save the one segment the address kind admits, under a pinned prefix), and the
   * URL it produces goes through the outbound guard on every request. See {@link placeCredential}.
   */
  /**
   * The key goes into one pinned query parameter (Amap's `key`, Baidu Maps' `ak`). Pinned
   * non-secret parameters the vendor also wants sit beside it in `fixedParams`.
   */
  | ({
      kind: "deployment-query";
      param: string;
      fixedParams?: Readonly<Record<string, string>>;
    } & CredentialCopy)
  /** The key goes into one pinned request header that is not `Authorization`. */
  | ({ kind: "deployment-header"; header: string } & CredentialCopy)
  /**
   * The credential IS an address: the vendor issues every customer their own URL, with the key in
   * its query (DingTalk's `/server/{serverId}?key=…`). The entry's host and `path` are the pinned
   * origin and prefix; the administrator's address may differ from them in exactly one path segment,
   * matching the anchored `segmentPattern`, and one query parameter, `param`. Anything else — another
   * host, another prefix, a second segment, a port, userinfo, a fragment, any other parameter — is
   * refused, both when it is stored and on every dial.
   */
  | ({
      kind: "deployment-address";
      segmentPattern: string;
      param: string;
    } & CredentialCopy)
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
      /**
       * Where a disconnect is sent, so revocation happens at the vendor and not just here.
       *
       * Absent for a vendor whose published metadata names no revocation endpoint (GitHub, Slack,
       * HubSpot and Figma among the MCP market's second batch): an address guessed for it would be
       * a source contract nobody read. Nothing calls any entry's `revokeUrl` today — see Baidu's
       * entry — so absence changes no behaviour; it only declines to record a URL that was not
       * published.
       */
      revokeUrl?: string;
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
   * 经过审查、确认只读的工具名单。可选；没有它的条目，行为和以前完全一样。
   *
   * 列出它就是列全了：这个条目上不在名单里的工具，{@link classifyTool} 一律算写，所以服务器以后
   * 新增的工具在有人读过、列进来之前都要先问。它只能让判定更严，不能放宽：写名单、厂商记录的写、
   * 没有广播过的名字、破坏性标记都仍然优先。{@link reviewedRead} 是「这个工具是否经审查确定只读」的
   * 唯一答案。名单照条目注释里记录的实测 `tools/list` 抄，不凭工具名猜。
   */
  readTools?: readonly string[];
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
 * Atlassian and Slack are back in the second batch, and that was such a review rather than a revert:
 * each is now the vendor's own hosted MCP server reached as the person asking (`user-oauth`), not the
 * shared bearer token the removed entries held, with its OAuth addresses read from the vendor's own
 * published metadata. Box, Salesforce and ServiceNow stay out.
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
 * The third batch (Amap, Baidu Maps, Tencent, Kuaidi100, DingTalk) is the same deployment-held shape
 * with the key placed where those vendors want it — a pinned query parameter, or for DingTalk a
 * per-customer address under a pinned prefix — rather than a bearer header. The placement is the
 * entry's, the value is the vault's, and the two meet only on the request; see `placeCredential`.
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
   * reviewed before it is granted, and added to `writeTools` if it changes anything. 五个纯文档条目
   * （context7、deepwiki、microsoft-learn、aws-knowledge、cloudflare-docs）还带了 `readTools`，把这一步
   * 交给代码：清单外新出现的名字直接算写，审查后再列进去。Reads only does
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
    // 上面注释里 2026-11-09 实测的清单；新出现的工具在列进来之前都是写。
    readTools: Object.freeze(["resolve-library-id", "query-docs"]),
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
    // 上面注释里 2026-11-09 实测的清单；新出现的工具在列进来之前都是写。
    readTools: Object.freeze([
      "ask_wiki_question",
      "read_wiki_contents",
      "read_wiki_structure",
    ]),
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
    // 上面注释里 2026-11-09 实测的清单；新出现的工具在列进来之前都是写。
    readTools: Object.freeze([
      "microsoft_docs_search",
      "microsoft_code_sample_search",
      "microsoft_docs_fetch",
    ]),
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
    // 上面注释里 2026-11-09 实测的清单；新出现的工具在列进来之前都是写。
    readTools: Object.freeze([
      "aws___read_documentation",
      "aws___search_documentation",
      "aws___list_regions",
      "aws___get_regional_availability",
      "aws___retrieve_skill",
    ]),
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
    // 上面注释里 2026-11-09 实测的清单；新出现的工具在列进来之前都是写。
    readTools: Object.freeze([
      "search_cloudflare_documentation",
      "migrate_pages_to_workers_guide",
    ]),
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

  /*
   * MCP MARKET, THIRD BATCH. Five vendor-hosted servers inside mainland China, each reached with ONE
   * credential an administrator stores for the whole deployment, and each needing it somewhere other
   * than `Authorization: Bearer` — which is what the three placed auth kinds above exist for.
   *
   * Reachability was measured on 2026-11-09 from the JD Cloud network this deployment is served from,
   * WITHOUT a credential: Amap 200, Baidu Maps 400, Tencent 200, Kuaidi100 200, DingTalk 404 at the
   * gateway root (a real DingTalk address is per customer). So no tool listing below was seen through
   * this deployment.
   *
   * THE WRITE LISTS ARE FROM THE CANDIDATE RESEARCH AND THE VENDORS' OWN PACKAGES, NOT FROM A LIVE
   * LISTING. 工具清单未带凭据实测，首次刷新工具时必须对账: on the first Refresh tools after the
   * credential is stored, compare the live listing against each entry's comment, and any tool that
   * changes something and is not named here goes into `writeTools` before it is granted. Where a list
   * is empty the vendor publishes nothing but lookups, and `unlistedAdvertisedTools` will name nothing
   * for it, so that comparison is a person's job.
   *
   * THE CREDENTIAL NEVER APPEARS IN THIS FILE, AND NEVER IN A URL ANYTHING STORES. `host + path` is
   * the bare pinned address; the key is sealed in the vault as the server's own `mcp` secret and is
   * put into its slot only inside the MCP transport, on the request itself (`placeCredential`). What
   * `mcp_servers.url`, the Plugins page, the audit trail and `last_error` see is the address without
   * it, and every message out of the transport has had every spelling of the key taken out.
   *
   * Feishu is not here. Its remote server takes `X-Lark-MCP-TAT` (a tenant token) or `X-Lark-MCP-UAT`
   * (a person's token), and both expire about two hours after they are issued: a tenant token stored
   * by hand stops working the same afternoon, and keeping one fresh means holding the app secret and
   * exchanging it at Feishu's token endpoint, which is a credential flow of its own rather than a
   * placement. The header kind is ready for it; the entry waits for that flow and for a first-hand
   * look at whether `X-Lark-MCP-Allowed-Tools` is required.
   *
   * None opts into owner assembly.
   */
  {
    key: "amap",
    title: "高德地图",
    vendor: "高德（阿里巴巴）",
    summary:
      "地理编码与逆地理、POI 检索、驾车/步行/骑行/公交路线、距离测量、IP 定位和天气查询。部署统一使用一个高德 Web 服务 Key，按高德配额计费。",
    /*
     * Amap's own hosted server, published in Amap's MCP documentation as `/mcp?key=<Web 服务 Key>`.
     * Answered 200 without a key on 2026-11-09, which is exactly why a placed entry refuses to dial
     * without one rather than going out anonymously. Lookups per the official
     * `@amap/amap-maps-mcp-server` package: `maps_geo`, `maps_regeocode`, `maps_ip_location`,
     * `maps_weather`, `maps_text_search`, `maps_around_search`, `maps_search_detail`,
     * `maps_direction_driving`, `maps_direction_walking`, `maps_bicycling`,
     * `maps_direction_transit_integrated`, `maps_distance`. The three `maps_schema_*` tools reported
     * for the HTTP endpoint build links that open the Amap app on navigation, ride-hailing or a
     * personal map — not an order in themselves, but ride-hailing leads to one, so they are writes.
     */
    host: "https://mcp.amap.com",
    path: "/mcp",
    auth: {
      kind: "deployment-query",
      param: "key",
      credentialLabel: "高德 Web 服务 Key",
      credentialHint: "在高德开放平台控制台创建「Web 服务」类型的 Key 后复制。",
    },
    writeTools: Object.freeze([
      "maps_schema_take_taxi",
      "maps_schema_navi",
      "maps_schema_personal_map",
    ]),
    docsUrl: "https://lbs.amap.com/api/mcp-server/create-project-and-key",
  },
  {
    key: "baidu-map",
    title: "百度地图",
    vendor: "百度",
    summary:
      "地理编码与逆地理、地点检索与详情、路线规划与批量算路、天气、IP 定位、实时路况。部署统一使用一个百度地图服务端 AK。",
    /*
     * Baidu Maps' own hosted server, `/mcp?ak=<服务端 AK>` per the official baidu-maps/mcp repository;
     * the AK must have the MCP service ticked in Baidu's console. Answered 400 without one on
     * 2026-11-09. All ten tools in that repository are lookups: `map_geocode`,
     * `map_reverse_geocode`, `map_search_places`, `map_place_details`, `map_directions_matrix`,
     * `map_directions`, `map_weather`, `map_ip_location`, `map_road_traffic`, `map_poi_extract`.
     */
    host: "https://mcp.map.baidu.com",
    path: "/mcp",
    auth: {
      kind: "deployment-query",
      param: "ak",
      credentialLabel: "百度地图服务端 AK",
      credentialHint:
        "在百度地图开放平台控制台创建服务端 AK，并为它勾选 MCP 服务后复制。",
    },
    writeTools: Object.freeze([]),
    docsUrl: "https://lbs.baidu.com/faq/api?title=mcpserver/base",
  },
  {
    key: "tencent-map",
    title: "腾讯位置服务",
    vendor: "腾讯",
    summary:
      "基于腾讯地图 WebService API 的地址解析、关键词/周边/沿途搜索等位置查询。部署统一使用一个腾讯位置服务 Key。",
    /*
     * Tencent's own hosted server, `/mcp?key=<Key>&format=0` per its MCP Server guide. `format=0`
     * asks for readable text rather than raw JSON (`1`); it is a fixed, non-secret parameter, so it
     * is pinned beside the key rather than typed. The Key needs WebServiceAPI enabled. Answered 200
     * without a key on 2026-11-09. Confirmed lookups: `geocoder`, `placeSuggestion`,
     * `placeSearchNearby`, `placeAlongby`; reverse geocoding, routing, IP location and weather are
     * reported by third parties under names not confirmed — all lookups, but read the first listing.
     */
    host: "https://mcp.map.qq.com",
    path: "/mcp",
    auth: {
      kind: "deployment-query",
      param: "key",
      fixedParams: Object.freeze({ format: "0" }),
      credentialLabel: "腾讯位置服务 Key",
      credentialHint:
        "在腾讯位置服务控制台创建 Key 并开启 WebServiceAPI 后复制。",
    },
    writeTools: Object.freeze([]),
    docsUrl: "https://lbs.qq.com/service/MCPServer/MCPServerGuide/overview",
  },
  {
    key: "kuaidi100",
    title: "快递100",
    vendor: "快递100",
    summary:
      "快递物流轨迹查询、运费预估和送达时效预估。部署统一使用一个快递100 授权 Key，商用接口按量收费。",
    /*
     * Kuaidi100's own hosted server, `/mcp/streamable?key=<授权 key>` per the official
     * kuaidi100-api/kuaidi100-MCP README, which recommends this over its SSE endpoint. Answered 200
     * without a key on 2026-11-09. The vendor's published package (kuaidi100-mcp 0.1.3) offers four
     * lookups — `query_trace`, `estimate_time`, `estimate_time_with_logistic`, `estimate_price` — and
     * `query_trace` takes a phone number, so a grant of it is a grant to look parcels up by one.
     *
     * Kuaidi100's API platform also sells ordering, cancelling and push subscriptions. None is in
     * the MCP package today; the names below are the shapes such tools would take, listed so that a
     * hosted server that grows one meets a write rather than a read on the day it appears.
     */
    host: "https://api.kuaidi100.com",
    path: "/mcp/streamable",
    auth: {
      kind: "deployment-query",
      param: "key",
      credentialLabel: "快递100 授权 Key",
      credentialHint: "在快递100 API 开放平台的账号信息里复制授权 key。",
      /*
       * Kuaidi100's 授权 key is shorter than the default floor of sixteen: the platform issues
       * twelve letters and digits. Lowered to exactly that, which is also the floor nothing may go
       * under; every other entry here keeps sixteen.
       */
      credentialMinLength: 12,
    },
    writeTools: Object.freeze([
      "place_order",
      "create_order",
      "send_order",
      "cancel_order",
      "border",
      "corder",
      "subscribe",
      "subscribe_trace",
      "poll",
    ]),
    docsUrl: "https://github.com/kuaidi100-api/kuaidi100-MCP",
  },
  {
    key: "dingtalk",
    title: "钉钉 MCP（企业专属地址）",
    vendor: "钉钉（阿里巴巴）",
    summary:
      "钉钉官方托管、按企业开通的 MCP 服务：通讯录、日程、待办、AI 表格、机器人消息、工作通知等，视开通的服务而定。以企业应用身份操作，写操作务必逐次审批。",
    /*
     * DingTalk's own MCP gateway. Each customer's administrator enables a service in DingTalk's MCP
     * square and is given an address of the form `https://mcp-gw.dingtalk.com/server/<serverId>
     * ?key=<key>` — the address IS the credential. So the whole address is what is stored, sealed
     * like any token, and `deployment-address` admits exactly one path segment under the pinned
     * `/server` prefix on the pinned host, and exactly one `key` parameter: no other host, prefix,
     * depth, port, userinfo, fragment or parameter can be stored or dialled. The gateway root
     * answered 404 on 2026-11-09, which is what a per-customer address looks like from outside.
     *
     * The credential is the ORGANISATION'S, acting as its DingTalk application, and reaches its
     * directory, calendars and group chats — far more than any one person asking can see. Every call
     * is audited as the deployment. The write list is every action in the vendor's open-source
     * dingtalk-mcp package (1.1.21) that creates, changes, sends, recalls or deletes, under both its
     * bare and its prefixed spelling where the package uses one. Reads there include looking a
     * person up by mobile number (`getUserIdByMobile`); grant those deliberately too. Which tools a
     * hosted service offers depends on what the customer enabled, so the first listing is the review.
     */
    host: "https://mcp-gw.dingtalk.com",
    path: "/server",
    auth: {
      kind: "deployment-address",
      segmentPattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
      param: "key",
      credentialLabel: "钉钉 MCP 专属地址",
      credentialHint:
        "企业管理员在钉钉 MCP 广场开通服务后，复制形如 https://mcp-gw.dingtalk.com/server/<服务 ID>?key=<密钥> 的完整地址。",
    },
    writeTools: Object.freeze([
      // Robot messages, DING and work notices.
      "sendMessageToGroupByRobot",
      "recallGroupMessageByRobot",
      "batchSendMessageToUsersByRobot",
      "batchRecallToUsersMessageByRobot",
      "sendMessageToGroupByCustomRobot",
      "sendDINGMessageByRobot",
      "recallDINGMessage",
      "sendNotice",
      "recallNotice",
      "sendServiceWindowMessage",
      "batchSendServiceWindowMessage",
      // Calendar.
      "createEvent",
      "updateEvent",
      "deleteEvent",
      "addAttendee",
      "removeAttendee",
      // To-dos.
      "createTask",
      "updateTask",
      "deleteTask",
      "updateExecutorsTaskStatus",
      // AI tables.
      "createNotableSheet",
      "updateNotableSheetName",
      "deleteNotableSheet",
      "insertNotableRecords",
      "updateNotableRecords",
      "deleteNotableRecords",
      "createNotableField",
      "updateNotableField",
      "deleteNotableField",
      // Work reports.
      "createReport",
      "saveReportDraft",
      // Projects (Teambition).
      "createProject",
      "addProjectMembers",
      "removeProjectMembers",
      "createProjectTask",
      "deleteProjectTask",
      "updateProjectTaskNote",
      "updateProjectTaskContent",
      "updateProjectTaskExecutors",
      "updateProjectTaskInvolveMembers",
      // Honours.
      "grantHonor",
      "createOrgHonor",
      "recallHonor",
      "mcp_dingtalk-honor_grantHonor",
      "mcp_dingtalk-honor_createOrgHonor",
      "mcp_dingtalk-honor_recallHonor",
      // Application management.
      "createInnerApp",
      "updateInnerApp",
      "setMicroAppScope",
      "publishInnerAppVersion",
      "rollbackInnerAppVersion",
    ]),
    docsUrl:
      "https://open.dingtalk.com/document/development/alibaba-cloud-uses-dingtalk-mcp-services",
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

  /*
   * MCP MARKET, SECOND BATCH. Ten vendor-hosted remote servers reached as the person asking, each on
   * the shape Notion established above. The evidence is narrower than the first batch's and the
   * difference matters: on 2026-11-09, from the JD Cloud network this deployment is served from, each
   * MCP endpoint answered an anonymous request with 401, and each vendor's published OAuth metadata
   * (RFC 9728 protected-resource, then RFC 8414 authorization-server) was read. Nobody logged in, so
   * NO TOOL LISTING WAS SEEN for any of them.
   *
   * Every OAuth address below is copied from that metadata, never composed: the comment on each says
   * which document. A vendor whose metadata publishes no revocation endpoint has no `revokeUrl`, and
   * nothing calls one today anyway (see Baidu's entry).
   *
   * Two client shapes, decided by the vendor rather than by us. Where the metadata publishes a
   * `registration_endpoint` the entry is `clientRegistration: "dynamic"` and registers itself on the
   * first connect (RFC 7591), a public client proven by PKCE. Where it does not, an administrator
   * registers an app at the vendor and pastes its client id and secret into this deployment, as for
   * Baidu (`POST /servers/:id/oauth-client`). Either way the shared flow sends S256 PKCE, joins
   * `scopes` with a space, and REQUIRES a refresh token from the code redemption: a vendor that
   * returns none fails the connect rather than storing an hour of access. Where that depends on a
   * setting of the vendor-side app, the entry says which.
   *
   * Scopes lean read-only where the vendor offers a read-only one. Where it does, the vendor refuses
   * the writes as well; where it does not (empty, or one all-or-nothing scope), `writeTools` and the
   * action policy are the whole write barrier, exactly as for Notion.
   *
   * THE WRITE LISTS ARE NOT RECONCILED. 未登录实测，首次刷新工具时必须对账: the names come from each
   * vendor's documentation and repository, are deliberately over-inclusive (a name a server never
   * advertises costs nothing here), and the first Refresh tools after somebody connects is where each
   * live listing is compared with them. An advertised tool missing from a list is a READ to
   * {@link classifyTool}, so any tool on that listing that changes something is added before it is
   * granted.
   *
   * NOT ENTERED: Zapier (`mcp.zapier.com`). Its tools are whatever actions each person configured in
   * Zapier, named at runtime, and nearly all of them send or write. No reviewed list can name them in
   * advance, and an advertised name that no list holds classifies as a read, so this catalogue cannot
   * express that server safely; it waits for a shape that treats every tool of an entry as a write.
   *
   * None of these opts into owner assembly.
   */
  {
    key: "github",
    title: "GitHub（只读）",
    vendor: "GitHub",
    summary:
      "提问的人自己有权访问的 GitHub 仓库、Issue、PR、Actions 等（只读端点）。",
    /*
     * GitHub's own hosted server, on the READ-ONLY path its remote-server documentation publishes
     * (`/mcp/readonly`, the default toolsets restricted to tools that only read). Chosen over `/mcp/`
     * because GitHub offers no read-only OAuth scope worth the name, so the endpoint is the vendor-side
     * barrier that a scope is for other vendors: the server does not advertise its writes at all.
     * Widening to `/mcp/` is its own review. Measured on 2026-11-09: `/mcp/` answered 401. The
     * read-only path was not probed separately; GitHub documents it as the same server, and the first
     * connect is where that is confirmed.
     */
    host: "https://api.githubcopilot.com",
    path: "/mcp/readonly",
    auth: {
      kind: "user-oauth",
      /*
       * From https://github.com/login/oauth 的 RFC 8414 元数据（/.well-known/oauth-authorization-server），
       * 2026-11-09 京东云实测. No registration endpoint and no revocation endpoint published.
       *
       * The administrator registers a GITHUB APP, not an OAuth App, with "Expire user authorization
       * tokens" left on. An OAuth App's user token never expires and comes with no refresh token, and
       * the shared flow refuses a redemption without one, so an OAuth App can never connect here. A
       * GitHub App's own permissions (set read-only by whoever registers it) are its scoping: GitHub
       * ignores `scope` for a GitHub App, so none is sent rather than one that asserts nothing.
       *
       * GitHub's token endpoint answers form-encoded unless asked for JSON; the shared flow sends
       * `Accept: application/json` on both token requests for exactly this.
       */
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: Object.freeze([]),
    },
    /*
     * Named although the read-only path advertises none of them — the Drive argument: this list keeps
     * a widening of the path from turning a write into something the policy has never heard of.
     * From the github-mcp-server README, plus older spellings of the same tools.
     */
    writeTools: Object.freeze([
      "actions_run_trigger",
      "add_comment_to_pending_review",
      "add_issue_comment",
      "add_pull_request_review_comment_to_pending_review",
      "add_reply_to_pull_request_comment",
      "add_sub_issue",
      "assign_copilot_to_issue",
      "assign_copilot_to_issue_with_intent",
      "cancel_workflow_run",
      "create_and_submit_pull_request_review",
      "create_branch",
      "create_gist",
      "create_issue",
      "create_or_update_file",
      "create_pending_pull_request_review",
      "create_pull_request",
      "create_pull_request_with_copilot",
      "create_repository",
      "create_repository_ruleset",
      "custom_properties_write",
      "delete_file",
      "delete_pending_pull_request_review",
      "delete_workflow_run_logs",
      "disable_pr_auto_merge",
      "discussion_comment_write",
      "dismiss_notification",
      "enable_pr_auto_merge",
      "fork_repository",
      "issue_write",
      "label_write",
      "manage_notification_subscription",
      "manage_repository_notification_subscription",
      "mark_all_notifications_read",
      "merge_pull_request",
      "projects_write",
      "pull_request_review_write",
      "push_files",
      "remove_sub_issue",
      "reprioritize_sub_issue",
      "request_copilot_review",
      "rerun_failed_jobs",
      "rerun_workflow_run",
      "resolve_review_thread",
      "run_secret_scanning",
      "run_workflow",
      "star_repository",
      "sub_issue_write",
      "submit_pending_pull_request_review",
      "unresolve_review_thread",
      "unstar_repository",
      "update_gist",
      "update_issue",
      "update_issue_comment",
      "update_pull_request",
      "update_pull_request_branch",
    ]),
    docsUrl:
      "https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md",
  },
  {
    key: "linear",
    title: "Linear",
    vendor: "Linear",
    summary: "提问的人自己 Linear 工作区里的 Issue、项目、周期与文档。",
    host: "https://mcp.linear.app",
    path: "/mcp",
    auth: {
      kind: "user-oauth",
      // From https://mcp.linear.app/.well-known/oauth-authorization-server，2026-11-09 京东云实测.
      authorizationUrl: "https://mcp.linear.app/authorize",
      tokenUrl: "https://mcp.linear.app/token",
      // Linear's published revocation_endpoint is its token endpoint, as Notion's is.
      revokeUrl: "https://mcp.linear.app/token",
      /*
       * `read` alone out of `read write openid email`: Linear refuses the writes below at the vendor
       * until somebody reviews asking for `write`. No identity scopes, since nothing here reads them.
       */
      scopes: Object.freeze(["read"]),
      clientRegistration: "dynamic",
      registrationUrl: "https://mcp.linear.app/register",
    },
    writeTools: Object.freeze([
      "create_attachment",
      "create_comment",
      "create_document",
      "create_issue",
      "create_issue_label",
      "create_project",
      "create_project_label",
      "delete_attachment",
      "delete_comment",
      "delete_issue",
      "save_comment",
      "save_document",
      "save_issue",
      "save_milestone",
      "save_project",
      "update_comment",
      "update_document",
      "update_issue",
      "update_project",
    ]),
    docsUrl: "https://linear.app/docs/mcp",
  },
  {
    key: "atlassian",
    title: "Atlassian（Jira / Confluence）",
    vendor: "Atlassian",
    summary:
      "提问的人自己有权访问的 Jira 事务、Confluence 页面与 Compass 组件。",
    /*
     * Atlassian's hosted Rovo MCP server. The site administrator of each Atlassian organisation must
     * first allow this deployment's callback domain (Atlassian Administration, Rovo MCP server
     * settings), or consent fails at Atlassian whatever this entry says.
     */
    host: "https://mcp.atlassian.com",
    path: "/v1/mcp",
    auth: {
      kind: "user-oauth",
      // From https://mcp.atlassian.com/.well-known/oauth-authorization-server，2026-11-09 京东云实测.
      authorizationUrl: "https://mcp.atlassian.com/v1/authorize",
      tokenUrl: "https://mcp.atlassian.com/v1/token",
      revokeUrl: "https://mcp.atlassian.com/v1/token",
      /*
       * Atlassian publishes no scopes for this server: the person's own Jira and Confluence
       * permissions, chosen on the consent screen, are the scoping. As for Notion, `writeTools` and
       * the action policy are the whole write barrier. The metadata also allows `plain` PKCE; the
       * shared flow only ever sends S256.
       */
      scopes: Object.freeze([]),
      clientRegistration: "dynamic",
      registrationUrl: "https://mcp.atlassian.com/v1/register",
    },
    writeTools: Object.freeze([
      "addCommentToJiraIssue",
      "addWorklogToJiraIssue",
      "createCompassComponent",
      "createCompassComponentRelationship",
      "createCompassCustomFieldDefinition",
      "createConfluenceFooterComment",
      "createConfluenceInlineComment",
      "createConfluencePage",
      "createIssueLink",
      "createJiraIssue",
      "deleteCompassCustomFieldDefinition",
      "editJiraIssue",
      "transitionJiraIssue",
      "updateCompassCustomFieldDefinition",
      "updateConfluencePage",
    ]),
    docsUrl:
      "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/use-atlassian-rovo-mcp-server/",
  },
  {
    key: "sentry",
    title: "Sentry",
    vendor: "Sentry",
    summary: "提问的人自己 Sentry 组织里的项目、Issue、事件与 Trace。",
    host: "https://mcp.sentry.dev",
    path: "/mcp",
    auth: {
      kind: "user-oauth",
      // From https://mcp.sentry.dev/.well-known/oauth-authorization-server，2026-11-09 京东云实测.
      authorizationUrl: "https://mcp.sentry.dev/oauth/authorize",
      tokenUrl: "https://mcp.sentry.dev/oauth/token",
      revokeUrl: "https://mcp.sentry.dev/oauth/token",
      /*
       * `org:read` alone. Every other scope Sentry publishes (`project:write`, `team:write`,
       * `event:write`, `alerts:write`) is a write; Sentry's server is read-only unless one is
       * granted. Whether `org:read` alone lists every read tool is checked on first connect.
       */
      scopes: Object.freeze(["org:read"]),
      clientRegistration: "dynamic",
      registrationUrl: "https://mcp.sentry.dev/oauth/register",
    },
    writeTools: Object.freeze([
      // Seer runs are billed to the organisation, so starting one is an effect.
      "analyze_issue_with_seer",
      "begin_seer_issue_fix",
      "create_dsn",
      "create_project",
      "create_team",
      "update_issue",
      "update_project",
      // Sentry's embedded agent tool, which can call any of the above.
      "use_sentry",
    ]),
    docsUrl: "https://docs.sentry.io/ai/mcp/",
  },
  {
    key: "stripe",
    title: "Stripe",
    vendor: "Stripe",
    summary:
      "提问的人自己 Stripe 账户里的客户、发票、订阅与支付。涉及资金，写操作务必逐次审批。",
    /*
     * Stripe's hosted server, served at the origin itself, so the path is the root. The
     * authorization server is a different host (`access.stripe.com`) from the MCP host; the catalogue
     * pins each address separately, so that needs nothing extra.
     */
    host: "https://mcp.stripe.com",
    path: "/",
    auth: {
      kind: "user-oauth",
      /*
       * From https://access.stripe.com/mcp 的 RFC 8414 元数据（/.well-known/oauth-authorization-server），
       * 2026-11-09 京东云实测.
       */
      authorizationUrl: "https://access.stripe.com/mcp/oauth2/authorize",
      tokenUrl: "https://access.stripe.com/mcp/oauth2/token",
      revokeUrl: "https://access.stripe.com/mcp/oauth2/revoke",
      /*
       * `mcp` is the only scope Stripe publishes, and it is all or nothing: there is no read-only
       * one. `writeTools` and the action policy are the whole write barrier for money.
       */
      scopes: Object.freeze(["mcp"]),
      clientRegistration: "dynamic",
      registrationUrl: "https://access.stripe.com/mcp/oauth2/register",
    },
    /*
     * Money moves through these, so every create, update, cancel, refund, finalize, send, pay and
     * delete Stripe documents or might, including names not yet seen on the hosted server. The
     * documented ones are from docs.stripe.com/mcp and the stripe/agent-toolkit repository; the rest
     * are the same API's other money-moving calls, listed so that one appearing on a refresh is
     * already a write.
     */
    writeTools: Object.freeze([
      "cancel_payment_intent",
      "cancel_refund",
      "cancel_subscription",
      "capture_payment_intent",
      "close_dispute",
      "confirm_payment_intent",
      "create_checkout_session",
      "create_coupon",
      "create_customer",
      "create_invoice",
      "create_invoice_item",
      "create_payment_intent",
      "create_payment_link",
      "create_payout",
      "create_price",
      "create_product",
      "create_promotion_code",
      "create_refund",
      "create_setup_intent",
      "create_subscription",
      "delete_coupon",
      "delete_customer",
      "delete_invoice",
      "expire_checkout_session",
      "finalize_invoice",
      "pay_invoice",
      "send_invoice",
      "update_customer",
      "update_dispute",
      "update_invoice",
      "update_payment_link",
      "update_price",
      "update_product",
      "update_subscription",
      "void_invoice",
    ]),
    docsUrl: "https://docs.stripe.com/mcp",
  },
  {
    key: "slack",
    title: "Slack",
    vendor: "Slack",
    summary:
      "以提问的人自己的身份搜索和读取 Slack 消息、频道、线程与 Canvas（只读授权）。",
    host: "https://mcp.slack.com",
    path: "/mcp",
    auth: {
      kind: "user-oauth",
      /*
       * From https://mcp.slack.com/.well-known/oauth-authorization-server，2026-11-09 京东云实测. Slack's
       * user-token pair; no registration endpoint and no revocation endpoint published.
       *
       * The administrator creates a Slack app (Slack may require it to be approved for its MCP
       * server), adds this deployment's redirect URI, and turns ON token rotation: without it Slack
       * issues no refresh token, and the shared flow refuses a redemption without one.
       */
      authorizationUrl: "https://slack.com/oauth/v2_user/authorize",
      tokenUrl: "https://slack.com/api/oauth.v2.user.access",
      /*
       * User scopes, read-only. Slack decides which tools a token sees from the scopes granted, so
       * leaving out `chat:write`, `canvases:write` and every other `:write` keeps the sending tools
       * away at the vendor. The probe read only the first twelve of Slack's published scopes; the
       * `*:history` and `search:read.*` names are from Slack's MCP documentation. 首次接入时须对照
       * Slack 官方 MCP 文档核对这一列表（例如是否还需要 `users:read`）。
       */
      scopes: Object.freeze([
        "canvases:read",
        "channels:history",
        "channels:read",
        "files:read",
        "groups:history",
        "groups:read",
        "im:history",
        "mpim:history",
        "search:read.im",
        "search:read.mpim",
        "search:read.private",
        "search:read.public",
      ]),
    },
    // Both spellings: Slack's own `slack_` prefix and the bare names third-party listings show.
    writeTools: Object.freeze([
      "create_canvas",
      "schedule_message",
      "send_message",
      "send_message_draft",
      "slack_create_canvas",
      "slack_schedule_message",
      "slack_send_message",
      "slack_send_message_draft",
      "slack_update_canvas",
      "update_canvas",
    ]),
    docsUrl: "https://docs.slack.dev/ai/slack-mcp-server/",
  },
  {
    key: "hubspot",
    title: "HubSpot CRM",
    vendor: "HubSpot",
    summary: "提问的人自己有权访问的 HubSpot 联系人、公司、交易与工单。",
    // HubSpot's hosted server, served at the origin itself, so the path is the root.
    host: "https://mcp.hubspot.com",
    path: "/",
    auth: {
      kind: "user-oauth",
      /*
       * From https://mcp.hubspot.com/.well-known/oauth-authorization-server，2026-11-09 京东云实测. No
       * registration endpoint and no revocation endpoint published.
       *
       * The administrator creates an MCP auth app in HubSpot (Development > MCP Auth Apps) and pastes
       * its client id and secret. HubSpot publishes no scopes for it: access follows the connecting
       * user's own HubSpot permissions, so no scope is sent and, as for Notion, `writeTools` and the
       * action policy are the whole write barrier.
       */
      authorizationUrl: "https://mcp.hubspot.com/oauth/authorize/user",
      tokenUrl: "https://mcp.hubspot.com/oauth/v3/token",
      scopes: Object.freeze([]),
    },
    writeTools: Object.freeze([
      "batch_create_crm_objects",
      "batch_update_crm_objects",
      "create_crm_object",
      "create_engagement",
      "manage_crm_objects",
      // Sends text to HubSpot on the person's behalf.
      "submit_feedback",
      "update_crm_object",
      "update_engagement",
    ]),
    docsUrl:
      "https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server",
  },
  {
    key: "asana",
    title: "Asana",
    vendor: "Asana",
    summary: "提问的人自己 Asana 工作区里的任务、项目与评论。",
    host: "https://mcp.asana.com",
    path: "/v2/mcp",
    auth: {
      kind: "user-oauth",
      /*
       * From https://app.asana.com/.well-known/oauth-authorization-server，2026-11-09 京东云实测. No
       * registration endpoint published, so the administrator registers an "MCP app" in Asana's
       * developer console and pastes its client id and secret.
       */
      authorizationUrl: "https://app.asana.com/-/oauth_authorize",
      tokenUrl: "https://app.asana.com/-/oauth_token",
      revokeUrl: "https://app.asana.com/-/oauth_revoke",
      /*
       * `default` is the one scope the metadata publishes, and it is Asana's full access: there is
       * no read-only one for this server. `writeTools` and the action policy are the write barrier.
       */
      scopes: Object.freeze(["default"]),
    },
    // Both the V2 server's bare names and the `asana_` names of Asana's earlier server.
    writeTools: Object.freeze([
      "add_comment",
      "add_followers",
      "add_task_dependencies",
      "add_task_dependents",
      "asana_add_task_dependencies",
      "asana_add_task_dependents",
      "asana_add_task_followers",
      "asana_create_project",
      "asana_create_project_status",
      "asana_create_task",
      "asana_create_task_story",
      "asana_delete_project_status",
      "asana_delete_task",
      "asana_remove_task_followers",
      "asana_set_parent_for_task",
      "asana_update_task",
      "create_project",
      "create_project_status",
      "create_task",
      "delete_task",
      "remove_followers",
      "set_parent_for_task",
      "update_project",
      "update_task",
    ]),
    docsUrl:
      "https://developers.asana.com/docs/integrating-with-asanas-mcp-server",
  },
  {
    key: "cloudflare-api",
    title: "Cloudflare API",
    vendor: "Cloudflare",
    summary:
      "以提问的人自己的 Cloudflare 账户调用 Cloudflare API（只申请只读权限）。",
    /*
     * Cloudflare's consolidated API server from its official mcp-server-cloudflare repository: one
     * tool searches the API and another executes code against it. That `execute` reaches the whole
     * Cloudflare API is the reason the scopes below are read-only and the reason it is a write.
     */
    host: "https://mcp.cloudflare.com",
    path: "/mcp",
    auth: {
      kind: "user-oauth",
      // From https://mcp.cloudflare.com/.well-known/oauth-authorization-server，2026-11-09 京东云实测.
      authorizationUrl: "https://mcp.cloudflare.com/authorize",
      tokenUrl: "https://mcp.cloudflare.com/token",
      revokeUrl: "https://mcp.cloudflare.com/token",
      /*
       * Read scopes only, and only the ones the probe saw (it read the first twelve of a longer
       * list). `offline_access` is what asks Cloudflare for the refresh token the shared flow
       * requires. Reads of zones, DNS, Workers and so on need further `:read` scopes, reviewed on
       * first connect against the full published list; no `:write` scope is asked for.
       */
      scopes: Object.freeze(["offline_access", "user:read", "account:read"]),
      clientRegistration: "dynamic",
      registrationUrl: "https://mcp.cloudflare.com/register",
    },
    writeTools: Object.freeze([
      "execute",
      // An account selector on Cloudflare's per-product servers; it changes server-side state.
      "set_active_account",
    ]),
    docsUrl: "https://github.com/cloudflare/mcp-server-cloudflare",
  },
  {
    key: "figma",
    title: "Figma",
    vendor: "Figma",
    summary: "读取提问的人有权访问的 Figma 设计稿上下文、截图与变量。",
    /*
     * Figma's hosted server. Figma admits dynamically registered clients by name from its own MCP
     * client catalogue, so registration may be refused until this deployment is admitted there; that
     * surfaces as Connect answering 502, and changes nothing else.
     */
    host: "https://mcp.figma.com",
    path: "/mcp",
    auth: {
      kind: "user-oauth",
      /*
       * From https://api.figma.com/.well-known/oauth-authorization-server，2026-11-09 京东云实测. The
       * consent page is on www.figma.com and the token and registration endpoints on api.figma.com,
       * as published. No revocation endpoint published.
       */
      authorizationUrl: "https://www.figma.com/oauth/mcp",
      tokenUrl: "https://api.figma.com/v1/oauth/token",
      // The one scope Figma publishes for this server, and not a read-only one.
      scopes: Object.freeze(["mcp:connect"]),
      clientRegistration: "dynamic",
      registrationUrl: "https://api.figma.com/v1/oauth/mcp/register",
    },
    writeTools: Object.freeze([
      "add_code_connect_map",
      "create_new_file",
      "generate_diagram",
      "generate_figma_design",
      "send_code_connect_mappings",
      "upload_assets",
      "use_figma",
    ]),
    docsUrl:
      "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation",
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
  // A switch the compiler checks for exhaustiveness, so an auth kind added later has to say here
  // whether it takes the deployment's credential rather than falling into "takes none".
  const auth = entry.auth;
  switch (auth.kind) {
    case "deployment-bearer":
    case "deployment-query":
    case "deployment-header":
    case "deployment-address":
      // Placed kinds are stored exactly as a bearer token is: the server's own `mcp` secret.
      return "mcp";
    case "none":
    case "user-oauth":
    case "builtin":
      return null;
    default: {
      const unknown: never = auth;
      throw new Error(
        `Unknown catalogue auth kind ${(unknown as { kind?: unknown }).kind}`,
      );
    }
  }
}

/**
 * Where on the request a placed deployment credential goes, with the pinned address it may go to.
 *
 * Plain data, built from the reviewed entry only, and handed down to the MCP transport beside the
 * decrypted secret so that the one module that builds a request is the one that places it. `base`
 * is the entry's own `host + path`: the dial is refused unless the connection's url is exactly
 * that, so a stored url edited by hand cannot carry the key somewhere else.
 */
export type CredentialPlacement =
  | {
      kind: "query";
      base: string;
      param: string;
      fixedParams: Readonly<Record<string, string>>;
      label: string;
      minLength: number;
    }
  | {
      kind: "header";
      base: string;
      header: string;
      label: string;
      minLength: number;
    }
  | {
      kind: "address";
      base: string;
      segmentPattern: string;
      param: string;
      label: string;
      minLength: number;
    };

/**
 * The placement for a placed kind, or null for a kind that is not one (bearer, none, OAuth,
 * builtin), which keeps its own path unchanged.
 *
 * Throws for a placed kind with no pinned host: the address is the whole of what makes putting a key
 * into a URL safe, and a per-instance host would make it the caller's. The catalogue test asserts no
 * entry is shaped that way; this is what stands behind a cast.
 */
export function credentialPlacement(
  entry: CatalogueEntry,
): CredentialPlacement | null {
  const auth = entry.auth;
  switch (auth.kind) {
    case "none":
    case "deployment-bearer":
    case "user-oauth":
    case "builtin":
      return null;
    case "deployment-query":
    case "deployment-header":
    case "deployment-address":
      break;
    default: {
      const unknown: never = auth;
      throw new Error(
        `Unknown catalogue auth kind ${(unknown as { kind?: unknown }).kind}`,
      );
    }
  }
  if (entry.host === null) {
    throw new Error(
      `${entry.key} places its credential and has no pinned host, so there is nowhere safe to put it.`,
    );
  }
  const base = `${entry.host}${entry.path === "/" ? "" : entry.path}`;
  const label = auth.credentialLabel;
  const minLength = auth.credentialMinLength ?? DEFAULT_PLACED_LENGTH;
  if (auth.kind === "deployment-query") {
    return {
      kind: "query",
      base,
      param: auth.param,
      fixedParams: auth.fixedParams ?? {},
      label,
      minLength,
    };
  }
  if (auth.kind === "deployment-header") {
    return { kind: "header", base, header: auth.header, label, minLength };
  }
  return {
    kind: "address",
    base,
    segmentPattern: auth.segmentPattern,
    param: auth.param,
    label,
    minLength,
  };
}

/**
 * A placed credential this deployment will not send, in a sentence for an administrator.
 *
 * NEVER CARRIES THE VALUE. Every message here is built from the reviewed placement alone — its
 * label, its pinned address, its parameter name — so it can go into `last_error`, an audit row, a
 * 400 body or a model's context without a key travelling with it.
 */
export class CredentialPlacementRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialPlacementRefusedError";
  }
}

/**
 * The characters a placed key may hold: letters, digits, `_` and `-`. Nothing else.
 *
 * Every key these vendors issue is hex or alphanumeric with dashes. Refusing the rest means a pasted
 * value with a line break cannot split a header, a value carrying `&`, `#`, `?` or a space is
 * refused rather than relied on to be encoded, and — the reason the set is this narrow rather than
 * base64's — a key made of these characters has exactly one spelling under every encoding a vendor
 * might echo it back in (percent, form, JSON, double), so {@link withoutSecrets} cannot miss one.
 */
const PLACED_CHARACTERS = /^[A-Za-z0-9_-]+$/;
/** The length a placed key must have unless its entry names a vendor's shorter official format. */
const DEFAULT_PLACED_LENGTH = 16;
/** No entry may lower the floor below this, whatever it names. */
const MIN_PLACED_FLOOR = 12;
const MAX_PLACED_LENGTH = 512;

/** The shortest key this placement admits: its own floor, never below {@link MIN_PLACED_FLOOR}. */
function placedFloor(placement: CredentialPlacement): number {
  return Math.max(placement.minLength, MIN_PLACED_FLOOR);
}

/** Whether this is a key a placement may hold: the characters above, and a length in range. */
function placedValueOk(placement: CredentialPlacement, value: string): boolean {
  return (
    PLACED_CHARACTERS.test(value) &&
    value.length >= placedFloor(placement) &&
    value.length <= MAX_PLACED_LENGTH
  );
}

/** The address an administrator pasted, broken into the two parts the dial may use. */
function parsedAddress(
  placement: Extract<CredentialPlacement, { kind: "address" }>,
  secret: string,
): { segment: string; key: string } | null {
  let url: URL;
  try {
    url = new URL(secret);
  } catch {
    return null;
  }
  const base = new URL(placement.base);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.origin !== base.origin ||
    url.hash !== ""
  ) {
    return null;
  }
  // `new URL` has already resolved dot segments, so `/server/../x` arrives as `/x` and fails here.
  const prefix = `${base.pathname.replace(/\/+$/, "")}/`;
  if (!url.pathname.startsWith(prefix)) return null;
  const segment = url.pathname.slice(prefix.length);
  if (!new RegExp(placement.segmentPattern).test(segment)) return null;
  const names = [...url.searchParams.keys()];
  if (names.length !== 1 || names[0] !== placement.param) return null;
  const key = url.searchParams.get(placement.param) ?? "";
  if (!placedValueOk(placement, key)) return null;
  return { segment, key };
}

/**
 * Why this deployment will not hold or send this value for this placement, or null when it will.
 *
 * Asked when an administrator stores the credential, so a malformed one is refused at the form, and
 * again inside {@link placeCredential} on every dial, because a credential can reach the vault by
 * other doors than the one that asks.
 */
export function credentialFormatRefusal(
  placement: CredentialPlacement,
  secret: string,
): string | null {
  const value = secret.trim();
  if (value === "") {
    return `还没有录入「${placement.label}」。请管理员在「插件 › 凭据」中录入后再试。`;
  }
  if (placement.kind === "address") {
    return parsedAddress(placement, value) === null
      ? `「${placement.label}」的格式不对：必须是 ${placement.base}/<服务 ID>?${placement.param}=<密钥> 这样的完整 https 地址，主机和路径前缀不能改，也不能带其他参数；密钥只能由英文字母、数字、_ 和 - 组成，至少 ${placedFloor(placement)} 位。`
      : null;
  }
  return placedValueOk(placement, value)
    ? null
    : `「${placement.label}」的格式不对：只能由英文字母、数字、_ 和 - 组成，长度 ${placedFloor(placement)} 到 ${MAX_PLACED_LENGTH} 位。`;
}

/**
 * The request a placed credential becomes: the URL to dial, the headers to send, and every spelling
 * of the secret an error message must not carry.
 *
 * THE ONLY FUNCTION THAT PUTS A PLACED KEY INTO A REQUEST, and it refuses rather than degrades:
 *
 *  - No credential is a refusal, never a dial without one. A vendor that answers anonymously would
 *    otherwise look connected while running on nobody's quota, or on a stranger's.
 *  - The connection's url must be the placement's pinned `base`, exactly. It is the stored
 *    `mcp_servers.url` on some paths, and a hand-edited row must not be able to move the key.
 *  - The key fills its pinned slot and nothing else: `URLSearchParams` encodes it as one value of
 *    one parameter, a header value is checked for visible ASCII before `Headers` sees it, and an
 *    address is rebuilt from the pinned base plus the two parts {@link parsedAddress} admits.
 *  - The result is checked once more — same origin, same path (or one segment under the prefix) —
 *    and then by the outbound guard's static check, the one an administrator's typed URL meets.
 *
 * Every refusal is a {@link CredentialPlacementRefusedError} whose message names no value.
 */
export function placeCredential(
  placement: CredentialPlacement,
  connectionUrl: string,
  secret: string | undefined,
): { url: string; headers: Record<string, string>; secrets: string[] } {
  const value = (secret ?? "").trim();
  if (connectionUrl !== placement.base) {
    throw new CredentialPlacementRefusedError(
      `这台服务器的地址与目录登记的 ${placement.base} 不一致，拒绝带着「${placement.label}」拨号。`,
    );
  }
  const refusal = credentialFormatRefusal(placement, value);
  if (refusal !== null) throw new CredentialPlacementRefusedError(refusal);

  const base = new URL(placement.base);
  let url: URL;
  const headers: Record<string, string> = {};
  const secrets = [value];
  switch (placement.kind) {
    case "query": {
      url = new URL(placement.base);
      for (const [name, fixed] of Object.entries(placement.fixedParams)) {
        url.searchParams.set(name, fixed);
      }
      url.searchParams.set(placement.param, value);
      break;
    }
    case "header": {
      // A vendor's own `X-` header only. `Authorization`, `Cookie`, `Host` and the rest mean
      // something to every hop between here and the vendor, and a reviewed entry naming one is a
      // mistake this refuses rather than sends.
      if (!/^x-[a-z0-9-]{1,64}$/i.test(placement.header)) {
        throw new CredentialPlacementRefusedError(
          `目录为「${placement.label}」登记的请求头名不是服务商自定义的 X- 头，拒绝拨号。`,
        );
      }
      url = new URL(placement.base);
      headers[placement.header] = value;
      break;
    }
    case "address": {
      const parts = parsedAddress(placement, value);
      // Unreachable after the format check above; asked again so the narrowing is not a cast.
      if (parts === null) {
        throw new CredentialPlacementRefusedError(
          `「${placement.label}」的格式不对。`,
        );
      }
      url = new URL(
        `${placement.base.replace(/\/+$/, "")}/${encodeURIComponent(parts.segment)}`,
      );
      url.searchParams.set(placement.param, parts.key);
      secrets.push(parts.key);
      break;
    }
    default: {
      const unknown: never = placement;
      throw new CredentialPlacementRefusedError(
        `未知的凭据放置方式 ${(unknown as { kind?: unknown }).kind}，拒绝拨号。`,
      );
    }
  }

  const samePath =
    placement.kind === "address"
      ? url.pathname.startsWith(`${base.pathname.replace(/\/+$/, "")}/`) &&
        url.pathname.split("/").length === base.pathname.split("/").length + 1
      : url.pathname === base.pathname;
  if (url.origin !== base.origin || !samePath) {
    throw new CredentialPlacementRefusedError(
      `「${placement.label}」改变了目录登记的主机或路径，拒绝拨号。`,
    );
  }
  const verdict = checkOutboundUrl(url.href);
  if (!verdict.allowed) {
    throw new CredentialPlacementRefusedError(verdict.reason);
  }
  return { url: url.href, headers, secrets: [...secrets, url.href] };
}

/**
 * Every spelling of one secret a message might carry it in.
 *
 * As typed; percent-encoded once and twice (`encodeURIComponent`, and that again, which is what a
 * vendor quoting an already-encoded URL produces); form-encoded, which writes a space as `+`; and
 * JSON-escaped, with and without the `\/` escape PHP's `json_encode` uses by default.
 */
function spellingsOf(secret: string): string[] {
  const once = encodeURIComponent(secret);
  const json = JSON.stringify(secret).slice(1, -1);
  return [
    secret,
    once,
    encodeURIComponent(once),
    new URLSearchParams({ v: secret }).toString().slice(2),
    json,
    json.replaceAll("/", "\\/"),
  ];
}

/**
 * Text with every spelling of these secrets taken out.
 *
 * Matched WITHOUT REGARD TO CASE, which covers in one rule a percent escape in either case (`%2F`
 * and `%2f`), a URL lower-cased by whatever logged it, and a key a vendor upper-cased. Longest first,
 * so a URL holding a key is removed whole rather than leaving its address around a gap.
 *
 * NO SECRET IS TOO SHORT. There used to be a floor below which a value was left alone, so that a
 * three-character token could not shred ordinary words; the floor is now on what may be STORED (a
 * placed key is at least twelve characters), and the scrub takes out whatever it is given. Only the
 * empty string is skipped, because it is not a secret and would match everywhere.
 *
 * Callers take a secret out BEFORE anything is cut to length: a cut that lands inside a key leaves a
 * prefix no full spelling matches, so that order is the whole of the guarantee.
 */
export function withoutSecrets(
  text: string,
  secrets: readonly (string | undefined)[],
): string {
  const spellings = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    for (const spelling of spellingsOf(secret)) spellings.add(spelling);
  }
  if (spellings.size === 0) return text;
  const pattern = [...spellings]
    .sort((a, b) => b.length - a.length)
    .map((spelling) => spelling.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return text.replace(new RegExp(pattern, "gi"), "[已隐去]");
}

/**
 * {@link withoutSecrets} over every string in a value: object keys, array items and nested values.
 *
 * For what a vendor hands back as structure rather than as text — a tool's input schema, a call's
 * structured content — where a key echoed into a `default`, an `example` or a property name would
 * otherwise be stored and shown as it came.
 */
export function withoutSecretsDeep<T>(
  value: T,
  secrets: readonly (string | undefined)[],
): T {
  if (!secrets.some(Boolean)) return value;
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return withoutSecrets(node, secrets);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node).map(([name, inner]) => [
          withoutSecrets(name, secrets),
          walk(inner),
        ]),
      );
    }
    return node;
  };
  return walk(value) as T;
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
  // 列了只读名单的条目就列全了：名单外它广播的任何名字都是写。只收紧，没有名单的条目不受影响；
  // 名单里的名字也不在这里定成读，下面厂商记录的写仍然能让它变成写。
  if (
    entry?.readTools &&
    !reviewedRead(entry, toolName, { destructive: false })
  )
    return "write";
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
 * 这个工具是否经过审查、确定只读：只有条目的 `readTools` 名单能这么说。
 *
 * 服务器自己的 `readOnlyHint`、代理商按描述打的只读标签、写名单里漏掉的名字，都只是「没人说它是写」，
 * 不是有人确认过它只读。破坏性标记和写名单仍然优先于只读名单。没有名单的条目一律回答 false，所以
 * 调用方不能拿它替换现有的读判定（那样会改变没有名单的条目的行为），只能拿它把判定收紧，
 * 例如 {@link classifyTool} 对列了名单的条目那样。
 */
export function reviewedRead(
  entry: CatalogueEntry | null,
  toolName: string,
  tool: { destructive: boolean },
): boolean {
  if (tool.destructive || !entry?.readTools) return false;
  if (entry.writeTools.includes(toolName)) return false;
  return entry.readTools.includes(toolName);
}

/**
 * 无人值守的 check-in 能不能把这个工具当读来调用。比聊天的 {@link classifyTool} 更严。
 *
 * 只认两种有人作证的读：
 * - 厂商列出时记录为读（`mcp_tools.effect` 正好是 `read`）。这一列只由厂商的标签写入：Composio 的
 *   `readOnlyHint` 记成 read；MCP 服务器自报的 `readOnlyHint` 不记（见 mcp.ts 的 `declaredEffect`）。
 * - 条目 `readTools` 里审查过的名字（{@link reviewedRead}）。
 *
 * `classifyTool` 对「目录里有、写名单没提到、厂商也没记录」的工具推断为读，这个推断在聊天里照旧有效
 * （人在场，写操作另有审批），但不能让工具进入没人看着的 check-in。破坏性标记、`unclassified`
 * （厂商什么都没说）以及 `classifyTool` 判为写的，一律不算。
 *
 * 调用方负责先确认这个名字确实被广播过（`mcp_tools` 里有这一行）。
 */
export function checkInRead(
  entry: CatalogueEntry | null,
  toolName: string,
  tool: {
    /** `mcp_tools.effect`：厂商记录的效果，没有记录时为 null。 */
    effect: string | null | undefined;
    destructive: boolean;
    unclassified: boolean;
  },
): boolean {
  if (tool.destructive || tool.unclassified) return false;
  if (classifyTool(entry, toolName, true, tool.effect) !== "read") return false;
  return tool.effect === "read" || reviewedRead(entry, toolName, tool);
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
