import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createLiveShell } from "../src/live-shell";

/**
 * A live shell started some other way than this process's own bash: the employee's live terminal,
 * which agent-computer starts through the root helper as the employee (`sudo -n xb-bot shell <key>
 * <dir>`). Here the "helper" is a plain bash given the same directory, so what is pinned is the
 * contract the helper relies on: the directory holds `bashrc` and `env`, private to this process, and
 * the shell it starts is the one a person watches and types into. The helper's own checks and the
 * switch to the employee's user are tested as root in the image (docker/tests/xb-bot.test.sh).
 */
test("a shell started through a command gets a private bashrc and env file, and is the one a person watches", async () => {
  let seenDirectory = "";
  const shell = createLiveShell({
    cwd: "/",
    env: () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", XB_SEEN: "yes" }),
    command: (directory) => {
      seenDirectory = directory;
      return [
        "bash",
        "-c",
        `set -a; . '${directory}/env'; set +a; exec bash --noprofile --rcfile '${directory}/bashrc' -i`,
      ];
    },
  });
  const decoder = new TextDecoder();
  let text = "";
  const viewer = shell.attach({
    binary: (bytes) => {
      text += decoder.decode(bytes, { stream: true });
      viewer?.ack(bytes.byteLength);
    },
    text: () => undefined,
  });
  try {
    const deadline = Date.now() + 10_000;
    while (!seenDirectory && Date.now() < deadline) await Bun.sleep(50);
    expect(seenDirectory).toMatch(/\.openbot-shell-/);
    // The directory and both files the helper reads, this process's alone (the helper checks 0700).
    expect(statSync(seenDirectory).mode & 0o777).toBe(0o700);
    for (const name of ["bashrc", "env"]) {
      const path = `${seenDirectory}/${name}`;
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).mode & 0o077).toBe(0);
    }
    const env = readFileSync(`${seenDirectory}/env`, "utf8").split("\n");
    expect(env).toContain("XB_SEEN=yes");
    expect(env.some((line) => line.startsWith("TERM="))).toBe(true);

    shell.input("echo seen-$XB_SEEN\r");
    while (!text.includes("seen-yes") && Date.now() < deadline)
      await Bun.sleep(50);
    expect(text).toContain("seen-yes");
  } finally {
    viewer.detach();
    shell.dispose();
  }
});
