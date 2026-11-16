/**
 * 微信 ClawBot 接口实测探针。只用协议里的接口和请求头，不依赖任何第三方 SDK。
 * 用法见 `bun scripts/wechat-probe.ts --help` 和 docs/acceptance/wechat-probe.md。
 * 凭证写在本机 ~/.wechat-probe.json（权限 600），任何子命令都不打印 token。
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const DEFAULT_BASE = "https://ilinkai.weixin.qq.com";
/** 实测前的取值：npm 上 latest 的版本，前三段必须是上游插件版本。 */
const DEFAULT_CLIENT_VERSION = "2.4.10";
const STATE_PATH = join(homedir(), ".wechat-probe.json");

type State = {
  bot_token: string;
  ilink_bot_id: string;
  ilink_user_id: string;
  baseurl: string;
  clientVersion: string;
  /** listen 记下的最近一条入站，供 push 使用。 */
  lastFromUserId?: string;
  lastContextToken?: string;
  lastInboundAt?: string;
};

const HELP = `微信 ClawBot 实测探针

用法：bun wechat-probe.ts <子命令> [选项]

子命令：
  bind                     取二维码、等你扫码确认，把凭证写进 ${STATE_PATH}（权限 600，不打印 token）
  listen                   长轮询收消息，逐条打印并回「收到：<文本>」；Ctrl+C 退出
  push --after <分钟>      等指定分钟后不等入站直接发一条，打印 ret / errcode
  --help                   显示本说明

选项：
  --client-version <x.y.z> iLink-App-ClientVersion 用的版本（默认 ${DEFAULT_CLIENT_VERSION}），bind 时写入文件
  --base <url>             bind 用的基础地址（默认 ${DEFAULT_BASE}）
  --to <用户ID>            push 的收件人（默认取 listen 最近一条入站的发送者，再退到 ilink_user_id）
  --with-context           push 时带上 listen 记下的 context_token（默认不带，测纯主动推送）
  --text <文本>            push 发送的内容
  --debug                  listen 额外打印每条消息的字段名（不含 token 值）
`;

function parseArgs(argv: string[]) {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(name, next);
        i++;
      } else flags.set(name, true);
    } else positional.push(a);
  }
  return { flags, positional };
}

/** 0x00MMNNPP 编成十进制字符串。 */
export function encodeClientVersion(v: string): string {
  const m = /^[vV]?(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) throw new Error(`版本号格式不对：${v}`);
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return String(((maj & 0xff) << 16) | ((min & 0xff) << 8) | (pat & 0xff));
}

function appHeaders(clientVersion: string): Record<string, string> {
  return {
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": encodeClientVersion(clientVersion),
  };
}

function uin(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] as number;
  return Buffer.from(String(n)).toString("base64");
}

