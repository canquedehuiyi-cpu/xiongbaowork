/**
 * 对标评测的 Codex 侧：逐题把夹具拷进临时目录，执行 `codex exec`，再用同一套判分脚本判。
 *
 * 只比工作方式，不比模型：Codex 用的是和熊宝同一个模型（默认 DeepSeek 的 deepseek-v4-flash），在临时
 * `CODEX_HOME/config.toml` 里加一个自定义 provider 指过去。Codex CLI 只讲 OpenAI Responses 协议
 * （`wire_api = "responses"`，旧的 `"chat"` 已被移除）；DeepSeek 官方 API 原生支持 Responses，
 * 地址就是 `https://api.deepseek.com`（Codex 在后面接 `/responses`）。换别的提供方时，它的接口也得支持
 * Responses，否则这一侧每题都会失败，报告里写明。
 *
 * 由 `.github/workflows/model-e2e.yml` 的 `employee-eval-codex` 作业手动触发；门槛见 `config.ts`。
 *
 * 环境变量（除 config.ts 里的模型参数外）：
 *   CODEX_BIN          codex 可执行文件；作业里用 npm 装好的精确版本（见 CODEX_VERSION）
 *   EVAL_TASKS         all（五道对标题）、hard（加难题：compare、refactor、terminal、webform）或逗号分隔的题名
 *                      （repeat、repeat-pitfall 只能点名：同一道题连做两次，Codex 每次都是全新环境），默认 all。
 *                      网页表单题的夹具网站由本脚本在本机起，Codex 的命令（curl 等）访问得到
 *   EVAL_REPEAT_PAIRS  重复类的题连做几对，1 到 6，默认 1（每一对两次，各次都是全新环境；Codex 只作对照）
 *   EVAL_SEED          有坑可学的题的基础种子（作业里是 run id，和熊宝侧同一个，夹具才一样）；没设就现抽一个并记在结果里
 *   EVAL_DEADLINE_EPOCH 作业截止时间（Unix 秒）：来不及再做完一对时，剩下的对不做，已完成的照常记录
 *   EVAL_TASK_MINUTES  每题墙钟上限，默认 20
 *   EVAL_OUT           结果目录，默认 ./employee-eval-out；写 codex.json、每题的 JSONL 记录和产物
 *   EVAL_CODEX_SANDBOX Codex 跑命令的沙箱：workspace-write（默认，联网打开）或 danger-full-access
 *
 * 本机验证：EVAL_LOCAL_MOCK=1 MODEL_E2E=1 CODEX_BIN=… bun scripts/e2e/employee-eval/run-codex.ts
 * （假模型只让 Codex 跑一条命令，判分不要求通过。）
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CHECKERS } from "./checkers";
import {
  evalGate,
  evalSeed,
  type ModelConfig,
  pairFits,
  repeatPairs,
  taskMinutes,
} from "./config";
import { pitfallPairSeeds } from "./gen-pitfall";
import {
  copyTree,
  EDITS_CODE_TASKS,
  HARD_SUITE,
  isRepeatTask,
  materialize,
  REPEAT_PITFALL_TASK,
  selectTasks,
  TASK_TITLES,
  type TaskName,
  taskPrompt,
} from "./lib";
import { analyzeCodex } from "./metrics";
import { startMockModel } from "./mock-model";
import {
  combinePairs,
  combineRepeat,
  type EvalRecord,
  type EvalResults,
  writeResults,
} from "./records";
import { sealReceived, startWebformSite } from "./webform-site";

/** 作业里安装的 Codex CLI 版本（npm 包 `@openai/codex`，Apache-2.0）。改版本时同步改 workflow。 */
export const CODEX_VERSION = "0.166.0";
/** Codex 读 key 的环境变量名（config.toml 的 env_key）。 */
const KEY_ENV = "EVAL_MODEL_API_KEY";

const tomlString = (value: string) => JSON.stringify(value);

/** 写给 Codex 的 config.toml：一个指向评测模型的自定义 provider。 */
export function codexConfig(
  config: Pick<ModelConfig, "provider" | "model" | "baseUrl">,
  sandbox: string,
) {
  if (!config.baseUrl)
    throw new Error(
      `提供方 ${config.provider} 没有已知的接口地址，Codex 侧需要 base_url（且要支持 Responses 协议）`,
    );
  return [
    `model = ${tomlString(config.model)}`,
    `model_provider = "eval"`,
    `approval_policy = "never"`,
    `sandbox_mode = ${tomlString(sandbox)}`,
    "",
    "[sandbox_workspace_write]",
    "network_access = true",
    "",
    "[model_providers.eval]",
    `name = ${tomlString(config.provider)}`,
    `base_url = ${tomlString(config.baseUrl)}`,
    `env_key = ${tomlString(KEY_ENV)}`,
    `wire_api = "responses"`,
    "request_max_retries = 4",
    "stream_max_retries = 5",
    "",
  ].join("\n");
}

