import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { cutAtCodeUnits } from "../channels/text";
import { createGuardedFetch, type OutboundPolicy } from "../net/outbound-guard";
import {
  type CredentialPlacement,
  CredentialPlacementRefusedError,
  placeCredential,
  withoutSecrets,
  withoutSecretsDeep,
} from "./catalogue";
import { transientFailure } from "./transient";

/**
 * The only place in this deployment that speaks MCP to somebody else's server.
 *
 * One door. Every call out is a credential leaving the building and a result coming back
 * that a model will read, so both directions want a single place to be careful in. A second client
 * somewhere else would be a second place to forget the timeout, the credential handling or the size
 * cap, and nothing about the second one would look wrong in review.
 *
 * No connection is kept. A client is built, used and closed for every listing and every call.
 * Streamable HTTP makes that cheap, and a pooled session would mean one Bot's request could arrive
 * on a session another Bot's credential opened, which is a whole class of bug we simply decline to
 * have.
 */

/** How long a server gets before we give up on it, for a handshake, a listing and a call. */
const CONNECT_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;

/**
 * The most result text a call may return.
 *
 * A tool result goes straight into a model's context, so an unbounded one is somebody else's server
 * deciding how much of our context window to spend, and a truncation the model can see is far better
 * than a run that fails or a bill nobody expected. Truncated visibly, never silently.
 */
export const MAX_RESULT_CHARS = 20_000;

/**
 * What a vendor said, as the string a model will read.
 *
 * Its own function, and exported, because this is a decision rather than plumbing: it settles what a
 * model is told when a vendor answers with nothing, with something enormous, or with a part we
 * cannot render. Keeping it out of {@link callTool} means it can be asserted without a server to
 * talk to.
 *
 * The empty case is the one that earns the separation. A tool that matched nothing used to produce
 * an empty string, and an empty string is the worst thing to put in front of a model: it reads as
 * "the tool had nothing to say" rather than "there is nothing there", and the model closes the gap
 * from memory. For a knowledge connector that is precisely the failure the whole slice exists to
 * prevent — an answer with nothing behind it. So nothing is stated, in words.
 */
/**
 * How much of a resource link's title, name or description a model is shown.
 *
 * Long enough for a heading and a sentence, short enough that a link's own metadata cannot spend
 * the result cap its pointer has to fit in.
 */
const LINK_FIELD_CHARS = 400;

/**
 * A resource_link as the lines a model reads: the pointer first, then bounded metadata.
 *
 * The URI is the link's identity; the title or name and the description are metadata. The URI
 * therefore leads, whole, and the other two are cut, so that a server's long name cannot push its
 * own pointer past {@link MAX_RESULT_CHARS} below and leave the model holding a link with nowhere
 * to go. Truncation may lose what a resource was called, never where it is. Each line is labelled,
 * so the fields are told apart by name rather than by position.
 *
 * The spec's `title` is the name meant for people, `name` the one meant for programs; the title is
 * shown when a server gives one. Null when the link names nothing, so the caller names its type.
 */
