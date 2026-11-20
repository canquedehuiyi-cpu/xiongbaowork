/**
 * 对标评测的熊宝侧：起一个真熊宝（本地 server + 本地电脑 + PostgreSQL），逐题交给员工，等它做完，把员工
 * 工作区里的产物拷出来判分，并从运行事件里读出工作方式指标。
 *
 * 执行路径：看板派活（`POST /api/channels/:id/dispatch`）。
 *   只调对话 API 拿不到电脑工具——对话里的 `computer_*` 是前端工具，由浏览器里的页面去调电脑；没有页面
 *   就没有人执行。看板派活的那一轮在服务器上跑（与例行、群聊同一个无人值守的轮次执行器），电脑工具由服务器
 *   直接执行（`computer/headless-tools.ts`），所以员工能真的跑命令、读写文件；派活还会在看板上开一张卡，
 *   办公题要查的「等验收 + workspace_file 证据」就在这张卡上。用 Playwright 驱动真实聊天也能拿到电脑工具，
 *   但要先构建前端、再起浏览器，慢而且多一层会抖的界面，所以不选它。
 *   代价：服务器上的一轮最长 5 分钟（toolkit `TURN_LIMITS.turnTimeoutMs`），到点就被停。评测脚本在
 *   这一轮没做完（被停、触顶、产物缺）时以本人身份再派一句「继续」，最多 3 次，次数记在 `nudges` 里。
 *
 * 电脑：本地起 `agent-computer`（单镜像里 `EMBEDDED_COMPUTER=on` 时由 s6 起的就是它），服务器用
 * `AGENT_COMPUTER_URL` 连它，`TENANT_RUNTIME=cloud`。所有员工共用一个工作区根目录，题目放在
 * `eval/<题名>/`（冒烟场景放在 `smoke/<场景>/`），评测脚本直接从这个目录落夹具、拷产物。
 *
 * 每道题用一个新员工、一段新对话，题与题之间不共享上下文；员工的「危险命令先问」关掉（等同 Codex 的
 * approval_policy = never），其他权限保持默认。
 *
 * 两个套件：`EVAL_SUITE=tasks`（五道题，默认）和 `EVAL_SUITE=smoke`（能力冒烟，见 smoke.ts）。
 *
 * 两条执行路径（`EVAL_PATH=board|chat`，默认 board，行为不变）：
 *   chat  同样的题走单聊接口（期九·六）。服务器开着 `XIONGBAO_CHAT_SERVER_COMPUTER_TOOLS=on`，每道题给同一个
 *         新员工开一段单聊（`POST /api/channels` 拿到对话），客户端用 HTTP 发运行请求
 *         （运行接口 `POST …/agent/:id/run`，`forwardedProps.computerTools="server"`，和页面发的一样），读事件流
 *         到这一轮结束，不开浏览器；电脑工具由服务器执行。没做完时以本人身份在同一段对话里发「继续」，规则和
 *         看板路径的一样（最多 3 次，记在 `nudges`）。一轮在服务器上最长 25 分钟（toolkit
 *         `TURN_LIMITS.workTurnTimeoutMs`），比每题墙钟上限长，所以墙钟先到。拷产物、判分、算指标和看板路径是
 *         同一套代码；办公题里「任务卡进入等验收」只在看板路径查，单聊路径标为不适用，不算失败。
 *         结果写 `xiongbao-chat.json` / `smoke-chat.json`，产物拷进 `xiongbao-chat/`，`report.ts` 把两条路径并排出表。
 *   后台长跑冒烟 `disconnect` / `reconnect`（`EVAL_SUITE=smoke EVAL_TASKS=background`）只有单聊路径做得了，不管
 *         `EVAL_PATH` 一律走单聊接口：收到第一个工具调用后断开；disconnect 之后只轮询线程直到这一轮结束，
 *         reconnect 等 30 秒再用 `/agent/:id/connect` 重连。判分见 chat-path.ts。
 *
 * 环境变量（除 config.ts 里的门槛和模型参数外）：
 *   E2E_DATABASE_URL, E2E_ROLE_WRITER_DATABASE_URL   与 wakerflow-real-model.ts 相同
 *   EVAL_SUITE        tasks | smoke
 *   EVAL_PATH         board | chat，默认 board
 *   EVAL_TASKS        all（五道对标题）、hard（加难题）或逗号分隔的题名（smoke 套件里是场景名，另有 background）
 *   EVAL_TASK_MINUTES 每题墙钟上限，默认 20（冒烟场景用各自的上限）
 *   EVAL_OUT          结果目录，默认 ./employee-eval-out；写 xiongbao.json / smoke.json（chat 路径是 -chat 结尾）、产物和服务器日志
 *   E2E_SERVER_PORT   默认取空闲端口
 *   EVAL_MOCK_SCRIPT  只在本机假模型下：设 research 时假模型演「调研题」——一步接一步读十几 KB 的文字，看一轮里每步
 *                     发给模型的请求有多大（请求体存在 `<结果目录>/mock-requests/`）。EVAL_MOCK_STEPS、EVAL_MOCK_BYTES、
 *                     EVAL_MOCK_SCREENSHOTS（哪几步改成打开网页再截图，如 6,12）可调；见 mock-research.ts
 *   COMPUTER_BROWSER_MODE  传给本地电脑；没有虚拟显示的机器上设 headless
 *
 * 本机验证：EVAL_LOCAL_MOCK=1 MODEL_E2E=1 E2E_DATABASE_URL=… E2E_ROLE_WRITER_DATABASE_URL=… \
 *   bun scripts/e2e/employee-eval/run-xiongbao.ts
 * 假模型会让员工先列计划、跑一条命令读题、写一个占位文件、再跑一条校验命令，证明「员工真的调用了电脑工具，
 * 产物被拷出并送去判分」；判分结果不要求通过。单聊路径加 `EVAL_PATH=chat`；后台长跑冒烟的假模型一步一条
 * 慢命令（共 10 步、约 40 秒），让断开、轮询、重连、比对的逻辑真的跑到。
 *
 * 只打印计数、id 和状态：不打印 key、模型的回答或提供方的报错原文。
 */

import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import {
  CONNECT_PATH,
  connectRequest,
  fetchStoredMessages,
  openStream,
  RUN_PATH,
  runRequest,
  type Stream,
  type Streamed,
} from "../chat-client";
import {
  afterRound,
  artifactDirName,
  conversationWith,
  finishedCheck,
  limitStops,
  logFileName,
  noticeCheck,
  officeCardCheck,
  parseEvalPath,
  replayChecks,
  resultFileName,
  roundState,
  runnerLabel,
  transcriptChecks,
} from "./chat-path";
import { CHECKERS } from "./checkers";
import { evalGate, taskMinutes } from "./config";
import {
  type Check,
  check,
  copyTree,
  listFiles,
  materialize,
  result,
  selectTasks,
  TASK_TITLES,
  type TaskName,
  taskPrompt,
} from "./lib";
import {
  analyzeXiongbao,
  asksQuestion,
  callSeries,
  type Capabilities,
  featureProbe,
  lastAssistantText,
  NOT_APPLICABLE,
  observedFeatures,
  snapshotHasReasoning,
  snapshotMessages,
  TOOL,
  type ToolCall,
  toolCallsFromMessages,
  toolCallsOf,
  withObserved,
} from "./metrics";
import { type MockRequest, type MockTurn, startMockModel } from "./mock-model";
import { researchPolicy, researchScriptFrom } from "./mock-research";
import {
  type EvalPath,
  type EvalRecord,
  type EvalResults,
  writeResults,
} from "./records";
import {
  type BackgroundKind,
  placeSmoke,
  type SmokeScenario,
  selectSmoke,
} from "./smoke";

