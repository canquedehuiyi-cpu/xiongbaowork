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
  for (const file of [
    "device-release.yml",
    "ci.yml",
    "release.yml",
    "clean-deploy.yml",
  ]) {
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
    "XB_DOWNLOAD_ACCESS_KEY_ID",
    "XB_DOWNLOAD_SECRET_ACCESS_KEY",
  ]);
  const paths = secretPaths(workflow.jobs);
  expect(paths.length).toBeGreaterThan(0);
  for (const path of paths) {
    expect(path).toMatch(/^[\w-]+\.steps\.\d+\.env\.\w+$/);
  }
  // The Apple secrets go only to the macOS job, the download page's keys only to its upload.
  for (const path of paths.filter(
    (p) => !p.startsWith("publish.") && !p.startsWith("download-page."),
  )) {
    expect(path.startsWith("macos.")).toBe(true);
  }
  for (const path of paths.filter((p) => p.startsWith("download-page."))) {
    expect(path).toMatch(/^download-page\.steps\.\d+\.env\.AWS_\w+$/);
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

// Desktop control phase 2 (Task 10): the runner's desktop read actions through the real, pinned
// agent-desktop on all three hosted runners. A runner without accessibility or an AT-SPI bus fails
// the probe; it is never skipped.
test("the desktop probe runs on three platforms, fetches the pinned binary and must print DESKTOP_PROBE_PASS", () => {
  const job = ci.jobs["desktop-probe"];
  expect(job).toBeDefined();
  expect(job["continue-on-error"]).toBeUndefined();
  expect(job["runs-on"]).toBe(expression("matrix.os"));
  expect(job.strategy["fail-fast"]).toBe(false);
  expect(job.strategy.matrix.include.map((entry) => entry.os).sort()).toEqual([
    "macos-latest",
    "ubuntu-latest",
    "windows-latest",
  ]);
  const steps = job.steps;
  for (const s of steps) expect(s["continue-on-error"]).toBeUndefined();
  expect(
    steps
      .filter((s) => String(s.uses ?? "").startsWith("oven-sh/setup-bun@"))
      .map((s) => String(s.with["bun-version"])),
  ).toEqual(["1.4.4"]);
  const runs = steps.map((s) => String(s.run ?? ""));
  expect(runs.some((r) => r.includes("bun install --frozen-lockfile"))).toBe(
    true,
  );
  const fetchAt = runs.findIndex((r) =>
    r.includes("desktop-device/scripts/fetch-agent-desktop.ts"),
  );
  expect(fetchAt).toBeGreaterThan(-1);
  expect(runs[fetchAt]).toContain("--out");
  const probes = steps.flatMap((s, at) =>
    String(s.run ?? "").includes("scripts/ci/desktop-probe.ts") ? [at] : [],
  );
  const probeOn = (os) => {
    const found = probes
      .map((at) => steps[at])
      .filter((s) => s.if === `runner.os == '${os}'`);
    expect(found.length, `one probe step for ${os}`).toBe(1);
    return found[0];
  };
  expect(probes.length).toBe(3);
  for (const at of probes) {
    expect(at, "the probe runs after the fetch").toBeGreaterThan(fetchAt);
    const run = steps[at].run;
    expect(run).toContain("--helper");
    expect(run).toContain("DESKTOP_PROBE_PASS");
    expect(run).toContain('"passed":false');
  }
  const linux = probeOn("Linux");
  expect(linux.run).toContain("xvfb-run");
  expect(linux.run).toContain("dbus-run-session");
  const windows = probeOn("Windows");
  expect(windows.env?.OPENBOT_DESKTOP_ENGINE).toBe("agent-desktop");
  expect(windows.shell).toBe("pwsh");
  probeOn("macOS");
  const install = steps.find((s) =>
    String(s.run ?? "").includes("apt-get install"),
  );
  expect(install?.if).toBe("runner.os == 'Linux'");
  for (const name of [
    "xvfb",
    "gedit",
    "openbox",
    "at-spi2-core",
    "dbus-x11",
    "libatspi2.0-0",
  ])
    expect(install.run.split(/\s+/)).toContain(name);
  const upload = steps.find((s) =>
    String(s.uses ?? "").startsWith("actions/upload-artifact@"),
  );
  expect(upload?.if).toBe("always()");
  expect(upload.with.name).toBe(`desktop-probe-${expression("matrix.os")}-log`);
});

// Bun 1.3.14 cannot drive playwright-core on Windows (launch over the pipe and connectOverCDP both
// time out; Bun 1.4.4 does both), so the device jobs moved to 1.4.4 first. Since upstream v1.0.0
// (M3) the server image itself runs Bun 1.4 (`oven/bun:1.4.3` in the Dockerfile) and the code needs
// it, so the server side is tested on 1.4.4 too: one Bun for everything CI runs.
test("device jobs and the server side both use Bun 1.4.4", () => {
  const bunOf = (doc, name) =>
    doc.jobs[name].steps
      .filter((step) =>
        String(step.uses ?? "").startsWith("oven-sh/setup-bun@"),
      )
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
      expect(check, `${job} checks the deb carries agent-desktop`).toContain(
        "usr/bin/agent-desktop$",
      );
    }
  }
});

