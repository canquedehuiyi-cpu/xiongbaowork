// F2 stage 3: .github/workflows/device-release.yml, the device app's release. It only runs from a
// person's device-v* tag (or a manual run on one), every action is pinned to a commit, and an
// unsigned installer can only ever be published as a prerelease. The decision steps are run here as
// written in the workflow (bash, inputs from env), with a stub `gh` standing in for the release.
// Its clean-machine checks live in scripts/ci/device-clean-{linux.sh,windows.ps1}, which ci.yml's
// device-clean-linux and device-clean-windows also run on every pull request's unsigned installers.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");
const workflows = join(root, ".github", "workflows");
const text = readFileSync(join(workflows, "device-release.yml"), "utf8");
const workflow = Bun.YAML.parse(text);
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "device-release-"));
  dirs.push(dir);
  return dir;
}

/** A GitHub expression as the YAML spells it, e.g. `${{ vars.X }}`. */
const expression = (inner) => `\${{ ${inner} }}`;

function step(job, id, doc = workflow) {
  const found = doc.jobs[job].steps.find((s) => s.id === id);
  if (!found) throw new Error(`no step ${id} in job ${job}`);
  return found;
}

/** Runs a workflow step's script the way GitHub runs `shell: bash`, with only `env` set. */
function run(
  job,
  id,
  env,
  cwd = scratch(),
  path = process.env.PATH,
  doc = workflow,
) {
  const output = join(scratch(), "github-output");
  writeFileSync(output, "");
  const script = join(scratch(), "step.sh");
  writeFileSync(script, step(job, id, doc).run);
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-eo", "pipefail", script],
    {
      cwd,
      encoding: "utf8",
      env: { PATH: path, HOME: tmpdir(), GITHUB_OUTPUT: output, ...env },
    },
  );
  const outputs = {};
  for (const line of readFileSync(output, "utf8").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) outputs[line.slice(0, at)] = line.slice(at + 1);
  }
  return { status: result.status, log: result.stdout + result.stderr, outputs };
}

function allSteps(doc) {
  return Object.values(doc.jobs).flatMap((job) => job.steps ?? []);
}

test("it runs only from device-v tags and manual dispatch", () => {
  expect(Object.keys(workflow.on).sort()).toEqual([
    "push",
    "workflow_dispatch",
  ]);
  expect(Object.keys(workflow.on.push)).toEqual(["tags"]);
  expect(workflow.on.push.tags.length).toBeGreaterThan(0);
  for (const pattern of workflow.on.push.tags) {
    expect(pattern.startsWith("device-v")).toBe(true);
  }
  // A manual run names an existing tag and defaults to a dry run.
  const inputs = workflow.on.workflow_dispatch.inputs;
  expect(inputs.tag.required).toBe(true);
  expect(inputs.dry_run.default).toBe(true);
  const check = workflow.jobs["tag-check"].steps.find((s) =>
    s.run?.includes('"$REF_TYPE" != tag'),
  );
  expect(check).toBeDefined();
  expect(check.run).toContain('"$INPUT_TAG" != "$REF_NAME"');
  expect(check.run).toContain("git merge-base --is-ancestor HEAD origin/main");
  // Nothing is published from a dry run.
  expect(workflow.jobs.publish.if).toContain("!inputs.dry_run");
  expect(workflow.jobs.publish.if).toContain(
    "needs.assemble.result == 'success'",
  );
  // macOS is built only once a person opts in (D5).
  expect(workflow.jobs.macos.if).toBe(
    expression("vars.DEVICE_RELEASE_MACOS == 'true'"),
  );
});

test("the tag must be device-vX.Y.Z[-rc.N] for the version package.json builds", () => {
  const cwd = scratch();
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({ version: "0.1.0" }),
  );
  const ok = run("tag-check", "tag", { REF_NAME: "device-v0.1.0" }, cwd);
  expect(ok.status).toBe(0);
  expect(ok.outputs).toEqual({
    tag: "device-v0.1.0",
    version: "0.1.0",
    rc: "false",
  });
  const rc = run("tag-check", "tag", { REF_NAME: "device-v0.1.0-rc.2" }, cwd);
  expect(rc.status).toBe(0);
  expect(rc.outputs).toEqual({
    tag: "device-v0.1.0-rc.2",
    version: "0.1.0",
    rc: "true",
  });
  for (const bad of [
    "v0.1.0",
    "device-v0.1",
    "device-v00.1.0",
    "device-v0.1.0-rc.0",
    "device-v0.1.0-beta.1",
    "device-v0.2.0",
  ]) {
    const refused = run("tag-check", "tag", { REF_NAME: bad }, cwd);
    expect(refused.status).not.toBe(0);
    expect(refused.outputs).toEqual({});
  }
});

test("every action is pinned to a commit SHA, as in the repository's other workflows", () => {
  for (const file of ["device-release.yml", "ci.yml"]) {
    const doc = Bun.YAML.parse(readFileSync(join(workflows, file), "utf8"));
    const uses = [
      ...allSteps(doc).map((s) => s.uses),
      ...Object.values(doc.jobs).map((job) => job.uses),
    ].filter(Boolean);
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) {
      if (ref.startsWith("./")) continue;
      expect(ref).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    }
  }
});

test("least privilege: only publish writes contents, only signing gets an OIDC token", () => {
  expect(workflow.permissions).toEqual({ contents: "read" });
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const permissions = job.permissions ?? {};
    expect(permissions.contents === "write").toBe(name === "publish");
    expect(permissions["id-token"] === "write").toBe(name === "windows");
    expect(permissions.packages).toBeUndefined();
  }
  expect(workflow.jobs.windows.environment).toBe("device-release");
  expect(workflow.jobs.macos.environment).toBe("device-release");
  expect(workflow.jobs.publish.environment).toBe("device-release");
});

/** Every place a string in `node` mentions `secrets.`, as a dotted path. */
function secretPaths(node, path = []) {
  if (typeof node === "string")
    return node.includes("secrets.") ? [path.join(".")] : [];
  if (node && typeof node === "object")
    return Object.entries(node).flatMap(([key, value]) =>
      secretPaths(value, [...path, key]),
    );
  return [];
}

