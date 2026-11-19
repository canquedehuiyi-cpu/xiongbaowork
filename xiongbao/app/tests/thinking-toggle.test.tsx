import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { useProfileSave } from "@/components/agents/agent-dialog";
import { ThinkingItem } from "@/components/agents/thinking-item";
import type { AgentProfile } from "@/lib/agents/queries";
import { THINKING_HINT, THINKING_LABEL } from "../../shared/thinking";
import { settleReactWork } from "./settle-react-work";

/**
 * 员工设置里的「思考模式」开关（期三）：在「模型」那一节，默认开；拨一下马上换过来并保存（`PATCH`），没存上就拨回去
 * 并说为什么；远端员工（不在本部署上跑）的模型由它自己的服务器决定，开关拨不动，并说明原因。
 */

const originalFetch = globalThis.fetch;
let patched: unknown[] = [];
let failPatch = false;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost/");
      if (url.pathname === "/api/agents/a1" && init?.method === "PATCH") {
        patched.push(JSON.parse(String(init.body)));
        return failPatch
          ? Response.json({ error: "服务器开小差了" }, { status: 500 })
          : Response.json({ agent: { ...agent, thinking: false } });
      }
      return Response.json({ error: "not served" }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  cleanup();
  patched = [];
  failPatch = false;
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const agent = {
  id: "a1",
  name: "小研",
  title: "调研员",
  roleDescription: "你负责调研。",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  canManage: true,
  hasAuth: false,
  modelRef: null,
  avatarSeed: "a1",
} as unknown as AgentProfile;

/** 设置页的接法：开关的保存走员工资料的同一个保存（`useProfileSave`）。 */
function Harness({ profile }: { profile: AgentProfile }) {
  const { save } = useProfileSave(profile.id, profile);
  return (
    <ThinkingItem agent={profile} onSave={(thinking) => save({ thinking })} />
  );
}

function draw(profile: AgentProfile) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness profile={profile} />
    </QueryClientProvider>,
  );
}

test("a coworker nobody has touched thinks, and the switch says so in the shared words", () => {
  const view = draw(agent);
  expect(view.getByText(THINKING_LABEL)).toBeTruthy();
  expect(view.getByText(THINKING_HINT)).toBeTruthy();
  const toggle = view.getByRole("switch", { name: THINKING_LABEL });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
});

test("switching it off saves thinking: false with the coworker's other facts", async () => {
  const view = draw({ ...agent, thinking: true } as AgentProfile);
  const toggle = view.getByRole("switch", { name: THINKING_LABEL });
  await act(async () => {
    fireEvent.click(toggle);
  });
  // 马上换过来，不等服务器。
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await waitFor(() => expect(patched).toHaveLength(1));
  expect(patched[0]).toMatchObject({ name: "小研", thinking: false });
});

test("a save that fails switches it back and says why", async () => {
  failPatch = true;
  const view = draw(agent);
  const toggle = view.getByRole("switch", { name: THINKING_LABEL });
  await act(async () => {
    fireEvent.click(toggle);
  });
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  expect((await view.findByRole("alert")).textContent).toContain(
    "服务器开小差了",
  );
});

test("a remote coworker's switch cannot be moved, and the row says why", () => {
  const view = draw({ ...agent, builtIn: false } as AgentProfile);
  const toggle = view.getByRole("switch", { name: THINKING_LABEL });
  expect(
    toggle.getAttribute("aria-disabled") ??
      toggle.getAttribute("data-disabled"),
  ).not.toBeNull();
  expect(view.getByText(/运行在它自己的端点上/)).toBeTruthy();
});