// macOS 13 is the floor for the device app, and the release notes say so.
test("release notes name macOS 13+ as the floor", () => {
  const text = readFileSync(join(workflows, "device-release.yml"), "utf8");
  expect(text).toContain("macOS 13+，Apple 芯片");
  expect(text).not.toContain("macOS 11+");
});

// Task 5: the image and the deb are scanned for the upstream's names, before anything else in the job
// can pass them through (ci.yml; the word lists live in openbot/app/tests/brand-artifacts).
test("image and deb are brand-scanned", () => {
  const ci = Bun.YAML.parse(readFileSync(join(workflows, "ci.yml"), "utf8"));
  const steps = (job) => ci.jobs[job].steps;
  const image = steps("image");
  const scanAt = image.findIndex((s) => s.run?.includes("--kind image-files"));
  const smokeAt = image.findIndex((s) =>
    s.run?.includes("per-bot-users-smoke.sh"),
  );
  expect(scanAt, "image job scans the file list").toBeGreaterThan(-1);
  expect(smokeAt, "image job runs the per-employee smoke").toBeGreaterThan(-1);
  expect(scanAt, "file scan runs before the smoke").toBeLessThan(smokeAt);
  expect(
    image.some((s) => s.run?.includes("--kind image-config")),
    "image job scans env and labels",
  ).toBe(true);
  expect(
    image.some(
      (s) =>
        s.run?.includes("--kind web") &&
        s.run.includes("app/tests/brand-artifacts/image-logs.json"),
    ),
    "image job scans the startup log",
  ).toBe(true);
  // One round must show every word list: the scans do not stop the job, a last step judges them.
  const verdictAt = image.findIndex((s) => s.name === "Brand scans verdict");
  expect(verdictAt, "image job judges the scans at the end").toBeGreaterThan(
    -1,
  );
  expect(image[verdictAt].if).toBe("always()");
  for (const s of image.filter((s) => s.run?.includes("scan-artifact.ts")))
    expect(s["continue-on-error"], s.name).toBe(true);

  const deb = steps("device-bundle-linux");
  const checkAt = deb.findIndex(
    (s) => s.name === "Check the package installs and carries the runner",
  );
  const debAt = deb.findIndex((s) => s.run?.includes("--kind deb"));
  expect(checkAt, "deb job checks the package").toBeGreaterThan(-1);
  expect(debAt, "deb job scans the package").toBeGreaterThan(checkAt);
});

// The container release (release.yml): what the image and its manifest say about themselves.
const containerRelease = Bun.YAML.parse(
  readFileSync(join(workflows, "release.yml"), "utf8"),
);
const containerReleaseText = readFileSync(
  join(workflows, "release.yml"),
  "utf8",
);

test("release labels carry title and vendor, not the repository", () => {
  const labels = containerReleaseText
    .split("\n")
    .filter((l) => l.includes("org.opencontainers.image."));
  expect(labels.length).toBeGreaterThan(0);
  expect(
    labels.some((l) => l.includes("org.opencontainers.image.source")),
    "no source label",
  ).toBe(false);
  for (const step of containerRelease.jobs.image.steps.filter((s) =>
    s.uses?.startsWith("docker/build-push-action"),
  )) {
    const l = step.with.labels;
    expect(l).toContain("org.opencontainers.image.title=");
    expect(l).toContain("org.opencontainers.image.vendor=");
    expect(l).toContain("org.opencontainers.image.revision=");
    expect(l).toContain("org.opencontainers.image.version=");
  }
  const brandStep = containerRelease.jobs.image.steps.find((s) =>
    s.run?.includes("brand.yaml"),
  );
  expect(brandStep, "a step reads the brand package").toBeDefined();
  expect(brandStep.run).toContain("product_name");
  expect(brandStep.run).toContain("company_name");
});

// Task 17: our own channel (Task U3's variables and secrets). The image goes to our registry as its
// linux/amd64 manifest alone, the record and the samples to our download page, the device installers
// beside them; clean-deploy then fetches them the way a customer does. Until the variables are set,
// every one of those steps is skipped and the run says 「未配置自有渠道」.
const cleanDeployText = readFileSync(
  join(workflows, "clean-deploy.yml"),
  "utf8",
);
const cleanDeploy = Bun.YAML.parse(cleanDeployText);

