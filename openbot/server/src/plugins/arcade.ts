/**
 * Arcade 传输层里与厂商无关的一半（上游 #770，fork X5 移植）。
 *
 * 不引入任何厂商包，也不引入 `./arcade-adapter`：adapter 引入这里，反过来就成了循环。
 * 这里的句子会出现在管理员页面、模型上下文和审计行里，所以一律是本部署自己写的中文句子，
 * 从不转述厂商的原话（厂商的 body 里可能带着授权链接和访问令牌）。
 */

import { cutAtCodeUnits } from "../channels/text";
import { appsPageZh } from "../edition";
import { flagOf } from "./broker";
import { type ListedTool, MAX_RESULT_CHARS, type McpCallResult } from "./mcp";
import { fitJsonResult } from "./result-fit";

/** 列工具不需要任何人的凭据：用的是部署自己的 Arcade key，清单不属于某个人。 */
export const listNeedsCredential = false;

const TOOLKIT_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * `arcade://Toolkit` 说的是哪个 toolkit。
 *
 * 大小写保留、不做任何规范化：Arcade 的 toolkit 和动作名区分大小写（`Gmail.ListEmails`），
 * `arcade://Gmail` 和 `arcade://gmail` 是两个应用。只认一个 toolkit：`arcade://Gmail/messages`
 * 不能回答 `Gmail/messages`，路径段不是应用。先 trim 再去掉结尾斜杠，与 `composio.ts` 一致。
 */
export function toolkitOf(url: string): string | null {
  const prefix = "arcade://";
  if (!url.startsWith(prefix)) return null;
  const name = url.slice(prefix.length).trim().replace(/\/+$/, "");
  return TOOLKIT_NAME.test(name) ? name : null;
}

/**
 * 一个动作做什么，读 `metadata.behavior`。先读 destructive，顺序就是决定：先读 read_only 会把两个
 * 标记都有的动作记成「读」，那是下游再也纠正不回来的方向。
 *
 * 没有 metadata、或标记读不懂（`flagOf` 答 null）、或 behavior 是空对象（两个标记都没说），都是
 * 「未分类的写」：按写操作先问，但不标成 destructive，因为厂商没这么说。
 */
export function classify(metadata: unknown): {
  effect: "read" | "write";
  destructive: boolean;
  /** Arcade 没有说任何能读懂的「这个动作做什么」。 */
  unclassified?: true;
} {
  const closed = {
    effect: "write",
    destructive: false,
    unclassified: true,
  } as const;
  if (typeof metadata !== "object" || metadata === null) return closed;
  const behavior = (metadata as { behavior?: unknown }).behavior;
  if (typeof behavior !== "object" || behavior === null) return closed;
  const flags = behavior as { destructive?: unknown; read_only?: unknown };
  const stated = (value: unknown) => value !== undefined && value !== null;
  if (!stated(flags.destructive) && !stated(flags.read_only)) return closed;
  const destructive = flagOf(flags.destructive, false);
  const readOnly = flagOf(flags.read_only, false);
  if (destructive === null || readOnly === null) return closed;
  if (destructive) return { effect: "write", destructive: true };
  if (readOnly) return { effect: "read", destructive: false };
  return { effect: "write", destructive: false };
}

/**
 * 这个传输层需要 Arcade 客户端做的事，仅此而已：`./arcade-adapter` 把 SDK 映射到它上面。
 * `listTools` 的查询类型没有 `user_id` 字段——清单不属于任何人。
 */
export type ArcadeActions = {
  listTools(q: {
    toolkit: string;
    limit: number;
    offset: number;
  }): Promise<{ items: unknown[]; total_count?: number }>;
  execute(r: {
    tool_name: string;
    input: Record<string, unknown>;
    user_id: string;
  }): Promise<{
    success?: boolean;
    output?: {
      value?: unknown;
      error?: { message?: string };
      authorization?: unknown;
    };
  }>;
};

let installed: ArcadeActions | null = null;

/** 装上（或用 `null` 卸下）Arcade 客户端。null 也是「没有配置」的状态。 */
export function useArcadeClient(client: ArcadeActions | null): void {
  installed = client;
}

export type ArcadeListedTool = ListedTool & { scopes: string[] };

const PAGE_SIZE = 100;
/** 防失控，不是上限：1000 页 × 100 远超任何一个 toolkit。 */
const MAX_PAGES = 1000;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 一个应该是某种形状的位置上来了什么，只说形状，不引用值。 */
export function shapeOf(value: unknown): string {
  if (Array.isArray(value)) return "a list";
  if (value === null || value === undefined) return "nothing";
  if (typeof value === "string" && value.trim() === "") return "a blank string";
  return `a ${typeof value}`;
}

