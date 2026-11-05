// F2 stage 3: .github/workflows/device-release.yml, the device app's release. It only runs from a
// person's device-v* tag (or a manual run on one), every action is pinned to a commit, and an
// unsigned installer can only ever be published as a prerelease. The decision steps are run here as
// written in the workflow (bash, inputs from env), with a stub `gh` standing in for the release.
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

function step(job, id) {
  const found = workflow.jobs[job].steps.find((s) => s.id === id);
  if (!found) throw new Error(`no step ${id} in job ${job}`);
  return found;
}

/** Runs a workflow step's script the way GitHub runs `shell: bash`, with only `env` set. */
function run(job, id, env, cwd = scratch(), path = process.env.PATH) {
  const output = join(scratch(), "github-output");
  writeFileSync(output, "");
  const script = join(scratch(), "step.sh");
  writeFileSync(script, step(job, id).run);
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

test("nothing is published until a fresh Ubuntu and a fresh Windows machine checked the exact files", () => {
  expect(workflow.jobs["clean-linux"]["runs-on"]).toBe("ubuntu-latest");
  expect(workflow.jobs["clean-windows"]["runs-on"]).toBe("windows-latest");
  for (const name of CLEAN) {
    const job = workflow.jobs[name];
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
    const upload = job.steps.find(
      (s) =>
        s.uses?.startsWith("actions/upload-artifact@") &&
        s.with.name === `device-clean-${name.slice(6)}-evidence`,
    );
    expect(upload).toBeDefined();
    expect(upload.if).toBe("always()");
    // The record says RESULT: PASS only from the last unconditional step, which every check before it
    // had to pass to reach; steps after it run only on failure or only upload.
    const unconditional = job.steps.filter((s) => s.run && !s.if);
    expect(unconditional.at(-1).run).toContain("RESULT: PASS");
    for (const s of job.steps.slice(
      job.steps.indexOf(unconditional.at(-1)) + 1,
    ))
      expect(["always()", "failure()"]).toContain(s.if);
    expect(publishNeeds()).toContain(name);
    expect(workflow.jobs.publish.if).toContain(
      `needs.${name}.result == 'success'`,
    );
  }
  // Windows: the signature is held to what the windows job verified, and the install is silent.
  expect(workflow.jobs["clean-windows"].needs).toContain("windows");
  const signature = step("clean-windows", "signature");
  expect(signature.env.WINDOWS_SIGNED).toBe(
    expression("needs.windows.outputs.signed"),
  );
  expect(signature.run).toContain("Get-AuthenticodeSignature");
  expect(signature.run).toContain("'Valid'");
  expect(signature.run).toContain("'NotSigned'");
  expect(step("clean-windows", "sums").run).toContain("Get-FileHash");
  expect(step("clean-windows", "install").run).toContain("-ArgumentList '/S'");
  expect(step("clean-windows", "app").run).toContain(
    "Get-Process -Name openbot-runner",
  );
  expect(step("clean-windows", "uninstall").run).toContain("uninstall.exe");
  expect(step("clean-windows", "uninstall").run).toContain(
    "-ArgumentList '/S'",
  );
  // Linux: apt installs it (and its Depends), the INSTALLED binaries are what the lifecycle runs, and
  // apt removes it.
  const linux = workflow.jobs["clean-linux"].steps;
  expect(
    linux.some((s) =>
      s.run?.includes(
        'sudo apt-get install -y "./release/dist/xiongbao-device_$',
      ),
    ),
  ).toBe(true);
  const lifecycle = linux.find((s) =>
    s.run?.includes("scripts/ci/device-clean-linux.sh"),
  );
  expect(lifecycle.env.RUNNER_BIN).toBe("/usr/bin/openbot-runner");
  expect(lifecycle.env.APP_BIN).toBe("/usr/bin/xiongbao-device");
  expect(step("clean-linux", "uninstall").run).toContain(
    "sudo apt-get remove -y xiongbao-device",
  );
  const lint = spawnSync(
    "bash",
    ["-n", join(root, "openbot", "scripts", "ci", "device-clean-linux.sh")],
    { encoding: "utf8" },
  );
  expect(lint.status).toBe(0);
});

function publishNeeds() {
  return workflow.jobs.publish.needs;
}

function cleanSums(files, sums) {
  const cwd = scratch();
  const temp = scratch();
  mkdirSync(join(cwd, "release", "dist"), { recursive: true });
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(cwd, "release", "dist", name), content);
  writeFileSync(join(cwd, "release", "dist", "SHA256SUMS"), sums);
  const result = run(
    "clean-linux",
    "sums",
    {
      VERSION: "0.1.0",
      TAG: "device-v0.1.0",
      COMMIT: "abc",
      RUNNER_TEMP: temp,
    },
    cwd,
  );
  const file = join(
    temp,
    "device-clean-linux",
    "device-clean-linux-evidence.txt",
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
});