function postHeaders(clientVersion: string, token?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": uin(),
    ...appHeaders(clientVersion),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function baseInfo(clientVersion: string) {
  return { channel_version: clientVersion, bot_agent: "wechat-probe/0.1" };
}

function loadState(): State {
  if (!existsSync(STATE_PATH)) {
    console.error(`找不到 ${STATE_PATH}，请先运行 bind。`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
}

function saveState(s: State) {
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2), { mode: 0o600 });
  chmodSync(STATE_PATH, 0o600);
}

const stamp = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// biome-ignore lint/suspicious/noExplicitAny: 协议字段未全部证实，探针按宽松 JSON 处理
type Json = any;

async function bind(flags: Map<string, string | true>) {
  const base = String(flags.get("base") ?? DEFAULT_BASE).replace(/\/$/, "");
  const clientVersion = String(flags.get("client-version") ?? DEFAULT_CLIENT_VERSION);
  encodeClientVersion(clientVersion);

  const fetchQr = async (): Promise<Json> => {
    console.log(`[${stamp()}] 正在向 ${base} 申请二维码……`);
    let res: Response;
    try {
      res = await fetch(`${base}/ilink/bot/get_bot_qrcode?bot_type=3`, {
        method: "POST",
        headers: postHeaders(clientVersion),
        body: JSON.stringify({ local_token_list: [] }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new Error(
        `连不上微信接口（${e instanceof Error ? e.message : e}）。如果开着 VPN 或代理，请关掉或改成规则模式后重试。`,
      );
    }
    if (!res.ok) throw new Error(`get_bot_qrcode HTTP ${res.status}`);
    return res.json();
  };

  let qr = await fetchQr();
  const show = () => {
    console.log("\n请用微信扫描下面这个二维码地址对应的图片并确认：");
    console.log(qr.qrcode_img_content);
    console.log("（如果这是一个网页地址，用浏览器打开；如果是文本，请用任意二维码工具把它转成二维码再扫）\n");
  };
  show();

  let pollBase = base;
  let refreshes = 1;
  let pendingCode: string | undefined;
  let statusWarned = false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const q = new URLSearchParams({ qrcode: qr.qrcode });
      if (pendingCode) q.set("verify_code", pendingCode);
      let st: Json;
      try {
        const res = await fetch(`${pollBase}/ilink/bot/get_qrcode_status?${q}`, {
          headers: appHeaders(clientVersion),
          signal: AbortSignal.timeout(40_000),
        });
        if (res.ok) st = await res.json();
        else {
          if (!statusWarned) console.log(`[${stamp()}] get_qrcode_status 返回 HTTP ${res.status}，继续等待（只提示一次）`);
          statusWarned = true;
          st = { status: "wait" };
        }
      } catch {
        st = { status: "wait" };
      }
      const status = String(st.status ?? "wait");
      if (status !== "wait") console.log(`[${stamp()}] 状态：${status}`);
      if (status.includes("need_verifycode")) {
        pendingCode = (await rl.question("手机上显示了一串数字，请输入：")).trim();
      } else if (status === "scaned") {
        pendingCode = undefined;
      } else if (status === "scaned_but_redirect" && st.redirect_host) {
        pollBase = `https://${st.redirect_host}`;
      } else if (status === "binded_redirect") {
        console.log("返回 binded_redirect：这个微信已经绑定过，没有签发新凭证。请记入结果表。");
        return;
      } else if (status === "expired" || status === "verify_code_blocked") {
        if (++refreshes > 3) throw new Error("二维码多次过期，请稍后重新开始");
        pendingCode = undefined;
        qr = await fetchQr();
        show();
      } else if (status === "confirmed") {
        if (!st.bot_token || !st.ilink_bot_id || !st.ilink_user_id) {
          console.error(
            `confirmed 但响应缺少字段：bot_token=${st.bot_token ? "有" : "无"} ilink_bot_id=${st.ilink_bot_id ? "有" : "无"} ilink_user_id=${st.ilink_user_id ? "有" : "无"}（响应字段：${Object.keys(st).join(",")}）。没有写凭证文件。`,
          );
          process.exit(1);
        }
        const state: State = {
          bot_token: String(st.bot_token),
          ilink_bot_id: String(st.ilink_bot_id),
          ilink_user_id: String(st.ilink_user_id),
          baseurl: String(st.baseurl || base),
          clientVersion,
        };
        saveState(state);
        console.log(`绑定成功。ilink_bot_id=${state.ilink_bot_id} ilink_user_id=${state.ilink_user_id} baseurl=${state.baseurl}`);
        console.log(`凭证已写入 ${STATE_PATH}（权限 600，未显示 token）。`);
        return;
      }
      if (status === "wait") await sleep(500);
    }
  } finally {
    rl.close();
  }
}

async function api(s: State, path: string, body: Json, timeoutMs: number): Promise<Json> {
  const res = await fetch(`${s.baseurl.replace(/\/$/, "")}/ilink/bot/${path}`, {
    method: "POST",
    headers: postHeaders(s.clientVersion, s.bot_token),
    body: JSON.stringify({ ...body, base_info: baseInfo(s.clientVersion) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${path} 返回的不是 JSON`);
  }
}

async function sendText(s: State, to: string, text: string, contextToken?: string): Promise<Json> {
  return api(
    s,
    "sendmessage",
    {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: `probe-${crypto.randomUUID()}`,
        message_type: 2,
        message_state: 2,
        ...(contextToken ? { context_token: contextToken } : {}),
        item_list: [{ type: 1, text_item: { text } }],
      },
    },
    15_000,
  );
}

/** 宽松取文本：文本条目，其次语音转写，再退到任何 text 字段。 */
function extractText(msg: Json): string {
  const parts: string[] = [];
  for (const it of (msg.item_list ?? []) as Json[]) {
    const t = it?.text_item?.text ?? it?.voice_item?.text ?? it?.text;
    if (typeof t === "string") parts.push(t);
    else parts.push(`[type=${it?.type ?? "?"}]`);
  }
  return parts.join("");
}

function shape(v: Json, depth = 0): Json {
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1)] : [];
  if (v && typeof v === "object") {
    if (depth > 3) return "{…}";
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)]));
  }
  return typeof v;
}

async function listen(flags: Map<string, string | true>) {
  const s = loadState();
  if (typeof flags.get("client-version") === "string") s.clientVersion = String(flags.get("client-version"));
  const debug = flags.has("debug");
  let buf = "";
  let timeout = 35_000;
  console.log(`[${stamp()}] 开始监听，给「微信 ClawBot」发消息试试。Ctrl+C 退出。`);
  for (;;) {
    let r: Json;
    try {
      r = await api(s, "getupdates", { get_updates_buf: buf }, timeout + 10_000);
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) continue;
      console.log(`[${stamp()}] 请求失败：${e instanceof Error ? e.message : e}，5 秒后重试`);
      await sleep(5000);
      continue;
    }
    const ret = r.ret ?? 0;
    const errcode = r.errcode ?? 0;
    if (ret !== 0 || errcode !== 0) {
      console.log(`[${stamp()}] getupdates ret=${ret} errcode=${errcode} errmsg=${r.errmsg ?? ""}`);
      if (ret === -14 || errcode === -14) {
        console.log("微信要求暂停，1 小时后自动继续");
        for (let left = 60; left > 0; left -= 10) {
          console.log(`[${stamp()}] 还剩约 ${left} 分钟`);
          await sleep(10 * 60_000);
        }
      } else await sleep(5000);
      continue;
    }
    if (typeof r.get_updates_buf === "string" && r.get_updates_buf) buf = r.get_updates_buf;
    if (typeof r.longpolling_timeout_ms === "number" && r.longpolling_timeout_ms > 0) timeout = r.longpolling_timeout_ms;
    for (const m of (r.msgs ?? []) as Json[]) {
      if (m.message_type === 2) continue; // 自己发的
      const text = extractText(m);
      const id = m.message_id ?? m.seq ?? m.client_id ?? "(无)";
      const hasCtx = Boolean(m.context_token);
      console.log(
        `[${stamp()}] 入站 发送者=${m.from_user_id} 消息ID=${id}（字段：message_id=${m.message_id ?? "无"} seq=${m.seq ?? "无"} client_id=${m.client_id ?? "无"}） 带context_token=${hasCtx ? "是" : "否"} 文本=${JSON.stringify(text)}`,
      );
      if (debug) console.log(`  字段结构：${JSON.stringify(shape(m))}`);
      s.lastFromUserId = m.from_user_id;
      s.lastContextToken = m.context_token;
      s.lastInboundAt = stamp();
      saveState(s);
      try {
        const out = await sendText(s, String(m.from_user_id), `收到：${text}`, m.context_token);
        console.log(`[${stamp()}] 回复 ret=${out.ret ?? "(无)"} errcode=${out.errcode ?? "(无)"} errmsg=${out.errmsg ?? ""}`);
      } catch (e) {
        console.log(`[${stamp()}] 回复失败：${e instanceof Error ? e.message : e}`);
      }
    }
  }
}

async function push(flags: Map<string, string | true>) {
  const s = loadState();
  if (typeof flags.get("client-version") === "string") s.clientVersion = String(flags.get("client-version"));
  const after = Number(flags.get("after"));
  if (!Number.isFinite(after) || after < 0) {
    console.error("push 需要 --after <分钟>，例如 --after 60");
    process.exit(1);
  }
  const to = String(flags.get("to") ?? s.lastFromUserId ?? s.ilink_user_id);
  const ctx = flags.has("with-context") ? s.lastContextToken : undefined;
  const text = String(typeof flags.get("text") === "string" ? flags.get("text") : `主动推送测试 ${after} 分钟`);
  console.log(`[${stamp()}] 最近一条入站：${s.lastInboundAt ?? "(未记录，请先 listen 并发一条消息)"}`);
  console.log(`[${stamp()}] 等待 ${after} 分钟后发送（收件人 ${to}，${ctx ? "带" : "不带"} context_token）……`);
  await sleep(after * 60_000);
  try {
    const out = await sendText(s, to, text, ctx);
    console.log(`[${stamp()}] 发送结果 ret=${out.ret ?? "(无)"} errcode=${out.errcode ?? "(无)"} errmsg=${out.errmsg ?? ""}`);
    console.log("请看手机是否真的收到，并把「接口返回」和「手机是否收到」都记进结果表。");
  } catch (e) {
    console.log(`[${stamp()}] 发送失败：${e instanceof Error ? e.message : e}`);
  }
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  if (flags.has("help") || !cmd) {
    console.log(HELP);
  } else if (cmd === "bind") {
    await bind(flags);
  } else if (cmd === "listen") {
    await listen(flags);
  } else if (cmd === "push") {
    await push(flags);
  } else {
    console.error(`不认识的子命令：${cmd}\n`);
    console.log(HELP);
    process.exit(1);
  }
}

// 不用 import.meta.main 判断：Windows 上的 Bun 直接运行本文件时它可能为 false，导致什么都不输出。
await main();
