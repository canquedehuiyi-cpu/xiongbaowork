import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_COMMIT_TOOL } from "../../shared/git-tools";
import { outsideRecheck } from "../src/approvals/service";
import {
  type ApprovalAction,
  ApprovalNotFoundError,
  type ApprovalRecord,
  ApprovalRefusedError,
  type ApprovalStore,
  withApprovalContext,
} from "../src/approvals/types";
import { botSeat } from "../src/computer/computer-key";
import { createComputerGateway } from "../src/computer/gateway";
import {
  type GitComputer,
  gitTools,
  showingCommand,
} from "../src/computer/git-tools";
import { runAsTenant } from "../src/tenant/context";
import { createApprovalFixtureService } from "./helpers/approval-producer-model";
import { fetchDouble } from "./support/fetch-double";

/*
 * 期 4 · Task 4.2：git_commit 在「改动前先问」下的完整流程，用真的审批服务和真的电脑网关（只有网络那一跳换成
 * 本机的 bash 和文件读取）：弹审批 → 批准 → 复核 → 重放 → 提交成功。
 *
 * 复核（validateReentry）把门前的第一个动作当成被批准的那个。提交前检查文件内容用的文件读取，不能被当成它。
 */

const OWNER = "owner";
const asOwner = <T>(work: () => T) => runAsTenant(OWNER, work);

function memoryStore(): ApprovalStore {
  const records = new Map<string, ApprovalRecord>();
  const find = (owner: string, id: string) => {
    const row = records.get(id);
    if (!row || row.ownerUserId !== owner) throw new ApprovalNotFoundError();
    return row;
  };
  return {
    enabled: async () => true,
    setEnabled: async () => undefined,
    open: async (action: ApprovalAction) => {
      const prior = [...records.values()].find(
        (row) =>
          row.ownerUserId === action.actorId &&
          row.action.runId === action.runId &&
          row.action.toolCallId === action.toolCallId,
      );
      if (prior) {
        if (prior.action.actionDigest !== action.actionDigest)
          throw new ApprovalRefusedError("The approved action has changed.");
        return structuredClone(prior);
      }
      const row: ApprovalRecord = {
        id: crypto.randomUUID(),
        ownerUserId: action.actorId,
        action: structuredClone(action),
        status: "pending",
        decision: null,
        result: null,
        createdAt: new Date(),
        decidedAt: null,
        consumedAt: null,
        completedAt: null,
      };
      records.set(row.id, row);
      return structuredClone(row);
    },
    get: async (owner, id) => structuredClone(find(owner, id)),
    list: async (owner) =>
      [...records.values()]
        .filter((row) => row.ownerUserId === owner)
        .map((row) => structuredClone(row)),
    decide: async (owner, id, decision) => {
      const row = find(owner, id);
      if (row.status !== "pending")
        throw new ApprovalRefusedError("This request was already decided.");
      row.decision = decision;
      row.status = decision === "deny" ? "denied" : "approved";
      row.decidedAt = new Date();
      return structuredClone(row);
    },
    consume: async (owner, id, digest) => {
      const row = find(owner, id);
      if (row.action.actionDigest !== digest)
        throw new ApprovalRefusedError("The approved action has changed.");
      if (row.status !== "approved" || row.result) return false;
      row.status = "consumed";
      row.consumedAt = new Date();
      return true;
    },
    saveResult: async (owner, id, result) => {
      const row = find(owner, id);
      if (row.result) return false;
      row.result = result;
      return true;
    },
    finish: async (owner, id) => {
      find(owner, id).status = "completed";
    },
    rules: async () => [],
    revoke: async () => undefined,
  };
}

