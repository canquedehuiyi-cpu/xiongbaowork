import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import {
  computerToolPlace,
  DEVICE_RUN_COMMAND_DESCRIPTION,
  WORKSPACE_RUN_COMMAND_DESCRIPTION,
} from "../../shared/computer-tool-words";
import {
  LOCAL_TOOL_DESCRIPTIONS,
  LOCAL_TOOL_NAMES,
  LOCAL_TOOL_PARAMETERS,
  CANDIDATE_REF as SHARED_CANDIDATE_REF,
} from "../../shared/local-tools";
import { createApprovalService } from "../src/approvals/service";
import type { ApprovalStore } from "../src/approvals/types";
import type { AuditEventInput } from "../src/audit";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { CANDIDATE_REF } from "../src/computer/app-discovery";
import type { ComputerTransport } from "../src/computer/client";
import {
  DESKTOP_SNAPSHOT_DESCRIPTION,
  DESKTOP_WINDOWS_DESCRIPTION,
} from "../src/computer/desktop-tools";
import { personSeat } from "../src/computer/computer-key";
import { createComputerGateway } from "../src/computer/gateway";
import { createHeadlessComputerTools } from "../src/computer/headless-tools";
import type { PolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";
import { createDeviceComputerProvider } from "../src/devices/selection";

/*
 * The web chat's way to the owner's local apps and desktop (真机验收 2026-11-09): the five tools the
 * unattended run already had, as routes under the Bot, for the browser's own tool registrations.
 *
 * A real gateway and the real approval gate, with only the paired machine faked. The routes shape the
 * request and hand it on; who may, what is asked about and what is recorded stay the gateway's. With
 * no conversation behind a plain route there is nobody to ask, so anything the gate would ask about is
 * refused rather than carried out.
 */

const OWNER = "owner-1";
const MACHINE = { tenantId: OWNER, deviceId: "studio" };
const CANDIDATE = "cand_a1b2_ABCDEFGHIJKLMNOPQRSTUV";
const BANK = {
  windowId: "w1001-42",
  title: "招商银行 - Google Chrome",
  process: "chrome",
  focused: true,
  minimized: false,
};
const NOTEPAD = {
  windowId: "w2002-77",
  title: "笔记.txt - 记事本",
  process: "notepad",
  focused: false,
  minimized: false,
};

const owner: AuthenticatedActor = {
  id: OWNER,
  email: "owner@openbot.test",
  role: "user",
};
const teammate: AuthenticatedActor = {
  id: "teammate-1",
  email: "teammate@openbot.test",
  role: "user",
};

function asActor(
  actor: AuthenticatedActor,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", actor);
    await next();
  };
}

