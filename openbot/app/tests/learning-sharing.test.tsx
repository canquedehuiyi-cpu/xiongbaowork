import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { PersonalLearningSharing } from "@openbot/shared/learning";
import { environmentManager, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  LearningSharing,
  SHARING_CHOICES,
} from "@/components/settings/learning-sharing";
import { queryClient } from "@/query-client";

let wasServer = true;
beforeAll(() => {
  GlobalRegistrator.register();
  wasServer = environmentManager.isServer();
  environmentManager.setIsServer(() => false);
});
afterAll(() => {
  environmentManager.setIsServer(() => wasServer);
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
let answer: PersonalLearningSharing;
let failRead = false;
let failWrite = false;
let edition: "team" | "personal" = "team";
const fetched: string[] = [];
const sent: { path: string; method: string; body: unknown }[] = [];

beforeEach(() => {
  queryClient.clear();
  sent.length = 0;
  fetched.length = 0;
  failRead = false;
  failWrite = false;
  edition = "team";
  answer = {
    mode: "closed",
    sharingAllowed: true,
    skills: [
      {
        name: "refund-order",
        description: "Refunds an order.",
        open: false,
        approvedBy: null,
        sharing: "none",
      },
      {
        name: "close-ticket",
        description: "Closes a ticket.",
        open: true,
        approvedBy: null,
        sharing: "none",
      },
    ],
  };
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      const method = init?.method ?? "GET";
      if (method === "PUT") {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        sent.push({ path: url, method, body });
        if (failWrite)
          return Response.json(
            { error: "Your Learning settings could not be saved." },
            { status: 503 },
          );
        if (url === "/api/settings/learning/mode")
          answer = { ...answer, mode: body.mode };
        const skill = /^\/api\/settings\/learning\/skills\/(.+)$/.exec(url);
        if (skill && answer.skills)
          answer = {
            ...answer,
            skills: answer.skills.map((entry) =>
              entry.name === decodeURIComponent(skill[1] ?? "")
                ? { ...entry, open: body.open }
                : entry,
            ),
          };
        return Response.json({ ok: true });
      }
      const detail = /^\/api\/settings\/learning\/skills\/(.+)$/.exec(url);
      if (detail) {
        const name = decodeURIComponent(detail[1] ?? "");
        fetched.push(url);
        return Response.json({
          skill: {
            name,
            description: "Refunds an order.",
            files: [
              {
                path: "SKILL.md",
                text: `---\nname: ${name}\n---\nStep one: look up the order.`,
              },
            ],
          },
        });
      }
      if (url === "/api/capabilities") return Response.json({ edition });
      if (url === "/api/settings/learning") {
        if (failRead) return new Response(null, { status: 500 });
        return Response.json(answer);
      }
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

function draw() {
  return render(
    <QueryClientProvider client={queryClient}>
      <LearningSharing />
    </QueryClientProvider>,
  );
}

/** The choice row whose title is `title`: one pressed button of three. */
const choice = (view: ReturnType<typeof draw>, title: string) =>
  choices(view).find((element) =>
    element.textContent?.includes(title),
  ) as HTMLElement;
const choices = (view: ReturnType<typeof draw>) =>
  view
    .getAllByRole("button")
    .filter((element) => element.hasAttribute("aria-pressed"));

test("three choices, each with one plain line saying who sees what", async () => {
  const view = draw();
  await view.findByText("还有谁的员工能用你的技能");
  expect(choices(view)).toHaveLength(3);
  for (const choice of SHARING_CHOICES) {
    expect(view.getByText(choice.title)).toBeTruthy();
    expect(view.getByText(choice.description)).toBeTruthy();
  }
  expect(view.getByText("只有你用的员工会用到你的技能。")).toBeTruthy();
  expect(view.getByText("熊宝上的每位员工都会用到你的全部技能。")).toBeTruthy();
});

test("closed is the default: Only my Bots is checked and your skills are listed without switches", async () => {
  const view = draw();
  await view.findByText("只给我的员工");
  expect(choice(view, "只给我的员工").getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(choice(view, "所有人的员工").getAttribute("aria-pressed")).toBe(
    "false",
  );
  expect(view.getByText("你的技能")).toBeTruthy();
  expect(view.getByText("Refund order")).toBeTruthy();
  expect(view.queryByRole("switch")).toBeNull();
});

test("Your skills shows in every sharing mode", async () => {
  for (const mode of ["closed", "open", "choose"] as const) {
    queryClient.clear();
    answer = { ...answer, mode };
    const view = draw();
    await view.findByText("你的技能");
    expect(view.getByText("Refund order")).toBeTruthy();
    expect(view.getByText("Close ticket")).toBeTruthy();
    expect(view.queryAllByRole("switch")).toHaveLength(
      mode === "choose" ? 2 : 0,
    );
    expect(
      view.getByText("Closes a ticket.", { exact: mode !== "choose" }),
    ).toBeTruthy();
    if (mode !== "choose") {
      expect(view.queryByText(/所有员工都可以用它/)).toBeNull();
      expect(view.queryByText(/只有你的员工会用它/)).toBeNull();
    }
    cleanup();
  }
});

test("choosing Everyone's Bots saves open at once", async () => {
  const view = draw();
  await view.findByText("只给我的员工");
  fireEvent.click(choice(view, "所有人的员工"));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/settings/learning/mode",
      method: "PUT",
      body: { mode: "open" },
    }),
  );
  await waitFor(() =>
    expect(choice(view, "所有人的员工").getAttribute("aria-pressed")).toBe(
      "true",
    ),
  );
});

test("pressing the choice already made saves nothing", async () => {
  const view = draw();
  await view.findByText("只给我的员工");
  fireEvent.click(choice(view, "只给我的员工"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sent).toEqual([]);
});

test("under The skills I choose, each skill in your space has a switch that opens it to everyone", async () => {
  answer = { ...answer, mode: "choose" };
  const view = draw();
  await view.findByText("你的技能");
  const refund = view.getByRole("switch", {
    name: "向所有人公开「Refund order」",
  });
  const close = view.getByRole("switch", {
    name: "向所有人公开「Close ticket」",
  });
  expect(refund.getAttribute("aria-checked")).toBe("false");
  expect(close.getAttribute("aria-checked")).toBe("true");
  expect(
    view.getByText(/只有你的员工会用它。 Refunds an order\./),
  ).toBeTruthy();
  expect(view.getByText(/所有员工都可以用它。 Closes a ticket\./)).toBeTruthy();
  fireEvent.click(refund);
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/settings/learning/skills/refund-order",
      method: "PUT",
      body: { open: true },
    }),
  );
  await waitFor(() =>
    expect(
      view
        .getByRole("switch", { name: "向所有人公开「Refund order」" })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
});

test("a space with no skills yet says so plainly", async () => {
  answer = { mode: "choose", sharingAllowed: true, skills: [] };
  const view = draw();
  await view.findByText(
    "还没有从你的录制里学到技能。学到之后，你在这里公开的每一项都会提供给所有员工。",
  );
  expect(view.queryByRole("switch")).toBeNull();
});

test("Skills Intelligence did not deliver show a plain unavailable line, and the choice still works", async () => {
  answer = {
    mode: "choose",
    sharingAllowed: true,
    skills: null,
    unavailable: "unavailable",
  };
  const view = draw();
  await view.findByText(
    "刚才没能从后端读到你的技能。你在上面的选择对它们仍然有效。",
  );
  fireEvent.click(choice(view, "只给我的员工"));
  await waitFor(() =>
    expect(sent).toContainEqual({
      path: "/api/settings/learning/mode",
      method: "PUT",
      body: { mode: "closed" },
    }),
  );
});

test("Automatic learning off says no skills are learned", async () => {
  answer = {
    mode: "choose",
    sharingAllowed: true,
    skills: null,
    unavailable: "off",
  };
  const view = draw();
  await view.findByText("管理员关闭了自动学习，所以不会从你的录制里学习技能。");
});

test("until an admin turns on skill sharing, it says so plainly and only Only my Bots can be chosen", async () => {
  answer = { ...answer, sharingAllowed: false };
  const view = draw();
  await view.findByText(
    "管理员还没开启向所有员工共享技能，所以只有你用的员工会用到你的技能。",
  );
  expect(choice(view, "只给我的员工").hasAttribute("disabled")).toBe(false);
  for (const title of ["所有人的员工", "我挑选的技能"]) {
    expect(choice(view, title).hasAttribute("disabled")).toBe(true);
    fireEvent.click(choice(view, title));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sent).toEqual([]);
});

test("a choice made before sharing was turned off says it applies again, and an open skill can be closed but none opened", async () => {
  answer = { ...answer, mode: "choose", sharingAllowed: false };
  const view = draw();
  await view.findByText(
    "管理员还没开启向所有员工共享技能，所以只有你用的员工会用到你的技能。管理员开启后，你在下面的选择会重新生效。",
  );
  const refund = view.getByRole("switch", {
    name: "向所有人公开「Refund order」",
  });
  const close = view.getByRole("switch", {
    name: "向所有人公开「Close ticket」",
  });
  expect(refund.hasAttribute("data-disabled")).toBe(true);
  expect(close.hasAttribute("data-disabled")).toBe(false);
  fireEvent.click(refund);
  fireEvent.click(close);
  await waitFor(() =>
    expect(sent).toEqual([
      {
        path: "/api/settings/learning/skills/close-ticket",
        method: "PUT",
        body: { open: false },
      },
    ]),
  );
});

test("a read that fails says so, and a save that fails says why", async () => {
  failRead = true;
  const failed = draw();
  await failed.findByText("读不到你的学习设置。请刷新页面。");
  cleanup();
  queryClient.clear();
  failRead = false;
  failWrite = true;
  const view = draw();
  await view.findByText("只给我的员工");
  fireEvent.click(choice(view, "所有人的员工"));
  await view.findByText("Your Learning settings could not be saved.");
});

test("each of Your skills opens its SKILL.md", async () => {
  answer = { ...answer, mode: "choose" };
  const view = draw();
  await view.findByText("你的技能");
  // Toggling the switch does not open the Skill.
  fireEvent.click(
    view.getByRole("switch", { name: "向所有人公开「Refund order」" }),
  );
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(fetched).toEqual([]);
  expect(view.queryByText(/Step one: look up the order/)).toBeNull();
  // Pressing the row does.
  fireEvent.click(view.getByRole("button", { name: /Refund order/ }));
  await view.findByText(/Step one: look up the order/);
  expect(fetched).toEqual(["/api/settings/learning/skills/refund-order"]);
});

test("pressing a Your skills row opens its SKILL.md where there is no switch", async () => {
  answer = { ...answer, mode: "closed" };
  const view = draw();
  await view.findByText("你的技能");
  expect(view.queryByRole("switch")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: /Refund order/ }));
  await view.findByText(/Step one: look up the order/);
  expect(fetched).toEqual(["/api/settings/learning/skills/refund-order"]);
});