const INDEX = `sha256:${"1".repeat(64)}`;
const PLATFORM = `sha256:${"2".repeat(64)}`;
const ATTESTATION = `sha256:${"3".repeat(64)}`;
const OTHER = `sha256:${"4".repeat(64)}`;
const OWN = {
  XB_REGISTRY: "registry.example.com",
  XB_IMAGE_REPOSITORY: "xb/app",
};
const OWN_REPOSITORY = "registry.example.com/xb/app";
const CREDENTIALS = {
  XB_REGISTRY_USERNAME: "push-user-a1b2",
  XB_REGISTRY_PASSWORD: "push-password-c3d4",
  GHCR_USERNAME: "someone",
  GHCR_TOKEN: "ghcr-token-e5f6",
};
const DOWNLOAD = {
  XB_DOWNLOAD_BUCKET: "downloads",
  XB_DOWNLOAD_ENDPOINT: "https://s3.example.com",
  AWS_ACCESS_KEY_ID: "access-key-g7h8",
  AWS_SECRET_ACCESS_KEY: "secret-key-i9j0",
};

/** A directory of stub commands; each records its arguments, one call per line, in `calls`. */
function stubs(scripts) {
  const bin = join(scratch(), "bin");
  mkdirSync(bin);
  const calls = join(scratch(), "calls");
  writeFileSync(calls, "");
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(
      join(bin, name),
      `#!/usr/bin/env bash\nprintf '${name} %s\\n' "$*" >> ${JSON.stringify(calls)}\n${body}\n`,
    );
    chmodSync(join(bin, name), 0o755);
  }
  return {
    path: `${bin}:${process.env.PATH}`,
    calls: () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean),
  };
}

/** A registry with one release index (the image and its attestation) behind a stub crane. */
function registry({ index, existing } = {}) {
  const state = scratch();
  writeFileSync(
    join(state, "index.json"),
    JSON.stringify(
      index ?? {
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.index.v1+json",
        manifests: [
          {
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            digest: PLATFORM,
            size: 1,
            platform: { architecture: "amd64", os: "linux" },
          },
          {
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            digest: ATTESTATION,
            size: 1,
            annotations: {
              "vnd.docker.reference.digest": PLATFORM,
              "vnd.docker.reference.type": "attestation-manifest",
            },
            platform: { architecture: "unknown", os: "unknown" },
          },
        ],
      },
    ),
  );
  writeFileSync(
    join(state, "platform.json"),
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
    }),
  );
  if (existing) writeFileSync(join(state, "existing"), existing);
  const s = JSON.stringify(state);
  return stubs({
    crane: `case "$1" in
  manifest)
    case "$2" in
      *@${INDEX}) cat ${s}/index.json ;;
      *@${PLATFORM}) cat ${s}/platform.json ;;
      *) echo "MANIFEST_UNKNOWN: manifest unknown" >&2; exit 1 ;;
    esac ;;
  digest)
    if [ -f ${s}/existing ]; then cat ${s}/existing; echo; else echo "GET $2: MANIFEST_UNKNOWN: manifest unknown; unknown tag" >&2; exit 1; fi ;;
  copy) printf '%s' "\${2##*@}" > ${s}/existing ;;
  *) exit 2 ;;
esac`,
  });
}

function mirror(env = {}, crane = registry()) {
  const summary = join(scratch(), "summary");
  writeFileSync(summary, "");
  const result = run(
    "mirror",
    "copy",
    {
      REPOSITORY: "ghcr.io/o/r",
      DIGEST: INDEX,
      TAG: "v0.2.0",
      RUNNER_TEMP: scratch(),
      GITHUB_STEP_SUMMARY: summary,
      ...OWN,
      ...env,
    },
    scratch(),
    crane.path,
    containerRelease,
  );
  return {
    ...result,
    calls: crane.calls(),
    summary: readFileSync(summary, "utf8"),
  };
}