function resourceLinkText(item: {
  uri?: unknown;
  name?: unknown;
  title?: unknown;
  description?: unknown;
}): string | null {
  const field = (value: unknown) =>
    typeof value === "string" && value.trim() !== "" ? value : null;
  const bounded = (value: string) =>
    value.length > LINK_FIELD_CHARS
      ? `${cutAtCodeUnits(value, LINK_FIELD_CHARS)}…`
      : value;
  const lines: string[] = [];
  const uri = field(item.uri);
  if (uri !== null) lines.push(`uri: ${uri}`);
  const title = field(item.title);
  const name = field(item.name);
  if (title !== null) lines.push(`title: ${bounded(title)}`);
  else if (name !== null) lines.push(`name: ${bounded(name)}`);
  const description = field(item.description);
  if (description !== null) {
    lines.push(`description: ${bounded(description)}`);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

export function resultText(
  rawContent: unknown,
  rawStructuredContent?: unknown,
  /**
   * Strings no part of the result may carry: the credential this call went out with, in every
   * spelling. Taken out of the vendor's whole answer FIRST, before any field is cut to length below
   * — a cut that lands inside a key leaves a prefix no full spelling matches any more.
   */
  secrets: readonly string[] = [],
): {
  text: string;
  truncated: boolean;
} {
  const content = withoutSecretsDeep(rawContent, secrets);
  const structuredContent = withoutSecretsDeep(rawStructuredContent, secrets);
  const parts = Array.isArray(content) ? content : [];
  let joined = parts
    .map((part) => {
      if (!part || typeof part !== "object") return "[unknown]";
      const item = part as {
        type?: string;
        text?: string;
        uri?: unknown;
        name?: unknown;
        title?: unknown;
        description?: unknown;
        resource?: { text?: unknown } | null;
      };
      if (item.type === "text" && typeof item.text === "string") {
        return item.text;
      }
      // An embedded resource with text in it is text, and often the answer itself: GitHub's MCP
      // server returns a file it read as one, beside a line saying the download worked. A resource
      // carrying bytes (`blob`) has no text to read and is named below like any other part.
      if (item.type === "resource" && typeof item.resource?.text === "string") {
        return item.resource.text;
      }
      // A resource_link is a pointer, not the file: a URI, a name, sometimes a title, and often a
      // sentence of what it is. Named as "[resource_link]", the model was told a link arrived and
      // never shown where it went, so a search that answered with pages produced no page it could
      // open.
      if (item.type === "resource_link") {
        const shown = resourceLinkText(item);
        if (shown !== null) return shown;
      }
      // A non-text part is named rather than dropped. A model told "[image]" can say the tool
      // returned an image; a model handed nothing concludes the tool returned nothing.
      return `[${item.type ?? "unknown"}]`;
    })
    .join("\n");

  // Trimmed only to decide emptiness, never to alter a result that has something in it. A vendor
  // that sent one newline has said nothing, and which shape of nothing arrived should not change
  // what the model is told.
  if (joined.trim() === "") {
    /*
     * MCP tools with an output schema often put the answer in `structuredContent` and leave
     * `content` empty. Treating that as "nothing was found" is the same lie an empty string was:
     * the tool answered, and the model fills the gap from memory. Read only when `content` had
     * nothing; a text part already present is the representation the server chose to show.
     */
    const structured =
      structuredContent !== null &&
      structuredContent !== undefined &&
      typeof structuredContent === "object"
        ? JSON.stringify(structuredContent)
        : "";
    if (structured === "") {
      return {
        text: "The tool returned no content. Nothing was found, so there is nothing here to answer from.",
        truncated: false,
      };
    }
    joined = structured;
  }

  if (joined.length <= MAX_RESULT_CHARS) {
    return { text: joined, truncated: false };
  }
  return {
    text: `${cutAtCodeUnits(joined, MAX_RESULT_CHARS)}\n\n[truncated: the tool returned ${joined.length} characters]`,
    truncated: true,
  };
}

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/**
 * A tool as a transport listed it, including anything that transport happens to know about it.
 *
 * Three optional fields rather than a separate type per transport, so `refreshTools` reads
 * `tool.effect` with no cast and no `"effect" in tool` sniffing. Optional because a transport may
 * know none of it for a given tool, and a field always left undefined would be an invitation to
 * read it as meaning something.
 *
 * AN MCP SERVER CAN PUBLISH AN EFFECT, and this docblock used to say it could not. That sentence
 * was not a stale comment, it was load bearing: the argument that surfacing a recorded effect could
 * not disturb any existing curated read rested on MCP listings never carrying one, which was true
 * only because {@link listTools} was discarding `annotations`. The specification defines
 * `annotations.destructiveHint`, servers publish it, and a tool a vendor declared destructive was
 * classifying as a read for any curated entry whose hand-written `writeTools` happened to omit the
 * name. Version is the field MCP genuinely has no concept of; effect and destructive are not.
 *
 * `McpTool` stays exactly what a `tools/list` answer contains, because that is what it is for.
 */
export type ListedTool = McpTool & {
  /**
   * 厂商调用这个动作用的名字，与 `name` 不同时才有（Arcade 的 `Gmail.ListEmails` 对 `ListEmails`）。
   * `name` 是本部署的标识、也是模型看到的名字；执行时发这个。没有时就是 `name`。
   */
  vendorName?: string;
  /** What the vendor said this action does, when it said anything. */
  effect?: "read" | "write";
  /** Whether the vendor marked it as destroying something. */
  destructive?: boolean;
  /**
   * vendor 对它做什么只字未提：MCP 服务器没有给 `readOnlyHint` 也没有给 `destructiveHint`，或
   * Composio 没有只读、破坏性、新建、修改中的任何一个标签。记成不算 destructive 的写操作；
   * catalogue 条目的名单覆盖它时由名单决定，不记（见 store.ts 的 `storableTools`）。
   */
  unclassified?: boolean;
  /** The vendor's version string, when calling the action requires one. */
  version?: string;
};

export class McpServerError extends Error {
  constructor(
    message: string,
    /**
     * Whether what failed passes (a timeout, a 429, the server's own 5xx), so a read may be tried
     * again. Decided from the transport's error before it is flattened into the sentence above, which
     * keeps only some statuses. See `./transient`.
     */
    readonly transient = false,
  ) {
    super(message);
    this.name = "McpServerError";
  }
}

type Connection = {
  url: string;
  /** The conversation the call is made in, for the built-in Routines (see store.ts `callTool`). */
  threadId?: string;
  /** The bearer token for this server, already decrypted. Absent for a server that needs none. */
  token?: string;
  /**
   * Present for a server whose URL a tenant chose (a custom server, no catalogue entry), and then
   * every request goes through the outbound guard with this policy: each DNS answer must be public,
   * and a redirect is refused rather than followed, so the token never travels with one.
   * `customUrlRefusal` only reads the string when it is stored; this is the check on where it points.
   * Absent for a catalogue-pinned server, whose host is a reviewed constant.
   */
  outbound?: OutboundPolicy;
  /**
   * Where `token` goes, for a catalogue entry whose vendor does not take it as a bearer token: a
   * pinned query parameter, a pinned vendor header, or an address that is itself the credential.
   *
   * Present, it REPLACES the Authorization header rather than adding to it, and three more things
   * hold: no token is a refusal rather than an anonymous dial; `url` must be the entry's pinned base
   * exactly; and every request goes through the outbound guard — with `outbound` when a test injects
   * one, with the strict default otherwise — so a redirect is refused rather than followed and a
   * key in a URL or a vendor header (which `fetch` does not strip across origins the way it strips
   * Authorization) is never carried to another host. See `placeCredential` in catalogue.ts.
   */
  placement?: CredentialPlacement;
};

/**
 * The vendor's own sentence out of a failure, when there is one worth reading.
 *
 * The transport puts the response body in the message, after a fixed prefix. Two shapes turn up: a
 * plain error object, and — from Google's Workspace servers — a JSON-RPC result whose `content` holds
 * the explanation as text under `isError`. Both are worth surfacing; the tool list, which arrives in
 * the same position under a 403, is not.
 */
function reasonFrom(error: unknown, secrets: readonly string[]): string | null {
  // Scrubbed while still whole, before `trimmed` below can cut through a key.
  const message = withoutSecrets(
    error instanceof Error ? error.message : String(error),
    secrets,
  );
  const body = message.slice(message.indexOf("{"));
  if (!body.startsWith("{")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  const asRecord = (value: unknown) =>
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};

  // `{"error": {"message": "..."}}` — how Google's REST APIs refuse.
  const restMessage = asRecord(asRecord(parsed).error).message;
  if (typeof restMessage === "string" && restMessage) {
    return trimmed(restMessage);
  }

  // `{"result": {"content": [{"text": "..."}], "isError": true}}` — how its MCP servers refuse.
  const result = asRecord(asRecord(parsed).result);
  if (result.isError === true && Array.isArray(result.content)) {
    const text = result.content
      .map((part) => asRecord(part).text)
      .find((value): value is string => typeof value === "string" && !!value);
    if (text) return trimmed(text);
  }

  return null;
}

/** Long enough for a sentence and a URL, short enough not to be the wall of JSON this replaced. */
const trimmed = (value: string) =>
  value.length > 400 ? `${cutAtCodeUnits(value, 400)}…` : value;

/**
 * A vendor's failure, as one sentence an operator can act on.
 *
 * WHAT THIS REPLACES. The transport throws `Error POSTing to endpoint: <the whole response body>`,
 * and the status lives on the error object rather than in the message — so rewrapping by `.message`
 * alone threw away the only part that says what went wrong and kept the part that does not.
 *
 * Google's Workspace MCP servers make that worse than it sounds. Asked for a tool list with a token
 * they will not accept, they answer **401, or 403, with a complete and valid tool list in the body** —
 * verified against the live endpoint. So the message was a wall of successful-looking JSON attached
 * to a failure, which reads as a parsing bug here rather than as a refusal there.
 *
 * The status leads, and the well-known ones are named. A 403 also keeps the vendor's own sentence
 * where there is one, because that is where Google says which API is not enabled — and each Workspace
 * product is two APIs, so nothing else can tell "I enabled it" from "it is enabled".
 */
function vendorFailure(error: unknown, secrets: readonly string[]): string {
  const status =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;

  if (status === 401) {
    return "The vendor rejected this credential (401). For a connector reached as the person asking, reconnecting the account is the usual fix; if it persists, the scopes it was granted may not cover this server.";
  }
  if (status === 403) {
    /*
     * A 403 keeps its reason, unlike a 401.
     *
     * This cost a diagnosis. Google refuses a Workspace MCP server with 403 when the API behind it is
     * not enabled for the project — and the sentence saying so, with the console URL to fix it, is in
     * the response body. Dropping the body left "the account may lack access, or the API may not be
     * enabled", which is a guess between two very different problems when the vendor had already
     * answered the question.
     *
     * Worse, each Workspace product is TWO APIs: enabling `drive.googleapis.com` does not enable
     * `drivemcp.googleapis.com`, so "I enabled it" and "it is enabled" are not the same claim and
     * only the body can tell them apart.
     *
     * Trimmed, because the body may instead be the tool list — the same server answers `tools/list`
     * with a full, valid list under a 403 — and a wall of JSON is what made the original error
     * unreadable.
     */
    const detail = reasonFrom(error, secrets);
    return detail
      ? `The vendor accepted the credential and refused the request (403). It said: ${detail}`
      : "The vendor accepted the credential and refused the request (403). The account may lack access, or the API may not be enabled for this project.";
  }
  if (typeof status === "number") {
    return `The vendor answered ${status}.`;
  }
  return withoutSecrets(
    error instanceof Error ? error.message : String(error),
    secrets,
  );
}

/**
 * The Authorization header a stored token becomes.
 *
 * Bearer by default, which is what an MCP server's own token usually is. A token that already
 * names its scheme is sent as written, because some vendors forward the header straight to an API
 * that only speaks Basic: DataForSEO's hosted server answers the handshake and the tool listing to
 * anything, then returns 401 on every real call made with Bearer, so a deployment that could only
 * say Bearer looked connected and never worked. The scheme travels with the credential rather than
 * as a setting on the server row, so rotating a token can change how it is presented and nothing
 * else has to know.
 */
export function authorizationHeader(token: string): string {
  const trimmed = token.trim();
  return /^(basic|bearer)\s+\S/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

/**
 * Build, use and close a client.
 *
 * The `finally` closes the transport whatever happened, because a thrown error is the case where a
 * leaked connection is most likely and least noticed.
 */
/**
 * The handshake, on a deadline of its own.
 *
 * `listTools` and `callTool` are both given one above, and neither covers getting here: the SDK's
 * `connect()` takes no timeout option, so an unreachable host leaves THIS await open for as long as the
 * socket's own (or a captive proxy's) patience — minutes, with nothing on the administrator's screen but
 * a spinner, and the failure that finally arrives is a browser network error rather than a sentence about
 * the server not answering. The two call deadlines were therefore guarding only the request of a session
 * that could already not be opened.
 *
 * Racing rather than aborting: an `AbortSignal` on the transport's `requestInit` would ride along on the
 * later calls too and quietly cap a 60-second tool call at 15. Whoever loses, the `finally` in
 * {@link withClient} still closes the client, which is what tears down a handshake that comes back late.
 */
async function connectWithinDeadline(
  client: Client,
  transport: StreamableHTTPClientTransport,
): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () =>
            reject(
              new Error(
                `The server did not answer the handshake within ${Math.round(CONNECT_TIMEOUT_MS / 1000)}s.`,
              ),
            ),
          CONNECT_TIMEOUT_MS,
        );
        // A deadline nobody is waiting on must not hold the process open.
        deadline.unref?.();
      }),
    ]);
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
}

