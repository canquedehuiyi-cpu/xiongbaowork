import { asResult, readOpening } from "./google-drive-rest";
import type { McpCallResult, McpTool } from "./mcp";

/**
 * Baidu Netdisk (百度网盘), reached over its xpan REST API, read-only.
 *
 * Modelled on {@link ./google-drive-rest} and implementing the same two-function contract
 * (`listTools`, `callTool`), so the store, the grants, the policy engine and the audit trail treat it
 * exactly as they treat Drive. Baidu publishes no MCP server, so there is no swap to keep open here;
 * the tool NAMES still follow Drive's (`search_files`, `get_file_metadata`, `read_file_content`) so a
 * person who has granted one file connector recognises the other.
 *
 * WHAT IS DIFFERENT FROM DRIVE, and each difference is deliberate:
 *
 * - The access token travels as the `access_token` QUERY PARAMETER, because that is the only place
 *   Baidu reads it. So no URL built here is ever put into a message, a log line or an error: an
 *   address with the query attached is the person's credential.
 * - A refusal usually arrives as HTTP 200 with a non-zero `errno` in the body, not as an HTTP status.
 *   Both are read.
 * - `fs_id` values are integers that can exceed what a JavaScript number holds exactly, so they are
 *   lifted out of the raw JSON as strings before parsing, and sent back as the same digits.
 * - Reading a file is two steps: `filemetas` with `dlink=1` returns a short-lived download address,
 *   which is then fetched with the token appended and Baidu's required `User-Agent: pan.baidu.com`.
 *   That address normally redirects once to a CDN host. Redirects are followed by hand, only to
 *   Baidu's own download hosts, and WITHOUT the token, so a vendor-supplied address can never carry
 *   the person's credential anywhere this file did not name.
 * - Baidu reports no MIME type, so whether a file is text is decided from its extension, by an allow
 *   list. Anything else is declined with its metadata, as Drive declines a binary file.
 *
 * Read-only by construction: the `basic,netdisk` scope can write, so nothing here offers a call that
 * does, and the catalogue entry names Baidu's write methods as writes in case a later edit adds one.
 */

/** Long enough for a slow listing, short enough that a Bot's turn is not held open on it. */
const REQUEST_TIMEOUT_MS = 30_000;

/** How many files a listing returns before the model is reading a directory rather than an answer. */
const PAGE_SIZE = 25;

/** Baidu refuses a `dlink` download without this exact agent, and asks for it on the API too. */
const BAIDU_USER_AGENT = "pan.baidu.com";

/** A `dlink` normally redirects once, to a CDN node. More than this is not a download. */
const MAX_DOWNLOAD_HOPS = 3;

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "search_files",
    description:
      "Search the files in your Baidu Netdisk (百度网盘) by file name. Returns matching files with their paths, sizes, last modified times and ids.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to look for in file names.",
        },
        dir: {
          type: "string",
          description:
            "The folder to search under, as an absolute path such as /工作. Defaults to the whole netdisk.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "list_files",
    description:
      "List the files and folders in one folder of your Baidu Netdisk (百度网盘), most recently changed first.",
    inputSchema: {
      type: "object",
      properties: {
        dir: {
          type: "string",
          description:
            "The folder to list, as an absolute path such as /工作. Defaults to the top level.",
        },
      },
    },
  },
  {
    name: "get_file_metadata",
    description:
      "Get the name, path, size, type and last modified time for one file in your Baidu Netdisk, by its id.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: {
          type: "string",
          description: "The file's Baidu Netdisk id (fs_id).",
        },
      },
      required: ["fileId"],
    },
  },
  {
    name: "read_file_content",
    description:
      "Read the text of one text file (txt, md, csv, json and similar) in your Baidu Netdisk, by its id. Other files return their metadata only.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: {
          type: "string",
          description: "The file's Baidu Netdisk id (fs_id).",
        },
      },
      required: ["fileId"],
    },
  },
  {
    name: "get_account_info",
    description:
      "Say which Baidu account this netdisk belongs to, so an answer can name the account it came from.",
    inputSchema: { type: "object", properties: {} },
  },
]);

type Connection = { url: string; token?: string };

/** The list is this file, as it is for Drive, so listing needs nobody's credential. */
export const listNeedsCredential = false;

/** 这份清单就是本文件，所以每次启动都把保存的那份刷新到当前版本（见 `refreshOwnListings`）。 */
export const listIsThisCode = true;