test("mirror copies only the platform manifest to our registry", () => {
  const job = containerRelease.jobs.mirror;
  expect(job.needs).toEqual(["tag-check", "image", "promote"]);
  expect(job.if).toBe(expression("!inputs.dry_run"));
  expect(job.environment).toBe("release");
  expect(job.permissions).toEqual({ contents: "read", packages: "read" });
  expect(job.outputs).toEqual({
    repository: expression("steps.copy.outputs.repository"),
    digest: expression("steps.copy.outputs.digest"),
  });
  const copy = step("mirror", "copy", containerRelease);
  // As written: the copy names the platform manifest's digest, never the index's, and one tag.
  const lines = copy.run.split("\n").filter((l) => l.includes("crane copy"));
  expect(lines.length).toBe(1);
  expect(lines[0]).toContain('"$REPOSITORY@$PLATFORM_DIGEST"');
  expect(lines[0]).not.toContain("@$DIGEST");
  expect(copy.run).not.toContain("--all-tags");
  expect(copy.run).not.toContain("--platform");
  expect(copy.env.DIGEST).toBe(expression("needs.image.outputs.digest"));
  // As run: the linux/amd64 manifest is copied under the release tag, the attestation is not.
  const ok = mirror();
  expect(ok.status).toBe(0);
  const copies = ok.calls.filter((c) => c.startsWith("crane copy"));
  expect(copies).toEqual([
    `crane copy ghcr.io/o/r@${PLATFORM} ${OWN_REPOSITORY}:v0.2.0`,
  ]);
  expect(ok.calls.join("\n")).not.toContain(ATTESTATION);
  expect(ok.outputs).toEqual({ repository: OWN_REPOSITORY, digest: PLATFORM });
  expect(ok.summary).toContain(`${OWN_REPOSITORY}:v0.2.0`);
  expect(ok.summary).toContain(PLATFORM);
  // A re-run over the same copy is fine; a tag that already names another image is never moved.
  expect(mirror({}, registry({ existing: PLATFORM })).status).toBe(0);
  const moved = mirror({}, registry({ existing: OTHER }));
  expect(moved.status).not.toBe(0);
  expect(moved.calls.some((c) => c.startsWith("crane copy"))).toBe(false);
  expect(moved.outputs).toEqual({});
  // Not exactly one linux/amd64 image manifest (none, two, or a plain manifest): nothing is copied.
  const amd64 = (digest) => ({
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest,
    size: 1,
    platform: { architecture: "amd64", os: "linux" },
  });
  for (const index of [
    { mediaType: "application/vnd.oci.image.index.v1+json", manifests: [] },
    {
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [amd64(PLATFORM), amd64(OTHER)],
    },
    { mediaType: "application/vnd.oci.image.manifest.v1+json", layers: [] },
  ]) {
    const refused = mirror({}, registry({ index }));
    expect(refused.status).not.toBe(0);
    expect(refused.calls.some((c) => c.startsWith("crane copy"))).toBe(false);
  }
  // crane is installed by a pinned action at a pinned release.
  const setup = job.steps.find((s) =>
    s.uses?.startsWith("imjasonh/setup-crane@"),
  );
  expect(setup.uses).toMatch(/^imjasonh\/setup-crane@[0-9a-f]{40}$/);
  expect(setup.with.version).toMatch(/^v\d+\.\d+\.\d+$/);
});

test("container-images.json names our registry's copy as images.xiongbao once it exists", () => {
  const record = (env) => {
    const cwd = scratch();
    const result = run(
      "github-release",
      "record",
      {
        VERSION: "0.2.0",
        GITHUB_SHA: "abc",
        REPOSITORY: "ghcr.io/o/r",
        DIGEST: INDEX,
        XB_REGISTRY: "",
        OWN_REPOSITORY: "",
        OWN_DIGEST: "",
        ...env,
      },
      cwd,
      process.env.PATH,
      containerRelease,
    );
    const file = join(cwd, "container-images.json");
    return {
      ...result,
      json: existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null,
    };
  };
  const ghcr = {
    repository: "ghcr.io/o/r",
    digest: INDEX,
    reference: `ghcr.io/o/r@${INDEX}`,
  };
  // Not configured: the same image under both keys, as before.
  const unset = record({});
  expect(unset.status).toBe(0);
  expect(unset.json).toEqual({
    version: "0.2.0",
    commit: "abc",
    images: { xiongbao: ghcr, openbot: ghcr },
  });
  // Configured: images.xiongbao is the platform manifest mirror copied; images.openbot stays GHCR.
  const own = record({
    XB_REGISTRY: OWN.XB_REGISTRY,
    OWN_REPOSITORY,
    OWN_DIGEST: PLATFORM,
  });
  expect(own.status).toBe(0);
  expect(own.json.images).toEqual({
    xiongbao: {
      repository: OWN_REPOSITORY,
      digest: PLATFORM,
      reference: `${OWN_REPOSITORY}@${PLATFORM}`,
    },
    openbot: ghcr,
  });
  // Configured but no copy reported: no record is written.
  for (const env of [
    { XB_REGISTRY: OWN.XB_REGISTRY },
    { XB_REGISTRY: OWN.XB_REGISTRY, OWN_REPOSITORY, OWN_DIGEST: "sha256:x" },
  ]) {
    const refused = record(env);
    expect(refused.status).not.toBe(0);
    expect(refused.json).toBeNull();
  }
  const env = step("github-release", "record", containerRelease).env;
  expect(env.OWN_REPOSITORY).toBe(
    expression("needs.mirror.outputs.repository"),
  );
  expect(env.OWN_DIGEST).toBe(expression("needs.mirror.outputs.digest"));
  expect(env.XB_REGISTRY).toBe(expression("vars.XB_REGISTRY"));
  expect(containerRelease.jobs["github-release"].needs).toContain("mirror");
});