/**
 * The request a connection becomes: where to send it, what headers, which fetch, and which strings
 * no message about it may carry.
 *
 * A placed credential is decided entirely in `placeCredential`, before any transport exists, so a
 * refusal there is a sentence with nothing sent. Everything else dials exactly as it always has.
 */
function dialFor(connection: Connection): {
  url: string;
  requestInit: RequestInit | undefined;
  fetch: typeof fetch | undefined;
  secrets: string[];
} {
  if (connection.placement) {
    const placed = placeCredential(
      connection.placement,
      connection.url,
      connection.token,
    );
    return {
      url: placed.url,
      requestInit:
        Object.keys(placed.headers).length > 0
          ? { headers: placed.headers }
          : undefined,
      // Always guarded: see `Connection.placement`.
      fetch: createGuardedFetch(connection.outbound ?? {}),
      secrets: [...placed.secrets, ...scrubbableBearer(connection.token)],
    };
  }
  return {
    url: connection.url,
    requestInit: connection.token
      ? { headers: { Authorization: authorizationHeader(connection.token) } }
      : undefined,
    // The SDK sends every POST, GET and DELETE through this when given; see `Connection.outbound`.
    fetch: connection.outbound
      ? createGuardedFetch(connection.outbound)
      : undefined,
    secrets: scrubbableBearer(connection.token),
  };
}

