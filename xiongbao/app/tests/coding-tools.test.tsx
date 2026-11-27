import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { z } from "zod";
import { CHAT_RUNTIME_HOOK } from "./chat-runtime-hook";
import { settleReactWork } from "./settle-react-work";

/**
 * 期五: the web chat's computer tools for coding. A command may ask for up to ten minutes
 * (`timeoutMs`, cut to ten when more is asked, two by default), on the same terms as the unattended
 * tool.
 */

const real = await import("@copilotkit/react-core/v2");
// A frozen copy, put back in `afterAll`: `mock.module` is process-wide (see approval-tools.test.tsx).
const original = { ...real };
type Registered = Parameters<typeof real.useFrontendTool>[0];
let registered = new Map<string, Registered>();
mock.module("@copilotkit/react-core/v2", () => ({
  ...original,
  [CHAT_RUNTIME_HOOK]: () => ({ copilotkit: { stopAgent: () => undefined } }),
  useFrontendTool: (tool: Registered) => {
    registered.set(tool.name, tool);
  },
}));
// Stood in for, as local-tools.test.tsx does: another file may replace this module for good.
const activeBot = { ...(await import("@/lib/copilot/active-bot")) };
const holder = { current: "bot-1" };
mock.module("@/lib/copilot/active-bot", () => ({
  ...activeBot,
  useActiveBotHolder: () => holder,
  useActiveBotId: () => "bot-1",
  useDeclaredBotId: () => "bot-1",
}));
const { ComputerTools } = await import("@/lib/copilot/computer-tools");

let registeredHere = false;
beforeAll(() => {
  if (!("document" in globalThis)) {
    GlobalRegistrator.register();
    registeredHere = true;
  }
});
afterEach(cleanup);
afterAll(async () => {
  mock.module("@copilotkit/react-core/v2", () => original);
  mock.module("@/lib/copilot/active-bot", () => activeBot);
  if (!registeredHere) return;
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
let requests: { path: string; method: string; body: unknown }[] = [];
let answers: Record<string, () => Response> = {};
afterEach(() => {
  global.fetch = originalFetch;
});

function serve(routes: Record<string, () => Response>) {
  requests = [];
  answers = routes;
  global.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = String(input);
      requests.push({
        path,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const answer = answers[path];
      return answer
        ? answer()
        : Response.json({ error: "Not here." }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
}

let queries = new QueryClient();

async function mount() {
  registered = new Map();
  serve({
    "/api/computers/bot-1/local-tools": () =>
      Response.json({ allowed: false, machine: "workspace" }),
  });
  queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    render(
      <QueryClientProvider client={queries}>
        <ComputerTools />
      </QueryClientProvider>,
    );
  });
  await waitFor(() => expect(queries.isFetching()).toBe(0));
  await settleReactWork();
}

const posted = () => requests.filter((request) => request.method === "POST");

test("the shell tool offers timeoutMs, and sends what was asked, the default, or ten minutes", async () => {
  await mount();
  const run = registered.get("computer_run_command");
  const parameters = z.toJSONSchema(run?.parameters as z.ZodType) as {
    properties: Record<string, { description?: string }>;
    required?: string[];
  };
  expect(Object.keys(parameters.properties)).toEqual(["command", "timeoutMs"]);
  expect(parameters.required).toEqual(["command"]);
  expect(parameters.properties.timeoutMs?.description).toContain("600000");

  answers["/api/computers/bot-1/exec"] = () =>
    Response.json({ command: "bun test", exitCode: 0, stdout: "", stderr: "" });
  requests = [];
  for (const args of [
    { command: "bun test", timeoutMs: 300_000 },
    { command: "bun test" },
    { command: "bun test", timeoutMs: 3_600_000 },
  ])
    await run?.handler?.(args as never, {} as never);
  expect(posted().map((request) => request.body)).toEqual([
    { command: "bun test", timeoutMs: 300_000 },
    { command: "bun test", timeoutMs: 120_000 },
    { command: "bun test", timeoutMs: 600_000 },
  ]);
});

test("the coding tools are offered beside the file tools, and each goes to its own route", async () => {
  await mount();
  const parameters = (name: string) =>
    Object.keys(
      (
        z.toJSONSchema(registered.get(name)?.parameters as z.ZodType) as {
          properties: object;
        }
      ).properties,
    );
  expect(parameters("computer_edit_file")).toEqual([
    "path",
    "old_string",
    "new_string",
    "replace_all",
  ]);
  expect(parameters("computer_grep")).toEqual([
    "pattern",
    "path",
    "glob",
    "ignore_case",
  ]);
  expect(parameters("computer_glob")).toEqual(["pattern", "path"]);
  expect(parameters("computer_read_file")).toEqual(["path", "offset", "limit"]);
  expect(registered.get("computer_read_file")?.description).toContain("offset");

  for (const route of ["read", "edit", "grep", "glob"])
    answers[`/api/computers/bot-1/files/${route}`] = () => Response.json({});
  requests = [];
  const calls = [
    ["computer_read_file", { path: "src/a.ts", offset: 10, limit: 20 }],
    [
      "computer_edit_file",
      { path: "src/a.ts", old_string: "a", new_string: "b" },
    ],
    ["computer_grep", { pattern: "TODO", glob: "*.ts", ignore_case: true }],
    ["computer_glob", { pattern: "src/**/*.ts" }],
  ] as const;
  for (const [name, args] of calls)
    await registered.get(name)?.handler?.(args as never, {} as never);
  expect(posted()).toEqual(
    calls.map(([name, args]) => ({
      path: `/api/computers/bot-1/files/${name.replace(/^computer_|_file$/g, "")}`,
      method: "POST",
      body: args,
    })),
  );
});

test("an edit is a change, asked about through the gate; the searches change nothing", async () => {
  const { viewOfTool } = await import("@/lib/computers/panel-view");
  for (const name of ["computer_edit_file", "computer_grep", "computer_glob"])
    expect(viewOfTool(name)).toBeUndefined();
  const source = await Bun.file(
    new URL("../src/lib/copilot/approval-tools.tsx", import.meta.url),
  ).text();
  const writes = source.slice(
    source.indexOf("const writes = new Set(["),
    source.indexOf("]);", source.indexOf("const writes = new Set([")),
  );
  expect(writes).toContain('"computer_edit_file"');
  expect(writes).not.toContain('"computer_grep"');
  expect(writes).not.toContain('"computer_glob"');
});