test("no run script interpolates an expression, and secrets reach steps only through env", () => {
  for (const s of allSteps(workflow)) {
    if (s.run) expect(s.run).not.toContain(expression("").slice(0, 3));
    expect(s["continue-on-error"]).toBeUndefined();
  }
  const secrets = [...text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(
    (m) => m[1],
  );
  expect([...new Set(secrets)].sort()).toEqual([
    "DEVICE_APPLE_API_KEY_P8",
    "DEVICE_APPLE_CERTIFICATE",
    "DEVICE_APPLE_CERTIFICATE_PASSWORD",
    "GITHUB_TOKEN",
  ]);
  const paths = secretPaths(workflow.jobs);
  expect(paths.length).toBeGreaterThan(0);
  for (const path of paths) {
    expect(path).toMatch(/^[\w-]+\.steps\.\d+\.env\.\w+$/);
  }
  // The Apple secrets go only to the macOS job.
  for (const path of paths.filter((p) => !p.startsWith("publish."))) {
    expect(path.startsWith("macos.")).toBe(true);
  }
  // CI's throwaway rehearsal certificate can never sign a release.
  expect(text).not.toContain("test-certificate");
});

test("every run step runs in the shell it is written for, never PowerShell by default", () => {
  // GitHub runs a step in PowerShell on Windows runners and in bash elsewhere unless the step or its
  // job names a shell. The bash steps the tests below execute must get bash on every runner, and a
  // PowerShell step must say so itself.
  const top = workflow.defaults?.run?.shell;
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const runner = String(job["runs-on"] ?? "");
    const jobShell = job.defaults?.run?.shell ?? top;
    for (const s of job.steps ?? []) {
      if (s.run === undefined) continue;
      const shell =
        s.shell ?? jobShell ?? (runner.startsWith("windows") ? "pwsh" : "bash");
      const label = `${name}: ${s.name ?? s.id ?? s.run.split("\n")[0]}`;
      if (shell === "pwsh") expect([label, s.shell]).toEqual([label, "pwsh"]);
      else expect([label, shell]).toEqual([label, "bash"]);
    }
  }
  expect(workflow.jobs.windows.defaults.run.shell).toBe("bash");
});

test("the Windows signing mode comes from configuration and a half-set one fails", () => {
  const none = run("windows", "mode", { DEVICE_WINDOWS_SIGNING: "" });
  expect(none.status).toBe(0);
  expect(none.outputs.mode).toBe("none");
  expect(
    run("windows", "mode", { DEVICE_WINDOWS_SIGNING: "none" }).outputs.mode,
  ).toBe("none");
  const vault = {
    DEVICE_WINDOWS_SIGNING: "azure-key-vault",
    DEVICE_WINDOWS_PUBLISHER: "Example Ltd",
    DEVICE_AZURE_CLIENT_ID: "client",
    DEVICE_AZURE_TENANT_ID: "tenant",
    DEVICE_AZURE_KEY_VAULT_URL: "https://example.vault.azure.net",
    DEVICE_AZURE_KEY_VAULT_CERTIFICATE: "device",
  };
  expect(run("windows", "mode", vault).outputs.mode).toBe("azure-key-vault");
  for (const missing of Object.keys(vault).slice(1)) {
    const refused = run("windows", "mode", { ...vault, [missing]: "" });
    expect(refused.status).not.toBe(0);
    expect(refused.log).toContain(missing);
  }
  const trusted = {
    DEVICE_WINDOWS_SIGNING: "trusted-signing",
    DEVICE_WINDOWS_PUBLISHER: "Example Ltd",
    DEVICE_AZURE_CLIENT_ID: "client",
    DEVICE_AZURE_TENANT_ID: "tenant",
    DEVICE_TRUSTED_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net",
    DEVICE_TRUSTED_SIGNING_ACCOUNT: "account",
    DEVICE_TRUSTED_SIGNING_PROFILE: "profile",
  };
  expect(run("windows", "mode", trusted).outputs.mode).toBe("trusted-signing");
  expect(
    run("windows", "mode", { ...trusted, DEVICE_TRUSTED_SIGNING_PROFILE: "" })
      .status,
  ).not.toBe(0);
  for (const other of ["test-certificate", "keyvault", "yes"]) {
    expect(
      run("windows", "mode", { ...vault, DEVICE_WINDOWS_SIGNING: other })
        .status,
    ).not.toBe(0);
  }
  // "signed" is recorded only after the verifier step, and only for a signing mode.
  const steps = workflow.jobs.windows.steps;
  const verify = steps.findIndex((s) =>
    s.run?.includes("verify-windows-signatures.ps1"),
  );
  expect(verify).toBeGreaterThan(-1);
  expect(steps.findIndex((s) => s.id === "done")).toBeGreaterThan(verify);
  expect(run("windows", "done", { MODE: "none" }).outputs.signed).toBe("false");
  expect(
    run("windows", "done", {
      MODE: "trusted-signing",
      DEVICE_WINDOWS_PUBLISHER: "Example Ltd",
    }).outputs,
  ).toEqual({
    signed: "true",
    publisher: "Example Ltd",
  });
  expect(workflow.jobs.windows.outputs.signed).toBe(
    expression("steps.done.outputs.signed"),
  );
});

function kind(env) {
  return run("assemble", "kind", {
    VERSION: "0.1.0",
    REQUIRE_SIGNED: "",
    MACOS_SIGNED: "skipped",
    ...env,
  });
}