/**
 * A bearer or OAuth token to scrub from what leaves the transport, or none.
 *
 * Placed credentials are format-checked at entry (at least twelve characters of `[A-Za-z0-9_-]`),
 * so scrubbing them can never hit ordinary text. A bearer or OAuth token is not: an administrator
 * may have typed a short test token, and scrubbing a four-letter word would replace it all through
 * tool results and schemas and hide every tool whose name contains it. Below eight characters a
 * token is not a credential worth that cost, and it was never scrubbed before placed credentials
 * brought scrubbing in.
 */
function scrubbableBearer(token: string | undefined): string[] {
  return token && token.length >= BEARER_SCRUB_MIN ? [token] : [];
}
const BEARER_SCRUB_MIN = 8;

async function withClient<T>(
  connection: Connection,
  use: (client: Client, secrets: readonly string[]) => Promise<T>,
): Promise<T> {
  let dial: ReturnType<typeof dialFor>;
  try {
    dial = dialFor(connection);
  } catch (error) {
    // A placement refusal names no value; anything else thrown while placing is not trusted to.
    throw new McpServerError(
      error instanceof CredentialPlacementRefusedError
        ? error.message
        : "无法为这台服务器构造请求，未发送任何内容。",
    );
  }
  const transport = new StreamableHTTPClientTransport(new URL(dial.url), {
    requestInit: dial.requestInit,
    ...(dial.fetch ? { fetch: dial.fetch } : {}),
  });
  const client = new Client({ name: "openbot", version: "1.0.0" });

  try {
    await connectWithinDeadline(client, transport);
    return await use(client, dial.secrets);
  } catch (error) {
    // Rewrapped so a caller never has to care whether the failure came from the transport, the
    // handshake or the call, and so the message that reaches an audit row and an admin page is one
    // sentence rather than a stack. Every spelling of the credential is taken out first: this
    // message is written into `last_error`, an audit row and a model's context, and a transport
    // error that quotes the URL it dialled would otherwise quote a key placed in it.
    throw new McpServerError(
      withoutSecrets(vendorFailure(error, dial.secrets), dial.secrets),
      transientFailure(error),
    );
  } finally {
    await client.close().catch(() => {
      // A server that will not say goodbye is not a failure of the work that just succeeded.
    });
  }
}

