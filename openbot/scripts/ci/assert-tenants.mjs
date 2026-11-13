// HTTP-only acceptance against the disposable B container. No chat/provider calls.
import { randomUUID } from "node:crypto";

const origin = process.argv[2];
if (origin !== "http://127.0.0.1:3772") {
  throw new Error(
    "Tenant smoke requires the disposable B origin on port 3772.",
  );
}
let failures = 0;
let assertions = 0;
function check(ok, name) {
  assertions++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failures++;
}
async function request(path, cookie, body, method) {
  const response = await fetch(`${origin}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000),
  });
  return { response, value: await response.json().catch(() => null) };
}
async function register(label) {
  const { response, value } = await request("/api/auth/sign-up/email", "", {
    name: `Delivery ${label}`,
    email: `delivery-${label}-${randomUUID()}@example.test`,
    password: randomUUID(),
  });
  const cookie = response.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0])
    .join("; ");
  check(
    response.status === 200 && Boolean(value.user?.id),
    `${label} signup 200`,
  );
  check(Boolean(cookie), `${label} session cookie issued`);
  if (!cookie || !value.user?.id) throw new Error(`${label} signup incomplete`);
  return cookie;
}
const a = await register("A");
const b = await register("B");
const businessPaths = [
  "/api/tasks",
  "/api/models",
  "/api/quota",
  "/api/devices",
  "/api/waker-groups",
  "/api/group-pipelines/templates",
  "/api/personas",
  "/api/agents/general-assistant/autonomous",
];
for (const path of businessPaths) {
  const own = await request(path, a);
  check(
    own.response.status === 200 &&
      own.response.headers.get("content-type")?.includes("application/json") &&
      Boolean(own.value),
    `A ${path} 200 JSON`,
  );
  const anonymous = await request(path, "");
  check(
    anonymous.response.status === 401 &&
      anonymous.value?.error === "Authentication required.",
    `anonymous ${path} 401`,
  );
}
// G2, no escalation: B cannot rename or dissolve A's crew (group-unify 6.4). The refusal is the
// same 404 an unknown id gets, and afterwards A still lists it under its own name.
const crewName = `交付隔离群组-${randomUUID().slice(0, 8)}`;
const crew = await request("/api/waker-groups", a, { name: crewName });
const crewId = crew.value?.group?.id;
if (crew.response.status !== 201 || !crewId)
  throw new Error("Group creation returned no id");
const crewPath = `/api/waker-groups/${encodeURIComponent(crewId)}`;
const foreignRename = await request(
  crewPath,
  b,
  { name: "被他人改名" },
  "PATCH",
);
check(foreignRename.response.status === 404, "B renaming A group returns 404");
const foreignDissolve = await request(crewPath, b, undefined, "DELETE");
check(
  foreignDissolve.response.status === 404,
  "B dissolving A group returns 404",
);
const crewsAfter = await request("/api/waker-groups", a);
check(
  crewsAfter.response.status === 200 &&
    crewsAfter.value?.groups?.some(
      (group) => group.id === crewId && group.name === crewName,
    ) === true,
  "A group still present and unchanged after B's attempts",
);
const input = {
  name: "交付隔离验证员工",
  title: "部署验证",
  roleDescription: "仅验证存储与权限，不执行任务。",
  visibility: "private",
};
const first = await request("/api/agents", a, input);
check(first.response.status === 201, "A first private employee created 201");
const id = first.value.agent?.id;
if (!id) throw new Error("Private employee creation returned no id");
const list = await request("/api/agents", b);
check(
  list.response.status === 200 &&
    Array.isArray(list.value.agents) &&
    !list.value.agents.some((agent) => agent.id === id),
  "B list excludes A private employee",
);
const hidden = await request(`/api/agents/${encodeURIComponent(id)}`, b);
check(
  hidden.response.status === 404,
  "B reading A private employee returns 404",
);
const ownSummary = await request(
  `/api/agents/${encodeURIComponent(id)}/autonomous`,
  a,
);
check(
  ownSummary.response.status === 200 &&
    ownSummary.value?.autonomous?.agentId === id,
  "A own private autonomous resource returns 200",
);
const foreignSummary = await request(
  `/api/agents/${encodeURIComponent(id)}/autonomous`,
  b,
);
check(
  foreignSummary.response.status === 404 &&
    foreignSummary.value?.error === "No such coworker.",
  "B reading A private autonomous resource returns 404",
);
const unknownSummary = await request(
  `/api/agents/missing-${randomUUID()}/autonomous`,
  a,
);
check(
  unknownSummary.response.status === 404,
  "unknown autonomous coworker returns 404",
);
// G2, no escalation: B cannot change or remove A's private employee. The refusal is the same 404 a
// read gets (no hint the row exists), and afterwards A still has it, unchanged.
const agentPath = `/api/agents/${encodeURIComponent(id)}`;
const foreignEdit = await request(
  agentPath,
  b,
  { ...input, name: "被他人改名" },
  "PATCH",
);
check(
  foreignEdit.response.status === 404,
  "B editing A private employee returns 404",
);
const foreignDelete = await request(agentPath, b, undefined, "DELETE");
check(
  foreignDelete.response.status === 404,
  "B deleting A private employee returns 404",
);
const afterward = await request(agentPath, a);
check(
  afterward.response.status === 200 &&
    afterward.value?.agent?.id === id &&
    afterward.value.agent.name === input.name,
  "A private employee still present and unchanged after B's attempts",
);
const anonymousCreate = await request("/api/agents", "", input);
check(
  anonymousCreate.response.status === 401,
  "anonymous employee creation 401",
);
// G2, no escalation: a signed-in person who is not an administrator is refused every administrator
// and operator door, including the two that would make them one (role) or hand out a tier (plan).
const users = await request("/api/admin/people", a);
check(users.response.status === 403, "non-admin GET /api/admin/people 403");
for (const [path, body] of [
  ["/api/admin/status", undefined],
  ["/api/admin/audit-events", undefined],
  ["/api/platform/tenants", undefined],
  [
    `/api/admin/people/${encodeURIComponent(randomUUID())}/role`,
    { role: "admin" },
  ],
  ["/api/quota/plan", { planId: "pro" }],
]) {
  const denied = await request(path, b, body);
  check(
    denied.response.status === 403,
    `non-admin ${body === undefined ? "GET" : "POST"} ${path.replace(/people\/[^/]+/, "people/:id")} 403`,
  );
}
const quotaAfter = await request("/api/quota", b);
check(
  quotaAfter.response.status === 200 && quotaAfter.value?.plan?.id === "free",
  "B still on the free plan after the refused switch",
);
for (const path of ["/api", "/api/missing-delivery-route"]) {
  check(
    (await request(path, a)).response.status === 404,
    `${path} stays 404 after authentication`,
  );
}
const second = await request("/api/agents", a, {
  ...input,
  name: "第二位验证员工",
});
check(second.response.status === 201, "A second private employee created 201");
const third = await request("/api/agents", a, {
  ...input,
  name: "第三位验证员工",
});
check(
  third.response.status === 402 &&
    third.value.code === "quota_exceeded" &&
    third.value.used === 2 &&
    third.value.limit === 2,
  "Free third employee returns 402 quota_exceeded used=2 limit=2",
);
console.log(
  `TENANTS assertions=${assertions} failed=${failures}; provider calls=0`,
);
process.exitCode = failures ? 1 : 0;