test("the record and the samples go up to our download page before the GitHub Release", () => {
  const job = containerRelease.jobs["github-release"];
  const upload = step("github-release", "upload", containerRelease);
  const publish = job.steps.findIndex((s) =>
    s.run?.includes("gh release create"),
  );
  expect(job.steps.indexOf(upload)).toBeLessThan(publish);
  expect(job.steps.indexOf(upload)).toBeGreaterThan(
    job.steps.indexOf(step("github-release", "record", containerRelease)),
  );
  const cwd = scratch();
  writeFileSync(join(cwd, "container-images.json"), "{}");
  mkdirSync(join(cwd, "source", "openbot", "docker"), { recursive: true });
  for (const f of ["delivery.env.example", "compose.delivery.yml"])
    writeFileSync(join(cwd, "source", "openbot", "docker", f), f);
  const aws = stubs({ aws: "" });
  const ok = run(
    "github-release",
    "upload",
    { TAG: "v0.2.0", ...DOWNLOAD },
    cwd,
    aws.path,
    containerRelease,
  );
  expect(ok.status).toBe(0);
  const s3 = "s3://downloads/v0.2.0";
  const flags = "--endpoint-url https://s3.example.com --only-show-errors";
  expect(aws.calls().filter((c) => c.startsWith("aws s3"))).toEqual([
    `aws s3 cp ${flags} container-images.json ${s3}/container-images.json`,
    `aws s3 cp ${flags} source/openbot/docker/delivery.env.example ${s3}/delivery.env.example`,
    `aws s3 cp ${flags} source/openbot/docker/compose.delivery.yml ${s3}/compose.delivery.yml`,
  ]);
  // Half-configured: it names what is missing and uploads nothing.
  for (const missing of [
    "XB_DOWNLOAD_ENDPOINT",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
  ]) {
    const none = stubs({ aws: "" });
    const refused = run(
      "github-release",
      "upload",
      { TAG: "v0.2.0", ...DOWNLOAD, [missing]: "" },
      cwd,
      none.path,
      containerRelease,
    );
    expect(refused.status).not.toBe(0);
    expect(refused.log).toContain(missing.replace(/^AWS_/, "XB_DOWNLOAD_"));
    expect(none.calls()).toEqual([]);
  }
  // The samples come from the tagged commit, without a stored credential.
  const checkout = job.steps.find((s) =>
    s.uses?.startsWith("actions/checkout@"),
  );
  expect(checkout.with).toMatchObject({
    ref: expression("github.sha"),
    "persist-credentials": false,
    path: "source",
    "sparse-checkout": "openbot/docker",
  });
});

test("the device installers go up to our download page after they are published", () => {
  const job = workflow.jobs["download-page"];
  expect(job.needs).toEqual(["tag-check", "publish"]);
  expect(job.if).toContain("needs.publish.result == 'success'");
  expect(job.if).toContain("!cancelled()");
  expect(job.environment).toBe("device-release");
  expect(job.permissions).toEqual({ contents: "read" });
  const download = job.steps.find((s) =>
    s.uses?.startsWith("actions/download-artifact@"),
  );
  expect(download.with).toEqual({
    name: "device-release-dist",
    path: "release",
  });
  const upload = (env, files = { "a.deb": "deb", "b.exe": "exe" }) => {
    const cwd = scratch();
    const dist = join(cwd, "release", "dist");
    mkdirSync(dist, { recursive: true });
    for (const [name, content] of Object.entries(files))
      writeFileSync(join(dist, name), content);
    const sums = spawnSync("sha256sum", Object.keys(files), {
      cwd: dist,
      encoding: "utf8",
    });
    writeFileSync(join(dist, "SHA256SUMS"), sums.stdout);
    writeFileSync(join(cwd, "release", "notes.md"), "notes");
    if (env.CHANGE) writeFileSync(join(dist, "a.deb"), "changed");
    const aws = stubs({ aws: "" });
    const summary = join(scratch(), "summary");
    writeFileSync(summary, "");
    const result = run(
      "download-page",
      "upload",
      {
        TAG: "device-v0.1.0",
        GITHUB_STEP_SUMMARY: summary,
        ...DOWNLOAD,
        ...env,
      },
      cwd,
      aws.path,
    );
    return {
      ...result,
      calls: aws.calls().filter((c) => c.startsWith("aws s3")),
    };
  };
  const ok = upload({});
  expect(ok.status).toBe(0);
  const flags = "--endpoint-url https://s3.example.com --only-show-errors";
  const s3 = "s3://downloads/device-v0.1.0/device";
  expect(ok.calls).toEqual([
    `aws s3 cp ${flags} release/dist/SHA256SUMS ${s3}/SHA256SUMS`,
    `aws s3 cp ${flags} release/dist/a.deb ${s3}/a.deb`,
    `aws s3 cp ${flags} release/dist/b.exe ${s3}/b.exe`,
  ]);
  // An installer that no longer matches SHA256SUMS, or a missing key: nothing goes up.
  expect(upload({ CHANGE: "1" }).calls).toEqual([]);
  expect(upload({ CHANGE: "1" }).status).not.toBe(0);
  for (const missing of ["XB_DOWNLOAD_ENDPOINT", "AWS_SECRET_ACCESS_KEY"]) {
    const refused = upload({ [missing]: "" });
    expect(refused.status).not.toBe(0);
    expect(refused.calls).toEqual([]);
  }
});