/*
 * 厂商授权字段的唯一读法：缺失、读不懂、读到。
 *
 * 缺失（没有键、undefined、null）是厂商什么都没说，按字段文档的默认值；读不懂（有但形状不对，
 * 空白字符串也算）两种默认都不是，每个调用方都按关闭方向处理；读到的状态一律折叠大小写并 trim。
 */

/** 一个动作的 `requirements.authorization` 说了什么。 */
export type AuthorizationRequirement =
  | { kind: "none" }
  | {
      kind: "unreadable";
      field: "requirements" | "authorization";
      shape: string;
    }
  | { kind: "required"; authorization: Record<string, unknown> };

export function authorizationRequirementOf(
  item: unknown,
): AuthorizationRequirement {
  const requirements = record(item)?.requirements;
  if (requirements === undefined || requirements === null) {
    return { kind: "none" };
  }
  if (typeof requirements !== "object" || Array.isArray(requirements)) {
    return {
      kind: "unreadable",
      field: "requirements",
      shape: shapeOf(requirements),
    };
  }
  const authorization = (requirements as Record<string, unknown>).authorization;
  if (authorization === undefined || authorization === null) {
    return { kind: "none" };
  }
  if (typeof authorization !== "object" || Array.isArray(authorization)) {
    return {
      kind: "unreadable",
      field: "authorization",
      shape: shapeOf(authorization),
    };
  }
  return {
    kind: "required",
    authorization: authorization as Record<string, unknown>,
  };
}

/**
 * 一个动作要的 OAuth scopes（`requirements.authorization.oauth2.scopes`）。
 *
 * `[]` 是厂商的声明（连接本身就是授权），只在厂商真这么说时才回答；其他形状、或列表里混了
 * 非 scope 文本，都是 `unreadable`——把 `["repo", 5]` 读成 `["repo"]` 就是放宽了授权。
 */
export type ScopesRequirement =
  | { kind: "read"; scopes: string[] }
  | {
      kind: "unreadable";
      field: "requirements" | "authorization" | "oauth2" | "scopes";
      shape: string;
    };

export function requiredScopesOf(item: unknown): ScopesRequirement {
  const read = authorizationRequirementOf(item);
  if (read.kind === "none") return { kind: "read", scopes: [] };
  if (read.kind === "unreadable") return read;
  const oauth2 = read.authorization.oauth2;
  if (oauth2 === undefined || oauth2 === null) {
    return { kind: "read", scopes: [] };
  }
  if (typeof oauth2 !== "object" || Array.isArray(oauth2)) {
    return { kind: "unreadable", field: "oauth2", shape: shapeOf(oauth2) };
  }
  const scopes = (oauth2 as Record<string, unknown>).scopes;
  if (scopes === undefined || scopes === null) {
    return { kind: "read", scopes: [] };
  }
  if (!Array.isArray(scopes)) {
    return { kind: "unreadable", field: "scopes", shape: shapeOf(scopes) };
  }
  const odd = scopes.findIndex(
    (scope) => typeof scope !== "string" || scope.trim() === "",
  );
  if (odd !== -1) {
    return {
      kind: "unreadable",
      field: "scopes",
      shape: `a list holding ${shapeOf(scopes[odd])}`,
    };
  }
  return { kind: "read", scopes: scopes as string[] };
}

/** 一个厂商状态字段（`token_status`、`connection_status`、mint 或 flow 的 `status`）。 */
export type VendorStatus =
  | { kind: "absent" }
  | { kind: "unreadable"; shape: string }
  | { kind: "text"; text: string };

export function vendorStatusOf(value: unknown): VendorStatus {
  if (value === undefined || value === null) return { kind: "absent" };
  if (typeof value !== "string" || value.trim() === "") {
    return { kind: "unreadable", shape: shapeOf(value) };
  }
  return { kind: "text", text: value.trim().toLowerCase() };
}

/**
 * 网关要检查的 scopes。从不读 `requirements.met`：不带 `user_id` 问时它对所有人都答 true，
 * 读它等于把每个人都记成已连接。读不懂的 scopes 拒绝整份清单，从不当成 `[]`。
 */
function scopesOf(tool: Record<string, unknown>, toolkit: string): string[] {
  const read = requiredScopesOf(tool);
  if (read.kind === "read") return read.scopes;
  throw new Error(
    `Arcade 列出的 ${toolkit} 的一个动作，在授权要求的位置上是 ${read.shape}，读不出它需要哪些权限。读不懂不等于「不需要权限」，所以这次没有刷新，已记录的动作保持不变。`,
  );
}