export async function listTools(_connection: Connection): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

/**
 * Baidu's own error numbers, said in words. Only the ones a person can act on; anything else is
 * reported by its number, which is what Baidu's documentation is indexed by.
 */
const ERRNO_MESSAGES: Record<number, string> = {
  [-6]: "百度网盘不认这次的授权（身份验证失败）。请到「设置 › 已连接的账号」重新连接百度网盘。",
  111: "百度网盘的访问令牌已失效。请到「设置 › 已连接的账号」重新连接百度网盘。",
  [-7]: "这个文件或文件夹的名字不对，或者这个账号无权访问它。",
  [-9]: "百度网盘里找不到这个文件或文件夹。",
  31066: "百度网盘里找不到这个文件。",
  2: "百度网盘说这次请求的参数不对。",
  6: "这个百度网盘应用还不允许读取用户数据。请让管理员检查百度网盘开放平台上的应用权限。",
  31034: "百度网盘限制了请求频率，请稍后再试。",
};

/** `fs_id` as the digits Baidu sent, before `JSON.parse` can round a large one. */
function parseKeepingIds(text: string): unknown {
  return JSON.parse(text.replace(/"fs_id"\s*:\s*(\d+)/g, '"fs_id":"$1"'));
}

/** A transport error's message, with the token cut out in case the runtime quoted the address. */
function scrubbed(error: unknown, token: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(token).join("***");
}

type ApiResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; message: string };

/**
 * One xpan API request, with the caller's own token as Baidu wants it: in the query.
 *
 * Redirects are never followed — a default fetch would carry the token-bearing query to wherever a
 * Location pointed. The address itself never appears in what this returns.
 */
async function api(
  connection: Connection,
  path: string,
  query: Record<string, string>,
): Promise<ApiResult> {
  const token = connection.token;
  if (!token) {
    return { ok: false, message: "这次调用没有可用的凭据。" };
  }

  const url = new URL(`${connection.url.replace(/\/+$/, "")}${path}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("access_token", token);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "user-agent": BAIDU_USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error && error.name === "TimeoutError"
          ? "百度网盘未在规定时间内响应。"
          : `无法连接百度网盘：${scrubbed(error, token)}`,
    };
  }

  if (
    (response.status >= 300 && response.status < 400) ||
    response.type === "opaqueredirect"
  ) {
    await response.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      message: `百度网盘返回了重定向（${response.status}）。系统不跟随重定向，凭据未被转发。`,
    };
  }

  const text = await response.text().catch(() => "");
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = parseKeepingIds(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON. Said below by status, or as an unreadable answer.
  }

  // Baidu's number is the useful part whichever way the refusal arrived.
  const errno = typeof body?.errno === "number" ? body.errno : 0;
  if (!response.ok || errno !== 0) {
    const known = errno !== 0 ? ERRNO_MESSAGES[errno] : undefined;
    if (known) return { ok: false, message: `${known}（errno ${errno}）` };
    return {
      ok: false,
      message:
        errno !== 0
          ? `百度网盘拒绝了这次请求（errno ${errno}）。`
          : `百度网盘拒绝了这次请求（${response.status}）。`,
    };
  }
  if (!body) {
    return { ok: false, message: "百度网盘的回答不是可以读的内容。" };
  }
  return { ok: true, body };
}

type NetdiskFile = {
  fs_id?: string;
  path?: string;
  server_filename?: string;
  filename?: string;
  size?: number;
  server_mtime?: number;
  isdir?: number;
  category?: number;
  dlink?: string;
};

const filesOf = (body: Record<string, unknown>): NetdiskFile[] =>
  Array.isArray(body.list) ? (body.list as NetdiskFile[]) : [];

const nameOf = (file: NetdiskFile, fallback: string): string =>
  file.server_filename ??
  file.filename ??
  file.path?.split("/").pop() ??
  fallback;

/** Baidu's web page for the folder a file sits in, so an answer can carry a link a person opens. */
function folderLink(path: string | undefined): string | null {
  if (!path?.startsWith("/")) return null;
  const parent = path.slice(0, path.lastIndexOf("/")) || "/";
  return `https://pan.baidu.com/disk/main#/index?category=all&path=${encodeURIComponent(parent)}`;
}

/** One file as a line a model can quote, carrying the id every other tool here takes. */
function fileLine(file: NetdiskFile): string {
  const name = nameOf(file, "(未命名)");
  const parts: string[] = [file.isdir === 1 ? `${name}/` : name];
  if (file.path) parts.push(file.path);
  const link = folderLink(file.path);
  if (link) parts.push(`[打开所在文件夹](${link})`);
  if (file.isdir !== 1 && typeof file.size === "number") {
    parts.push(`${file.size} bytes`);
  }
  if (typeof file.server_mtime === "number") {
    parts.push(`modified ${new Date(file.server_mtime * 1000).toISOString()}`);
  }
  if (file.fs_id) parts.push(`id: ${file.fs_id}`);
  return `- ${parts.join(" · ")}`;
}

/**
 * Extensions whose bytes are text. An allow list, for the reason Drive's `isTextual` is one: an
 * unrecognised file decoded and hoped for reaches a model as mojibake that looks like content.
 */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "ndjson",
  "xml",
  "html",
  "htm",
  "yaml",
  "yml",
  "toml",
  "ini",
  "conf",
  "cfg",
  "log",
  "sql",
  "srt",
  "js",
  "ts",
  "py",
  "java",
  "go",
  "rs",
  "c",
  "h",
  "cpp",
  "sh",
]);

function isTextFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && TEXT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * Whether a download address is one this adapter will send a request to.
 *
 * The API's own origin (which in production is `https://pan.baidu.com`), or https on Baidu's
 * download hosts: `d.pcs.baidu.com`, which `dlink` names, and the `*.baidupcs.com` CDN it redirects
 * to. Anything else is somebody else's machine, whatever Baidu's answer said.
 */
function downloadAdmissible(target: URL, apiOrigin: string): boolean {
  if (target.origin === apiOrigin) return true;
  if (target.protocol !== "https:" || target.username || target.password) {
    return false;
  }
  const host = target.hostname.toLowerCase();
  return host === "d.pcs.baidu.com" || host.endsWith(".baidupcs.com");
}

/**
 * Fetch a `dlink`: the token on the first hop only, Baidu's agent on every hop, redirects followed
 * by hand and only to {@link downloadAdmissible} hosts.
 */
async function download(
  dlink: string,
  connection: Connection,
  token: string,
): Promise<{ ok: true; response: Response } | { ok: false; message: string }> {
  const apiOrigin = new URL(connection.url).origin;
  let target: URL;
  try {
    target = new URL(dlink);
  } catch {
    return { ok: false, message: "百度网盘给的下载地址不是一个地址。" };
  }
  if (!downloadAdmissible(target, apiOrigin)) {
    return {
      ok: false,
      message:
        "百度网盘给的下载地址不在百度的下载域名上，系统没有去取，凭据未被转发。",
    };
  }
  target.searchParams.set("access_token", token);

  for (let hop = 0; hop <= MAX_DOWNLOAD_HOPS; hop++) {
    let response: Response;
    try {
      response = await fetch(target, {
        headers: { "user-agent": BAIDU_USER_AGENT },
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof Error && error.name === "TimeoutError"
            ? "百度网盘的下载未在规定时间内响应。"
            : `无法从百度网盘下载：${scrubbed(error, token)}`,
      };
    }

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      let next: URL | null = null;
      try {
        next = location ? new URL(location, target) : null;
      } catch {
        next = null;
      }
      if (!next || !downloadAdmissible(next, apiOrigin)) {
        return {
          ok: false,
          message:
            "百度网盘的下载跳转到了百度下载域名以外的地方，系统没有跟随，凭据未被转发。",
        };
      }
      // The next hop is Baidu's CDN, which authorises by its own signed address, not by the token.
      next.searchParams.delete("access_token");
      target = next;
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        message: `百度网盘拒绝了这次下载（${response.status}）。`,
      };
    }
    return { ok: true, response };
  }

  return { ok: false, message: "百度网盘的下载跳转次数过多，系统已停止。" };
}

const failure = (message: string): McpCallResult => ({
  text: message,
  isError: true,
  truncated: false,
});

/** An absolute netdisk path a person or model typed, or null when it is not one. */
function dirArg(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const dir = value.trim();
  return dir.startsWith("/") && dir.length <= 1000 ? dir : null;
}

/** One file's metas, with or without a download address. */
async function metasFor(
  connection: Connection,
  fileId: string,
  withDlink: boolean,
): Promise<{ ok: true; file: NetdiskFile } | { ok: false; message: string }> {
  const result = await api(connection, "/multimedia", {
    method: "filemetas",
    fsids: `[${fileId}]`,
    dlink: withDlink ? "1" : "0",
    extra: "0",
  });
  if (!result.ok) return result;
  const file = filesOf(result.body)[0];
  if (!file) return { ok: false, message: "百度网盘里找不到这个文件。" };
  return { ok: true, file };
}