/** Fetch stub that records POSTs, on top of the default one. */
function recordPosts() {
  const posts: string[] = [];
  const inner = global.fetch;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(String(path));
        return Response.json({ ok: true });
      }
      return inner(path, init);
    },
    { preconnect: originalFetch.preconnect },
  );
  return posts;
}

const approvedByPerson = (
  name: string,
  open: boolean,
  sharing: "none" | "requested" | "approved" | "declined",
) => ({
  name,
  description: `${name} description.`,
  open,
  approvedBy: "person" as const,
  sharing,
});

test("under Everyone's Bots, a skill waiting for an admin has one control: Ask to share", async () => {
  answer = {
    ...answer,
    mode: "open",
    skills: [
      approvedByPerson("refund-order", false, "none"),
      approvedByPerson("close-ticket", true, "requested"),
      {
        name: "reopen-ticket",
        description: "Reopens a ticket.",
        open: false,
        approvedBy: "admin",
        sharing: "none",
      },
    ],
  };
  const posts = recordPosts();
  const view = draw();
  await view.findByText("Refund order");
  expect(view.queryAllByRole("switch")).toHaveLength(0);
  expect(view.getAllByRole("button", { name: "申请共享" })).toHaveLength(1);
  expect(view.getByText("已申请共享")).toBeTruthy();
  const refundRow = view.getByText("Refund order").closest("button");
  expect(refundRow?.textContent).toContain("只有你的员工会用它。");
  // Scoped to the row itself: the title div's own closest("div") would be the title.
  const reopenRow = view
    .getByText("Reopen ticket")
    .closest('[data-slot="item"]') as HTMLElement;
  expect(reopenRow.textContent).toContain("Reopens a ticket.");
  expect(reopenRow.textContent).not.toContain("只有你的员工会用它。");
  fireEvent.click(view.getByRole("button", { name: "申请共享" }));
  await waitFor(() =>
    expect(posts).toEqual([
      "/api/settings/learning/skills/refund-order/share-request",
    ]),
  );
});