function inputSchemaOf(input: unknown): Record<string, unknown> {
  const parameters = record(input)?.parameters;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const raw of Array.isArray(parameters) ? parameters : []) {
    const parameter = record(raw);
    if (!parameter || typeof parameter.name !== "string") continue;
    const valType = record(parameter.value_schema)?.val_type;
    properties[parameter.name] = {
      type: valType === "json" ? "object" : (valType ?? "string"),
      description:
        typeof parameter.description === "string" ? parameter.description : "",
    };
    if (parameter.required === true) required.push(parameter.name);
  }
  return { type: "object", properties, required };
}

/**
 * 一个 toolkit 的全部动作，读到底。不发送 `user_id`。
 *
 * 分页遇到短页才停，从不靠 `total_count`（它是可选的）；`total_count` 只作交叉核对，取所有页里
 * 报过的最大值，不取最后一页的。
 */
export async function listTools(connection: {
  url: string;
}): Promise<ArcadeListedTool[]> {
  const toolkit = toolkitOf(connection.url);
  if (!toolkit) {
    throw new Error(
      `${connection.url} 不是一个 Arcade toolkit 的地址，所以没有去问它提供什么。地址必须是 arcade:// 加 toolkit 名，请在${appsPageZh()}里改正。`,
    );
  }
  if (!installed) {
    throw new Error(
      `这个部署没有配置 Arcade，所以没法问 ${toolkit} 提供什么。已记录的动作保持不变，不会被清空。`,
    );
  }

  const raw: unknown[] = [];
  let total: number | undefined;
  let exhausted = true;
  for (let page = 0; page < MAX_PAGES; page++) {
    let answer: { items: unknown[]; total_count?: number };
    try {
      answer = await installed.listTools({
        toolkit,
        limit: PAGE_SIZE,
        offset: raw.length,
      });
    } catch (error) {
      // 本部署的句子，不是厂商的对象：SDK 的 APIError 用整个响应 body 拼 message。原错误留作 cause。
      throw new Error(listingSentence(toolkit), { cause: error });
    }
    const items = (answer as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) {
      throw new Error(
        `Arcade 没有回答 ${toolkit} 的动作列表。这次没有刷新，已记录的动作保持不变。`,
      );
    }
    raw.push(...items);
    if (typeof answer.total_count === "number") {
      total =
        total === undefined
          ? answer.total_count
          : Math.max(total, answer.total_count);
    }
    if (items.length < PAGE_SIZE) {
      exhausted = false;
      break;
    }
  }
  if (exhausted) {
    throw new Error(
      `Arcade 给 ${toolkit} 的列表翻了 ${MAX_PAGES} 页仍没有结束，不能当作这个应用的动作列表。这次没有刷新，已记录的动作保持不变。`,
    );
  }
  if (total !== undefined && raw.length < total) {
    throw new Error(
      `Arcade 只列出了 ${toolkit} 的 ${raw.length}/${total} 个动作，列表不完整。这次没有刷新，已记录的动作保持不变。`,
    );
  }

  return raw.flatMap((item) => {
    const tool = record(item);
    if (!tool || typeof tool.qualified_name !== "string") return [];
    const offerable = offerableName(tool.qualified_name, toolkit);
    if (offerable === null) return [];
    return [
      {
        name: offerable,
        // 厂商用来调用它的名字，记在本部署记录的名字旁边：执行时发这个，模型看到的是 `name`。
        vendorName: tool.qualified_name,
        description:
          typeof tool.description === "string" ? tool.description : "",
        inputSchema: inputSchemaOf(tool.input),
        ...classify(tool.metadata),
        scopes: scopesOf(tool, toolkit),
      },
    ];
  });
}

/**
 * Arcade 的 `qualified_name`（`Gmail.ListEmails`）里本部署记作动作名的部分。
 *
 * 点号在模型工具名里是非法字符，整个记进去会让模型 API 拒绝整个请求；toolkit 已经是 server id，
 * 前缀只会把应用名写两遍。只去掉厂商自己的前缀，剩下的为空才丢弃；其他认不出的名字留给
 * `storableTools` 的守卫逐个排除。
 */
function offerableName(qualifiedName: string, toolkit: string): string | null {
  const prefix = `${toolkit}.`;
  const bare = qualifiedName.toLowerCase().startsWith(prefix.toLowerCase())
    ? qualifiedName.slice(prefix.length)
    : qualifiedName;
  return bare.trim().length === 0 ? null : bare;
}

/** Arcade 的列表读不到时本部署说的话。从不是厂商的原话。 */
function listingSentence(toolkit: string): string {
  return `读不到 Arcade 给 ${toolkit} 的动作列表，所以这次没有刷新，已记录的动作保持不变。`;
}

