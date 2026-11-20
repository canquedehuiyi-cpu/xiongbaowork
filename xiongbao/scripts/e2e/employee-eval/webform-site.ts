/**
 * 网页表单题的夹具网站：由评测脚本在本机起（回环地址、随机端口），熊宝员工和 Codex 都访问得到。
 * 一个两步的「新员工入职登记」：第一步填基本信息，第二步填设备和紧急联系人，提交成功页上有一个回执号。
 *
 * 判分不看员工怎么填的，只看服务端收到并接受了什么：评测脚本在员工做完以后把服务端的记录写进
 * 被判分的目录（{@link sealReceived}，文件名 {@link RECEIVED_FILE}），员工写不到这个文件的最终内容。
 *
 * 表单是真的会挑剔的：第一步要带上刚打开页面时拿到的一次性 ticket，日期只认 `YYYY-MM-DD`，手机号要 11 位，
 * 第二步要带第一步给的 draft，同一个邮箱不能登记两次。所以直接猜字段名乱 POST 是过不去的，要先读页面、
 * 按页面上的字段填。浏览器里点着填和用 curl 提交都行（表单、multipart、JSON 三种提交都认）。
 */

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** 被判分的目录里，服务端记录的文件名。 */
export const RECEIVED_FILE = ".webform-received.json";

export const DEPARTMENTS: Record<string, string> = {
  eng: "研发部",
  mkt: "市场部",
  sales: "销售部",
  fin: "财务部",
  hr: "人事部",
};
export const LAPTOPS: Record<string, string> = {
  mac14: "MacBook Pro 14 寸",
  mac16: "MacBook Pro 16 寸",
  thinkpad: "ThinkPad X1 Carbon",
};

export type Attempt = {
  step: 1 | 2;
  ok: boolean;
  error?: string;
  fields: Record<string, string>;
};
export type Accepted = { fields: Record<string, string>; receipt: string };
export type Received = { accepted: Accepted[]; attempts: Attempt[] };

export type WebformSite = {
  /** 例如 `http://127.0.0.1:41234`，不带结尾斜杠。 */
  url: string;
  received: () => Received;
  stop: () => void;
};

const esc = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const page = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body><h1>${esc(title)}</h1>${body}</body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );

const options = (choices: Record<string, string>) =>
  Object.entries(choices)
    .map(([value, label]) => `<option value="${value}">${esc(label)}</option>`)
    .join("");

function stepOneForm(ticket: string, error?: string) {
  return page(
    "新员工入职登记（1/2）",
    `${error ? `<p role="alert" style="color:#b00">${esc(error)}</p>` : ""}
<form method="post" action="/register">
<input type="hidden" name="ticket" value="${ticket}">
<p><label>姓名 <input type="text" name="full_name"></label></p>
<p><label>工作邮箱 <input type="email" name="work_email"></label></p>
<p><label>部门 <select name="department"><option value="">请选择</option>${options(DEPARTMENTS)}</select></label></p>
<p><label>入职日期 <input type="date" name="start_date"></label>（格式 YYYY-MM-DD）</p>
<p><button type="submit">下一步</button></p>
</form>`,
    error ? 422 : 200,
  );
}

function stepTwoForm(draft: string, error?: string) {
  const laptops = Object.entries(LAPTOPS)
    .map(
      ([value, label]) =>
        `<label><input type="radio" name="laptop" value="${value}"> ${esc(label)}</label>`,
    )
    .join(" ");
  return page(
    "新员工入职登记（2/2）",
    `${error ? `<p role="alert" style="color:#b00">${esc(error)}</p>` : ""}
<form method="post" action="/register/devices">
<input type="hidden" name="draft" value="${draft}">
<p>笔记本：${laptops}</p>
<p><label><input type="checkbox" name="monitor" value="yes"> 需要外接显示器</label></p>
<p><label>紧急联系人 <input type="text" name="emergency_name"></label></p>
<p><label>紧急联系人手机 <input type="tel" name="emergency_phone"></label></p>
<p><label>备注 <textarea name="note"></textarea></label></p>
<p><button type="submit">提交登记</button></p>
</form>`,
    error ? 422 : 200,
  );
}

/** 表单、multipart 和 JSON 三种提交都收，统一成「字段 → 去掉首尾空白的字符串」。 */
async function fieldsOf(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get("content-type") ?? "";
  const out: Record<string, string> = {};
  if (type.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    for (const [key, value] of Object.entries(body))
      if (typeof value === "string" || typeof value === "number")
        out[key] = String(value).trim();
      else if (typeof value === "boolean") out[key] = String(value);
    return out;
  }
  const form = await request.formData().catch(() => null);
  if (!form) return out;
  for (const [key, value] of form.entries())
    if (typeof value === "string") out[key] = value.trim();
  return out;
}