/** 本机假模型的打法：先读题面，再写一个占位产物，然后收尾。只证明链路，不做题。 */
function mockPolicy(request: {
  lastUser: string;
  toolResultsSinceUser: number;
}) {
  if (request.toolResultsSinceUser === 0)
    return {
      tools: [
        { name: "exec_command", arguments: { cmd: "cat TASK.md && ls" } },
      ],
    };
  if (request.toolResultsSinceUser === 1)
    return {
      tools: [
        {
          name: "exec_command",
          arguments: { cmd: "echo 'mock output' > mock-output.md && ls" },
        },
      ],
    };
  return { text: "做完了（假模型）。" };
}

async function runOne(
  task: TaskName,
  options: {
    bin: string;
    home: string;
    apiKey: string;
    model: string;
    minutes: number;
    out: string;
    /** 重复任务的第几次；产物和记录按它分开存。 */
    round?: "first" | "second";
    /** 连做多对时的第几对（只有一对时不写）；产物和记录按它分开存。 */
    pair?: number;
    /** 夹具由种子生成的题（有坑可学）：这一次的种子。 */
    seed?: string;
  },
): Promise<EvalRecord> {
  const key = options.round
    ? `${task}${options.pair ? `-p${options.pair}` : ""}-${options.round}`
    : task;
  const work = mkdtempSync(join(tmpdir(), `codex-${key}-`));
  // 网页表单题：夹具网站在本机起，Codex 的命令访问得到；判分读它收到的记录。
  const site = task === "webform" ? startWebformSite() : null;
  materialize(
    task,
    work,
    site ? { SITE_URL: site.url } : undefined,
    options.seed,
  );
  const started = Date.now();
  const transcript = join(options.out, "codex", `${key}.jsonl`);
  mkdirSync(join(options.out, "codex"), { recursive: true });
  let timedOut = false;
  let error: string | undefined;
  let stdout = "";
  try {
    const child = Bun.spawn(
      [
        options.bin,
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--ephemeral",
        "-C",
        work,
        "-m",
        options.model,
        taskPrompt(task, "当前目录"),
      ],
      {
        cwd: work,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "/tmp",
          CODEX_HOME: options.home,
          [KEY_ENV]: options.apiKey,
          NO_COLOR: "1",
        },
      },
    );
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.minutes * 60_000);
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(timer);
    stdout = out;
    if (child.exitCode !== 0 && !timedOut)
      // stderr 是 Codex 自己的话，可能带上游报错原文；只留最后几行、截断。
      error = `codex exited ${child.exitCode}: ${err.trim().split("\n").slice(-3).join(" ").slice(0, 300)}`;
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  }
  const wallMs = Date.now() - started;
  if (site) {
    sealReceived(site, work);
    site.stop();
  }
  writeFileSync(transcript, stdout);
  copyTree(work, join(options.out, "codex", key));
  const outcome = await CHECKERS[task](work, options.seed);
  rmSync(work, { recursive: true, force: true });
  const summary = analyzeCodex(stdout.split("\n"), {
    editsData: EDITS_CODE_TASKS.includes(task),
  });
  const tools: Record<string, number> = {};
  for (const line of stdout.split("\n")) {
    const type =
      /"type":"item\.completed","item":\{"id":"[^"]*","type":"([a-z_]+)"/.exec(
        line,
      )?.[1];
    if (type && type !== "agent_message") tools[type] = (tools[type] ?? 0) + 1;
  }
  return {
    task,
    title: TASK_TITLES[task],
    passed: outcome.passed,
    wallMs,
    timedOut,
    steps: summary.steps,
    toolCalls: summary.steps,
    modelCalls: null,
    tokens: summary.tokens,
    silentStop: null,
    nudges: 0,
    tools,
    capabilities: summary.capabilities,
    checks: outcome.checks,
    ...(error ? { error } : {}),
    ...(options.seed ? { seed: options.seed } : {}),
  };
}