/** 来自 Arcade 的失败，已由 `./arcade-adapter` 规范化并解开 cause。`name` 是响应 body 的 `error.name`。 */
export type ArcadeFailure = {
  status: number | undefined;
  name: string | undefined;
  message: string | undefined;
};

/**
 * Arcade 的拒绝，作为真正的 `Error`，带本部署的句子而不是厂商的。
 *
 * 裸对象不是理由（日志只会写出 `[object Object]`）；厂商的文字在这里丢掉——SDK 的 APIError 的
 * message 就是响应 body，授权路径上的 body 带着授权链接（持有即可用的凭证）和 `context.token`
 * （真实的访问令牌）。只保留 `status` 和 body 的 `error.name` 两个机器字段。
 */
export class ArcadeFailureError extends Error {
  readonly status: number | undefined;
  readonly failure: ArcadeFailure;
  constructor(sentence: string, failure: ArcadeFailure) {
    super(sentence);
    this.name = "ArcadeFailureError";
    this.status = failure.status;
    // 厂商的文字唯一不能通过的门，写在这里而不是每个构造点，后来的调用方忘了也传不出去。
    this.failure = {
      status: failure.status,
      name: failure.name,
      message: undefined,
    };
  }
}

/** 按 body 的 name 判断，从不按 403：被吊销的 key、停用的项目、限流也都是 403。 */
export function isAuthorizationRequired(failure: ArcadeFailure): boolean {
  return failure.name === "tool_authorization_required";
}

/** 按形状读抛出的值，不强转。{@link ArcadeFailureError} 先按类型认。 */
function arcadeFailure(thrown: unknown): ArcadeFailure | null {
  if (thrown instanceof ArcadeFailureError) return thrown.failure;
  const raw = record(thrown);
  if (!raw || typeof raw.name !== "string") return null;
  return {
    status: typeof raw.status === "number" ? raw.status : undefined,
    name: raw.name,
    message: typeof raw.message === "string" ? raw.message : undefined,
  };
}

/** 失败句子也过上限：它会进模型上下文，而且引用了厂商清单给的动作名。 */
function cap(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_RESULT_CHARS) return { text, truncated: false };
  return {
    text: `${cutAtCodeUnits(text, MAX_RESULT_CHARS)}\n\n[truncated]`,
    truncated: true,
  };
}

const failureResult = (text: string): McpCallResult => ({
  ...cap(text),
  isError: true,
});

/**
 * Arcade 不让这个账号执行这个动作：要么授权在那边没了，要么这个账号只授权了应用的其他动作。
 * 两种都用「连接」补齐，所以交给 store 去判断要不要结束这一行（`actionNotAllowed`）。
 */
const notAllowedResult = (toolName: string): McpCallResult => ({
  ...failureResult(`Arcade 不允许在这个账号上执行 ${toolName}。`),
  actionNotAllowed: true,
});

/**
 * 以连接的身份调用一个 Arcade 动作。
 *
 * 任何路径上句子里都没有链接：`authorization.url` 是持有即可用的凭证，从不给模型、不写日志、
 * 不进错误 body、不进审计。200 也不是安全的信封：`output.authorization` 和 403 带的是同一个
 * 东西，里面有链接和真实的访问令牌，所以只有 `output.value` 能进 `text`，信封从不整体序列化；
 * 带 `authorization` 的回答就是拒绝。`output.error` 只当布尔值读，厂商的文字不进 `text`。
 */
export async function callTool(
  connection: { url: string; actorId?: string },
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  if (!installed) {
    return failureResult(`这个部署没有配置 Arcade，所以没有执行 ${toolName}。`);
  }
  if (!connection.actorId) {
    return failureResult(`没有执行 ${toolName}：没有指明以哪个账号执行。`);
  }
  try {
    const answer = await installed.execute({
      tool_name: toolName,
      input: args,
      user_id: connection.actorId,
    });
    if (answer.output?.authorization) return notAllowedResult(toolName);
    if (answer.success === false || answer.output?.error) {
      return failureResult(`Arcade 没能执行 ${toolName}。`);
    }
    const value = JSON.stringify(answer.output?.value ?? null, null, 2);
    // 没有 JSON 形式的值（函数、symbol）让 stringify 答 undefined，而不是抛错。
    if (value === undefined) {
      return failureResult(
        `${toolName} 执行了，但它的结果没有 JSON 形式，没有可以展示的内容。`,
      );
    }
    return {
      ...fitJsonResult(answer.output?.value ?? null, value, toolName),
      isError: false,
    };
  } catch (thrown) {
    const failure = arcadeFailure(thrown);
    if (failure && isAuthorizationRequired(failure)) {
      return notAllowedResult(toolName);
    }
    return failureResult(`Arcade 没能执行 ${toolName}。`);
  }
}