function sh(cwd: string, command: string) {
  const result = Bun.spawnSync(["bash", "-c", command], {
    cwd,
    env: {
      ...process.env,
      HOME: cwd,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("git_commit under 「改动前先问」, with the real approval service", () => {
  test("asks, is approved, is checked again, and commits", () =>
    asOwner(async () => {
      const root = mkdtempSync(join(tmpdir(), "git-approval-"));
      try {
        mkdirSync(join(root, "app"));
        sh(
          root,
          "cd app && git init -q -b main && git config user.name t && git config user.email t@example.com && echo one > a.txt && git add a.txt && git commit -q -m init",
        );
        writeFileSync(join(root, "app", "a.txt"), "one\ntwo\n");
        const commands: string[] = [];
        const store = memoryStore();
        const service = createApprovalFixtureService(store);
        const gateway = createComputerGateway({
          provider: {
            name: "test",
            isolation: "per-person",
            locate: async () => "http://computer:4100",
            status: async (seat) => ({ botId: seat.botId, state: "ready" }),
            list: async () => [],
            stop: async () => ({ wasRunning: true }),
            reset: async () => ({ cleared: true }),
          },
          policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
          auditStore: { insert: async () => undefined },
          approvalGate: service.gate,
          fetchImpl: fetchDouble(async (input, init) => {
            const path = new URL(String(input)).pathname;
            const body = JSON.parse(String(init?.body ?? "{}"));
            if (path === "/exec") {
              commands.push(body.command);
              return Response.json({
                command: body.command,
                ...sh(root, body.command),
                truncated: false,
                timedOut: false,
                elapsedMs: 1,
              });
            }
            if (path === "/files/read") {
              try {
                const text = readFileSync(join(root, body.path), "utf8");
                return Response.json({
                  path: body.path,
                  text,
                  truncated: false,
                  bytes: Buffer.byteLength(text),
                });
              } catch {
                return new Response(`There is no file at ${body.path}.`, {
                  status: 404,
                });
              }
            }
            return new Response("not found", { status: 404 });
          }),
        });
        const seat = botSeat("bot");
        const acting = { id: OWNER, userId: OWNER };
        const computer: GitComputer = {
          run: (command, signal) =>
            showingCommand(command, () =>
              gateway.runCommand(
                seat,
                acting,
                { command, timeoutMs: 60_000 },
                signal,
              ),
            ),
          // As `index.ts` builds it: the read is not the approved action.
          read: (path, signal) =>
            outsideRecheck(async () => {
              const file = await gateway.readFile(
                seat,
                acting,
                { path },
                signal,
              );
              return {
                text: file.text,
                truncated: file.truncated,
                bytes: file.bytes,
              };
            }),
        };
        const tool = gitTools({
          computer: async () => computer,
          connectorTools: async () => [],
        }).find((candidate) => candidate.name === GIT_COMMIT_TOOL);
        if (!tool) throw new Error("no git_commit");
        const args = { repo: "app", paths: ["a.txt"], message: "改 a 文件" };
        const context = {
          runId: "run",
          threadId: "thread",
          toolCallId: "call",
          toolName: GIT_COMMIT_TOOL,
          args,
          messages: [],
          state: {},
          context: [],
          forwardedProps: {},
        };
        const run = () =>
          withApprovalContext(context, () => tool.execute(args));

        // 1. It asks: the one thing waiting is the command, and nothing has been committed.
        await expect(run()).rejects.toMatchObject({
          name: "HeadlessToolSuspension",
        });
        const rows = await store.list(OWNER);
        expect(rows).toHaveLength(1);
        const [row] = rows;
        if (!row) throw new Error("missing approval");
        expect(row.action.toolRef).toBe("computer_run_command");
        expect(row.status).toBe("pending");
        // 批准的人看得到实际要执行的命令，不只是 paths 和 message。
        expect(row.action.args).toMatchObject({
          repo: "app",
          paths: ["a.txt"],
        });
        expect((row.action.args as { command?: string }).command).toContain(
          "git",
        );
        expect((row.action.args as { command?: string }).command).toContain(
          "commit",
        );
        expect(commands).toEqual([]);
        expect(
          sh(join(root, "app"), "git rev-list --count HEAD").stdout.trim(),
        ).toBe("1");

        // 2. The person approves; the server checks it again and carries it out.
        await service.decide(OWNER, row.id, "allow_once", "web");
        const continued: { result: { content: string; error?: string } }[] = [];
        await service.resume(OWNER, row.id, {
          validate: (action) =>
            service.validateReentry(action, () => tool.execute(args)),
          execute: () => tool.execute(args),
          continue: async (input) => {
            continued.push(input);
          },
        });

        // 3. It committed, and nothing was refused as "changed".
        const [done] = continued;
        expect(done?.result).not.toHaveProperty("error");
        expect(JSON.parse(done?.result.content ?? "{}")).toMatchObject({
          ok: true,
          branch: "main",
          files: ["a.txt"],
        });
        expect(commands).toHaveLength(1);
        expect(
          sh(join(root, "app"), "git log -1 --format=%s").stdout,
        ).toContain("改 a 文件");
        expect(
          sh(join(root, "app"), "git rev-list --count HEAD").stdout.trim(),
        ).toBe("2");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }));
});