if (import.meta.main) {
  const verdict = evalGate(process.env);
  if (!verdict.ok) {
    console.error(`run-codex refused: ${verdict.reason}`);
    process.exit(2);
  }
  const config = verdict.config;
  delete process.env.MODEL_E2E_API_KEY;
  const tasks = selectTasks(process.env.EVAL_TASKS, HARD_SUITE);
  // 重复类的题连做几对、夹具的基础种子：和熊宝侧同一组输入，两边的每一对夹具一样。
  const pairChoice = repeatPairs(process.env);
  if (!pairChoice.ok) {
    console.error(`run-codex refused: ${pairChoice.reason}`);
    process.exit(2);
  }
  const pairCount = pairChoice.pairs;
  const baseSeed = evalSeed(process.env);
  const minutes = taskMinutes(process.env);
  const out = resolve(process.env.EVAL_OUT?.trim() || "employee-eval-out");
  const bin = process.env.CODEX_BIN?.trim() || "codex";
  const sandbox = process.env.EVAL_CODEX_SANDBOX?.trim() || "workspace-write";
  if (!["workspace-write", "danger-full-access"].includes(sandbox)) {
    console.error(
      "EVAL_CODEX_SANDBOX must be workspace-write or danger-full-access",
    );
    process.exit(2);
  }
  const mock = config.mock ? startMockModel(mockPolicy) : null;
  const baseUrl = mock ? `${mock.url}/v1` : config.baseUrl;
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  const notes: string[] = [];
  const startedAt = new Date().toISOString();
  const records: EvalRecord[] = [];
  let version = "unknown";
  try {
    const probe = Bun.spawnSync([bin, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    version =
      probe.stdout.toString().trim() ||
      `codex --version exited ${probe.exitCode}`;
    console.log(`codex: ${version}`);
    writeFileSync(
      join(home, "config.toml"),
      codexConfig({ ...config, baseUrl }, sandbox),
    );
    for (const task of tasks) {
      console.log(`\n== ${task}（${TASK_TITLES[task]}）`);
      const common = {
        bin,
        home,
        apiKey: config.apiKey,
        model: config.model,
        minutes,
        out,
      };
      // 重复任务：同一道题连做两次，连做 pairCount 对（Codex 每次都是全新的临时目录，没有跨次的记忆，作对照；
      // 照样每一对一个新种子，和熊宝侧的夹具一样）。
      let record: EvalRecord | undefined;
      if (isRepeatTask(task)) {
        const parts: EvalRecord[] = [];
        let lastPairMs: number | undefined;
        for (let index = 1; index <= pairCount; index += 1) {
          if (!pairFits(process.env, Date.now(), lastPairMs, minutes)) {
            notes.push(
              `${task} 第 ${index}/${pairCount} 对没做：离作业截止时间不够做完一对，已完成的各对照常记录`,
            );
            break;
          }
          const pairStarted = Date.now();
          const [firstSeed, secondSeed] =
            task === REPEAT_PITFALL_TASK
              ? pitfallPairSeeds(baseSeed, index)
              : [undefined, undefined];
          const pairPart = pairCount > 1 ? { pair: index } : {};
          const first = await runOne(task, {
            ...common,
            ...pairPart,
            round: "first",
            seed: firstSeed,
          });
          const second = await runOne(task, {
            ...common,
            ...pairPart,
            round: "second",
            seed: secondSeed,
          });
          parts.push(combineRepeat(first, second, task));
          lastPairMs = Date.now() - pairStarted;
        }
        if (parts.length === 0) continue;
        record = combinePairs(task, parts);
        if (task === REPEAT_PITFALL_TASK)
          notes.push(
            `有坑可学的题的基础种子 ${baseSeed}（各次运行的种子在 seed 里）`,
          );
      } else record = await runOne(task, common);
      records.push(record);
      console.log(
        `   ${record.passed ? "PASS" : "FAIL"} ${(record.wallMs / 1000).toFixed(1)} s, steps ${record.steps}, tokens ${record.tokens?.total ?? "?"}${record.timedOut ? "，超时" : ""}${record.error ? `，${record.error}` : ""}`,
      );
      for (const item of record.checks)
        console.log(
          `     ${item.ok ? "ok " : "NO "} ${item.name} ${item.detail}`,
        );
    }
  } catch (thrown) {
    notes.push(
      `Codex 侧中止：${thrown instanceof Error ? thrown.message : String(thrown)}`,
    );
    console.error(notes[notes.length - 1]);
  } finally {
    mock?.stop();
    rmSync(home, { recursive: true, force: true });
  }
  if (config.mock)
    notes.push(`本机假模型（${mock?.calls ?? 0} 次调用），判分结果不代表能力`);
  const results: EvalResults = {
    side: "codex",
    suite: "tasks",
    provider: config.provider,
    model: config.model,
    baseUrl: config.mock ? null : config.baseUrl,
    runner: `codex exec (${version}, sandbox ${sandbox})`,
    mock: config.mock,
    startedAt,
    finishedAt: new Date().toISOString(),
    records,
    notes,
  };
  writeResults(join(out, "codex.json"), results);
  console.log(`\nresults: ${join(out, "codex.json")}`);
  // 判分没过不算脚本失败：报告里看结果。脚本自己出错才非零退出。
  process.exit(records.length === tasks.length ? 0 : 1);
}
