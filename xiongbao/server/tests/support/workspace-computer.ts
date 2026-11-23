import type { AuditEventInput, AuditStore } from "../../src/audit";
import { botSeat, type ComputerSeat } from "../../src/computer/computer-key";
import { createComputerGateway } from "../../src/computer/gateway";
import type { ActionPolicy } from "../../src/computer/policy";
import type { ComputerProvider } from "../../src/computer/provider";

/**
 * An employee's computer reduced to what a turn's file list depends on: a workspace of files, a
 * snapshot taken on request and a comparison against it. The gateway in front of it is the real one,
 * so what marks a turn (a snapshot recorded only when the computer is first used, dropped when it is
 * compared) is the product's, not a copy of it in a test.
 *
 * A command whose text is `write <path> <contents>` writes that file. Anything else only runs.
 */
export function workspaceComputer() {
  const files = new Map<string, { bytes: number; modifiedMs: number }>();
  const marks = new Map<
    string,
    Map<string, { bytes: number; modifiedMs: number }>
  >();
  const asked: string[] = [];
  let clock = 1_000;

  const provider: ComputerProvider = {
    name: "test",
    isolation: "per-person",
    locate: async () => "http://agent-computer:4100",
    status: async (seat) => ({ botId: seat.botId, state: "ready" }),
    stop: async () => ({ wasRunning: true }),
    reset: async () => ({ cleared: true }),
    list: async () => [],
  };

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    asked.push(path);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/files/mark") {
      marks.set(String(body.mark), new Map(files));
      return Response.json({ scanned: files.size, scanTruncated: false });
    }
    if (path === "/files/changes") {
      const before = marks.get(String(body.mark));
      if (!before)
        return Response.json({ error: "no such mark" }, { status: 404 });
      const found = [...files]
        .filter(([name, now]) => {
          const was = before.get(name);
          return (
            !was || was.bytes !== now.bytes || was.modifiedMs !== now.modifiedMs
          );
        })
        .map(([name, now]) => ({
          path: name,
          bytes: now.bytes,
          modifiedMs: now.modifiedMs,
          change: before.has(name) ? "modified" : "new",
        }));
      return Response.json({
        files: found,
        scanned: files.size,
        scanTruncated: false,
        omitted: 0,
      });
    }
    if (path === "/exec") {
      const [verb, name, ...rest] = String(body.command).split(" ");
      if (verb === "write" && name) {
        clock += 1;
        files.set(name, {
          bytes: rest.join(" ").length,
          modifiedMs: clock,
        });
      }
      return Response.json({
        command: body.command,
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
      });
    }
    return Response.json(
      { error: `Unknown endpoint: ${path}` },
      { status: 404 },
    );
  }) as unknown as typeof fetch;

  const audit: AuditEventInput[] = [];
  const auditStore: AuditStore = {
    insert: async (event) => void audit.push(event),
  };
  const allow: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };
  const gateway = createComputerGateway({
    provider,
    fetchImpl,
    auditStore,
    policy: () => allow,
  });

  return {
    gateway,
    /** The computer's paths the gateway was asked for, in order. */
    asked,
    files,
    /** The seat a person's chat with this Bot uses. */
    seatOf: async (botId: string, _personId: string): Promise<ComputerSeat> =>
      botSeat(botId),
    /** What the Bot does with its computer: run a command as the person. */
    run: (seat: ComputerSeat, command: string) =>
      gateway.runCommand(seat, { id: "person" }, { command }),
  };
}
