/*
 * A stand-in for the C# desktop helper, speaking the same line-JSON protocol (`runner/src/desktop/
 * host.ts`). Run with `bun`. It first prints `{"ready":true,"pid":N,"session":S,"interactive":true}`,
 * then answers each `{"id":N,"op":...}` line with `{"id":N,"ok":true,"result":{...}}`. Lines that
 * are not request JSON (the host's preamble, for one) are ignored, as PowerShell would run them.
 *
 * Behaviour comes from FAKE_DESKTOP_MODE:
 *   ok        answers at once: `windows` with two windows, any other op with `{ op, pid, maxInflight }`
 *   noise     like ok, with `PS>` and banner lines (and JSON lines no request owns) before the ready
 *             line and before every answer
 *   slow      like ok, but each answer waits FAKE_DESKTOP_DELAY_MS (default 5000) first
 *   crash     never ready: on its first input line writes `Add-Type : 编译错误` to stderr, exits 1
 *   noready   never prints the ready line
 *   session0  the ready line says `"session":0,"interactive":false`
 *   split     answers with a result holding 熊宝员工, written in two pieces cut inside a character
 *
 * Test hooks in any answering mode: a request with `fail: "<code>"` is answered
 * `{"ok":false,"code":"<code>","message":"fake failure"}`; one with `exit: true` makes the helper
 * exit with 3 without answering; one with `flood: N` writes N characters with no newline and never
 * answers; one with `echo: true` first writes the request itself back (an id, but no `ok`).
 * FAKE_DESKTOP_STDERR_FILL=N makes crash mode write N copies of 错 to stderr before its error.
 * Every request line received is appended to FAKE_DESKTOP_LOG (when set), as it arrived.
 * `maxInflight` is the most requests this process has held unanswered
 * at once, so a test can see whether the host ever sent a second request before the first was done.
 * The helper exits when its stdin closes, as the real one does.
 */

import { appendFileSync } from "node:fs";

const mode = process.env.FAKE_DESKTOP_MODE ?? "ok";
const log = process.env.FAKE_DESKTOP_LOG;
const delayMs = Number(process.env.FAKE_DESKTOP_DELAY_MS ?? 5000);

const WINDOWS = [
  { hwnd: "4242", pid: 77, title: "无标题 - 记事本", process: "notepad" },
  {
    hwnd: "5151",
    pid: 88,
    title: "招商银行 - Google Chrome",
    process: "chrome",
  },
];

function line(text: string) {
  process.stdout.write(`${text}\n`);
}

function noise() {
  if (mode !== "noise") return;
  line("Windows PowerShell");
  line("PS> ");
  line('{"id":987654,"ok":true,"result":{"stray":true}}');
  line('{"ok":true,"result":{"noId":true}}');
  line("{ not json");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let inflight = 0;
let maxInflight = 0;

async function answer(request: Record<string, unknown>) {
  inflight += 1;
  maxInflight = Math.max(maxInflight, inflight);
  if (mode === "slow") await sleep(delayMs);
  if (request.exit === true) process.exit(3);
  if (typeof request.flood === "number") {
    process.stdout.write("x".repeat(request.flood));
    return;
  }
  if (request.echo === true) line(JSON.stringify(request));
  const id = request.id;
  let reply: Record<string, unknown>;
  if (typeof request.fail === "string") {
    reply = { id, ok: false, code: request.fail, message: "fake failure" };
  } else if (request.op === "windows") {
    reply = { id, ok: true, result: { windows: WINDOWS } };
  } else if (mode === "split") {
    reply = { id, ok: true, result: { op: request.op, text: "熊宝员工" } };
  } else {
    reply = {
      id,
      ok: true,
      result: { op: request.op, pid: process.pid, maxInflight },
    };
  }
  inflight -= 1;
  noise();
  if (mode === "split") {
    const bytes = Buffer.from(`${JSON.stringify(reply)}\n`);
    // One byte into 熊 (three bytes in UTF-8): the first piece ends inside the character.
    const cut = bytes.indexOf(Buffer.from("熊")) + 1;
    process.stdout.write(bytes.subarray(0, cut));
    await sleep(100);
    process.stdout.write(bytes.subarray(cut));
    return;
  }
  line(JSON.stringify(reply));
}

noise();
if (mode !== "noready" && mode !== "crash") {
  const session0 = mode === "session0";
  line(
    JSON.stringify({
      ready: true,
      pid: process.pid,
      session: session0 ? 0 : 1,
      interactive: !session0,
    }),
  );
}

let pending = "";
const decoder = new TextDecoder();
process.stdin.on("data", (chunk: Buffer) => {
  pending += decoder.decode(chunk, { stream: true });
  let at = pending.indexOf("\n");
  while (at !== -1) {
    const text = pending.slice(0, at);
    pending = pending.slice(at + 1);
    at = pending.indexOf("\n");
    if (mode === "crash") {
      const fill = Number(process.env.FAKE_DESKTOP_STDERR_FILL ?? 0);
      process.stderr.write(`${"错".repeat(fill)}Add-Type : 编译错误\n`);
      process.exit(1);
    }
    let request: unknown;
    try {
      request = JSON.parse(text);
      if (log) appendFileSync(log, `${text}\n`);
    } catch {
      continue;
    }
    if (
      typeof request === "object" &&
      request !== null &&
      typeof (request as { id?: unknown }).id === "number"
    )
      void answer(request as Record<string, unknown>);
  }
});
process.stdin.on("end", () => process.exit(0));
