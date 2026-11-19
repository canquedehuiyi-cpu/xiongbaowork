import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACP_MANIFEST,
  claudeModelLaunch,
  cloudAdapterLaunch,
} from "../src/acp/manifest";

/*
 * 期八·二: how the adapters are started on the employee's own computer (manifest.ts, THE EMPLOYEE'S OWN
 * COMPUTER). The launch is the installed copy, the environment is an allow list, and a device's launch is not touched by any of it.
 */

const scratch = mkdtempSync(join(tmpdir(), "xiongbao-cloud-launch-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const model = {
  baseUrl: "http://server.internal:3001/api/agent-model/",
  token: "xbm_secret_pass",
  model: "deepseek-chat",
  wire: "responses" as const,
};

test("Claude Code is started from the installed copy, in the ask mode, on the proxy", () => {
  const spec = cloudAdapterLaunch(
    { adapterDir: "/a" },
    {
      binDir: "/bin-dir",
      env: { PATH: "/usr/bin" },
      model: claudeModelLaunch(model),
      parentEnv: { PATH: "/usr/bin", COMPUTER_TOKEN: "x" },
    },
  );
  expect(spec.args).toEqual(["/bin-dir/claude-agent-acp"]);
  expect(spec.sessionMode).toBe("default");
  expect(spec.sessionMode).toBe(ACP_MANIFEST["claude-code"].askSessionMode);
  expect(spec.env.ANTHROPIC_BASE_URL).toBe(
    "http://server.internal:3001/api/agent-model",
  );
  expect(spec.env.ANTHROPIC_AUTH_TOKEN).toBe(model.token);
  expect(spec.env.DISABLE_AUTOUPDATER).toBe("1");
  expect(spec.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  expect(spec.env.INITIAL_AGENT_MODE).toBeUndefined();
  expect(spec.unsetEnv).toContain("COMPUTER_TOKEN");
  expect(spec.unsetEnv).toContain("ANTHROPIC_API_KEY");
  expect(spec.unsetEnv).toContain("CLAUDE_CODE_USE_BEDROCK");
});

test("a device's launch is what it was: npx, the owner's mode, nothing unset but npm's", async () => {
  const { adapterLaunch } = await import("../src/acp/manifest");
  const spec = await adapterLaunch(
    "codex",
    { adapterDir: join(scratch, "adapters"), workdir: scratch },
    { processEnv: async () => ({ PATH: "/usr/bin" }) },
  );
  expect(spec.command).toBe("npx");
  expect(spec.args).toEqual(["-y", "@agentclientprotocol/codex-acp@2.6.0"]);
  expect(spec.sessionMode).toBe("read-only");
  expect(spec.env.INITIAL_AGENT_MODE).toBe("read-only");
});