const ROOT = resolve(import.meta.dir, "../../..");
const SERVER_DIR = resolve(ROOT, "server");
const COMPUTER_DIR = resolve(ROOT, "agent-computer");
const MAX_NUDGES = 3;
const NUDGE =
  "继续完成上面交代的任务，直到要求全部做完；做完后自己核对一遍再结束。";

// ---------------------------------------------------------------------------------------------
// 门槛与配置
// ---------------------------------------------------------------------------------------------

const verdict = evalGate(process.env);
if (!verdict.ok) {
  console.error(`run-xiongbao refused: ${verdict.reason}`);
  process.exit(2);
}
const config = verdict.config;
delete process.env.MODEL_E2E_API_KEY;
const suite = process.env.EVAL_SUITE?.trim() === "smoke" ? "smoke" : "tasks";
let evalPath: EvalPath;
try {
  evalPath = parseEvalPath(process.env.EVAL_PATH);
} catch (error) {
  console.error(
    `run-xiongbao refused: ${error instanceof Error ? error.message : "bad EVAL_PATH"}`,
  );
  process.exit(2);
}
const databaseUrl = process.env.E2E_DATABASE_URL?.trim() ?? "";
const roleWriterDatabaseUrl =
  process.env.E2E_ROLE_WRITER_DATABASE_URL?.trim() ?? "";
if (!databaseUrl || !roleWriterDatabaseUrl) {
  console.error(
    "run-xiongbao refused: E2E_DATABASE_URL and E2E_ROLE_WRITER_DATABASE_URL are required",
  );
  process.exit(2);
}
const OUT = resolve(process.env.EVAL_OUT?.trim() || "employee-eval-out");
mkdirSync(OUT, { recursive: true });
const tasks: TaskName[] =
  suite === "tasks" ? selectTasks(process.env.EVAL_TASKS) : [];
const scenarios: SmokeScenario[] =
  suite === "smoke" ? selectSmoke(process.env.EVAL_TASKS) : [];
/** 这道题实际走的路径：后台长跑冒烟只有单聊路径做得了，不管 `EVAL_PATH`。 */
const pathOf = (scenario?: SmokeScenario): EvalPath =>
  scenario?.background ? "chat" : evalPath;
/** 服务器要不要开着「单聊的电脑工具由服务器执行」的部署开关。 */
const needsChat =
  evalPath === "chat" || scenarios.some((scenario) => scenario.background);
const minutes = taskMinutes(process.env);
const features = featureProbe(ROOT);

// ---------------------------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------------------------

async function until<T>(
  what: string,
  probe: () =>
    | Promise<T | undefined | null | false>
    | T
    | undefined
    | null
    | false,
  timeoutMs: number,
  everyMs = 1000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = (error instanceof Error ? error.message : "unknown").slice(0, 200);
    }
    if (Date.now() > deadline)
      throw new Error(
        `Timed out after ${timeoutMs} ms waiting for ${what}${last ? ` (${last})` : ""}`,
      );
    await Bun.sleep(everyMs);
  }
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port as number;
  probe.stop(true);
  return port;
}

// ---------------------------------------------------------------------------------------------
// 本机假模型（只在 EVAL_LOCAL_MOCK=1 时）
// ---------------------------------------------------------------------------------------------

/**
 * 不懂题目，只按固定节奏动手：列计划 → 跑命令读题 → 写占位文件 → 跑校验命令 → 计划打勾 → 收尾。
 * 题目目录从交代里认（`eval/<题>` 或 `smoke/<场景>`）。
 */
const researchScript = researchScriptFrom(process.env);
function mockPolicy(request: MockRequest): MockTurn {
  // `EVAL_MOCK_SCRIPT=research`：一步接一步读大段文字，看一轮里每步的请求有多大。
  if (researchScript)
    return researchPolicy(request, researchScript, `${mock?.url}/page`);
  const dir = /((?:eval|smoke)\/[a-z-]+)/.exec(request.lastUser)?.[1] ?? "eval";
  const done = request.toolResultsSinceUser;
  // 冒烟「长任务」：一步一条命令，追加 1..55，用来在本机走一遍触顶与续跑。
  const long = /单独\*{0,2}调用一次命令工具/.exec(request.lastUser);
  if (long) {
    const count = Number(/1 到 (\d+)/.exec(request.lastUser)?.[1] ?? "55");
    return done < count
      ? {
          tools: [
            {
              name: TOOL.command,
              arguments: { command: `echo ${done + 1} >> ${dir}/log.txt` },
            },
          ],
        }
      : { text: `已追加 ${count} 行（假模型）。` };
  }
  // 后台长跑冒烟：一步一条慢命令（每条 sleep 4 秒），共 10 步、约 40 秒，断开和重连都落在中途。
  if (/smoke\/(?:disconnect|reconnect)/.test(request.lastUser)) {
    const steps = 10;
    return done < steps
      ? {
          tools: [
            {
              name: TOOL.command,
              arguments: {
                command: `sleep 4 && echo step-${done + 1} >> ${dir}/progress.log`,
              },
            },
          ],
        }
      : { text: `已走完 ${steps} 步（假模型）。` };
  }
  const planned = request.offeredTools.includes(TOOL.plan);
  const plan = (status: "pending" | "done") => ({
    name: TOOL.plan,
    arguments: {
      items: [
        { text: "读题", status: status === "done" ? "done" : "in_progress" },
        { text: "写产物", status },
      ],
    },
  });
  const steps: MockTurn[] = [
    {
      tools: [
        ...(planned ? [plan("pending")] : []),
        {
          name: TOOL.command,
          arguments: { command: `ls -la ${dir} && cat ${dir}/TASK.md || true` },
        },
      ],
    },
    {
      tools: [
        {
          name: TOOL.write,
          arguments: {
            path: `${dir}/mock-output.md`,
            contents: "假模型写下的占位产物\n",
          },
        },
      ],
    },
    {
      tools: [
        {
          name: TOOL.command,
          arguments: {
            command: `test -f ${dir}/mock-output.md && echo checked-by-mock`,
          },
        },
      ],
    },
    ...(planned ? [{ tools: [plan("done")] }] : []),
    { text: "做完了：占位产物已写好并核对过（假模型）。" },
  ];
  // 第一步可能一次发两个工具调用，之后每步一个：按已收到的结果数算走到了第几步。
  const first = planned ? 2 : 1;
  const index = done === 0 ? 0 : 1 + Math.max(0, done - first);
  return steps[Math.min(index, steps.length - 1)] as MockTurn;
}