const token = (prefix: string) => `${prefix}-${randomBytes(6).toString("hex")}`;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function startWebformSite(): WebformSite {
  const received: Received = { accepted: [], attempts: [] };
  const tickets = new Set<string>();
  const drafts = new Map<
    string,
    {
      full_name: string;
      work_email: string;
      department: string;
      start_date: string;
    }
  >();
  const done = new Set<string>();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // 员工的命令可能很慢才来取下一页：不让空闲连接被服务器掐掉。
    idleTimeout: 120,
    async fetch(request) {
      const url = new URL(request.url);
      const post = request.method === "POST";

      if (url.pathname === "/" && !post)
        return page(
          "入职登记系统",
          '<p>新员工请先<a href="/register">开始登记</a>。登记分两步，提交后页面会给出回执号。</p>',
        );

      if (url.pathname === "/register" && !post) {
        const ticket = token("t");
        tickets.add(ticket);
        return stepOneForm(ticket);
      }

      if (url.pathname === "/register" && post) {
        const fields = await fieldsOf(request);
        const fail = (error: string) => {
          received.attempts.push({ step: 1, ok: false, error, fields });
          const ticket = token("t");
          tickets.add(ticket);
          return stepOneForm(ticket, error);
        };
        if (!fields.ticket || !tickets.delete(fields.ticket))
          return fail("表单已过期或不是从登记页打开的，请重新打开登记页再填。");
        if (!fields.full_name) return fail("请填写姓名。");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.work_email ?? ""))
          return fail("工作邮箱格式不对。");
        if (!DEPARTMENTS[fields.department ?? ""])
          return fail("请从列表里选一个部门。");
        if (!ISO_DATE.test(fields.start_date ?? ""))
          return fail("入职日期的格式应为 YYYY-MM-DD。");
        if (done.has(fields.work_email as string))
          return fail("这个邮箱已经登记过了。");
        const draft = token("d");
        drafts.set(draft, {
          full_name: fields.full_name,
          work_email: fields.work_email as string,
          department: fields.department as string,
          start_date: fields.start_date as string,
        });
        received.attempts.push({ step: 1, ok: true, fields });
        return Response.redirect(
          `${url.origin}/register/devices?draft=${draft}`,
          303,
        );
      }

      if (url.pathname === "/register/devices" && !post) {
        const draft = url.searchParams.get("draft") ?? "";
        if (!drafts.has(draft))
          return page("找不到这次登记", "<p>请从第一步重新开始。</p>", 404);
        return stepTwoForm(draft);
      }

      if (url.pathname === "/register/devices" && post) {
        const fields = await fieldsOf(request);
        const draft = fields.draft ?? "";
        const base = drafts.get(draft);
        const fail = (error: string) => {
          received.attempts.push({ step: 2, ok: false, error, fields });
          return stepTwoForm(draft, error);
        };
        if (!base) return fail("找不到这次登记，请从第一步重新开始。");
        if (!LAPTOPS[fields.laptop ?? ""]) return fail("请选择一款笔记本。");
        if (!fields.emergency_name) return fail("请填写紧急联系人。");
        const phone = (fields.emergency_phone ?? "").replace(/[\s\-+]/g, "");
        if (!/^1\d{10}$/.test(phone))
          return fail("紧急联系人手机应为 11 位手机号。");
        if (done.has(base.work_email)) return fail("这个邮箱已经登记过了。");
        const monitor = ["yes", "on", "true", "1"].includes(
          (fields.monitor ?? "").toLowerCase(),
        );
        const receipt = `RCPT-${randomBytes(3).toString("hex").toUpperCase()}`;
        const all: Record<string, string> = {
          ...base,
          laptop: fields.laptop as string,
          monitor: monitor ? "yes" : "no",
          emergency_name: fields.emergency_name,
          emergency_phone: phone,
          note: fields.note ?? "",
        };
        done.add(base.work_email);
        drafts.delete(draft);
        received.attempts.push({ step: 2, ok: true, fields });
        received.accepted.push({ fields: all, receipt });
        return page(
          "登记成功",
          `<p>已收到 ${esc(base.full_name)} 的入职登记。</p><p>回执号：<strong id="receipt">${receipt}</strong></p>`,
        );
      }

      return page("没有这个页面", "<p>404</p>", 404);
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    received: () => structuredClone(received),
    stop: () => server.stop(true),
  };
}

/** 员工做完以后，把服务端收到的记录写进被判分的目录（覆盖员工可能放在那里的同名文件）。 */
export function sealReceived(site: WebformSite, dir: string) {
  writeFileSync(
    join(dir, RECEIVED_FILE),
    `${JSON.stringify(site.received(), null, 2)}\n`,
  );
}