test("under The skills I choose, every skill keeps its switch, including ones waiting for an admin", async () => {
  answer = {
    ...answer,
    mode: "choose",
    skills: [
      approvedByPerson("refund-order", false, "none"),
      approvedByPerson("close-ticket", true, "requested"),
      {
        name: "reopen-ticket",
        description: "Reopens a ticket.",
        open: false,
        approvedBy: "admin",
        sharing: "none",
      },
    ],
  };
  const view = draw();
  await view.findByText("Refund order");
  expect(view.getAllByRole("switch")).toHaveLength(3);
  expect(view.queryByRole("button", { name: "申请共享" })).toBeNull();
  expect(view.getByText("已申请共享")).toBeTruthy();
  expect(view.queryByText(/所有员工都可以用它/)).toBeNull();
  expect(view.getAllByText(/只有你的员工会用它/)).toHaveLength(3);
});

test("an open skill waiting for an admin can be closed", async () => {
  answer = {
    ...answer,
    mode: "choose",
    skills: [approvedByPerson("close-ticket", true, "none")],
  };
  const view = draw();
  const toggle = await view.findByRole("switch", {
    name: "向所有人公开「Close ticket」",
  });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(sent).toEqual([
      {
        path: "/api/settings/learning/skills/close-ticket",
        method: "PUT",
        body: { open: false },
      },
    ]),
  );
});

