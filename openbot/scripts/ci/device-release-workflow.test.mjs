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
  expect(workflow.jobs.publish.if).toBe(expression("!inputs.dry_run"));
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
  expect(workflow.jobs.publish.environment).toBe("device-release");
});

test("no run script interpolates an expression, and only GITHUB_TOKEN is a secret", () => {
  for (const s of allSteps(workflow)) {
    if (s.run) expect(s.run).not.toContain(expression("").slice(0, 3));
    expect(s["continue-on-error"]).toBeUndefined();
  }
  const secrets = [...text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(
    (m) => m[1],
  );
  expect([...new Set(secrets)]).toEqual(["GITHUB_TOKEN"]);
  // CI's throwaway rehearsal certificate can never sign a release.
  expect(text).not.toContain("test-certificate");
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
});

function release(env) {
  const cwd = scratch();
  mkdirSync(join(cwd, "release", "dist"), { recursive: true });
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
      const decided = kind({ RC, WINDOWS_SIGNED });
      const published = release({
        PRERELEASE: decided.outputs.prerelease,
        SIGNED: decided.outputs.signed,
      });
      expect(published.status).toBe(0);
      if (!published.args.includes("--prerelease")) {
        expect(WINDOWS_SIGNED).toBe("true");
        expect(RC).toBe("false");
      }
    }
  }
  expect(workflow.jobs.publish.needs).toContain("assemble");
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
});