test("unsigned output is always a prerelease titled 未签名内测版", () => {
  for (const RC of ["true", "false"]) {
    const unsigned = kind({ RC, WINDOWS_SIGNED: "false" });
    expect(unsigned.status).toBe(0);
    expect(unsigned.outputs.prerelease).toBe("true");
    expect(unsigned.outputs.signed).toBe("false");
    expect(unsigned.outputs.title).toBe(
      "熊宝数字员工 设备端 0.1.0（未签名内测版）",
    );
    expect(unsigned.outputs.unsigned).toBe("Windows");
  }
  const rc = kind({ RC: "true", WINDOWS_SIGNED: "true" });
  expect(rc.outputs).toMatchObject({ prerelease: "true", signed: "true" });
  expect(rc.outputs.title).not.toContain("未签名");
  const full = kind({ RC: "false", WINDOWS_SIGNED: "true" });
  expect(full.outputs).toMatchObject({
    prerelease: "false",
    signed: "true",
    title: "熊宝数字员工 设备端 0.1.0",
  });
  // D4 = "must be signed": the same unsigned build fails instead of publishing.
  const required = kind({
    RC: "false",
    WINDOWS_SIGNED: "false",
    REQUIRE_SIGNED: "true",
  });
  expect(required.status).not.toBe(0);
  expect(required.outputs).toEqual({});
  // A missing result (job skipped or output lost) is not "signed".
  for (const WINDOWS_SIGNED of ["", "yes"]) {
    expect(kind({ RC: "false", WINDOWS_SIGNED }).status).not.toBe(0);
  }
  for (const MACOS_SIGNED of ["", "yes"]) {
    expect(
      kind({ RC: "false", WINDOWS_SIGNED: "true", MACOS_SIGNED }).status,
    ).not.toBe(0);
  }
  // An unsigned macOS build makes the release unsigned even when Windows is signed.
  const mac = kind({
    RC: "false",
    WINDOWS_SIGNED: "true",
    MACOS_SIGNED: "false",
  });
  expect(mac.outputs).toMatchObject({
    prerelease: "true",
    signed: "false",
    unsigned: "macOS",
  });
  expect(mac.outputs.title).toContain("未签名内测版");
  const both = kind({
    RC: "false",
    WINDOWS_SIGNED: "true",
    MACOS_SIGNED: "true",
  });
  expect(both.outputs).toMatchObject({ prerelease: "false", signed: "true" });
  const assemble = step("assemble", "kind").env.MACOS_SIGNED;
  expect(assemble).toContain("needs.macos.result == 'skipped'");
});

test("macOS signing needs every Apple variable and secret, and is never half-applied", () => {
  const none = run("macos", "mode", { DEVICE_MACOS_SIGNING: "" });
  expect(none.status).toBe(0);
  expect(none.outputs.mode).toBe("none");
  const full = {
    DEVICE_MACOS_SIGNING: "developer-id",
    DEVICE_APPLE_SIGNING_IDENTITY:
      "Developer ID Application: Example (TEAM123456)",
    DEVICE_APPLE_TEAM_ID: "TEAM123456",
    DEVICE_APPLE_API_KEY_ID: "KEY",
    DEVICE_APPLE_API_ISSUER: "issuer",
    HAS_DEVICE_APPLE_CERTIFICATE: "true",
    HAS_DEVICE_APPLE_CERTIFICATE_PASSWORD: "true",
    HAS_DEVICE_APPLE_API_KEY_P8: "true",
  };
  expect(run("macos", "mode", full).outputs.mode).toBe("developer-id");
  for (const missing of Object.keys(full).slice(1)) {
    const value = missing.startsWith("HAS_") ? "false" : "";
    const refused = run("macos", "mode", { ...full, [missing]: value });
    expect(refused.status).not.toBe(0);
    expect(refused.log).toContain(missing.replace(/^HAS_/, ""));
  }
  expect(
    run("macos", "mode", { ...full, DEVICE_MACOS_SIGNING: "adhoc" }).status,
  ).not.toBe(0);
  // The mode step sees only whether each secret is set.
  for (const value of Object.values(step("macos", "mode").env)) {
    expect(value).toMatch(/^\$\{\{ secrets\.\w+ != '' \}\}$/);
  }
  const steps = workflow.jobs.macos.steps;
  const verify = steps.findIndex((s) => s.run?.includes("verify-macos.sh"));
  expect(verify).toBeGreaterThan(-1);
  expect(steps[verify].run).toContain("--unsigned");
  expect(steps[verify].run).toContain('--team-id "$DEVICE_APPLE_TEAM_ID"');
  expect(steps.findIndex((s) => s.id === "done")).toBeGreaterThan(verify);
  expect(run("macos", "done", { MODE: "none" }).outputs.signed).toBe("false");
  expect(
    run("macos", "done", { MODE: "developer-id", DEVICE_APPLE_TEAM_ID: "T" })
      .outputs,
  ).toEqual({ signed: "true", team: "T" });
  const notarize = steps.find((s) => s.run?.includes("notarytool submit"));
  expect(notarize.run).toContain("xcrun stapler staple");
  expect(notarize.if).toBe(
    expression("steps.mode.outputs.mode == 'developer-id'"),
  );
});

const EVIDENCE = [
  "evidence/device-clean-linux-evidence.txt",
  "evidence/device-clean-windows-evidence.txt",
];

function release(
  env,
  evidence = {
    linux: "PASS a\nRESULT: PASS\n",
    windows: "PASS a\r\nRESULT: PASS\r\n",
  },
) {
  const cwd = scratch();
  mkdirSync(join(cwd, "release", "dist"), { recursive: true });
  mkdirSync(join(cwd, "evidence"));
  for (const [os, content] of Object.entries(evidence))
    if (content !== null)
      writeFileSync(
        join(cwd, "evidence", `device-clean-${os}-evidence.txt`),
        content,
      );
  writeFileSync(join(cwd, "release", "notes.md"), "notes\n");
  writeFileSync(join(cwd, "release", "dist", "a.exe"), "installer");
  const sums = spawnSync("sha256sum", ["a.exe"], {
    cwd: join(cwd, "release", "dist"),
    encoding: "utf8",
  });
  writeFileSync(join(cwd, "release", "dist", "SHA256SUMS"), sums.stdout);
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const calls = join(cwd, "gh-calls");
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(calls)}\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  const result = run(
    "publish",
    "publish",
    { TAG: "device-v0.1.0", TITLE: "t", GH_TOKEN: "x", GH_REPO: "o/r", ...env },
    cwd,
    `${bin}:${process.env.PATH}`,
  );
  const args = existsSync(calls)
    ? readFileSync(calls, "utf8").trim().split("\n")
    : null;
  return { ...result, args };
}

