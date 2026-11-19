import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACP_MANIFEST,
  CLOUD_ASK_PREFIXES,
  CLOUD_CODEX_MODE,
  claudeModelLaunch,
  cloudAdapterLaunch,
  cloudCodexConfigToml,
  cloudCodexRules,
  codexConfigToml,
  codexModelLaunch,
  writeCloudCodexHome,
} from "../src/acp/manifest";

/*
 * 期八·二: how the adapters are started on the employee's own computer (manifest.ts, THE EMPLOYEE'S OWN
 * COMPUTER). The launch is the installed copy, the environment is an allow list, Codex has no sandbox
 * of its own, and a device's launch is not touched by any of it.
 */

const scratch = mkdtempSync(join(tmpdir(), "xiongbao-cloud-launch-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const model = {
  baseUrl: "http://server.internal:3001/api/agent-model/",
  token: "xbm_secret_pass",
  model: "deepseek-chat",
  wire: "responses" as const,
};

test("a cloud Codex's config.toml: the proxy as its only provider and a profile that is the whole container", () => {
  const toml = cloudCodexConfigToml(model);
  expect(toml).toContain('model_provider = "xiongbao"');
  expect(toml).toContain(
    'base_url = "http://server.internal:3001/api/agent-model/v1"',
  );
  expect(toml).toContain('env_key = "XIONGBAO_AGENT_MODEL_TOKEN"');
  expect(toml).toContain("requires_openai_auth = false");
  // No sandbox of its own: the container is the sandbox.
  expect(toml).toContain('approval_policy = "on-request"');
  expect(toml).toContain('default_permissions = "xiongbao-cloud"');
  expect(toml).toContain("[permissions.xiongbao-cloud.filesystem]");
  expect(toml).toContain('":root" = "write"');
  expect(toml).toContain("[permissions.xiongbao-cloud.network]");
  expect(toml).toContain("enabled = true");
  // Nothing of its own going out but the model.
  expect(toml).toContain("check_for_update_on_startup = false");
  expect(toml).toMatch(/\[analytics\]\nenabled = false/);
  expect(toml).toMatch(/\[feedback\]\nenabled = false/);
  // The pass is in the environment, never in the file.
  expect(toml).not.toContain(model.token);
  // A device's config is untouched: no profile, no sandbox setting.
  const device = codexConfigToml(model);
  expect(device).not.toContain("permissions");
  expect(device).not.toContain("approval_policy");
});

test("the rules ask the approval gate about shell wrappers and the risky programs", () => {
  const rules = cloudCodexRules();
  // Every rule is a prompt, never an allow or a forbid.
  const decisions = [...rules.matchAll(/decision = "(\w+)"/g)].map((m) => m[1]);
  expect(decisions.length).toBe(CLOUD_ASK_PREFIXES.length + 1);
  expect(new Set(decisions)).toEqual(new Set(["prompt"]));
  expect(rules).toContain('"bash"');
  expect(rules).toContain('"-lc"');
  for (const program of ["rm", "sudo", "curl", "git", "npm", "pip", "docker"])
    expect(rules).toContain(`"${program}"`);
  expect(rules).toContain(
    '["git"], ["push", "clone", "fetch", "pull", "remote"]',
  );
});

test("the home is made private, with the config and the rules and nothing else", () => {
  const home = join(scratch, "home");
  writeCloudCodexHome(home, model);
  expect(statSync(home).mode & 0o777).toBe(0o700);
  expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(
    cloudCodexConfigToml(model),
  );
  expect(readFileSync(join(home, "rules", "xiongbao.rules"), "utf8")).toBe(
    cloudCodexRules(),
  );
  expect(statSync(join(home, "config.toml")).mode & 0o777).toBe(0o600);
});

test("Codex is started from the installed copy, in the cloud mode, with only the allow list", () => {
  const spec = cloudAdapterLaunch(
    "codex",
    { adapterDir: "/var/lib/xiongbao-acp/adapters" },
    {
      binDir: "/opt/xiongbao-acp/node_modules/.bin",
      env: {
        PATH: "/usr/local/bin:/usr/bin",
        HOME: "/var/lib/xiongbao-acp/homes/a",
      },
      model: codexModelLaunch(model, "/tmp/xiongbao-codex-abc"),
      parentEnv: {
        PATH: "/usr/bin",
        COMPUTER_TOKEN: "computer-secret",
        ANTHROPIC_API_KEY: "sk-x",
      },
    },
  );
  expect(spec.command).toBe("node");
  expect(spec.args).toEqual(["/opt/xiongbao-acp/node_modules/.bin/codex-acp"]);
  // Never `npx`, never a download.
  expect(JSON.stringify(spec)).not.toContain("npx");
  expect(spec.cwd).toBe("/var/lib/xiongbao-acp/adapters");
  expect(spec.sessionMode).toBe(CLOUD_CODEX_MODE);
  expect(spec.env).toEqual({
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/var/lib/xiongbao-acp/homes/a",
    CODEX_HOME: "/tmp/xiongbao-codex-abc",
    XIONGBAO_AGENT_MODEL_TOKEN: model.token,
    INITIAL_AGENT_MODE: CLOUD_CODEX_MODE,
    NO_BROWSER: "1",
  });
  expect(spec.unsetEnv).toEqual([
    "PATH",
    "COMPUTER_TOKEN",
    "ANTHROPIC_API_KEY",
  ]);
});

test("Claude Code is started from the installed copy, in the ask mode, on the proxy", () => {
  const spec = cloudAdapterLaunch(
    "claude-code",
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
