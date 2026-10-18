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
async function request(path, cookie, body) {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
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