test("publish passes --prerelease for anything unsigned and refuses an unsigned full release", () => {
  const unsigned = release({ PRERELEASE: "true", SIGNED: "false" });
  expect(unsigned.status).toBe(0);
  expect(unsigned.args).toContain("--prerelease");
  expect(unsigned.args).toContain("--verify-tag");
  expect(unsigned.args.slice(0, 2)).toEqual(["release", "create"]);
  expect(release({ PRERELEASE: "true", SIGNED: "true" }).args).toContain(
    "--prerelease",
  );
  expect(release({ PRERELEASE: "false", SIGNED: "true" }).args).not.toContain(
    "--prerelease",
  );
  for (const [PRERELEASE, SIGNED] of [
    ["false", "false"],
    ["", "false"],
    ["false", ""],
  ]) {
    const refused = release({ PRERELEASE, SIGNED });
    expect(refused.status).not.toBe(0);
    expect(refused.args).toBeNull();
  }
  // End to end over every input the release kind can see: no full release without signatures.
  for (const RC of ["true", "false"]) {
    for (const WINDOWS_SIGNED of ["true", "false"]) {
      for (const MACOS_SIGNED of ["true", "false", "skipped"]) {
        const decided = kind({ RC, WINDOWS_SIGNED, MACOS_SIGNED });
        const published = release({
          PRERELEASE: decided.outputs.prerelease,
          SIGNED: decided.outputs.signed,
        });
        expect(published.status).toBe(0);
        if (!published.args.includes("--prerelease")) {
          expect(WINDOWS_SIGNED).toBe("true");
          expect(MACOS_SIGNED).not.toBe("false");
          expect(RC).toBe("false");
        }
      }
    }
  }
  expect(workflow.jobs.publish.needs).toContain("assemble");
  // The fresh-machine records go up beside the installers, and SHA256SUMS still names installers only.
  const attached = release({ PRERELEASE: "true", SIGNED: "false" });
  expect(attached.args.slice(2)).toEqual([
    "device-v0.1.0",
    "release/dist/SHA256SUMS",
    "release/dist/a.exe",
    ...EVIDENCE,
    "--verify-tag",
    "--title",
    "t",
    "--notes-file",
    "release/notes.md",
    "--prerelease",
  ]);
  // A missing record, or one that does not end in RESULT: PASS, publishes nothing.
  for (const evidence of [
    { linux: null, windows: "RESULT: PASS\n" },
    { linux: "RESULT: PASS\n", windows: null },
    { linux: "PASS a\nFAIL b\n", windows: "RESULT: PASS\n" },
    { linux: "RESULT: PASS\n", windows: "RESULT: PASSED\r\n" },
  ]) {
    const refused = release({ PRERELEASE: "true", SIGNED: "false" }, evidence);
    expect(refused.status).not.toBe(0);
    expect(refused.args).toBeNull();
  }
  const env = step("publish", "publish").env;
  expect(env.PRERELEASE).toBe(expression("needs.assemble.outputs.prerelease"));
  expect(env.SIGNED).toBe(expression("needs.assemble.outputs.signed"));
});

test("the release carries exactly the installers and their SHA256SUMS", () => {
  const cwd = scratch();
  mkdirSync(join(cwd, "dist"));
  writeFileSync(join(cwd, "dist", "xiongbao-device_0.1.0_amd64.deb"), "deb");
  writeFileSync(
    join(cwd, "dist", "xiongbao-device_0.1.0_x64-setup.exe"),
    "exe",
  );
  const env = {
    TAG: "device-v0.1.0",
    VERSION: "0.1.0",
    SIGNED: "false",
    UNSIGNED: "Windows",
    WINDOWS_SIGNED: "false",
    WINDOWS_PUBLISHER: "",
    MACOS_SIGNED: "skipped",
    MACOS_TEAM: "",
    COMMIT: "abc",
  };
  const unsigned = run("assemble", "assets", env, cwd);
  expect(unsigned.status).toBe(0);
  const sums = readFileSync(join(cwd, "dist", "SHA256SUMS"), "utf8");
  expect(sums).toMatch(
    /^[0-9a-f]{64} {2}xiongbao-device_0\.1\.0_amd64\.deb\n[0-9a-f]{64} {2}xiongbao-device_0\.1\.0_x64-setup\.exe\n$/,
  );
  const notes = readFileSync(join(cwd, "notes.md"), "utf8");
  expect(notes).toContain("**未签名内测版**");
  expect(notes).toContain("SHA256SUMS");

  rmSync(join(cwd, "dist", "SHA256SUMS"));
  const signed = run(
    "assemble",
    "assets",
    {
      ...env,
      SIGNED: "true",
      UNSIGNED: "",
      WINDOWS_SIGNED: "true",
      WINDOWS_PUBLISHER: "Example Ltd",
    },
    cwd,
  );
  expect(signed.status).toBe(0);
  const signedNotes = readFileSync(join(cwd, "notes.md"), "utf8");
  expect(signedNotes).not.toContain("未签名内测版");
  expect(signedNotes).toContain("已签名（Example Ltd）");

  rmSync(join(cwd, "dist", "SHA256SUMS"));
  writeFileSync(join(cwd, "dist", "stray.txt"), "?");
  expect(run("assemble", "assets", env, cwd).status).not.toBe(0);
  rmSync(join(cwd, "dist", "stray.txt"));

  // With macOS: the dmg is listed, checksummed and described; without it, it is an unexpected file.
  const macEnv = { ...env, MACOS_SIGNED: "false", UNSIGNED: "Windows macOS" };
  expect(run("assemble", "assets", macEnv, cwd).status).not.toBe(0);
  writeFileSync(join(cwd, "dist", "xiongbao-device_0.1.0_aarch64.dmg"), "dmg");
  expect(run("assemble", "assets", env, cwd).status).not.toBe(0);
  const withMac = run("assemble", "assets", macEnv, cwd);
  expect(withMac.status).toBe(0);
  expect(readFileSync(join(cwd, "dist", "SHA256SUMS"), "utf8")).toContain(
    "  xiongbao-device_0.1.0_aarch64.dmg\n",
  );
  const macNotes = readFileSync(join(cwd, "notes.md"), "utf8");
  expect(macNotes).toContain("macOS 会提示无法验证开发者");
  expect(macNotes).toContain("xiongbao-device_0.1.0_aarch64.dmg");
});