function harness(
  options: { actor?: AuthenticatedActor; device?: boolean } = {},
) {
  const posts: { path: string; payload: unknown }[] = [];
  const rows: AuditEventInput[] = [];
  const transport: ComputerTransport = {
    async post<T>(
      _address: string,
      _botId: string,
      path: string,
      payload: unknown,
    ): Promise<T> {
      posts.push({ path, payload });
      if (path === "/apps/tools")
        return {
          tools: [
            {
              name: "read_note",
              description: "Read a note",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: true },
            },
            {
              name: "write_note",
              description: "Write a note",
              inputSchema: { type: "object" },
            },
          ],
        } as T;
      if (path === "/apps/call")
        return { content: [{ type: "text", text: "买牛奶" }] } as T;
      if (path === "/apps/discover")
        return {
          candidates: [
            {
              ref: CANDIDATE,
              name: "Figma",
              sourceLabel: "Claude 桌面版",
              kind: "stdio",
              status: "ready",
              enabled: false,
            },
          ],
          installed: [],
        } as T;
      if (path === "/apps/enable")
        return { app: { ref: "app-figma", name: "Figma" }, tools: [] } as T;
      if (path === "/desktop/windows") return { windows: [BANK, NOTEPAD] } as T;
      if (path === "/desktop/snapshot")
        return {
          snapshotId: "abc123-1",
          window: NOTEPAD,
          truncated: false,
          elements: [
            { ref: "abc123-1:0", type: "Document", name: "文本", depth: 0 },
          ],
        } as T;
      throw new Error(`unexpected path ${path}`);
    },
    call: async () => {
      throw new Error("no GET expected");
    },
    navigate: async () => {
      throw new Error("no navigation expected");
    },
    download: async () => {
      throw new Error("no download expected");
    },
  };
  // The real gate, over a store with no rules: a change asks, and so does a sensitive window.
  const service = createApprovalService({
    enabled: async () => true,
  } as unknown as ApprovalStore);
  const gateway = createComputerGateway({
    provider: createDeviceComputerProvider(),
    auditStore: { insert: async (row) => void rows.push(row) },
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    transport,
    ...(options.device === false
      ? {}
      : {
          resolveDevice: async () => MACHINE,
          deviceApps: async () => [{ ref: "app-notes", name: "Notes" }],
        }),
    approvalGate: service.gate,
    approvalRefusal: service.refusal,
  });
  const routes = createComputerRoutes(
    gateway,
    {} as PolicyStore,
    asActor(options.actor ?? owner),
    // Permissive: who may reach the Bot's routes at all has its own suite (bot-access.test.ts).
    async () => true,
  );
  const send = (path: string, body: unknown) =>
    routes.request(`http://openbot.test/bot-1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const paths = () => posts.map((post) => post.path);
  return { routes, send, posts, paths, rows };
}

describe("the five tools are the same words and parameters on both sides", () => {
  test("the shared copy matches what the unattended run offers", () => {
    const tools = createHeadlessComputerTools({
      gateway: {} as never,
      seat: personSeat(OWNER, "bot-1"),
      actor: { id: OWNER },
      machine: "device",
      apps: true,
    });
    for (const name of LOCAL_TOOL_NAMES) {
      const tool = tools.find(
        (candidate) => candidate.definition.name === name,
      );
      expect(tool?.definition.description).toBe(LOCAL_TOOL_DESCRIPTIONS[name]);
      expect(tool?.definition.parameters).toEqual(LOCAL_TOOL_PARAMETERS[name]);
    }
    expect(LOCAL_TOOL_DESCRIPTIONS.computer_desktop_windows).toBe(
      DESKTOP_WINDOWS_DESCRIPTION,
    );
    expect(LOCAL_TOOL_DESCRIPTIONS.computer_desktop_snapshot).toBe(
      DESKTOP_SNAPSHOT_DESCRIPTION,
    );
    expect(SHARED_CANDIDATE_REF.source).toBe(CANDIDATE_REF.source);
    expect(SHARED_CANDIDATE_REF.flags).toBe(CANDIDATE_REF.flags);
  });
});

describe("local apps from a plain route", () => {
  test("the owner lists an app's tools", async () => {
    const h = harness();
    const response = await h.send("/apps/list", { app: "Notes" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      apps: { name: string; tools: { name: string }[] }[];
      untrusted: string;
    };
    expect(body.apps[0]?.name).toBe("Notes");
    expect(body.apps[0]?.tools.map((tool) => tool.name)).toEqual([
      "read_note",
      "write_note",
    ]);
    expect(body.untrusted).toBeString();
    expect(h.paths()).toEqual(["/apps/tools"]);
    expect(h.rows.length).toBeGreaterThan(0);
  });

  test("the owner lists every app with what else the computer has", async () => {
    const h = harness();
    const response = await h.send("/apps/list", {});
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      available?: { candidate: string }[];
      hints?: unknown;
    };
    expect(body.available?.map((entry) => entry.candidate)).toEqual([
      CANDIDATE,
    ]);
    expect(body.hints).toBeDefined();
  });

  test("the owner calls a read-only tool", async () => {
    const h = harness();
    const response = await h.send("/apps/call", {
      app: "Notes",
      tool: "read_note",
      args: { id: 1 },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      content: [{ type: "text", text: "买牛奶" }],
    });
    expect(h.posts.at(-1)).toEqual({
      path: "/apps/call",
      payload: { app: "app-notes", tool: "read_note", args: { id: 1 } },
    });
  });

  test("a tool that changes things is asked about, so with nobody to ask it does not run", async () => {
    const h = harness();
    const response = await h.send("/apps/call", {
      app: "Notes",
      tool: "write_note",
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toContain(
      "approval",
    );
    expect(h.paths()).not.toContain("/apps/call");
  });

  test("someone who is not the owner is refused and the machine is never asked", async () => {
    const h = harness({ actor: teammate });
    for (const [path, body] of [
      ["/apps/list", {}],
      ["/apps/call", { app: "Notes", tool: "read_note" }],
      ["/apps/enable", { candidate: CANDIDATE }],
    ] as const) {
      const response = await h.send(path, body);
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: string }).error).toContain(
        "主人",
      );
    }
    expect(h.posts).toEqual([]);
  });

  test("enabling an app always goes to the owner's approval, and nothing is enabled without it", async () => {
    const h = harness();
    const response = await h.send("/apps/enable", { candidate: CANDIDATE });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toContain(
      "approval",
    );
    expect(h.paths()).not.toContain("/apps/enable");
  });

  test("malformed arguments are 400 and reach nothing", async () => {
    const h = harness();
    for (const [path, body] of [
      ["/apps/list", { app: "" }],
      ["/apps/list", { app: "x".repeat(41) }],
      ["/apps/list", { app: "Notes", extra: true }],
      ["/apps/call", { tool: "read_note" }],
      ["/apps/call", { app: "Notes" }],
      ["/apps/call", { app: "x".repeat(41), tool: "read_note" }],
      ["/apps/call", { app: "Notes", tool: "*" }],
      ["/apps/call", { app: "Notes", tool: "x".repeat(129) }],
      ["/apps/call", { app: "Notes", tool: "read_note", args: [1] }],
      ["/apps/enable", { candidate: "Figma" }],
      ["/apps/enable", {}],
      ["/desktop/windows", { windowId: "w1001-42" }],
      ["/desktop/snapshot", {}],
      ["/desktop/snapshot", { windowId: "notepad" }],
      ["/desktop/snapshot", { windowId: "w2002-77", from: "e1" }],
      ["/desktop/snapshot", { windowId: "w2002-77", screenshot: "yes" }],
    ] as const) {
      const response = await h.send(path, body);
      expect({ path, body, status: response.status }).toEqual({
        path,
        body,
        status: 400,
      });
    }
    expect(h.posts).toEqual([]);
    expect(h.rows).toEqual([]);
  });
});

describe("the desktop from a plain route", () => {
  test("the owner lists the windows", async () => {
    const h = harness();
    const response = await h.send("/desktop/windows", {});
    expect(response.status).toBe(200);
    const body = (await response.json()) as { windows: { title: string }[] };
    expect(body.windows.map((window) => window.title)).toEqual([
      BANK.title,
      NOTEPAD.title,
    ]);
    expect(h.paths()).toEqual(["/desktop/windows"]);
  });

  test("the owner reads a plain window", async () => {
    const h = harness();
    const response = await h.send("/desktop/snapshot", {
      windowId: NOTEPAD.windowId,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ snapshotId: "abc123-1" });
    expect(h.paths()).toEqual(["/desktop/windows", "/desktop/snapshot"]);
  });

  test("a window with a sensitive title is asked about, so with nobody to ask it is not read", async () => {
    const h = harness();
    const response = await h.send("/desktop/snapshot", {
      windowId: BANK.windowId,
      screenshot: true,
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toContain(
      "approval",
    );
    expect(h.paths()).not.toContain("/desktop/snapshot");
  });

  test("someone who is not the owner is refused and the machine is never asked", async () => {
    const h = harness({ actor: teammate });
    const windows = await h.send("/desktop/windows", {});
    const snapshot = await h.send("/desktop/snapshot", {
      windowId: NOTEPAD.windowId,
    });
    expect(windows.status).toBe(403);
    expect(snapshot.status).toBe(403);
    expect(h.posts).toEqual([]);
  });
});

describe("whether the browser offers the five tools", () => {
  test("yes to the owner of a Bot on a paired machine", async () => {
    const response = await harness().routes.request(
      "http://openbot.test/bot-1/local-tools",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      allowed: true,
      machine: "device",
    });
  });

  test("no to anyone else", async () => {
    const response = await harness({ actor: teammate }).routes.request(
      "http://openbot.test/bot-1/local-tools",
    );
    expect(await response.json()).toEqual({
      allowed: false,
      machine: "device",
    });
  });

  test("no where the deployment has no paired machines at all", async () => {
    const h = harness({ device: false });
    const response = await h.routes.request(
      "http://openbot.test/bot-1/local-tools",
    );
    expect(await response.json()).toEqual({
      allowed: false,
      machine: "workspace",
    });
    // Nor do the tools work there: the gateway says there is nothing to use.
    expect((await h.send("/apps/list", {})).status).toBe(503);
  });

  test("no when the owner's machine cannot be found", async () => {
    const routes = createComputerRoutes(
      createComputerGateway({
        provider: createDeviceComputerProvider(),
        auditStore: { insert: async () => undefined },
        policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
        resolveDevice: async () => {
          throw new Error("no paired machine");
        },
        deviceApps: async () => [],
      }),
      {} as PolicyStore,
      asActor(owner),
      async () => true,
    );
    const response = await routes.request(
      "http://openbot.test/bot-1/local-tools",
    );
    expect(await response.json()).toEqual({
      allowed: false,
      machine: "device",
    });
  });
});

describe("where the shell and file tools say they act", () => {
  const described = (machine: "device" | "workspace") =>
    new Map(
      createHeadlessComputerTools({
        gateway: {} as never,
        botId: "bot-1",
        actor: { id: OWNER },
        machine,
      }).map((tool) => [tool.definition.name, tool.definition.description]),
    );

  test("the unattended run words them from the shared file the web chat reads", () => {
    const device = described("device");
    expect(device.get("computer_run_command")).toBe(
      DEVICE_RUN_COMMAND_DESCRIPTION,
    );
    expect(device.get("computer_list_files")).toContain(
      computerToolPlace("device"),
    );
    expect(described("workspace").get("computer_run_command")).toBe(
      WORKSPACE_RUN_COMMAND_DESCRIPTION,
    );
    expect(described("workspace").get("computer_list_files")).toContain(
      computerToolPlace("workspace"),
    );
  });
});
