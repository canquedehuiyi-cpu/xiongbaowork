/*
 * WIN1, the desktop half (plan docs/plans/2026-11-08-desktop-control.md, Task 3): the real C# helper,
 * compiled by the machine's Windows PowerShell 5.1, reads a real Notepad. The file's name and its text
 * are Chinese, so a GBK code page anywhere on the way would show up as question marks.
 *
 * Read only: the helper lists windows, reads the UI Automation tree and takes a screenshot. Then the
 * host's allow-list is widened on purpose, `click` and `type` are written to the helper itself, and
 * the helper must refuse them on its own, with Notepad's text unchanged afterwards.
 *
 * It needs an interactive desktop (session 1 or later). If the helper reports session 0 or none, the
 * probe fails with `session0`: per the plan's design decision 14 that is reported, never skipped.
 *
 * Called from windows-runner-probe.ts. `execute` is checked here once the runner's desktop actions
 * exist (Task 4).
 */

import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import {
  createDesktopHost,
  DesktopHelperError,
  defaultHelperSpec,
  HELPER_OPS,
} from "../../runner/src/desktop/host.ts";
import type { RunnerExecutor } from "../../runner/src/execute.ts";

type Assert = (ok: unknown, label: string, seen?: unknown) => void;
type Host = ReturnType<typeof createDesktopHost>;

type HelperWindow = {
  hwnd: string;
  pid: number;
  title: string;
  process: string;
  focused: boolean;
  minimized: boolean;
};
type HelperElement = {
  type: string;
  name: string;
  depth: number;
  value?: string;
  disabled?: true;
  password?: true;
};
type HelperTree = {
  window: HelperWindow;
  truncated: boolean;
  elements: HelperElement[];
};
type HelperShot = { base64: string; width: number; height: number };

const TEXT = "熊宝员工-桌面探针";
const TREE = {
  maxDepth: 12,
  maxNodes: 800,
  nameMax: 120,
  valueMax: 200,
  budgetMs: 12_000,
};

type Outcome<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        name?: string;
        code?: string;
        sent?: boolean;
        message: string;
        stderrTail?: string;
      };
    };

async function outcome<T>(promise: Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    if (error instanceof DesktopHelperError)
      return {
        ok: false,
        error: {
          name: error.name,
          code: error.code,
          sent: error.sent,
          message: error.message,
          stderrTail: error.stderrTail,
        },
      };
    const plain = error as Error & { sent?: boolean };
    return {
      ok: false,
      error: { name: plain.name, sent: plain.sent, message: String(plain) },
    };
  }
}

/** A tree, short enough to print when a check fails. */
function brief(tree: HelperTree | undefined) {
  if (!tree) return tree;
  return {
    window: tree.window,
    truncated: tree.truncated,
    count: tree.elements.length,
    elements: tree.elements.slice(0, 40),
  };
}

function editIndex(tree: HelperTree): number {
  return tree.elements.findIndex(
    (element) =>
      (element.type === "Edit" || element.type === "Document") &&
      (element.value ?? "").includes(TEXT),
  );
}

function taskkill(pid: number | undefined) {
  if (!pid) return;
  const root =
    process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  spawnSync(
    win32.join(root, "System32", "taskkill.exe"),
    ["/PID", String(pid), "/T", "/F"],
    { windowsHide: true, stdio: "ignore", timeout: 15_000 },
  );
}

/**
 * The helper started by hand, not through a host: a request with the op twice, once in another case,
 * is written exactly as it is, and the helper must refuse it whole.
 */