const CLEAN = ["clean-linux", "clean-windows"];
const openbotDir = join(root, "openbot");
const linuxScriptPath = join(
  openbotDir,
  "scripts",
  "ci",
  "device-clean-linux.sh",
);
const windowsScriptPath = join(
  openbotDir,
  "scripts",
  "ci",
  "device-clean-windows.ps1",
);
const linuxScript = readFileSync(linuxScriptPath, "utf8");
const windowsScript = readFileSync(windowsScriptPath, "utf8");
const ciText = readFileSync(join(workflows, "ci.yml"), "utf8");
const ci = Bun.YAML.parse(ciText);

// Each clean-machine check is one phase of the shared script, run by one step, in this order, in both
// device-release.yml and ci.yml.
const LINUX_PHASES = [
  "sums",
  "install",
  "files",
  "selfcheck",
  "server",
  "lifecycle",
  "stop-server",
  "uninstall",
  "result",
];
const WINDOWS_PHASES = [
  "sums",
  "signature",
  "install",
  "selfcheck",
  "app",
  "uninstall",
  "result",
];
const LINUX_CALL = /^bash scripts\/ci\/device-clean-linux\.sh ([\w-]+)$/;
const WINDOWS_CALL =
  /^\.\/scripts\/ci\/device-clean-windows\.ps1 -Phase (\w+)(?: .*)?$/;

/** The body of one phase of device-clean-linux.sh, `phase_<name>() { ... }`. */
function linuxPhase(name) {
  const found = linuxScript.match(
    new RegExp(
      `^phase_${name.replace("-", "_")}\\(\\) \\{\\n[\\s\\S]*?\\n\\}$`,
      "m",
    ),
  );
  if (!found) throw new Error(`no phase ${name} in device-clean-linux.sh`);
  return found[0];
}

/** The body of one phase of device-clean-windows.ps1, `function Invoke-<Name> { ... }`. */
function windowsPhase(name) {
  const title = name[0].toUpperCase() + name.slice(1);
  const found = windowsScript.match(
    new RegExp(`^function Invoke-${title} \\{\\n[\\s\\S]*?\\n\\}$`, "m"),
  );
  if (!found) throw new Error(`no phase ${name} in device-clean-windows.ps1`);
  return found[0];
}

/** The phases a job's steps run, in order. Every step that calls the script does only that. */
function phases(job) {
  return job.steps
    .filter((s) => s.run?.includes("scripts/ci/device-clean-"))
    .map((s) => {
      const call = s.run.trim();
      const found = call.match(LINUX_CALL) ?? call.match(WINDOWS_CALL);
      expect([call, found !== null]).toEqual([call, true]);
      return found[1];
    });
}

function phaseStep(job, phase) {
  return job.steps.find((s) => {
    const call = s.run?.trim() ?? "";
    return (call.match(LINUX_CALL) ?? call.match(WINDOWS_CALL))?.[1] === phase;
  });
}