/**
 * Call one tool. Whether the call was permitted was decided before this module, as it is for Drive;
 * this dispatches and formats, and refuses a tool it does not implement rather than guessing.
 */
export async function callTool(
  connection: Connection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const stringArg = (key: string): string | null => {
    const value = args[key];
    return typeof value === "string" && value.trim() !== ""
      ? value.trim()
      : null;
  };
  const fileIdArg = (): string | null => {
    const value = args.fileId;
    const id =
      typeof value === "number" && Number.isSafeInteger(value)
        ? String(value)
        : stringArg("fileId");
    return id && /^\d{1,20}$/.test(id) ? id : null;
  };

  if (toolName === "search_files") {
    const query = stringArg("query");
    if (!query) return failure("搜索需要一个要找的词。");
    const dir = dirArg(args.dir);
    if (dir === null) return failure("文件夹要写成以 / 开头的完整路径。");

    const result = await api(connection, "/file", {
      method: "search",
      key: query,
      dir: dir ?? "/",
      recursion: "1",
      page: "1",
      num: String(PAGE_SIZE),
      web: "0",
    });
    if (!result.ok) return failure(result.message);
    return asResult(filesOf(result.body).map(fileLine).join("\n"));
  }

  if (toolName === "list_files") {
    const dir = dirArg(args.dir);
    if (dir === null) return failure("文件夹要写成以 / 开头的完整路径。");

    const result = await api(connection, "/file", {
      method: "list",
      dir: dir ?? "/",
      order: "time",
      desc: "1",
      start: "0",
      limit: String(PAGE_SIZE),
      web: "0",
    });
    if (!result.ok) return failure(result.message);
    return asResult(filesOf(result.body).map(fileLine).join("\n"));
  }

  if (toolName === "get_file_metadata") {
    const fileId = fileIdArg();
    if (!fileId) return failure("要查一个文件，需要它的数字 id（fs_id）。");
    const metas = await metasFor(connection, fileId, false);
    if (!metas.ok) return failure(metas.message);
    return asResult(fileLine(metas.file));
  }

  if (toolName === "read_file_content") {
    const fileId = fileIdArg();
    if (!fileId) return failure("要读一个文件，需要它的数字 id（fs_id）。");
    const token = connection.token;
    if (!token) return failure("这次调用没有可用的凭据。");

    const metas = await metasFor(connection, fileId, true);
    if (!metas.ok) return failure(metas.message);
    const file = metas.file;
    const name = nameOf(file, fileId);

    if (file.isdir === 1) {
      return failure(
        `${name} 是一个文件夹，不是文件。可以用 list_files 列出里面的内容。`,
      );
    }
    /*
     * Declined by name, as Drive declines a binary file: the metadata and a link a person can open
     * are worth more to a model than a decoded PDF or image.
     */
    if (!isTextFile(name)) {
      return failure(
        `${name} 不是这个连接器能按文本读取的文件类型。它的信息如下，需要的话请本人在百度网盘里打开：\n${fileLine(file)}`,
      );
    }
    if (!file.dlink) {
      return failure(`百度网盘没有给出 ${name} 的下载地址。`);
    }

    const content = await download(file.dlink, connection, token);
    if (!content.ok) return failure(content.message);

    const { text, cut } = await readOpening(content.response);
    return asResult(`${name}\n\n${text}`, cut);
  }

  if (toolName === "get_account_info") {
    const result = await api(connection, "/nas", { method: "uinfo" });
    if (!result.ok) return failure(result.message);
    const { baidu_name, netdisk_name, vip_type } = result.body;
    const lines = [
      typeof baidu_name === "string" && baidu_name
        ? `百度账号：${baidu_name}`
        : null,
      typeof netdisk_name === "string" && netdisk_name
        ? `网盘名称：${netdisk_name}`
        : null,
      typeof vip_type === "number"
        ? `会员类型：${vip_type === 2 ? "超级会员" : vip_type === 1 ? "普通会员" : "普通用户"}`
        : null,
    ];
    return asResult(lines.filter(Boolean).join("\n"));
  }

  return failure(
    `${toolName} 不是这个连接器提供的工具。保存的工具列表已经过时，请在「插件」页刷新。`,
  );
}