/**
 * A remote server will not list its tools to nobody, so a credential is required to ask.
 *
 * Declared rather than assumed, because the other transport in this deployment answers differently
 * and the difference is the whole shape of an administrator's setup flow. See {@link ./transport}.
 */
export const listNeedsCredential = true;

/**
 * ONLY THE HINT THAT NARROWS IS BELIEVED, and the omission of the other one is the decision here.
 *
 * The SDK declares four hints on `annotations` — `readOnlyHint`, `destructiveHint`,
 * `idempotentHint`, `openWorldHint` — and warns in the same place that a client should never make
 * tool use decisions from annotations a server it does not trust supplied. That warning is the
 * whole design of this function. `destructiveHint` can only ever move an action from read to write,
 * so a server that lies with it can restrict itself and nothing else. `readOnlyHint` moves an
 * action the other way, and `classifyTool` exists to make sure nothing but review can do that.
 *
 * WHAT HONOURING `readOnlyHint` WOULD ACTUALLY BUY, which is the reason withholding it costs
 * nothing. For a curated vendor it changes no answer: an advertised name absent from the reviewed
 * `writeTools` already classifies as a read, so recording `read` for it lands on the same result by
 * a worse route. For a name the reviewed list DOES hold, `classifyTool` consults review first and
 * ignores the column, so the hint would be discarded anyway. The single case where it would change
 * an answer is a server an administrator added by URL, which has no reviewed list behind it and
 * whose every tool is a write for exactly that reason — and there, believing it means letting an
 * arbitrary server declare its own tools harmless and be believed. Zero accuracy gained, one
 * fail-open introduced, so it is not read at all.
 *
 * `destructiveHint` is taken on presence of `true` only, never inverted. The specification gives it
 * a default of true when a tool is not read-only, and applying that default would reclassify every
 * unannotated action of every MCP vendor as a write — correct by the letter and a mass revocation
 * of grants people already hold. An absent hint stays absent, which leaves the reviewed list
 * deciding exactly as it did before, and only an explicit declaration narrows anything.
 *
 * A server that sets both hints is contradicting itself, and is read as destructive. The
 * specification says `destructiveHint` is meaningless while `readOnlyHint` is true, but resolving
 * an incoherent listing towards the permissive reading is the one direction that could hurt.
 */
