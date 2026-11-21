import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  computerLaunch,
  isolationFrom,
  openUpArgv,
  parseProbe,
  probeCommand,
  probeNotes,
  shellQuote,
} from "./isolation";

const isolation = { user: "xbeval", computerDir: "/opt/xbeval/agent-computer" };

test("没设用户、没设副本目录、不是 Linux、用户名不合法时不隔离", () => {
  const env = { EVAL_EMPLOYEE_USER: "xbeval", EVAL_COMPUTER_DIR: "/opt/c" };
  expect(isolationFrom(env, "linux")).toEqual({
    user: "xbeval",
    computerDir: "/opt/c",
  });
  expect(isolationFrom({}, "linux")).toBeUndefined();
  expect(
    isolationFrom({ EVAL_EMPLOYEE_USER: "xbeval" }, "linux"),
  ).toBeUndefined();
  expect(isolationFrom(env, "darwin")).toBeUndefined();
  expect(
    isolationFrom({ ...env, EVAL_EMPLOYEE_USER: "a b; rm -rf /" }, "linux"),
  ).toBeUndefined();
  expect(isolationFrom({ ...env, EVAL_EMPLOYEE_USER: " " }, "linux")).toBe(
    undefined,
  );
});

test("不隔离时照旧 bun src/index.ts，环境原样", () => {
  const vars = { PATH: "/bin", HOME: "/h", COMPUTER_TOKEN: "t" };
  expect(computerLaunch(undefined, vars, "/repo/agent-computer")).toEqual({
    argv: ["bun", "src/index.ts"],
    env: vars,
    cwd: "/repo/agent-computer",
  });
});

test("隔离时用 sudo 以专用用户起，令牌不进命令行，umask 000，在运行副本目录里", () => {
  const launch = computerLaunch(
    isolation,
    {
      PATH: "/usr/bin",
      HOME: "/home/runner",
      PORT: "4100",
      WORKSPACE_DIR: "/tmp/s/workspace",
      COMPUTER_TOKEN: "secret-token",
    },
    "/repo/agent-computer",
  );
  expect(launch.cwd).toBe("/opt/xbeval/agent-computer");
  expect(launch.argv.slice(0, 7)).toEqual([
    "sudo",
    "-n",
    "-H",
    "-u",
    "xbeval",
    "--preserve-env=COMPUTER_TOKEN",
    "env",
  ]);
  expect(launch.argv).toContain("PORT=4100");
  expect(launch.argv).toContain("WORKSPACE_DIR=/tmp/s/workspace");
  expect(launch.argv).toContain("PATH=/usr/bin");
  expect(launch.argv.join(" ")).not.toContain("secret-token");
  expect(launch.argv.join(" ")).not.toContain("/home/runner");
  expect(launch.argv.at(-1)).toBe("umask 000; exec bun src/index.ts");
  expect(launch.env).toEqual({
    PATH: "/usr/bin",
    COMPUTER_TOKEN: "secret-token",
  });
});

test("单引号转义", () => {
  expect(shellQuote("a'b")).toBe("'a'\\''b'");
});

const paths = {
  repoFiles: ["/nope/a.ts", "/nope/it's.ts"],
  scratchPaths: ["/nope/scratch"],
  workspace: "/tmp",
  tools: ["sh", "definitely-not-a-tool-xyz"],
};

test("自检命令：读不到、工具缺、工作区可写，各自对应一个标记（真跑一遍 shell）", () => {
  const ran = spawnSync("sh", ["-c", probeCommand(paths)], {
    encoding: "utf8",
  });
  const probe = parseProbe(ran.stdout);
  expect(probe).toEqual({
    repoReadable: false,
    scratchReadable: false,
    workspaceWritable: true,
    missingTools: ["definitely-not-a-tool-xyz"],
  });
});

test("自检命令：任一仓库文件读得到就标未隔离", () => {
  const ran = spawnSync(
    "sh",
    [
      "-c",
      probeCommand({ ...paths, repoFiles: ["/nope/x", import.meta.path] }),
    ],
    { encoding: "utf8" },
  );
  expect(parseProbe(ran.stdout).repoReadable).toBe(true);
});

test("自检结论：未隔离、隔离成功、隔离但配置有问题", () => {
  const hidden = {
    repoReadable: false,
    scratchReadable: false,
    workspaceWritable: true,
    missingTools: [],
  };
  expect(probeNotes(isolation, hidden)).toEqual([
    "员工的命令读不到评测仓库（自检通过）",
  ]);
  expect(probeNotes(undefined, { ...hidden, repoReadable: true })[0]).toContain(
    "未与仓库隔离",
  );
  expect(probeNotes(isolation, { ...hidden, repoReadable: true })[0]).toContain(
    "未隔离",
  );
  const broken = probeNotes(isolation, {
    ...hidden,
    scratchReadable: true,
    workspaceWritable: false,
    missingTools: ["bun"],
  });
  expect(broken.join("\n")).toContain("临时目录");
  expect(broken.join("\n")).toContain("写不了工作区");
  expect(broken.join("\n")).toContain("找不到 bun");
});

test("放开目录用 sudo chmod，不经 shell", () => {
  expect(openUpArgv("/tmp/s")).toEqual([
    "sudo",
    "-n",
    "chmod",
    "-R",
    "a+rwX",
    "/tmp/s",
  ]);
});