let deploymentHits = 0;
const deploymentStub = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    if (!/\/models\/?$/.test(new URL(request.url).pathname))
      deploymentHits += 1;
    return new Response(null, { status: 503 });
  },
});
/**
 * 假模型收到的每一步请求体原样存进 `<结果目录>/mock-requests/`：系统提示、工具定义、历史消息都在里面，
 * `token-breakdown.ts --requests <目录>` 按它算每一步各部分占多少 token。只在本机假模型模式下写。
 */
let mockRequestCount = 0;
function keepMockRequest(request: MockRequest) {
  mockRequestCount += 1;
  const dir = join(OUT, "mock-requests");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${String(mockRequestCount).padStart(3, "0")}.json`),
    `${JSON.stringify(request.raw)}\n`,
  );
}
const mock = config.mock
  ? startMockModel((request) => {
      keepMockRequest(request);
      return mockPolicy(request);
    })
  : null;
const providerBaseUrl = mock ? `${mock.url}/v1` : config.baseUrl;

// ---------------------------------------------------------------------------------------------
// 电脑和服务器
// ---------------------------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "xiongbao-eval-"));
const WORKSPACE = join(scratch, "workspace");
mkdirSync(WORKSPACE, { recursive: true });
mkdirSync(join(scratch, "profiles"), { recursive: true });
const COMPUTER_TOKEN = randomBytes(24).toString("hex");
const COMPUTER_PORT = await freePort();
const PORT = Number(process.env.E2E_SERVER_PORT?.trim() || (await freePort()));
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ADMIN_EMAIL = `eval-${randomUUID().slice(0, 8)}@example.test`;

let computer: Subprocess | undefined;
let server: Subprocess | undefined;

function logFile(name: string): number {
  return openSync(join(OUT, name), "w");
}

async function startComputer() {
  const fd = logFile(logFileName("computer", evalPath));
  computer = Bun.spawn(["bun", "src/index.ts"], {
    cwd: COMPUTER_DIR,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "/tmp",
      PORT: String(COMPUTER_PORT),
      WORKSPACE_DIR: WORKSPACE,
      PROFILES_DIR: join(scratch, "profiles"),
      COMPUTER_TOKEN,
      ...(process.env.PLAYWRIGHT_BROWSERS_PATH
        ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }
        : {}),
      // 没有虚拟显示的机器上，本机验证可以设 headless。
      ...(process.env.COMPUTER_BROWSER_MODE
        ? { COMPUTER_BROWSER_MODE: process.env.COMPUTER_BROWSER_MODE }
        : {}),
    },
    stdout: fd,
    stderr: fd,
  });
  closeSync(fd);
  await until(
    "the computer to answer",
    async () => {
      if (computer?.exitCode !== null)
        throw new Error(`computer exited ${computer?.exitCode}`);
      const response = await fetch(`http://127.0.0.1:${COMPUTER_PORT}/exec`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${COMPUTER_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ command: "echo ready" }),
        signal: AbortSignal.timeout(3000),
      });
      return response.status === 200;
    },
    90_000,
    500,
  );
  console.log(`   computer on :${COMPUTER_PORT}, workspace ${WORKSPACE}`);
}