function declaredEffect(annotations: ToolAnnotations | undefined) {
  // 两个提示都没给，就是服务器对它做什么只字未提。effect 仍不记，让 catalogue 的名单照旧决定读写。
  if (
    annotations?.readOnlyHint === undefined &&
    annotations?.destructiveHint === undefined
  )
    return { unclassified: true } as const;
  if (annotations?.destructiveHint !== true) return {};
  return { effect: "write", destructive: true } as const;
}

/** What this server says it offers, right now. */
export async function listTools(connection: Connection): Promise<ListedTool[]> {
  return withClient(connection, async (client, secrets) => {
    const result = await client.listTools(undefined, {
      timeout: LIST_TIMEOUT_MS,
    });
    return (
      result.tools
        /*
         * A tool whose NAME carries the credential is not listed at all. A name is an identifier a
         * grant, a policy rule and a call are all written against, so scrubbing it would list a tool
         * nobody can call under the name shown — and leaving it would store the key as a tool name.
         */
        .filter((tool) => withoutSecrets(tool.name, secrets) === tool.name)
        .map((tool) => ({
          name: tool.name,
          // Stored and shown on the Plugins page, and handed to a model: a vendor echoing the key
          // into a description, a schema's default, an example or a property name puts it nowhere.
          description: withoutSecrets(tool.description ?? "", secrets),
          inputSchema: withoutSecretsDeep(
            (tool.inputSchema ?? {}) as Record<string, unknown>,
            secrets,
          ),
          ...declaredEffect(tool.annotations),
        }))
    );
  });
}

export type McpCallResult = {
  /** The result as text, which is what a model reads. Truncated visibly if it was enormous. */
  text: string;
  /** True when the server itself reported the call as an error rather than failing to answer. */
  isError: boolean;
  truncated: boolean;
  /**
   * 厂商拒绝这个账号执行这个动作（Arcade 要求授权）。只由 Arcade 传输层设置。
   *
   * X5 还没有接上：store 目前只把它当作一次失败的调用（失败文字给模型、审计 `mcp.call_failed`），
   * 不出上游的「重新连接」卡片，也不去问 broker 账号是否还在、不结束连接行。
   */
  actionNotAllowed?: true;
};

/**
 * Call one tool.
 *
 * Whether the call was permitted is not decided here. This function's only job is to speak the
 * protocol; the grant and the policy are settled before anything reaches it. Keeping the two apart
 * means the permission check cannot be accidentally satisfied by a code path that also happens to
 * make the call.
 */
export async function callTool(
  connection: Connection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  return withClient(connection, async (client, secrets) => {
    const result = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: CALL_TIMEOUT_MS },
    );

    // The secrets go INTO `resultText`, so the answer is scrubbed whole before it is cut to length.
    const { text, truncated } = resultText(
      result.content,
      "structuredContent" in result ? result.structuredContent : undefined,
      secrets,
    );
    // A model reads this, and an `isError` text is copied into the audit row; neither gets the key.
    return {
      text: withoutSecrets(text, secrets),
      isError: result.isError === true,
      truncated,
    };
  });
}