test("nothing is published until a fresh Ubuntu and a fresh Windows machine checked the exact files", () => {
  expect(workflow.jobs["clean-linux"]["runs-on"]).toBe("ubuntu-latest");
  expect(workflow.jobs["clean-windows"]["runs-on"]).toBe("windows-latest");
  for (const name of CLEAN) {
    const job = workflow.jobs[name];
    const os = name.slice(6);
    expect(job.needs).toContain("assemble");
    expect(job.if).toContain("needs.assemble.result == 'success'");
    expect(job.if).toContain("!cancelled()");
    // Read-only, no Environment (its reviewers and signing variables), no secret anywhere in it.
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.environment).toBeUndefined();
    expect(secretPaths(job)).toEqual([]);
    // The artifact publish uploads, not a rebuild.
    const download = job.steps.find((s) =>
      s.uses?.startsWith("actions/download-artifact@"),
    );
    expect(download.with.name).toBe("device-release-dist");
    expect(job.steps.indexOf(download)).toBe(0);
    expect(job.env.DIST).toBe(
      `${expression("github.workspace")}/${download.with.path}/dist`,
    );
    // The scripts come from the tagged commit, checked out beside the artifact.
    const checkout = job.steps[1];
    expect(checkout.uses).toStartWith("actions/checkout@");
    expect(checkout.with).toEqual({
      ref: expression("github.sha"),
      "persist-credentials": false,
      path: "source",
    });
    expect(job.defaults.run["working-directory"]).toBe("source/openbot");
    const upload = job.steps.find(
      (s) =>
        s.uses?.startsWith("actions/upload-artifact@") &&
        s.with.name === `device-clean-${os}-evidence`,
    );
    expect(upload).toBeDefined();
    expect(upload.if).toBe("always()");
    expect(job.env.EVIDENCE).toBe(
      `${upload.with.path}device-clean-${os}-evidence.txt`,
    );
    // The record says RESULT: PASS only from the last unconditional step, which every check before it
    // had to pass to reach; steps after it run only on failure or only upload.
    const unconditional = job.steps.filter((s) => s.run && !s.if);
    expect(unconditional.at(-1)).toBe(phaseStep(job, "result"));
    for (const s of job.steps.slice(
      job.steps.indexOf(unconditional.at(-1)) + 1,
    ))
      expect(["always()", "failure()"]).toContain(s.if);
    expect(publishNeeds()).toContain(name);
    expect(workflow.jobs.publish.if).toContain(
      `needs.${name}.result == 'success'`,
    );
  }
  expect(phases(workflow.jobs["clean-linux"])).toEqual(LINUX_PHASES);
  expect(phases(workflow.jobs["clean-windows"])).toEqual(WINDOWS_PHASES);
  for (const result of [linuxPhase("result"), windowsPhase("result")]) {
    expect(result).toContain("RESULT: PASS");
    expect(result).toContain("'^FAIL '");
  }
  // Windows: the signature is held to what the windows job verified, and the install is silent.
  expect(workflow.jobs["clean-windows"].needs).toContain("windows");
  const signature = step("clean-windows", "signature");
  expect(signature.env.WINDOWS_SIGNED).toBe(
    expression("needs.windows.outputs.signed"),
  );
  expect(signature.env.WINDOWS_PUBLISHER).toBe(
    expression("needs.windows.outputs.publisher"),
  );
  expect(signature.run).toContain("-Phase signature");
  expect(signature.run).toContain("-ExpectedSigned $env:WINDOWS_SIGNED");
  expect(signature.run).toContain("-ExpectedPublisher $env:WINDOWS_PUBLISHER");
  const authenticode = windowsPhase("signature");
  expect(authenticode).toContain("Get-AuthenticodeSignature");
  expect(authenticode).toContain("'Valid'");
  expect(authenticode).toContain("'NotSigned'");
  expect(authenticode).toContain("$publisher -cne $ExpectedPublisher");
  expect(authenticode).toContain(
    "throw \"ExpectedSigned is '$ExpectedSigned', expected true or false.\"",
  );
  expect(step("clean-windows", "sums").run).toContain("-Phase sums");
  expect(windowsPhase("sums")).toContain("Get-FileHash");
  expect(step("clean-windows", "install").run).toContain("-Phase install");
  expect(windowsPhase("install")).toContain("-ArgumentList '/S'");
  expect(step("clean-windows", "app").run).toContain("-Phase app");
  expect(windowsPhase("app")).toContain("Get-Process -Name xiongbao-runner");
  // The runner it watches is the supervised one, picked by the --server only that run is given, not
  // a one-shot command of the window's that happened to be up first.
  expect(windowsPhase("app")).toContain(
    "Where-Object { $_.CommandLine -like '* --server *' }",
  );
  expect(windowsPhase("app")).not.toContain("-notlike '*--list-roots*'");
  expect(step("clean-windows", "uninstall").run).toContain("-Phase uninstall");
  expect(windowsPhase("uninstall")).toContain("uninstall.exe");
  expect(windowsPhase("uninstall")).toContain("-ArgumentList '/S'");
  // Linux: apt installs it (and its Depends), the INSTALLED binaries are what the lifecycle runs, and
  // apt removes it.
  expect(step("clean-linux", "install").run).toContain(
    "device-clean-linux.sh install",
  );
  expect(linuxPhase("install")).toContain('sudo apt-get install -y "');
  expect(linuxScript).toContain(`echo "xiongbao-device_\${VERSION}_amd64.deb"`);
  const lifecycle = step("clean-linux", "lifecycle");
  expect(lifecycle.run).toContain("device-clean-linux.sh lifecycle");
  expect(lifecycle.env.RUNNER_BIN).toBe("/usr/bin/xiongbao-runner");
  expect(lifecycle.env.APP_BIN).toBe("/usr/bin/xiongbao-device");
  expect(step("clean-linux", "uninstall").run).toContain(
    "device-clean-linux.sh uninstall",
  );
  expect(linuxPhase("uninstall")).toContain(
    "sudo apt-get remove -y xiongbao-device",
  );
  const lint = spawnSync("bash", ["-n", linuxScriptPath], { encoding: "utf8" });
  expect(lint.status).toBe(0);
});

function publishNeeds() {
  return workflow.jobs.publish.needs;
}

/** The release's sums step as written, from openbot/ (its working directory), on a scratch dist. */
function cleanSums(files, sums, env = { TAG: "device-v0.1.0" }) {
  const cwd = scratch();
  const temp = scratch();
  const dist = join(cwd, "release", "dist");
  mkdirSync(dist, { recursive: true });
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(dist, name), content);
  if (sums !== null) writeFileSync(join(dist, "SHA256SUMS"), sums);
  const file = join(
    temp,
    "device-clean-linux",
    "device-clean-linux-evidence.txt",
  );
  const result = run(
    "clean-linux",
    "sums",
    { VERSION: "0.1.0", COMMIT: "abc", DIST: dist, EVIDENCE: file, ...env },
    openbotDir,
  );
  return {
    ...result,
    evidence: existsSync(file) ? readFileSync(file, "utf8") : "",
  };
}

test("the Linux check verifies the deb against SHA256SUMS before anything is installed", () => {
  const deb = "xiongbao-device_0.1.0_amd64.deb";
  const exe = "xiongbao-device_0.1.0_x64-setup.exe";
  const hash = (content) =>
    new Bun.CryptoHasher("sha256").update(content).digest("hex");
  const sums = `${hash("deb")}  ${deb}\n${hash("exe")}  ${exe}\n`;
  const ok = cleanSums({ [deb]: "deb", [exe]: "exe" }, sums);
  expect(ok.status).toBe(0);
  expect(ok.evidence).toContain("标签 device-v0.1.0，提交 abc");
  expect(ok.evidence).toContain(`SHA256：${hash("deb")}`);
  expect(ok.evidence).toContain("PASS SHA256SUMS");
  expect(ok.evidence).toContain("checksum-only");
  // Only the deb arrived (--ignore-missing), still checked.
  expect(cleanSums({ [deb]: "deb" }, sums).status).toBe(0);
  // A changed deb, a deb SHA256SUMS does not name, or a deb named twice: nothing is installed.
  expect(cleanSums({ [deb]: "changed", [exe]: "exe" }, sums).status).not.toBe(
    0,
  );
  expect(
    cleanSums({ [deb]: "deb" }, `${hash("exe")}  ${exe}\n`).status,
  ).not.toBe(0);
  expect(
    cleanSums(
      { [deb]: "deb" },
      `${hash("deb")}  ${deb}\n${hash("deb")}  ${deb}\n`,
    ).status,
  ).not.toBe(0);
  // No SHA256SUMS at all: nothing is installed either.
  const missing = cleanSums({ [deb]: "deb" }, null);
  expect(missing.status).not.toBe(0);
  expect(missing.evidence).toContain("FAIL ");
});

