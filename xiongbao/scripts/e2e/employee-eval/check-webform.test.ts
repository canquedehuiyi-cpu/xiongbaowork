import { afterAll, afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { checkWebform } from "./check-webform";
import { cleanup, emptyDir, failed, untouched, write } from "./test-support";
import {
  sealReceived,
  startWebformSite,
  type WebformSite,
} from "./webform-site";

const sites: WebformSite[] = [];
afterEach(() => {
  for (const site of sites.splice(0)) site.stop();
});
afterAll(cleanup);

const site = () => {
  const started = startWebformSite();
  sites.push(started);
  return started;
};

const GOOD = {
  full_name: "周明远",
  work_email: "zhou.mingyuan@example.test",
  department: "mkt",
  start_date: "2026-12-07",
  laptop: "mac14",
  monitor: "yes",
  emergency_name: "周丽华",
  emergency_phone: "138-0000-2468",
};

/** 一个照着页面做事的员工：先读登记页拿 ticket，提交第一步，跟着跳转，提交第二步，读回执号。 */
async function register(
  started: WebformSite,
  change: Partial<typeof GOOD> = {},
  as: "form" | "json" = "form",
) {
  const data = { ...GOOD, ...change };
  const html = await (await fetch(`${started.url}/register`)).text();
  const ticket = /name="ticket" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const send = (path: string, body: Record<string, string>) =>
    as === "json"
      ? fetch(`${started.url}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      : fetch(`${started.url}${path}`, {
          method: "POST",
          body: new URLSearchParams(body),
        });
  const step1 = await send("/register", {
    ticket,
    full_name: data.full_name,
    work_email: data.work_email,
    department: data.department,
    start_date: data.start_date,
  });
  const draft =
    /name="draft" value="([^"]+)"/.exec(await step1.text())?.[1] ?? "";
  const step2 = await send("/register/devices", {
    draft,
    laptop: data.laptop,
    monitor: data.monitor,
    emergency_name: data.emergency_name,
    emergency_phone: data.emergency_phone,
  });
  const receipt = /id="receipt">([^<]+)</.exec(await step2.text())?.[1] ?? "";
  return { step1: step1.status, step2: step2.status, receipt };
}

function judged(started: WebformSite, receipt: string | null) {
  const dir = untouched("webform", { SITE_URL: started.url });
  if (receipt !== null) write(dir, "receipt.txt", `${receipt}\n`);
  sealReceived(started, dir);
  return dir;
}

test("the task text carries the site address the runner filled in", async () => {
  const started = site();
  const dir = untouched("webform", { SITE_URL: started.url });
  const text = await Bun.file(join(dir, "TASK.md")).text();
  expect(text).toContain(started.url);
  expect(text).not.toContain("{{SITE_URL}}");
});

test("the standard answer passes every check, by form post or by JSON", async () => {
  for (const as of ["form", "json"] as const) {
    const started = site();
    const done = await register(started, {}, as);
    expect(done.step2).toBe(200);
    const outcome = checkWebform(judged(started, done.receipt));
    expect(failed(outcome)).toEqual([]);
    expect(outcome.passed).toBe(true);
  }
});

test("an empty directory and an employee who never submitted fail", () => {
  expect(failed(checkWebform(emptyDir()))).toEqual([
    "读到了服务端收到的记录",
    "服务端接受了一次、也只接受了一次登记",
    "接受下来的资料与有效资料一致",
    "receipt.txt 里是服务端发出的回执号",
  ]);
  const started = site();
  const outcome = checkWebform(judged(started, null));
  expect(outcome.passed).toBe(false);
  expect(failed(outcome)).not.toContain("读到了服务端收到的记录");
});

test("the traps in the notes: the old phone number, the 16-inch laptop, the wrong department", async () => {
  const started = site();
  const done = await register(started, {
    emergency_phone: "138-0000-1357",
    laptop: "mac16",
    department: "eng",
  });
  const outcome = checkWebform(judged(started, done.receipt));
  expect(failed(outcome)).toEqual(["接受下来的资料与有效资料一致"]);
  const detail = outcome.checks.find((item) => !item.ok)?.detail ?? "";
  expect(detail).toContain("emergency_phone");
  expect(detail).toContain("laptop");
  expect(detail).toContain("department");
});

test("a made-up receipt number fails; the real one passes", async () => {
  const started = site();
  const done = await register(started);
  expect(done.receipt).toMatch(/^RCPT-[0-9A-F]{6}$/);
  expect(failed(checkWebform(judged(started, "RCPT-000000")))).toEqual([
    "receipt.txt 里是服务端发出的回执号",
  ]);
});

test("the site refuses bad input, so guessing does not get through", async () => {
  const started = site();
  const bareStep1 = await fetch(`${started.url}/register`, {
    method: "POST",
    body: new URLSearchParams({ ...GOOD }),
  });
  expect(bareStep1.status).toBe(422);
  const wrongDate = await register(started, { start_date: "2026年12月7日" });
  expect(wrongDate.step1).toBe(422);
  expect(started.received().accepted).toHaveLength(0);
  const attempts = started.received().attempts;
  expect(attempts.length).toBeGreaterThanOrEqual(2);
  expect(attempts.every((attempt) => !attempt.ok || attempt.step === 2)).toBe(
    true,
  );
});

test("registering the same person twice is refused, and one accepted record is what counts", async () => {
  const started = site();
  const first = await register(started);
  const second = await register(started);
  expect(first.step2).toBe(200);
  expect(second.step1).toBe(422);
  expect(started.received().accepted).toHaveLength(1);
  expect(checkWebform(judged(started, first.receipt)).passed).toBe(true);
});
