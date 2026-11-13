import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLiveShell } from "../src/live-shell";

/**
 * A live shell started some other way than this process's own bash: the employee's live terminal,
 * which agent-computer starts through the root helper as the employee (`sudo -n xb-bot shell <key>
 * <rc> NAME=VALUE...`). Here the "helper" is a plain bash, so what is pinned is the contract the
 * helper relies on: the startup file's text and the environment arrive as values, never as a path for
 * it to read, and the shell started is the one a person watches and types into. The helper's own
 * checks and the switch to the employee's user are tested as root in the image
 * (docker/tests/xb-bot.test.sh).
 */
test("a shell started through a command is given its startup file and environment as values, and is the one a person watches", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "live-shell-command-"));
  let given: { rc: string; env: Record<string, string> } | undefined;
  const shell = createLiveShell({
    cwd: "/",
    env: () => ({
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      XB_SEEN: "yes",
      XB_MULTILINE: "a\nb",
    }),
    command: (start) => {
      given = start;
      const rc = join(scratch, "rc");
      writeFileSync(rc, start.rc);
      return [
        "env",
        "-i",
        ...Object.entries(start.env).map(([name, value]) => `${name}=${value}`),
        "bash",
        "--noprofile",
        "--rcfile",
        rc,
        "-i",
      ];
    },
  });
  const decoder = new TextDecoder();
  let text = "";
  const viewer = shell.attach({
    binary: (bytes) => {
      text += decoder.decode(bytes, { stream: true });
      viewer.ack(bytes.byteLength);
    },
    text: () => undefined,
  });
  try {
    const deadline = Date.now() + 10_000;
    while (!given && Date.now() < deadline) await Bun.sleep(50);
    // The prompt marks, as this process's own shell gets them.
    expect(given?.rc).toContain("__xiongbao_prompt");
    expect(given?.env.XB_SEEN).toBe("yes");
    expect(given?.env.TERM).toBe("xterm-256color");
    // A value that would split into two NAME=VALUE arguments is not handed over at all.
    expect(given?.env.XB_MULTILINE).toBeUndefined();

    shell.input("echo seen-$XB_SEEN\r");
    while (!text.includes("seen-yes") && Date.now() < deadline)
      await Bun.sleep(50);
    expect(text).toContain("seen-yes");
  } finally {
    viewer.detach();
    shell.dispose();
    rmSync(scratch, { recursive: true, force: true });
  }
});