test("switching on a skill waiting for an admin opens it and asks to share", async () => {
  answer = {
    ...answer,
    mode: "choose",
    skills: [approvedByPerson("refund-order", false, "none")],
  };
  const posts = recordPosts();
  const view = draw();
  fireEvent.click(
    await view.findByRole("switch", { name: "向所有人公开「Refund order」" }),
  );
  await waitFor(() =>
    expect(posts).toEqual([
      "/api/settings/learning/skills/refund-order/share-request",
    ]),
  );
  expect(sent).toEqual([
    {
      path: "/api/settings/learning/skills/refund-order",
      method: "PUT",
      body: { open: true },
    },
  ]);
});

test("a skill already asked about is switched on without a second request", async () => {
  answer = {
    ...answer,
    mode: "choose",
    skills: [approvedByPerson("refund-order", false, "requested")],
  };
  const posts = recordPosts();
  const view = draw();
  fireEvent.click(
    await view.findByRole("switch", { name: "向所有人公开「Refund order」" }),
  );
  await waitFor(() => expect(sent).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(posts).toEqual([]);
});

test("while an admin has sharing off, Your skills says only your Bots use them, whatever the saved mode", async () => {
  for (const mode of ["open", "choose"] as const) {
    queryClient.clear();
    answer = { ...answer, mode, sharingAllowed: false };
    const view = draw();
    await view.findByText("你的技能");
    expect(view.getByText("只有你用的员工会用到这些技能。")).toBeTruthy();
    expect(view.queryByText(/Every Bot on OpenBot draws on these/)).toBeNull();
    expect(view.queryByText(/公开一项技能，熊宝上的每位员工/)).toBeNull();
    expect(view.queryByText(/所有员工都可以用它/)).toBeNull();
    if (mode === "choose")
      expect(view.getAllByText(/只有你的员工会用它/)).toHaveLength(2);
    cleanup();
  }
});

test("the personal edition lists Your skills with no sharing choice and no switches", async () => {
  edition = "personal";
  answer = {
    ...answer,
    mode: "choose",
    skills: [
      {
        name: "refund-order",
        description: "Refunds an order.",
        open: false,
        approvedBy: "person",
        sharing: "none",
      },
      {
        name: "close-ticket",
        description: "Closes a ticket.",
        open: true,
        approvedBy: "admin",
        sharing: "approved",
      },
    ],
  };
  const view = draw();
  await view.findByText("你的技能");
  await view.findByText("Refund order");
  expect(view.queryByText("还有谁的员工能用你的技能")).toBeNull();
  expect(choices(view)).toHaveLength(0);
  expect(view.queryAllByRole("switch")).toHaveLength(0);
  expect(view.queryByRole("button", { name: "申请共享" })).toBeNull();
  expect(view.queryByText(/Bots use it|Every Bot|Asked to share/)).toBeNull();
  expect(
    view.queryByText(/Only the Bots you use|Open a skill to let/),
  ).toBeNull();
  fireEvent.click(view.getByRole("button", { name: /Refund order/ }));
  await view.findByText(/Step one: look up the order/);
  expect(fetched).toEqual(["/api/settings/learning/skills/refund-order"]);
});