/** Steps that reach our channel: they name its variables or secrets, or run crane or aws. */
function channelSteps(doc) {
  return Object.entries(doc.jobs).flatMap(([job, j]) =>
    (j.steps ?? [])
      .filter((s) => {
        const text = JSON.stringify(s);
        return (
          /secrets\.XB_|vars\.XB_|crane|aws /.test(text) &&
          !String(s.if ?? "").includes("== ''")
        );
      })
      .map((s) => ({ job, step: s })),
  );
}

test("our channel steps skip cleanly when unconfigured", () => {
  const registryGate = expression("vars.XB_REGISTRY != ''");
  const downloadGate = expression("vars.XB_DOWNLOAD_BUCKET != ''");
  // Every step that does something with the channel is gated on its variable; the record step and
  // the summary only read the variables, and must run either way.
  const ungated = new Set(["github-release/record", "own-channel/summary"]);
  const release = channelSteps(containerRelease);
  expect(release.length).toBeGreaterThan(5);
  for (const { job, step: s } of release) {
    const label = `${job}/${s.id ?? s.uses ?? s.name}`;
    if (ungated.has(label)) {
      expect([label, s.if]).toEqual([label, undefined]);
      continue;
    }
    const gate = job === "mirror" ? registryGate : downloadGate;
    expect([label, s.if]).toEqual([label, gate]);
  }
  // Steps of the channel's jobs that do not mention it are gated too (crane's install, a checkout).
  for (const s of containerRelease.jobs.mirror.steps)
    expect([s.id ?? s.uses, s.if]).toEqual([s.id ?? s.uses, registryGate]);
  for (const s of containerRelease.jobs["github-release"].steps.filter((s) =>
    s.uses?.startsWith("actions/checkout@"),
  ))
    expect(s.if).toBe(downloadGate);
  const device = workflow.jobs["download-page"].steps;
  for (const s of device.filter((s) => !String(s.if).includes("== ''")))
    expect([s.id ?? s.uses, s.if]).toEqual([s.id ?? s.uses, downloadGate]);
  // Unconfigured, the run says so: release.yml in every mode (dry runs included), the device release
  // once it has published.
  const summary = (env) => {
    const file = join(scratch(), "summary");
    writeFileSync(file, "");
    const result = run(
      "own-channel",
      "summary",
      {
        TAG: "v0.2.0",
        XB_REGISTRY: "",
        XB_IMAGE_REPOSITORY: "",
        XB_DOWNLOAD_BUCKET: "",
        DRY_RUN: "",
        GITHUB_STEP_SUMMARY: file,
        ...env,
      },
      scratch(),
      process.env.PATH,
      containerRelease,
    );
    return { status: result.status, text: readFileSync(file, "utf8") };
  };
  const own = containerRelease.jobs["own-channel"];
  expect(own.needs).toBe("tag-check");
  expect(own.if).toBeUndefined();
  expect(own.environment).toBeUndefined();
  expect(own.permissions).toEqual({ contents: "read" });
  expect(secretPaths(own)).toEqual([]);
  const none = summary({ DRY_RUN: "true" });
  expect(none.status).toBe(0);
  expect(none.text.match(/未配置自有渠道/g)?.length).toBe(2);
  expect(none.text).toContain("XB_REGISTRY");
  expect(none.text).toContain("XB_DOWNLOAD_BUCKET");
  const set = summary({ ...OWN, XB_DOWNLOAD_BUCKET: "downloads" });
  expect(set.text).not.toContain("未配置自有渠道");
  expect(set.text).toContain(`${OWN_REPOSITORY}:v0.2.0`);
  expect(set.text).toContain("s3://downloads/v0.2.0/");
  const notice = device.find(
    (s) => s.if === expression("vars.XB_DOWNLOAD_BUCKET == ''"),
  );
  expect(notice.run).toContain("未配置自有渠道");
  expect(notice.run).toContain("GITHUB_STEP_SUMMARY");
});