test("RESULT: PASS is written only when no check wrote FAIL", () => {
  const verdict = (content) => {
    const file = join(scratch(), "evidence.txt");
    if (content !== null) writeFileSync(file, content);
    const result = run("clean-linux", "result", { EVIDENCE: file }, openbotDir);
    return {
      status: result.status,
      evidence: existsSync(file) ? readFileSync(file, "utf8") : "",
    };
  };
  const passed = verdict("header\nPASS a\nPASS b\n");
  expect(passed.status).toBe(0);
  expect(passed.evidence.trimEnd().split("\n").at(-1)).toBe("RESULT: PASS");
  const failed = verdict("header\nPASS a\nFAIL b\n");
  expect(failed.status).not.toBe(0);
  expect(failed.evidence).not.toContain("RESULT: PASS");
  expect(verdict(null).status).not.toBe(0);
});

test("every pull request runs the same clean-machine phases on the unsigned CI installers", () => {
  const lanes = [
    [
      "device-clean-linux",
      "clean-linux",
      "device-bundle-linux",
      "ubuntu-latest",
      "linux",
      LINUX_PHASES,
    ],
    [
      "device-clean-windows",
      "clean-windows",
      "device-bundle-windows",
      "windows-latest",
      "windows",
      WINDOWS_PHASES,
    ],
  ];
  for (const [name, release, bundle, runner, os, expected] of lanes) {
    const job = ci.jobs[name];
    expect(job.name).toBe(`device clean-machine install (${runner})`);
    expect(job["runs-on"]).toBe(runner);
    expect([job.needs].flat()).toEqual([bundle]);
    expect(job.if).toBeUndefined();
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.environment).toBeUndefined();
    expect(secretPaths(job)).toEqual([]);
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(60);
    // The installer the bundle job built and uploaded on this run, not a rebuild.
    const uploaded = ci.jobs[bundle].steps
      .filter((s) => s.uses?.startsWith("actions/upload-artifact@"))
      .map((s) => s.with.name);
    const download = job.steps.find((s) =>
      s.uses?.startsWith("actions/download-artifact@"),
    );
    expect(download.with.name).toStartWith("xiongbao-device-unsigned-");
    expect(uploaded).toContain(download.with.name);
    // CI uploads no SHA256SUMS: a stage step writes one for the download, then the same phases run,
    // in the same order and by the same script as in the release job.
    const stage = job.steps.findIndex((s) => s.id === "stage");
    expect(stage).toBeGreaterThan(job.steps.indexOf(download));
    expect(stage).toBeLessThan(job.steps.indexOf(phaseStep(job, "sums")));
    expect(job.steps[stage].run).toContain("SHA256SUMS");
    expect(phases(job)).toEqual(expected);
    expect(phases(workflow.jobs[release])).toEqual(expected);
    // The evidence is uploaded under a name of its own: device-release.yml calls ci.yml, and its
    // clean-linux and clean-windows upload device-clean-<os>-evidence in the same run.
    const upload = job.steps.find((s) =>
      s.uses?.startsWith("actions/upload-artifact@"),
    );
    expect(upload.if).toBe("always()");
    expect(upload.with.name).toBe(`device-clean-${os}-ci-evidence`);
    expect(job.env.EVIDENCE).toBe(
      `${upload.with.path}device-clean-${os}-evidence.txt`,
    );
    const unconditional = job.steps.filter((s) => s.run && !s.if);
    expect(unconditional.at(-1)).toBe(phaseStep(job, "result"));
    for (const s of job.steps.slice(
      job.steps.indexOf(unconditional.at(-1)) + 1,
    ))
      expect(["always()", "failure()"]).toContain(s.if);
    // The file's conventions: inputs through env only, bash with openbot/ as the working directory,
    // and every PowerShell step says so itself.
    expect(job.defaults.run["working-directory"]).toBe("openbot");
    for (const s of job.steps) {
      if (s.run === undefined) continue;
      expect(s.run).not.toContain(expression("").slice(0, 3));
      expect(s["continue-on-error"]).toBeUndefined();
      const label = `${name}: ${s.name ?? s.id}`;
      if (os === "windows") expect([label, s.shell]).toEqual([label, "pwsh"]);
      else
        expect([label, s.shell ?? job.defaults.run.shell]).toEqual([
          label,
          "bash",
        ]);
    }
  }
  // A CI build is never signed, so NotSigned is what the signature phase must see.
  expect(step("device-clean-windows", "signature", ci).run).toBe(
    "./scripts/ci/device-clean-windows.ps1 -Phase signature -ExpectedSigned false",
  );
  // Linux pairs the installed runner with the same server and database recipe as the release job.
  const linux = ci.jobs["device-clean-linux"];
  const releaseLinux = workflow.jobs["clean-linux"];
  expect(linux.services).toEqual(releaseLinux.services);
  for (const key of [
    "PGPASSWORD",
    "OWNER_DATABASE_URL",
    "APP_DATABASE_URL",
    "ROLE_WRITER_URL",
    "ORIGIN",
    "LOG_DIR",
  ])
    expect([key, linux.env[key]]).toEqual([key, releaseLinux.env[key]]);
  expect(step("device-clean-linux", "lifecycle", ci).env).toEqual(
    step("clean-linux", "lifecycle").env,
  );
});