async function rawHelperAnswers(lines: string[]): Promise<unknown[]> {
  const spec = defaultHelperSpec();
  const child = spawn(spec.command, spec.args, {
    stdio: "pipe",
    windowsHide: true,
  });
  child.stdin.on("error", () => {});
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let ready = false;
  const answers: unknown[] = [];
  try {
    return await new Promise<unknown[]>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no answers in 45 s; got ${buffer}`)),
        45_000,
      );
      child.once("close", (code) => {
        clearTimeout(timer);
        reject(new Error(`the helper exited with ${String(code)}`));
      });
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += decoder.decode(chunk, { stream: true });
        let at = buffer.indexOf("\n");
        while (at !== -1) {
          const line = buffer.slice(0, at).trim();
          buffer = buffer.slice(at + 1);
          at = buffer.indexOf("\n");
          const brace = line.indexOf("{");
          if (brace === -1) continue;
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(line.slice(brace));
          } catch {
            continue;
          }
          if (!ready) {
            if (message.ready !== true) continue;
            ready = true;
            for (const request of lines) child.stdin.write(`${request}\n`);
            continue;
          }
          if (message.ok === undefined) continue;
          answers.push(message);
          if (answers.length === lines.length) {
            clearTimeout(timer);
            resolve(answers);
          }
        }
      });
      if (spec.preamble !== undefined) child.stdin.write(`${spec.preamble}\n`);
    });
  } finally {
    child.stdin.end();
    taskkill(child.pid);
  }
}

export async function probeDesktop(
  assert: Assert,
  root: string,
  _execute?: RunnerExecutor,
): Promise<void> {
  // 1. A Notepad with a Chinese name and Chinese text.
  const file = join(root, "熊宝员工.txt");
  writeFileSync(file, `\uFEFF${TEXT}`, "utf8");
  const notepad = Bun.spawn(["notepad.exe", file]);
  const host = createDesktopHost({ spec: defaultHelperSpec });
  let raw: Host | undefined;
  let window: HelperWindow | undefined;
  try {
    // 2. It shows up in the window list. The 15 s count from the helper's first answer: starting the
    // helper (Add-Type compiling the C#) has its own 30 s limit.
    let seen: unknown;
    let deadline: number | undefined;
    while (!window && (deadline === undefined || Date.now() < deadline)) {
      const listed = await outcome(
        host.request<{ windows: HelperWindow[] }>({ op: "windows", max: 50 }),
      );
      seen = listed.ok ? listed.value : listed.error;
      // The helper did not start, or has no desktop to see (session 0): nothing to wait for.
      if (!listed.ok) break;
      deadline ??= Date.now() + 15_000;
      window = listed.value.windows.find(
        (entry) =>
          entry.title.includes("熊宝员工") &&
          entry.process.toLowerCase() === "notepad",
      );
      if (!window) await Bun.sleep(250);
    }
    assert(window, "desktop helper lists Notepad with its Chinese title", seen);
    if (!window) return;
    const target = { hwnd: window.hwnd, pid: window.pid };

    // 3. Its UI Automation tree, within the limits, with the edit area's Chinese text.
    await host.ensure();
    const s1 = host.nextSnapshotId();
    const first = await outcome(
      host.request<HelperTree>({
        op: "tree",
        ...target,
        snapshot: s1,
        ...TREE,
        refuseWords: [],
      }),
    );
    const tree1 = first.ok ? first.value : undefined;
    const edit1 = tree1 ? editIndex(tree1) : -1;
    assert(
      tree1 &&
        tree1.elements.length <= 800 &&
        Math.max(0, ...tree1.elements.map((element) => element.depth)) <= 12 &&
        edit1 >= 0,
      "the UIA tree reads Notepad's edit area in Chinese",
      first.ok ? brief(tree1) : first.error,
    );
    if (!tree1) return;
    const editType = tree1.elements[edit1]?.type;
    const editValue = tree1.elements[edit1]?.value;

    // 4. A screenshot: a PNG no longer than 1280 px on its long side.
    const shot = await outcome(
      host.request<HelperShot>({
        op: "screenshot",
        ...target,
        maxEdge: 1280,
        refuseWords: [],
      }),
    );
    const png = shot.ok ? Buffer.from(shot.value.base64, "base64") : undefined;
    assert(
      shot.ok &&
        png !== undefined &&
        png.length > 8 &&
        png[0] === 0x89 &&
        png[1] === 0x50 &&
        png[2] === 0x4e &&
        png[3] === 0x47 &&
        shot.value.width > 0 &&
        shot.value.height > 0 &&
        Math.max(shot.value.width, shot.value.height) <= 1280,
      "a window screenshot is a PNG within 1280 px",
      shot.ok
        ? {
            width: shot.value.width,
            height: shot.value.height,
            bytes: png?.length,
            head: png ? [...png.subarray(0, 8)] : undefined,
          }
        : shot.error,
    );

    // 5. A ref from the snapshot before the latest is stale; one from the latest reads its subtree.
    const s2 = host.nextSnapshotId();
    const second = await outcome(
      host.request<HelperTree>({
        op: "tree",
        ...target,
        snapshot: s2,
        ...TREE,
        refuseWords: [],
      }),
    );
    const tree2 = second.ok ? second.value : undefined;
    const edit2 = tree2 ? editIndex(tree2) : -1;
    const old = await outcome(
      host.request<HelperTree>({
        op: "tree",
        ...target,
        snapshot: host.nextSnapshotId(),
        from: `${s1}:${edit1}`,
        ...TREE,
        refuseWords: [],
      }),
    );
    assert(
      !old.ok && old.error.code === "stale",
      "a ref from an older snapshot is refused as stale",
      old.ok ? brief(old.value) : old.error,
    );
    const latest = await outcome(
      host.request<HelperTree>({
        op: "tree",
        ...target,
        snapshot: host.nextSnapshotId(),
        from: `${s2}:${edit2}`,
        ...TREE,
        refuseWords: [],
      }),
    );
    assert(
      edit2 >= 0 &&
        latest.ok &&
        latest.value.elements.length > 0 &&
        latest.value.elements[0]?.type === tree2?.elements[edit2]?.type &&
        latest.value.elements[0]?.depth === 0,
      "a ref from the latest snapshot reads its subtree",
      latest.ok
        ? { edit2, expected: tree2?.elements[edit2], got: brief(latest.value) }
        : { edit2, error: latest.error },
    );

    // 6. The live title carries a refused word: nothing is read.
    const refused = await outcome(
      host.request<HelperTree>({
        op: "tree",
        ...target,
        snapshot: host.nextSnapshotId(),
        ...TREE,
        refuseWords: ["熊宝"],
      }),
    );
    assert(
      !refused.ok &&
        refused.error.code === "sensitive" &&
        refused.error.message === "熊宝",
      "a live title with a refused word is not read",
      refused.ok ? brief(refused.value) : refused.error,
    );

    // 7. Past the host's allow-list, the helper still refuses to write, and Notepad is unchanged.
    raw = createDesktopHost({
      spec: defaultHelperSpec,
      ops: new Set([...HELPER_OPS, "click", "type"]),
    });
    const click = await outcome(raw.request({ op: "click", ...target }));
    const type = await outcome(
      raw.request({ op: "type", ...target, text: "x" }),
    );
    const after = await outcome(
      host.request<HelperTree>({
        op: "tree",
        ...target,
        snapshot: host.nextSnapshotId(),
        ...TREE,
        refuseWords: [],
      }),
    );
    const afterEdit = after.ok ? editIndex(after.value) : -1;
    const afterElement = after.ok ? after.value.elements[afterEdit] : undefined;
    assert(
      !click.ok &&
        click.error.code === "unsupported" &&
        click.error.sent === true &&
        !type.ok &&
        type.error.code === "unsupported" &&
        type.error.sent === true &&
        afterElement !== undefined &&
        afterElement.type === editType &&
        afterElement.value === editValue,
      "the helper itself refuses write ops and Notepad is unchanged",
      {
        click: click.ok ? click.value : click.error,
        type: type.ok ? type.value : type.error,
        before: editValue,
        after: after.ok ? afterElement : after.error,
      },
    );

    // The helper reads keys exactly: the op twice, or once in another case, is refused whole.
    const smuggled = await outcome(
      rawHelperAnswers([
        `{"id":1,"op":"windows","Op":"click"}`,
        `{"id":2,"Op":"click","op":"windows"}`,
        `{"id":3,"op":"windows","op":"click"}`,
        `{"id":4,"op":"windows","max":1}`,
      ]),
    );
    const answers = smuggled.ok
      ? (smuggled.value as { id: number; ok: boolean; code?: string }[])
      : [];
    const byId = (id: number) => answers.find((answer) => answer.id === id);
    assert(
      [1, 2, 3].every(
        (id) => byId(id)?.ok === false && byId(id)?.code === "unsupported",
      ) && byId(4)?.ok === true,
      "the helper itself refuses a duplicate or case-variant key",
      smuggled.ok ? answers : smuggled.error,
    );

    // 8. Closed.
    await raw.close();
    await host.close();
    assert(!host.running && !raw.running, "the desktop helpers are closed", {
      host: host.running,
      raw: raw.running,
    });
  } finally {
    await raw?.close();
    await host.close();
    taskkill(window?.pid);
    taskkill(notepad.pid);
  }
}