test("credentials never appear on a command line", () => {
  // As written: no run script names a secret or interpolates an expression; secrets come in by env.
  for (const doc of [containerRelease, workflow, cleanDeploy]) {
    for (const { step: s } of channelSteps(doc)) {
      if (s.run) {
        expect(s.run).not.toContain("secrets.");
        expect(s.run).not.toContain(expression("").slice(0, 3));
        expect(s.run).not.toMatch(/\bset -x|xtrace/);
      }
      for (const [key, value] of Object.entries(s.with ?? {}))
        expect([key, String(value)]).not.toEqual([
          key,
          expect.stringContaining("secrets."),
        ]);
    }
  }
  const xbSecrets = (doc) =>
    secretPaths(doc.jobs).filter((p) =>
      /secrets\.XB_/.test(
        p.split(".").reduce((node, key) => node[key], doc.jobs),
      ),
    );
  expect(xbSecrets(containerRelease).sort()).toEqual([
    "github-release.steps.3.env.AWS_ACCESS_KEY_ID",
    "github-release.steps.3.env.AWS_SECRET_ACCESS_KEY",
    "mirror.steps.1.env.XB_REGISTRY_PASSWORD",
    "mirror.steps.1.env.XB_REGISTRY_USERNAME",
  ]);
  expect(secretPaths(cleanDeploy.jobs).every((p) => !p.includes("XB_"))).toBe(
    true,
  );
  // As run: the sign-in writes a Docker config for crane from the environment; no command it starts
  // is given a credential as an argument, and nothing it prints contains one.
  const config = scratch();
  const traced = stubs({ jq: 'exec /usr/bin/env -S "$REAL_JQ" "$@"' });
  const login = run(
    "mirror",
    "login",
    {
      ...OWN,
      ...CREDENTIALS,
      RUNNER_TEMP: config,
      REAL_JQ: Bun.which("jq"),
      GITHUB_ENV: join(config, "github-env"),
    },
    scratch(),
    traced.path,
    containerRelease,
  );
  expect(login.status).toBe(0);
  const secretValues = Object.values(CREDENTIALS).filter(
    (v) => v !== "someone",
  );
  for (const value of secretValues) {
    expect(login.log).not.toContain(value);
    expect(traced.calls().join("\n")).not.toContain(value);
  }
  const dockerConfig = join(config, "own-channel-docker");
  expect(readFileSync(join(config, "github-env"), "utf8")).toBe(
    `DOCKER_CONFIG=${dockerConfig}\n`,
  );
  const auths = JSON.parse(
    readFileSync(join(dockerConfig, "config.json"), "utf8"),
  ).auths;
  const decode = (entry) => Buffer.from(entry.auth, "base64").toString();
  expect(decode(auths[OWN.XB_REGISTRY])).toBe(
    "push-user-a1b2:push-password-c3d4",
  );
  expect(decode(auths["ghcr.io"])).toBe("someone:ghcr-token-e5f6");
  // A registry without its repository or credentials stops before anything is written.
  for (const missing of [
    "XB_IMAGE_REPOSITORY",
    "XB_REGISTRY_USERNAME",
    "XB_REGISTRY_PASSWORD",
  ]) {
    const dir = scratch();
    const refused = run(
      "mirror",
      "login",
      {
        ...OWN,
        ...CREDENTIALS,
        [missing]: "",
        RUNNER_TEMP: dir,
        GITHUB_ENV: join(dir, "github-env"),
      },
      scratch(),
      process.env.PATH,
      containerRelease,
    );
    expect(refused.status).not.toBe(0);
    expect(refused.log).toContain(missing);
    expect(existsSync(join(dir, "own-channel-docker", "config.json"))).toBe(
      false,
    );
  }
  // The upload hands its keys to aws through the environment only.
  const cwd = scratch();
  writeFileSync(join(cwd, "container-images.json"), "{}");
  mkdirSync(join(cwd, "source", "openbot", "docker"), { recursive: true });
  for (const f of ["delivery.env.example", "compose.delivery.yml"])
    writeFileSync(join(cwd, "source", "openbot", "docker", f), f);
  const aws = stubs({
    aws: `[ "$1" != s3 ] || printf '%s|%s\\n' "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" >> ${JSON.stringify(join(cwd, "keys"))}`,
  });
  const upload = run(
    "github-release",
    "upload",
    { TAG: "v0.2.0", ...DOWNLOAD },
    cwd,
    aws.path,
    containerRelease,
  );
  expect(upload.status).toBe(0);
  for (const value of [
    DOWNLOAD.AWS_ACCESS_KEY_ID,
    DOWNLOAD.AWS_SECRET_ACCESS_KEY,
  ]) {
    expect(upload.log).not.toContain(value);
    expect(aws.calls().join("\n")).not.toContain(value);
  }
  expect(readFileSync(join(cwd, "keys"), "utf8").trim().split("\n")).toEqual(
    Array(3).fill("access-key-g7h8|secret-key-i9j0"),
  );
});

function cleanRecord(env, files) {
  const evidence = scratch();
  const githubEnv = join(scratch(), "github-env");
  writeFileSync(githubEnv, "");
  const record = JSON.stringify({
    images: {
      xiongbao: { reference: files.xiongbao },
      openbot: { reference: files.openbot },
    },
  });
  const fixture = join(scratch(), "container-images.json");
  writeFileSync(fixture, record);
  const tools = stubs({
    curl: `out=""; prev=""; for a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; done; cp ${JSON.stringify(fixture)} "$out"`,
    gh: `cp ${JSON.stringify(fixture)} "\${@: -1}/container-images.json"`,
  });
  const result = run(
    "linux",
    "record",
    {
      TAG: "v0.2.0",
      EVIDENCE: evidence,
      GITHUB_ENV: githubEnv,
      GH_TOKEN: "x",
      GH_REPO: "o/r",
      XB_REGISTRY: "",
      XB_IMAGE_REPOSITORY: "",
      XB_DOWNLOAD_BUCKET: "",
      XB_DOWNLOAD_BASE_URL: "",
      ...env,
    },
    scratch(),
    tools.path,
    cleanDeploy,
  );
  return {
    ...result,
    calls: tools.calls(),
    env: readFileSync(githubEnv, "utf8"),
  };
}