test("the CI deb is staged under its release name with a SHA256SUMS the sums phase accepts", () => {
  const stage = (debs) => {
    const cwd = scratch();
    const download = join(cwd, "download");
    const dist = join(cwd, "dist");
    const githubEnv = join(cwd, "github-env");
    mkdirSync(download);
    writeFileSync(githubEnv, "");
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ version: "0.1.0" }),
    );
    for (const deb of debs) writeFileSync(join(download, deb), `deb ${deb}`);
    const result = run(
      "device-clean-linux",
      "stage",
      { DOWNLOAD: download, DIST: dist, GITHUB_ENV: githubEnv },
      cwd,
      process.env.PATH,
      ci,
    );
    return { ...result, dist, githubEnv };
  };
  const ok = stage(["熊宝数字员工 设备端_0.1.0_amd64.deb"]);
  expect(ok.status).toBe(0);
  expect(readFileSync(ok.githubEnv, "utf8")).toBe("VERSION=0.1.0\n");
  const deb = "xiongbao-device_0.1.0_amd64.deb";
  expect(readFileSync(join(ok.dist, deb), "utf8")).toBe(
    "deb 熊宝数字员工 设备端_0.1.0_amd64.deb",
  );
  expect(readFileSync(join(ok.dist, "SHA256SUMS"), "utf8")).toMatch(
    new RegExp(`^[0-9a-f]{64} {2}${deb.replaceAll(".", "\\.")}\\n$`),
  );
  const evidence = join(scratch(), "evidence.txt");
  const sums = run(
    "device-clean-linux",
    "sums",
    { VERSION: "0.1.0", COMMIT: "abc", DIST: ok.dist, EVIDENCE: evidence },
    openbotDir,
    process.env.PATH,
    ci,
  );
  expect(sums.status).toBe(0);
  const record = readFileSync(evidence, "utf8");
  expect(record).toContain("CI 构建的未签名安装包（不发布），提交 abc");
  expect(record).toContain("PASS SHA256SUMS");
  // None, or more than one deb in the artifact: nothing is staged.
  expect(stage([]).status).not.toBe(0);
  expect(stage(["a_0.1.0_amd64.deb", "b_0.1.0_amd64.deb"]).status).not.toBe(0);
});

test("the browser probe also runs on windows-latest, headed, and must print BROWSER_PROBE_PASS", () => {
  const job = ci.jobs["g5-browser-probe-windows"];
  expect(job).toBeDefined();
  expect(job["runs-on"]).toBe("windows-latest");
  expect(job["continue-on-error"]).toBeUndefined();
  const probe = job.steps.find((s) =>
    String(s.run ?? "").includes("runner-browser-probe.ts --run --executable"),
  );
  expect(probe).toBeDefined();
  expect(probe.run).not.toContain("--headless");
  expect(probe.run).toContain("BROWSER_PROBE_PASS");
  expect(probe.run).toContain('"passed":false');
  for (const step of job.steps)
    expect(step["continue-on-error"]).toBeUndefined();
});

// Bun 1.3.14 cannot drive playwright-core on Windows (launch over the pipe and connectOverCDP both
// time out; Bun 1.4.4 does both), so the device jobs moved to 1.4.4 first. Since upstream v1.0.0
// (M3) the server image itself runs Bun 1.4 (`oven/bun:1.4.3` in the Dockerfile) and the code needs
// it, so the server side is tested on 1.4.4 too: one Bun for everything CI runs.
test("device jobs and the server side both use Bun 1.4.4", () => {
  const bunOf = (doc, name) =>
    doc.jobs[name].steps
      .filter((step) => String(step.uses ?? "").startsWith("oven-sh/setup-bun@"))
      .map((step) => String(step.with["bun-version"]));
  for (const name of [
    "win1-windows",
    "g5-browser-probe",
    "g5-browser-probe-windows",
    "device-bundle-linux",
    "device-bundle-windows",
    "device-bundle-macos",
  ])
    expect(bunOf(ci, name)).toEqual(["1.4.4"]);
  for (const name of ["linux", "windows", "macos"])
    expect(bunOf(workflow, name)).toEqual(["1.4.4"]);
  // The clean-machine jobs run the server (migrate, serve) beside the installed device.
  for (const name of [
    "static",
    "server-test",
    "app-test",
    "e2e-wakerflow",
    "image",
    "workspaces-test",
    "desktop-windows",
    "device-shell",
    "device-clean-linux",
  ])
    expect(bunOf(ci, name)).toEqual(["1.4.4"]);
  expect(bunOf(workflow, "clean-linux")).toEqual(["1.4.4"]);
});

// Phase 2 of desktop control: every device bundle fetches the pinned agent-desktop, checks it against
// agent-desktop.lock.json, and ships it next to the runner.
test("every device bundle fetches and verifies agent-desktop before tauri build", () => {
  const ci = Bun.YAML.parse(readFileSync(join(workflows, "ci.yml"), "utf8"));
  const targets = [
    [ci, "device-bundle-linux", false],
    [ci, "device-bundle-windows", false],
    [ci, "device-bundle-macos", true],
    [workflow, "linux", false],
    [workflow, "windows", false],
    [workflow, "macos", true],
  ];
  for (const [doc, job, macos] of targets) {
    const steps = doc.jobs[job].steps;
    const runs = steps.map((s) => s.run ?? "");
    const fetchAt = runs.findIndex((r) => r.includes("fetch-agent-desktop.ts"));
    const builds = runs.flatMap((r, i) =>
      r.includes("tauri build") ? [i] : [],
    );
    expect(fetchAt, `${job} fetches agent-desktop`).toBeGreaterThan(-1);
    expect(builds.length, `${job} builds`).toBeGreaterThan(0);
    for (const at of builds) {
      expect(fetchAt, `${job} fetches before step ${at}`).toBeLessThan(at);
      if (macos)
        expect(runs[at], `${job} bundles the macOS helper`).toContain(
          "tauri.agent-desktop-macos.conf.json",
        );
    }
    if (job === "device-bundle-linux" || job === "linux") {
      const check = runs.find((r) => r.includes("dpkg-deb -c"));
      expect(check, `${job} lists the deb contents`).toBeDefined();
      expect(
        check,
        `${job} checks the deb carries agent-desktop`,
      ).toContain("usr/bin/agent-desktop$");
    }
  }
});

// macOS 13 is the floor for the device app, and the release notes say so.
test("release notes name macOS 13+ as the floor", () => {
  const text = readFileSync(join(workflows, "device-release.yml"), "utf8");
  expect(text).toContain("macOS 13+，Apple 芯片");
  expect(text).not.toContain("macOS 11+");
});