async function startServer() {
  const fd = logFile(logFileName("server", evalPath));
  server = Bun.spawn(["bun", "src/index.ts"], {
    cwd: SERVER_DIR,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "/tmp",
      NODE_ENV: "test",
      PORT: String(PORT),
      DATABASE_URL: databaseUrl,
      ROLE_WRITER_DATABASE_URL: roleWriterDatabaseUrl,
      KEY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      BETTER_AUTH_URL: ORIGIN,
      OPENBOT_PUBLIC_URL: ORIGIN,
      INITIAL_ADMIN_EMAILS: ADMIN_EMAIL,
      INTELLIGENCE_MODE: "local",
      TENANT_PACKAGE_DIR: "../examples/xiongbao",
      TENANT_RUNTIME: "cloud",
      EMBEDDED_COMPUTER: "on",
      // 单聊路径：带了 computerTools=server 的运行才由服务器执行电脑工具，部署开关要开着（默认关）。
      ...(needsChat ? { XIONGBAO_CHAT_SERVER_COMPUTER_TOOLS: "on" } : {}),
      AGENT_COMPUTER_URL: `http://127.0.0.1:${COMPUTER_PORT}`,
      COMPUTER_TOKEN,
      // 部署自己的模型是个只回 503 的桩：所有模型调用都必须走员工绑定的模型库条目（结束时断言）。
      OPENAI_BASE_URL: `http://127.0.0.1:${deploymentStub.port}/v1`,
      OPENAI_API_KEY: "eval-deployment-stub-not-a-secret",
      COPILOTKIT_TELEMETRY_DISABLED: "true",
      DO_NOT_TRACK: "1",
      // 假模型在回环地址上讲明文 http，只有这个模式才打开开发用的开关；真模型下 SSRF 防护保持全开。
      ...(config.mock ? { AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true" } : {}),
    },
    stdout: fd,
    stderr: fd,
  });
  closeSync(fd);
  await until(
    "the server /health",
    async () => {
      if (server?.exitCode !== null)
        throw new Error(`server exited ${server?.exitCode}`);
      const response = await fetch(`${ORIGIN}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.status === 200;
    },
    120_000,
    500,
  );
  console.log(`   server on ${ORIGIN}`);
}

async function stop(process_: Subprocess | undefined) {
  if (!process_ || process_.exitCode !== null) return;
  process_.kill("SIGTERM");
  const exited = await Promise.race([
    process_.exited.then(() => true),
    Bun.sleep(10_000).then(() => false),
  ]);
  if (!exited) {
    process_.kill("SIGKILL");
    await process_.exited;
  }
}

// ---------------------------------------------------------------------------------------------
// API（带注册时拿到的会话 cookie）
// ---------------------------------------------------------------------------------------------

const cookies = new Map<string, string>();

async function api<T = Record<string, unknown>>(
  method: "GET" | "POST" | "PUT" | "PATCH",
  path: string,
  data?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      ...(cookies.size
        ? {
            cookie: [...cookies]
              .map(([name, value]) => `${name}=${value}`)
              .join("; "),
          }
        : {}),
      ...(data === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(30_000),
  });
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";")[0] ?? "";
    const at = pair.indexOf("=");
    if (at > 0) cookies.set(pair.slice(0, at), pair.slice(at + 1));
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: response.status, body: body as T };
}

function must(
  response: { status: number; body: unknown },
  expected: number[],
  what: string,
) {
  if (!expected.includes(response.status)) {
    const error = (response.body as { error?: unknown } | null)?.error;
    throw new Error(
      `${what}: HTTP ${response.status}${typeof error === "string" ? ` ${error.slice(0, 120)}` : ""}`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// 以租户身份读库：运行事件和 token 计量
// ---------------------------------------------------------------------------------------------

const { createDatabase } = await import("../../../server/src/db/client");
const schema = await import("../../../server/src/db/schema");
const { runAsTenant } = await import("../../../server/src/tenant/context");
const database = createDatabase(databaseUrl, { max: 2 });
let tenant = "";

type AgUiEvent = Record<string, unknown> & { type?: string };

async function eventsOf(runIds: string[]): Promise<AgUiEvent[]> {
  if (!runIds.length) return [];
  // 读整张表再在这里筛：评测库是一次性的，行数很少；这样也不必在脚本里引数据库查询库。
  const rows = await runAsTenant(tenant, () =>
    database
      .select({
        runId: schema.threadRunEvents.runId,
        seq: schema.threadRunEvents.seq,
        event: schema.threadRunEvents.event,
      })
      .from(schema.threadRunEvents),
  );
  return runIds.flatMap((runId) =>
    rows
      .filter((row) => row.runId === runId)
      .sort((a, b) => a.seq - b.seq)
      .map(
        (row) =>
          (typeof row.event === "string"
            ? JSON.parse(row.event)
            : row.event) as AgUiEvent,
      ),
  );
}

/**
 * 这几轮运行在库里留下的头信息和对话快照：每轮应有几条事件（`thread_runs.event_count`）、实际存下几条，以及
 * 这条对话最新的消息快照。事件整批没存进库时（见 metrics.ts 的 `toolCallsFromMessages`），工具调用改从快照读。
 */
async function storedRuns(runIds: string[]) {
  if (!runIds.length) return { expected: 0, messages: [] as unknown[] };
  const runs = await runAsTenant(tenant, () =>
    database
      .select({
        id: schema.threadRuns.id,
        threadId: schema.threadRuns.threadId,
        eventCount: schema.threadRuns.eventCount,
      })
      .from(schema.threadRuns),
  );
  const mine = runs.filter((run) => runIds.includes(run.id));
  const threadIds = new Set(mine.map((run) => run.threadId));
  const threads = await runAsTenant(tenant, () =>
    database
      .select({
        id: schema.threads.id,
        messages: schema.threads.messagesSnapshot,
      })
      .from(schema.threads),
  );
  return {
    expected: mine.reduce((total, run) => total + run.eventCount, 0),
    messages: threads
      .filter((thread) => threadIds.has(thread.id))
      .flatMap((thread) => snapshotMessages(thread.messages)),
  };
}

async function tokenRows(agentId: string, since: Date) {
  const rows = await runAsTenant(tenant, () =>
    database.select().from(schema.modelTokenCalls),
  );
  return rows.filter(
    (row) =>
      row.agentId === agentId &&
      new Date(row.startedAt).getTime() >= since.getTime() - 1000,
  );
}

/** 一段对话下的全部运行（含审批、续接带出来的），按开始时间从早到晚。 */
async function runsOfThread(threadId: string) {
  const rows = await runAsTenant(tenant, () =>
    database
      .select({
        id: schema.threadRuns.id,
        threadId: schema.threadRuns.threadId,
        createdAt: schema.threadRuns.createdAt,
      })
      .from(schema.threadRuns),
  );
  return rows
    .filter((row) => row.threadId === threadId)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/**
 * 一轮在库里的状态：`running`（心跳还在）、`finished`、`interrupted`；一次写完的轮没有活性行，读作 `finished`；
 * 运行记录还没出现读作 undefined。
 */
async function turnStatus(runId: string): Promise<string | undefined> {
  const live = await runAsTenant(tenant, () =>
    database
      .select({
        runId: schema.threadRunLiveness.runId,
        status: schema.threadRunLiveness.status,
      })
      .from(schema.threadRunLiveness),
  );
  const row = live.find((item) => item.runId === runId);
  if (row) return row.status;
  const runs = await runAsTenant(tenant, () =>
    database.select({ id: schema.threadRuns.id }).from(schema.threadRuns),
  );
  return runs.some((run) => run.id === runId) ? "finished" : undefined;
}

/** 这个人的 `reply` 发件箱行：完成通知（九·五）按推送设备各记一条，去重键 `reply:turn-end:<运行>:…`。 */
async function replyOutbox() {
  const rows = await runAsTenant(tenant, () =>
    database
      .select({
        dedupeKey: schema.deliveryOutbox.dedupeKey,
        kind: schema.deliveryOutbox.kind,
        state: schema.deliveryOutbox.state,
        ownerUserId: schema.deliveryOutbox.ownerUserId,
      })
      .from(schema.deliveryOutbox),
  );
  return rows.filter((row) => row.ownerUserId === tenant);
}

/**
 * 给本人记一个推送设备（假的令牌）：完成通知只有在本人有地方可发（推送设备、绑定的聊天平台）时才记发件箱行，
 * 评测账号什么都没有，没有它就没有「通知记录」可查。只写这一行，不配推送服务，所以不会真的往外发。
 */
async function registerStandInDevice() {
  await runAsTenant(tenant, () =>
    database.insert(schema.pushDevices).values({
      id: randomUUID(),
      ownerUserId: tenant,
      token: `ExponentPushToken[eval-${randomUUID().replaceAll("-", "")}]`,
      projectId: randomUUID(),
      platform: "android",
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// 一道题
// ---------------------------------------------------------------------------------------------

let modelRef = "";
let firstAgent = "";

async function newEmployee(label: string): Promise<string> {
  const fields = {
    name: `评测员工·${label}`,
    title: "全能员工",
    roleDescription: "把交代的工作一次做完：先想清楚，动手做，做完自己核对。",
    visibility: "private",
  };
  const created = await api<{ agent: { id: string } }>(
    "POST",
    "/api/agents",
    fields,
  );
  if (created.status === 402 && firstAgent) return firstAgent;
  must(created, [201], "create employee");
  const id = created.body.agent.id;
  must(
    await api("PATCH", `/api/agents/${id}`, { ...fields, modelRef }),
    [200],
    "bind the model",
  );
  // 等同 Codex 的 approval_policy = never：危险命令不再先问（其他权限照旧）。
  const security = await api(
    "PATCH",
    `/api/approvals/employees/${id}/security`,
    {
      dangerousCommands: "off",
      sensitivePaths: "ask",
      extraSensitivePaths: [],
      disabledDefaultPaths: [],
    },
  );
  if (security.status !== 200)
    console.log(
      `   (security settings left at defaults: HTTP ${security.status})`,
    );
  if (!firstAgent) firstAgent = id;
  return id;
}

type Card = {
  id: string;
  status: string;
  runRef: string | null;
  executorAgentId: string | null;
  deliverableRef: { workspaceFiles?: string[] } | null;
  updatedAt?: string;
};

async function cards(): Promise<Card[]> {
  const response = await api<{ tasks: Card[] }>("GET", "/api/tasks");
  return response.status === 200 ? response.body.tasks : [];
}

/** 一轮是否结束：运行事件里有 RUN_FINISHED / RUN_ERROR，或卡片离开「进行中」。 */
async function roundEnded(runId: string): Promise<boolean> {
  const events = await eventsOf([runId]);
  if (
    events.some(
      (event) => event.type === "RUN_FINISHED" || event.type === "RUN_ERROR",
    )
  )
    return true;
  // 卡片离开「进行中」也算：等批准（needs_action）时这一轮已经停下，再等也不会动。
  const card = (await cards()).find((item) => item.runRef === runId);
  return Boolean(card && card.status !== "running");
}

type Work = {
  key: string;
  title: string;
  label: string;
  where: string;
  prompt: string;
  minutes: number;
  /** 这道题走哪条路径（后台长跑冒烟一律单聊）。 */
  via: EvalPath;
  /** 后台长跑冒烟：中途断开 / 重连，见 smoke.ts。 */
  background?: BackgroundKind;
  /** 产物都在不在（决定要不要追「继续」）。 */
  outputsReady: (dir: string) => boolean;
  judge: (
    dir: string,
    context: {
      capabilities: Capabilities;
      events: AgUiEvent[];
      calls: ToolCall[];
      agentId: string;
      since: Date;
    },
  ) => Promise<{ passed: boolean; checks: Check[]; skipped?: string }>;
  editsData: boolean;
};

const OUTPUTS: Record<TaskName, string[]> = {
  research: ["research.md"],
  docs: ["README.md"],
  code: ["src/duration.ts"],
  data: ["summary.csv"],
  office: ["actions.csv"],
  compare: ["compare.md"],
};

/** 一道题交给员工、等它做完之后的结果：用到的运行、追了几次「继续」、有没有超时，和路径自己的几项判分。 */
type Driven = {
  /** 看板路径是派活时拿到的运行号；单聊路径在 {@link runsOf} 里按对话读。 */
  runIds: string[];
  nudges: number;
  timedOut: boolean;
  error?: string;
  /** 这条路径自己的判分项（后台长跑冒烟的断开 / 重连判断），并进这道题的检查里。 */
  checks?: Check[];
  /** 单聊路径：这道题的对话，运行号从这里读（含审批、续接带出来的运行）。 */
  threadId?: string;
  /** 单聊路径：事件流中途被服务器断开、又用 `/connect` 接上的次数。 */
  rejoins?: number;
  /** 单聊路径：发出去的运行请求数。一轮的运行记录在这一轮结束后才写进库，读之前要等它们到齐。 */
  sent?: number;
};

/** 看板路径：派活 → 等这一轮结束 → 没做完就以本人身份再派一句「继续」。 */
async function driveBoard(
  work: Work,
  agentId: string,
  deadline: number,
  dir: string,
): Promise<Driven> {
  const channel = await api<{ channel: { id: string } }>(
    "POST",
    "/api/channels",
    { agentIds: [agentId] },
  );
  must(channel, [201], "create channel");
  const channelId = channel.body.channel.id;

  const runIds: string[] = [];
  let nudges = 0;
  let timedOut = false;
  let error: string | undefined;
  try {
    for (let round = 0; round <= MAX_NUDGES; round += 1) {
      const dispatched = await api<{ runId: string; taskId: string }>(
        "POST",
        `/api/channels/${channelId}/dispatch`,
        {
          id: randomUUID(),
          agentId,
          text: round === 0 ? work.prompt : NUDGE,
        },
      );
      must(dispatched, [200, 201, 202], "dispatch");
      const runId = dispatched.body.runId;
      runIds.push(runId);
      if (round > 0) nudges += 1;
      const remaining = deadline - Date.now();
      try {
        await until(
          `round ${round + 1} of ${work.key}`,
          () => roundEnded(runId),
          Math.max(remaining, 1000),
          2000,
        );
      } catch {
        timedOut = true;
        break;
      }
      const events = await eventsOf([runId]);
      const failed = events.some((event) => event.type === "RUN_ERROR");
      const limited = events.some(
        (event) => event.type === "CUSTOM" && event.name === "step-limit",
      );
      if (work.outputsReady(dir) && !failed && !limited) break;
      if (Date.now() > deadline - 30_000) {
        timedOut = !work.outputsReady(dir);
        break;
      }
      console.log(
        `   round ${round + 1} ended ${failed ? "with an error" : limited ? "at the step limit" : "without the outputs"}; nudging`,
      );
    }
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  }
  return { runIds, nudges, timedOut, ...(error ? { error } : {}) };
}

// ---------------------------------------------------------------------------------------------
// 单聊路径：HTTP 发运行请求、读事件流，不开浏览器
// ---------------------------------------------------------------------------------------------

const cookieHeader = () =>
  [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
const openChatStream = (path: string, payload: unknown) =>
  openStream(ORIGIN, cookieHeader(), path, payload);
const storedMessagesOf = (agentId: string, threadId: string) =>
  fetchStoredMessages(ORIGIN, cookieHeader(), agentId, threadId);

/**
 * 把一轮的事件流读到结束，结束的判断照 background-chat：流以服务器关闭收尾，里面有 RUN_FINISHED / RUN_ERROR。
 *
 * 流断了却没有结束事件、而服务器上的这一轮还在跑，就用 `/connect` 接着读：连接回放这一轮到目前为止的全部事件，
 * 再接上直播，所以最后一条流里是这一轮完整的事件。服务器对一条 10 秒没出声的连接会关掉它（Bun.serve 的默认
 * 空闲超时），工具静默跑得久（装依赖、跑测试）时这很常见；这一轮不受影响，只是客户端要再连一次。
 * 读到墙钟上限还没结束：挂断（服务器上的这一轮不受影响），记为超时。
 */
async function readRound(
  stream: Stream,
  agentId: string,
  threadId: string,
  deadline: number,
): Promise<{ events: Streamed[]; timedOut: boolean; rejoins: number }> {
  let current = stream;
  let rejoins = 0;
  for (;;) {
    try {
      const events = await current.done(Math.max(deadline - Date.now(), 1000));
      if (roundState(events).ended) return { events, timedOut: false, rejoins };
    } catch (error) {
      // 墙钟到了还没读完：挂断，记超时。其他读错误（连接被断开）当作流中途关了，往下看这一轮还在不在跑。
      if (
        /^Timed out after/.test(error instanceof Error ? error.message : "")
      ) {
        current.hangUp();
        return { events: current.events, timedOut: true, rejoins };
      }
    }
    if (roundState(current.events).ended)
      return { events: current.events, timedOut: false, rejoins };
    const latest = (await runsOfThread(threadId)).at(-1);
    const status = latest ? await turnStatus(latest.id) : undefined;
    // 运行记录最迟几秒后写进库：还没有记录的头几次也当作在跑。
    const running =
      status === "running" || (status === undefined && rejoins < 3);
    if (!running) return { events: current.events, timedOut: false, rejoins };
    if (Date.now() >= deadline) {
      current.hangUp();
      return { events: current.events, timedOut: true, rejoins };
    }
    rejoins += 1;
    await Bun.sleep(500);
    current = await openChatStream(
      CONNECT_PATH(agentId),
      connectRequest(threadId),
    );
  }
}

/** 一条流上等第一个电脑工具调用；流在它出现前断了就用 `/connect` 重连再等。返回见到它的那条流。 */
async function untilFirstComputerCall(
  stream: Stream,
  agentId: string,
  threadId: string,
  limitMs: number,
): Promise<Stream> {
  const limitAt = Date.now() + limitMs;
  let current = stream;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await current.next(
        (event) =>
          event.type === "TOOL_CALL_START" &&
          String(event.toolCallName).startsWith("computer_"),
        Math.max(limitAt - Date.now(), 1000),
      );
      return current;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/^Timed out after/.test(message) || attempt >= 5) throw error;
      current.hangUp();
      await Bun.sleep(500);
      current = await openChatStream(
        CONNECT_PATH(agentId),
        connectRequest(threadId),
      );
    }
  }
}

/** 等这一轮在库里结束（线程轮询：不连事件流）。超时返回 undefined。 */
async function untilTurnEnds(
  threadId: string,
  limitMs: number,
): Promise<string | undefined> {
  return until(
    "the turn to end",
    async () => {
      const latest = (await runsOfThread(threadId)).at(-1);
      const status = latest ? await turnStatus(latest.id) : undefined;
      return status && status !== "running" ? status : false;
    },
    limitMs,
    3000,
  ).catch(() => undefined);
}

/** 重连前断开多久（规格：30 秒）。 */
const RECONNECT_AFTER_MS = 30_000;
/** 断开后等这一轮结束的上限（规格：例如 12 分钟）。 */
const POLL_LIMIT_MS = 12 * 60_000;
const FIRST_CALL_WAIT_MS = 5 * 60_000;

/**
 * 后台长跑冒烟：收到第一个电脑工具调用后断开。
 *  disconnect：之后只轮询线程，直到这一轮结束；判线程里的调用和结果、这一轮以完成结束、完成通知记录。
 *  reconnect：等 30 秒，用 `/connect` 重连，读到运行结束；把重连拿到的流和结束后再回放一次的流比对。
 * 校验脚本那一条在公共的判分里（smoke.ts 的 `check`）。
 */
async function driveBackground(
  kind: BackgroundKind,
  work: Work,
  agentId: string,
  threadId: string,
  deadline: number,
): Promise<Driven> {
  const checks: Check[] = [];
  let timedOut = false;
  let rejoins = 0;
  let error: string | undefined;
  try {
    // 完成通知（九·五）只有本人有地方可发时才记；reconnect 不查通知，不必记。
    if (kind === "disconnect") await registerStandInDevice();
    const stream = await openChatStream(
      RUN_PATH(agentId),
      runRequest({
        threadId,
        messages: conversationWith([], work.prompt, randomUUID()),
      }),
    );
    const first = await untilFirstComputerCall(
      stream,
      agentId,
      threadId,
      Math.min(FIRST_CALL_WAIT_MS, Math.max(deadline - Date.now(), 1000)),
    );
    const seen = first.events.filter(
      (event) => event.type === "TOOL_CALL_START",
    ).length;
    first.hangUp();
    console.log(
      `   client hung up after ${first.events.length} events (${seen} tool calls seen)`,
    );

    if (kind === "reconnect") {
      await Bun.sleep(RECONNECT_AFTER_MS);
      const latest = (await runsOfThread(threadId)).at(-1);
      const running =
        latest !== undefined && (await turnStatus(latest.id)) === "running";
      const joined = await openChatStream(
        CONNECT_PATH(agentId),
        connectRequest(threadId),
      );
      console.log(
        `   reconnected (the turn ${running ? "is still running" : "had already ended"})`,
      );
      const rejoined = await readRound(joined, agentId, threadId, deadline);
      timedOut = rejoined.timedOut;
      rejoins += rejoined.rejoins;
      await untilTurnEnds(threadId, 60_000);
      const replay = await (
        await openChatStream(CONNECT_PATH(agentId), connectRequest(threadId))
      ).done(60_000);
      checks.push(
        ...replayChecks({
          joined: rejoined.events,
          replay,
          seenBeforeHangUp: seen,
          runningAtReconnect: running,
        }),
      );
      console.log(
        `   joined stream ${rejoined.events.length} events, replay ${replay.length} events`,
      );
    } else {
      const status = await untilTurnEnds(
        threadId,
        Math.min(POLL_LIMIT_MS, Math.max(deadline - Date.now(), 1000)),
      );
      timedOut = status === undefined;
      console.log(`   polled the thread; the turn ${status ?? "did not end"}`);
      const runs = await runsOfThread(threadId);
      const runIds = runs.map((run) => run.id);
      const latest = runs.at(-1);
      const events = await eventsOf(runIds);
      checks.push(
        ...transcriptChecks(await storedMessagesOf(agentId, threadId), seen),
        finishedCheck(latest ? await turnStatus(latest.id) : undefined, events),
      );
      // 通知是在这一轮的流关闭之前异步发出的：给它几秒落库再查。
      await until(
        "the completion notice",
        async () =>
          noticeCheck(await replyOutbox(), runIds).ok ? true : undefined,
        20_000,
        1000,
      ).catch(() => undefined);
      checks.push(noticeCheck(await replyOutbox(), runIds));
    }
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
    checks.push({ name: `${kind} 流程走完`, ok: false, detail: error });
  }
  return {
    runIds: [],
    nudges: 0,
    timedOut,
    threadId,
    rejoins,
    sent: 1,
    checks,
    ...(error ? { error } : {}),
  };
}

/** 单聊路径：开一段单聊 → 发运行请求读到结束 → 没做完就在同一段对话里以本人身份发「继续」。 */
async function driveChat(
  work: Work,
  agentId: string,
  deadline: number,
  dir: string,
): Promise<Driven> {
  const channel = await api<{ channel: { id: string; threadId: string } }>(
    "POST",
    "/api/channels",
    { agentIds: [agentId] },
  );
  must(channel, [201], "create channel");
  const threadId = channel.body.channel.threadId;
  if (work.background)
    return driveBackground(work.background, work, agentId, threadId, deadline);

  let nudges = 0;
  let sent = 0;
  let rejoins = 0;
  let timedOut = false;
  let error: string | undefined;
  try {
    for (let round = 0; round <= MAX_NUDGES; round += 1) {
      sent += 1;
      const stream = await openChatStream(
        RUN_PATH(agentId),
        runRequest({
          threadId,
          messages: conversationWith(
            round === 0 ? [] : await storedMessagesOf(agentId, threadId),
            round === 0 ? work.prompt : NUDGE,
            randomUUID(),
          ),
        }),
      );
      if (round > 0) nudges += 1;
      const read = await readRound(stream, agentId, threadId, deadline);
      rejoins += read.rejoins;
      if (read.timedOut) {
        timedOut = true;
        break;
      }
      const state = roundState(read.events);
      const next = afterRound({
        state,
        outputsReady: work.outputsReady(dir),
        msLeft: deadline - Date.now(),
      });
      if (next.action !== "nudge") {
        timedOut = next.timedOut;
        break;
      }
      console.log(
        `   round ${round + 1} ended ${state.failed ? "with an error" : state.limited ? "at the turn limit" : "without the outputs"}; nudging`,
      );
    }
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  }
  return {
    runIds: [],
    nudges,
    timedOut,
    threadId,
    rejoins,
    sent,
    ...(error ? { error } : {}),
  };
}

async function runWork(work: Work): Promise<EvalRecord> {
  console.log(
    `\n== ${work.key}（${work.title}）${work.via === "chat" ? " [chat]" : ""}`,
  );
  const since = new Date();
  const started = Date.now();
  const deadline = started + work.minutes * 60_000;
  const agentId = await newEmployee(work.label);
  const dir = join(WORKSPACE, work.where);
  const driven =
    work.via === "chat"
      ? await driveChat(work, agentId, deadline, dir)
      : await driveBoard(work, agentId, deadline, dir);
  const { nudges, timedOut, error } = driven;
  if (driven.rejoins)
    notes.push(
      `${work.key}：事件流在这一轮还在跑时被服务器断开 ${driven.rejoins} 次，已用 /connect 接上继续读（服务器对 10 秒没出声的连接会关掉它，工具静默运行时就会这样；这一轮本身不受影响）`,
    );
  // 单聊路径：一轮的运行记录在这一轮结束后才写进库，先等发出去的每一轮都落了库（超时的那一轮还在跑，只等记录出现）。
  if (driven.threadId) {
    const threadId = driven.threadId;
    await until(
      "the runs to be stored",
      async () => {
        const runs = await runsOfThread(threadId);
        if (runs.length < Math.max(driven.sent ?? 1, 1)) return false;
        if (driven.timedOut) return true;
        const states = await Promise.all(runs.map((run) => turnStatus(run.id)));
        return states.every((state) => state !== "running");
      },
      30_000,
      1000,
    ).catch(() => undefined);
  }
  // 给最后一轮的事件和计量一点时间落库。
  await Bun.sleep(2000);
  // 单聊路径的运行号按对话读：审批、续接带出来的运行也算这道题的。
  const runIds = driven.threadId
    ? (await runsOfThread(driven.threadId)).map((run) => run.id)
    : driven.runIds;
  const wallMs = Date.now() - started;

  const copy = join(OUT, artifactDirName(suite, work.via), work.key);
  copyTree(dir, copy);
  const events = await eventsOf(runIds);
  const tokens = await tokenRows(agentId, since);
  const perRound = runIds.map(
    (runId) => tokens.filter((row) => row.runId === runId).length,
  );
  /*
   * 工具调用从运行事件里拼；事件没存全（一轮事件太多、整批写库失败）时改从对话快照读，并在报告里记一笔。
   */
  const stored = await storedRuns(runIds);
  const eventsLost = stored.expected > events.length;
  const calls = eventsLost
    ? toolCallsFromMessages(stored.messages)
    : toolCallsOf(events);
  if (eventsLost)
    notes.push(
      `${work.key}：运行事件只存下 ${events.length}/${stored.expected} 条（一轮超过 16383 条事件时整批写库失败），工具调用改从对话快照读，触顶事件读不到`,
    );
  const capabilities = analyzeXiongbao(events, {
    features,
    editsData: work.editsData,
    modelCallsPerRound: perRound,
    calls,
    reasoningSeen: snapshotHasReasoning(stored.messages),
  });
  const tools: Record<string, number> = {};
  for (const call of calls) tools[call.name] = (tools[call.name] ?? 0) + 1;
  const computerCalls = calls.filter((call) =>
    call.name.startsWith("computer_"),
  ).length;
  console.log(
    `   rounds ${runIds.length}, tool calls ${calls.length} (computer ${computerCalls}), files out ${listFiles(copy).length}`,
  );

  const judged = await work.judge(copy, {
    capabilities,
    events,
    calls,
    agentId,
    since,
  });
  const pathChecks = driven.checks ?? [];
  const checks = [...judged.checks, ...pathChecks];
  const passed = judged.passed && pathChecks.every((item) => item.ok);
  const sum = (
    key:
      | "inputTokens"
      | "outputTokens"
      | "cachedInputTokens"
      | "reasoningTokens",
  ) =>
    tokens.some((row) => row[key] !== null)
      ? tokens.reduce((total, row) => total + (row[key] ?? 0), 0)
      : null;
  const input = sum("inputTokens");
  const output = sum("outputTokens");
  const cachedInput = sum("cachedInputTokens");
  const reasoning = sum("reasoningTokens");
  const stepLimited = capabilities.stepLimit === "yes";
  const finalText = lastAssistantText(events);
  // 每轮的报错只记产品自己的错误码（不记消息原文，免得带出提供方的话）；无头工具续接上限单独说明。
  const roundErrors = events
    .filter((event) => event.type === "RUN_ERROR")
    .map((event) =>
      /continuation limit/.test(String(event.message ?? ""))
        ? "无头工具续接上限（一轮最多 30 段工具调用）"
        : String(event.code ?? "RUN_ERROR"),
    );
  const record: EvalRecord = {
    task: work.key,
    title: work.title,
    path: work.via,
    passed,
    wallMs,
    timedOut,
    // 步数 = 模型调用次数（model_token_calls 的行数，每一步一次调用）；工具调用次数另记。
    steps: tokens.length,
    ...callSeries(tokens, runIds),
    toolCalls: calls.length,
    modelCalls: tokens.length,
    tokens:
      input === null && output === null
        ? null
        : {
            input,
            output,
            total: (input ?? 0) + (output ?? 0),
            cachedInput,
            reasoning,
          },
    limitStops: limitStops(events),
    silentStop:
      !timedOut &&
      !stepLimited &&
      !asksQuestion(finalText) &&
      (!work.outputsReady(copy) || capabilities.planDone === "no"),
    nudges,
    tools,
    capabilities,
    checks,
    ...(roundErrors.length
      ? {
          error: `运行报错 ${roundErrors.length} 次：${[...new Set(roundErrors)].join("；")}`,
        }
      : {}),
    ...(judged.skipped ? { error: judged.skipped } : {}),
    ...(error ? { error } : {}),
  };
  console.log(
    `   ${judged.skipped ? "N/A " : record.passed ? "PASS" : "FAIL"} ${(wallMs / 1000).toFixed(1)} s, model calls ${record.modelCalls}, tokens ${record.tokens?.total ?? "?"} (cached input ${cachedInput ?? "?"}), nudges ${nudges}${timedOut ? ", timed out" : ""}`,
  );
  for (const item of record.checks)
    console.log(`     ${item.ok ? "ok " : "NO "} ${item.name} ${item.detail}`);
  return record;
}

function taskWork(task: TaskName): Work {
  const where = `eval/${task}`;
  return {
    key: task,
    title: TASK_TITLES[task],
    label: task,
    where,
    prompt: taskPrompt(task, where),
    minutes,
    via: pathOf(),
    editsData: task === "code" || task === "data",
    outputsReady: (dir) =>
      OUTPUTS[task].every((path) => existsSync(join(dir, path))),
    judge: async (dir, { agentId, since }) => {
      const outcome = await CHECKERS[task](dir);
      if (task !== "office") return outcome;
      // 看板路径：办公题多查一条，员工交付后卡片进入等验收，交付物里有工作区文件。单聊路径没有这张卡，标不适用。
      let board = { delivered: false, detail: "" };
      if (pathOf() === "board") {
        const mine = (await cards()).filter(
          (card) =>
            card.executorAgentId === agentId &&
            (!card.updatedAt ||
              new Date(card.updatedAt).getTime() >= since.getTime() - 1000),
        );
        board = {
          delivered: Boolean(
            mine.find(
              (card) =>
                card.status === "awaiting_review" &&
                (card.deliverableRef?.workspaceFiles?.length ?? 0) > 0,
            ),
          ),
          detail:
            mine
              .map(
                (card) =>
                  `${card.status}/${card.deliverableRef?.workspaceFiles?.length ?? 0} 个文件`,
              )
              .join("；") || "没有这位员工的卡",
        };
      }
      return result("office", [
        ...outcome.checks,
        officeCardCheck(pathOf(), board),
      ]);
    },
  };
}

function smokeWork(scenario: SmokeScenario): Work {
  const where = `smoke/${scenario.name}`;
  return {
    key: scenario.name,
    title: `${scenario.title}（${scenario.stage}）`,
    label: `冒烟-${scenario.name}`,
    where,
    prompt: scenario.prompt.replaceAll("{dir}", where),
    minutes: scenario.minutes,
    via: pathOf(scenario),
    ...(scenario.background ? { background: scenario.background } : {}),
    editsData: scenario.name === "code",
    outputsReady: () => true,
    judge: async (dir, { capabilities, events, calls }) => {
      // 运行里实际出现的能力也算在：标志读漏了，事件能补上。
      const known = withObserved(features, observedFeatures(events, calls));
      const missing = scenario.requires.filter((feature) => !known[feature]);
      if (missing.length)
        return {
          passed: false,
          skipped: `不适用：产品里还没有 ${missing.join("、")}`,
          checks: [
            check("能力已合入", false, `缺 ${missing.join("、")}，记为不适用`),
          ],
        };
      const checks = scenario.check({ dir, capabilities, calls });
      return result(scenario.name, checks);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------------------------

const startedAt = new Date().toISOString();
const records: EvalRecord[] = [];
const notes: string[] = [];
let failed = false;
try {
  console.log(
    `mode: ${config.mock ? "LOCAL MOCK model" : "REAL model"}; suite ${suite}; path ${evalPath}; provider ${config.provider}; model ${config.model}`,
  );
  console.log(
    `features: ${Object.entries(features)
      .map(([name, on]) => `${name}=${on ? "on" : "off"}`)
      .join(" ")}`,
  );
  await startComputer();
  await startServer();

  must(
    await api("POST", "/api/auth/sign-up/email", {
      name: "对标评测",
      email: ADMIN_EMAIL,
      password: `pw-${randomUUID()}`,
    }),
    [200],
    "sign up",
  );
  const me = await api<{ user?: { id?: string } }>("GET", "/api/me");
  tenant = me.body.user?.id ?? "";
  if (!tenant) throw new Error("no tenant id");
  must(
    await api("POST", "/api/me/onboarding", { completed: true }),
    [200],
    "onboarding",
  );
  const grant = Bun.spawnSync(["bun", "scripts/grant-admin.ts", ADMIN_EMAIL], {
    cwd: SERVER_DIR,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "/tmp",
      DATABASE_URL: databaseUrl,
      ROLE_WRITER_DATABASE_URL: roleWriterDatabaseUrl,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  if (grant.exitCode !== 0) throw new Error("grant-admin.ts failed");
  must(
    await api("POST", "/api/quota/plan", { planId: "pro" }),
    [200],
    "Pro plan",
  );

  // 模型库：提供方模板支持自定义地址就带上地址；假模型一律走 OpenAI 兼容的 custom。
  const provider = config.mock ? "custom" : config.provider;
  const body = {
    provider,
    modelName: config.model,
    apiKey: config.apiKey,
    ...(providerBaseUrl ? { baseUrl: providerBaseUrl } : {}),
    label: `评测 ${config.provider}/${config.model}`,
  };
  let model = await api<{ model: { id: string }; error?: string }>(
    "POST",
    "/api/models",
    body,
  );
  if (model.status === 400 && providerBaseUrl && !config.mock) {
    // 这个模板不收自定义地址（或不认识这个提供方）：退到 OpenAI 兼容的 custom，地址照旧。
    model = await api("POST", "/api/models", { ...body, provider: "custom" });
    notes.push(
      `提供方模板 ${config.provider} 不收自定义地址，改用 custom（OpenAI 兼容）连 ${providerBaseUrl}`,
    );
  }
  must(model, [201], "model library row");
  modelRef = model.body.model.id;

  const works =
    suite === "tasks" ? tasks.map(taskWork) : scenarios.map(smokeWork);
  for (const work of works) {
    materializeWork(work);
    records.push(await runWork(work));
  }
  if (deploymentHits > 0)
    notes.push(
      `部署自身的模型（只回 503 的桩）被请求了 ${deploymentHits} 次：不是员工的调用，不计入指标`,
    );
} catch (thrown) {
  failed = true;
  notes.push(
    `熊宝侧中止：${thrown instanceof Error ? thrown.message : String(thrown)}`,
  );
  console.error(`\nFAIL: ${notes[notes.length - 1]}`);
} finally {
  await stop(server);
  await stop(computer);
  await database.$client.end({ timeout: 5 }).catch(() => undefined);
  deploymentStub.stop(true);
  mock?.stop();
}

function materializeWork(work: Work) {
  const dir = join(WORKSPACE, work.where);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (suite === "tasks") materialize(work.key as TaskName, dir);
  else {
    const scenario = scenarios.find((item) => item.name === work.key);
    if (scenario) placeSmoke(scenario, dir);
  }
}

if (config.mock)
  notes.push(`本机假模型（${mock?.calls ?? 0} 次调用），判分结果不代表能力`);
const results: EvalResults = {
  side: "xiongbao",
  suite,
  provider: config.provider,
  model: config.model,
  baseUrl: config.mock ? null : config.baseUrl,
  runner: runnerLabel(
    evalPath,
    records.map((record) => record.path),
  ),
  path: evalPath,
  mock: config.mock,
  startedAt,
  finishedAt: new Date().toISOString(),
  records: records.map((record) => ({
    ...record,
    capabilities: record.capabilities ?? NOT_APPLICABLE,
  })),
  notes,
};
const file = join(OUT, resultFileName(suite, evalPath));
writeResults(file, results);
rmSync(scratch, { recursive: true, force: true });
console.log(`\nresults: ${file}`);
process.exit(failed ? 1 : 0);