test("clean-deploy fetches from our download page when configured", () => {
  const ghcr = `ghcr.io/o/r@${INDEX}`;
  const own = `${OWN_REPOSITORY}@${PLATFORM}`;
  // Not configured: the GitHub Release's record and its images.openbot, as before.
  const before = cleanRecord({}, { xiongbao: ghcr, openbot: ghcr });
  expect(before.status).toBe(0);
  expect(before.calls).toEqual([
    `gh release download v0.2.0 --pattern container-images.json --dir ${before.calls[0].split(" ").at(-1)}`,
  ]);
  expect(before.env).toBe(`EXPECTED_REFERENCE=${ghcr}\n`);
  expect(
    cleanRecord(
      {},
      { xiongbao: ghcr, openbot: `registry.example.com/x@${INDEX}` },
    ).status,
  ).not.toBe(0);
  // Configured: the record comes from our download page as a customer reaches it, and the image to
  // run and check is images.xiongbao, in our registry.
  const configured = {
    ...OWN,
    XB_DOWNLOAD_BUCKET: "downloads",
    XB_DOWNLOAD_BASE_URL: "https://download.example.com/xb/",
  };
  const after = cleanRecord(configured, { xiongbao: own, openbot: ghcr });
  expect(after.status).toBe(0);
  expect(after.calls.length).toBe(1);
  expect(after.calls[0]).toStartWith("curl ");
  expect(after.calls[0]).toEndWith(
    " https://download.example.com/xb/v0.2.0/container-images.json",
  );
  expect(after.env).toBe(
    `CUSTOMER_IMAGE=${OWN_REPOSITORY}:v0.2.0\nEXPECTED_REFERENCE=${own}\n`,
  );
  // images.xiongbao must be our registry's copy, by digest; GHCR no longer passes.
  for (const xiongbao of [
    ghcr,
    `${OWN_REPOSITORY}:v0.2.0`,
    `registry.example.com/other@${PLATFORM}`,
  ]) {
    const refused = cleanRecord(configured, { xiongbao, openbot: ghcr });
    expect(refused.status).not.toBe(0);
    expect(refused.env).toBe("");
  }
  // Only one half configured: the download page alone keeps GHCR's image, our registry alone keeps
  // the GitHub Release's record.
  const pageOnly = cleanRecord(
    {
      XB_DOWNLOAD_BUCKET: "downloads",
      XB_DOWNLOAD_BASE_URL: "https://d.example.com",
    },
    { xiongbao: ghcr, openbot: ghcr },
  );
  expect(pageOnly.calls[0]).toEndWith(
    " https://d.example.com/v0.2.0/container-images.json",
  );
  expect(pageOnly.env).toBe(`EXPECTED_REFERENCE=${ghcr}\n`);
  const registryOnly = cleanRecord(OWN, { xiongbao: own, openbot: ghcr });
  expect(registryOnly.calls[0]).toStartWith("gh release download");
  expect(registryOnly.env).toContain(`EXPECTED_REFERENCE=${own}\n`);
  // A bucket without the page's address fails rather than fetch from GitHub.
  expect(
    cleanRecord(
      { XB_DOWNLOAD_BUCKET: "downloads" },
      { xiongbao: ghcr, openbot: ghcr },
    ).status,
  ).not.toBe(0);
  const recordEnv = step("linux", "record", cleanDeploy).env;
  for (const name of [
    "XB_REGISTRY",
    "XB_IMAGE_REPOSITORY",
    "XB_DOWNLOAD_BUCKET",
    "XB_DOWNLOAD_BASE_URL",
  ])
    expect(recordEnv[name]).toBe(expression(`vars.${name}`));
  // delivery.env.example (external database) comes from the same place; the customer run starts our
  // registry's copy through the README's OPENBOT_IMAGE when it is configured.
  const roles = step("linux", "roles", cleanDeploy);
  expect(roles.run).toContain(
    '"$XB_DOWNLOAD_BASE_URL/$TAG/delivery.env.example"',
  );
  expect(roles.run).toContain("raw.githubusercontent.com");
  expect(roles.env.XB_DOWNLOAD_BUCKET).toBe(
    expression("vars.XB_DOWNLOAD_BUCKET"),
  );
  const customer = step("linux", "customer", cleanDeploy);
  expect(customer.run).toContain("OPENBOT_IMAGE=$CUSTOMER_IMAGE");
  const check = step("linux", "digest", cleanDeploy);
  expect(check.run).toContain(`"\${expected%@*}:$TAG"`);
});
