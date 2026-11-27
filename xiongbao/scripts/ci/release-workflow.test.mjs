// The image release pipeline (.github/workflows/release.yml and the workflows it calls), after what
// went wrong in v0.2.16:
// - a job-level `if:` (and any job that names no Environment) cannot see a variable set only on the
//   `release` Environment, so the mirror job was skipped and G7 failed. Such variables are read
//   only inside a job that names the Environment; anything decided from them goes on as job outputs.
// - a re-run built the image again, got a new digest, and promote (rightly) refused to move the
//   immutable tags to it. A re-run now goes on with the digest those tags already name.
// - G7 pulled the private JCR copy anonymously. It installs the public GHCR image.
// Steps are run here as written (bash, inputs from env) with stub `docker` and `gh`.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
const load = (name) =>
  Bun.YAML.parse(readFileSync(join(workflows, name), "utf8"));
const release = load("release.yml");
const cleanDeploy = load("clean-deploy.yml");
const cleanDeployText = readFileSync(
  join(workflows, "clean-deploy.yml"),
  "utf8",
);
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "release-workflow-"));
  dirs.push(dir);
  return dir;
}

const expression = (inner) => `\${{ ${inner} }}`;

function step(doc, job, id) {
  const found = doc.jobs[job].steps.find((s) => s.id === id);
  if (!found) throw new Error(`no step ${id} in job ${job}`);
  return found;
}

function run(doc, job, id, env, path = process.env.PATH) {
  const output = join(scratch(), "github-output");
  writeFileSync(output, "");
  const summary = join(scratch(), "summary");
  writeFileSync(summary, "");
  const script = join(scratch(), "step.sh");
  writeFileSync(script, step(doc, job, id).run);
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-eo", "pipefail", script],
    {
      cwd: scratch(),
      encoding: "utf8",
      env: {
        PATH: path,
        HOME: tmpdir(),
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        RUNNER_TEMP: scratch(),
        ...env,
      },
    },
  );
  const outputs = {};
  for (const line of readFileSync(output, "utf8").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) outputs[line.slice(0, at)] = line.slice(at + 1);
  }
  return {
    status: result.status,
    log: result.stdout + result.stderr,
    outputs,
    summary: readFileSync(summary, "utf8"),
  };
}

/** Stub commands; each records its arguments, one call per line. */
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

// ---- variables an Environment holds ----

// Variables that must be set at repository level because something outside a job that names an
// Environment reads them. The release pipeline needs none: every `vars.*` it reads is read in a
// step of a job that names the `release` Environment, which sees Environment and repository
// variables alike. Adding a name here means documenting it as repository-level in
// docs/releasing.md and docs/deployment-xiongbao.md.
const REPO_LEVEL_VARS = [];
// What the release pipeline reads inside the `release` Environment (either level works there).
const ENVIRONMENT_VARS = [
  "XB_DOWNLOAD_BASE_URL",
  "XB_DOWNLOAD_BUCKET",
  "XB_DOWNLOAD_ENDPOINT",
  "XB_DOWNLOAD_REGION",
  "XB_IMAGE_REPOSITORY",
  "XB_JDCLOUD_REGION",
  "XB_JDCLOUD_REGISTRY_NAME",
  "XB_REGISTRY",
];
// release.yml, the workflows it calls, and the manual copy that shares its steps.
const PIPELINE = [
  "release.yml",
  "ci.yml",
  "clean-deploy.yml",
  "mirror-release.yml",
];

/** Every `vars.NAME` in a node, with where it is. */
function varsIn(node, path) {
  if (typeof node === "string")
    return [...node.matchAll(/\bvars\.(\w+)/g)].map((m) => ({
      name: m[1],
      path,
    }));
  if (node && typeof node === "object")
    return Object.entries(node).flatMap(([key, value]) =>
      varsIn(value, `${path}.${key}`),
    );
  return [];
}

/**
 * The `vars.*` that GitHub evaluates where an Environment-only variable reads as empty: anything
 * outside `jobs` (triggers, concurrency, env); in a job that names no Environment, everything
 * (`if`, `with`, `env`, `outputs`, steps...); in a job that names one, the keys decided before the
 * job enters it (`if`, `needs`, `environment`, `strategy`, `runs-on`, `concurrency`). Its `env`,
 * `outputs` and steps run inside the Environment and see its variables.
 */
const BEFORE_ENVIRONMENT = [
  "if",
  "needs",
  "environment",
  "strategy",
  "runs-on",
  "concurrency",
];
function outsideEnvironment(doc, file, repoLevel = REPO_LEVEL_VARS) {
  const { jobs, ...top } = doc;
  const found = varsIn(top, file);
  for (const [name, job] of Object.entries(jobs))
    for (const [key, value] of Object.entries(job))
      if (!job.environment || BEFORE_ENVIRONMENT.includes(key))
        found.push(...varsIn(value, `${file}.jobs.${name}.${key}`));
  return found.filter((v) => !repoLevel.includes(v.name));
}

test("no job-level if, and no job outside the release Environment, reads an Environment variable", () => {
  for (const file of PIPELINE)
    expect([file, outsideEnvironment(load(file), file)]).toEqual([file, []]);
  // The checker catches what broke v0.2.16: a job-level gate on XB_REGISTRY, and G7 (no
  // Environment) reading XB_IMAGE_REPOSITORY in a step.
  expect(
    outsideEnvironment(
      {
        jobs: {
          mirror: {
            if: expression("vars.XB_REGISTRY != ''"),
            environment: "release",
            steps: [{ env: { A: expression("vars.XB_REGISTRY") } }],
          },
          linux: {
            steps: [{ env: { B: expression("vars.XB_IMAGE_REPOSITORY") } }],
          },
        },
      },
      "old",
    ).map((v) => `${v.path}:${v.name}`),
  ).toEqual([
    "old.jobs.mirror.if:XB_REGISTRY",
    "old.jobs.linux.steps.0.env.B:XB_IMAGE_REPOSITORY",
  ]);
});

test("every variable the pipeline reads is declared, and each job that reads one names the release Environment", () => {
  const used = new Set();
  for (const file of PIPELINE) {
    const doc = load(file);
    for (const [name, job] of Object.entries(doc.jobs))
      for (const v of varsIn(job.steps ?? [], `${file}.jobs.${name}`)) {
        used.add(v.name);
        expect([v.path, job.environment]).toEqual([v.path, "release"]);
      }
  }
  expect([...used].sort()).toEqual(
    [...ENVIRONMENT_VARS, ...REPO_LEVEL_VARS].sort(),
  );
  // The docs say where each one goes.
  for (const doc of ["releasing.md", "deployment-xiongbao.md"]) {
    const text = readFileSync(
      join(import.meta.dir, "..", "..", "docs", doc),
      "utf8",
    );
    for (const name of ENVIRONMENT_VARS)
      expect([doc, name, text.includes(`\`${name}\``)]).toEqual([
        doc,
        name,
        true,
      ]);
  }
});

test("mirror and G7 follow what promote read inside the release Environment", () => {
  const promote = release.jobs.promote;
  expect(promote.environment).toBe("release");
  expect(promote.steps[0].id).toBe("channel");
  expect(promote.outputs).toEqual({
    mirror: expression("steps.channel.outputs.mirror"),
    download_base_url: expression("steps.channel.outputs.download_base_url"),
  });
  expect(release.jobs.mirror.if).toBe(
    expression("!inputs.dry_run && needs.promote.outputs.mirror == 'true'"),
  );
  const releaseIf = release.jobs["github-release"].if.replace(/\s+/g, " ");
  expect(releaseIf).toContain(
    "(needs.mirror.result == 'skipped' && needs.promote.outputs.mirror == 'false')",
  );
  expect(release.jobs["g7-linux"].needs).toContain("promote");
  expect(release.jobs["g7-linux"].with).toEqual({
    tag: expression("needs.tag-check.outputs.tag"),
    download_base_url: expression("needs.promote.outputs.download_base_url"),
  });
  expect(release.jobs["own-channel"]).toBeUndefined();
  // Half a channel never skips quietly: it stops promote, before any tag, naming what is missing.
  const channel = (env) =>
    run(release, "promote", "channel", {
      TAG: "v0.2.17",
      XB_REGISTRY: "",
      XB_IMAGE_REPOSITORY: "",
      XB_DOWNLOAD_BUCKET: "",
      XB_DOWNLOAD_BASE_URL: "",
      ...env,
    });
  for (const [env, message] of [
    [
      { XB_REGISTRY: "r.example.com" },
      "XB_REGISTRY is set but XB_IMAGE_REPOSITORY is not",
    ],
    [
      { XB_IMAGE_REPOSITORY: "xb/app" },
      "XB_IMAGE_REPOSITORY is set but XB_REGISTRY is not",
    ],
    [
      { XB_DOWNLOAD_BUCKET: "downloads" },
      "XB_DOWNLOAD_BUCKET is set but XB_DOWNLOAD_BASE_URL is not",
    ],
    [
      { XB_DOWNLOAD_BASE_URL: "https://d.example.com" },
      "XB_DOWNLOAD_BASE_URL is set but XB_DOWNLOAD_BUCKET is not",
    ],
    [
      { XB_DOWNLOAD_BUCKET: "d", XB_DOWNLOAD_BASE_URL: "http://d.example.com" },
      "XB_DOWNLOAD_BASE_URL must start with https://",
    ],
  ]) {
    const refused = channel(env);
    expect([message, refused.status]).toEqual([message, 1]);
    expect(refused.log).toContain(`::error::${message}`);
    expect(refused.outputs).toEqual({});
  }
  const none = channel({});
  expect(none.status).toBe(0);
  expect(none.outputs).toEqual({ mirror: "false", download_base_url: "" });
  // Skipped on purpose, and said so where the run is read.
  expect(none.log).toContain("::notice::");
  expect(none.summary).toContain("mirror 跳过");
  const all = channel({
    XB_REGISTRY: "r.example.com",
    XB_IMAGE_REPOSITORY: "xb/app",
    XB_DOWNLOAD_BUCKET: "downloads",
    XB_DOWNLOAD_BASE_URL: "https://d.example.com",
  });
  expect(all.status).toBe(0);
  expect(all.outputs).toEqual({
    mirror: "true",
    download_base_url: "https://d.example.com",
  });
  // Before anything immutable is written.
  const order = promote.steps.map((s) => s.id ?? s.name);
  expect(order.indexOf("channel")).toBeLessThan(
    order.indexOf("Tag the verified digest"),
  );
});

// ---- a re-run reuses the digest it already built ----

const SHA = "0123456789abcdef0123456789abcdef01234567";
const D1 = `sha256:${"a".repeat(64)}`;
const D2 = `sha256:${"b".repeat(64)}`;
const REPOSITORY = "ghcr.io/o/r";

/**
 * Runs image's `existing` step. `tags` maps a tag to the digest GHCR has for it (absent: not found;
 * "denied": a lookup that fails for another reason). `verified` is whether the provenance checks.
 */
function existing(tags, { verified = true } = {}) {
  const state = scratch();
  writeFileSync(join(state, "tags.json"), JSON.stringify(tags));
  const tools = stubs({
    docker: `[ "$1 $2 $3" = "buildx imagetools inspect" ] || exit 2
tag="\${4##*:}"
got="$(jq -r --arg t "$tag" '.[$t] // empty' ${JSON.stringify(join(state, "tags.json"))})"
case "$got" in
  "") echo "ERROR: $4: not found" >&2; exit 1 ;;
  denied) echo "ERROR: $4: unauthorized: authentication required" >&2; exit 1 ;;
  *) echo "$got" ;;
esac`,
    gh: verified
      ? "echo verified"
      : "echo 'no matching attestations' >&2; exit 1",
  });
  const result = run(
    release,
    "image",
    "existing",
    {
      REPOSITORY,
      TAG: "v0.2.17",
      GH_TOKEN: "t",
      GH_REPO: "O/r",
      GITHUB_SHA: SHA,
    },
    tools.path,
  );
  const calls = tools.calls();
  return {
    ...result,
    gh: calls.filter((c) => c.startsWith("gh ")),
    docker: calls.filter((c) => c.startsWith("docker ")),
  };
}

test("a first run finds nothing for this commit and builds", () => {
  const first = existing({});
  expect(first.status).toBe(0);
  expect(first.outputs).toEqual({ reuse: "false" });
  expect(first.gh).toEqual([]);
  expect(first.docker).toEqual([
    `docker buildx imagetools inspect ${REPOSITORY}:sha-${SHA} --format {{.Manifest.Digest}}`,
    `docker buildx imagetools inspect ${REPOSITORY}:v0.2.17 --format {{.Manifest.Digest}}`,
  ]);
});

test("a re-run reuses the digest sha-<commit> names once its provenance matches, and does not build", () => {
  for (const tags of [
    { [`sha-${SHA}`]: D1 },
    { [`sha-${SHA}`]: D1, "v0.2.17": D1 },
    // Promote writes both tags in one go; if only the version tag made it, that is the digest.
    { "v0.2.17": D1 },
  ]) {
    const rerun = existing(tags);
    expect([JSON.stringify(tags), rerun.status]).toEqual([
      JSON.stringify(tags),
      0,
    ]);
    expect(rerun.outputs).toEqual({ reuse: "true", digest: D1 });
    expect(rerun.gh).toEqual([
      `gh attestation verify oci://${REPOSITORY}@${D1} --repo O/r --signer-workflow O/r/.github/workflows/release.yml --source-digest ${SHA} --deny-self-hosted-runners`,
    ]);
    expect(rerun.summary).toContain(`${REPOSITORY}@${D1}`);
  }
  // Nothing is built, pushed or attested again on that path; every later job takes the digest step's.
  const image = release.jobs.image;
  const skipIf = expression(
    "!inputs.dry_run && steps.existing.outputs.reuse != 'true'",
  );
  const at = (s) => image.steps.indexOf(s);
  const push = step(release, "image", "push");
  const attest = image.steps.find((s) =>
    s.uses?.startsWith("actions/attest-build-provenance@"),
  );
  expect(push.if).toBe(skipIf);
  expect(attest.if).toBe(skipIf);
  expect(attest.with["subject-digest"]).toBe(
    expression("steps.digest.outputs.digest"),
  );
  const login = image.steps.find((s) =>
    s.uses?.startsWith("docker/login-action@"),
  );
  const lookup = step(release, "image", "existing");
  expect(lookup.if).toBe(expression("!inputs.dry_run"));
  expect(at(login)).toBeLessThan(at(lookup));
  expect(at(lookup)).toBeLessThan(at(push));
  expect(at(push)).toBeLessThan(at(step(release, "image", "digest")));
  expect(image.outputs.digest).toBe(expression("steps.digest.outputs.digest"));
  // Reading provenance needs nothing beyond what the job already has.
  expect(image.permissions.attestations).toBe("write");
  expect(lookup.env.GH_TOKEN).toBe(expression("secrets.GITHUB_TOKEN"));
});

test("a re-run never builds over a tag it cannot vouch for", () => {
  // The two tags disagree, the provenance does not match, or GHCR cannot say: stop, and do not build.
  for (const [tags, options, message] of [
    [{ [`sha-${SHA}`]: D1, "v0.2.17": D2 }, {}, "a person must sort this out"],
    [{ [`sha-${SHA}`]: D1 }, { verified: false }, "provenance does not say"],
    [{ [`sha-${SHA}`]: "denied" }, {}, "could not tell whether"],
    [{ [`sha-${SHA}`]: "latest" }, {}, "not a digest"],
  ]) {
    const refused = existing(tags, options);
    expect([message, refused.status]).toEqual([message, 1]);
    expect(refused.log).toContain(message);
    expect(refused.outputs).toEqual({});
  }
  expect(existing({ [`sha-${SHA}`]: D1, "v0.2.17": D2 }).gh).toEqual([]);
});

test("the digest step hands on exactly one digest, pushed or reused", () => {
  const digest = (env) =>
    run(release, "image", "digest", { PUSHED: "", REUSED: "", ...env });
  expect(digest({ PUSHED: D1 }).outputs).toEqual({ digest: D1 });
  expect(digest({ REUSED: D2 }).outputs).toEqual({ digest: D2 });
  expect(digest({ REUSED: D2 }).log).toContain(`Reused ${D2}`);
  for (const env of [{}, { PUSHED: D1, REUSED: D2 }, { PUSHED: "sha256:x" }]) {
    const refused = digest(env);
    expect(refused.status).not.toBe(0);
    expect(refused.outputs).toEqual({});
  }
});

test("promote still never moves an immutable tag to another digest", () => {
  const promote = (existingDigest) => {
    const tools = stubs({
      docker: `case "$3" in
  inspect)
    case "$4" in
      *:latest) echo "ERROR: $4: not found" >&2; exit 1 ;;
      *) ${existingDigest ? `echo ${existingDigest}` : `echo "ERROR: $4: not found" >&2; exit 1`} ;;
    esac ;;
  create) exit 0 ;;
  *) exit 2 ;;
esac`,
    });
    const tag = release.jobs.promote.steps.find(
      (s) => s.name === "Tag the verified digest",
    );
    const script = join(scratch(), "tag.sh");
    writeFileSync(script, tag.run);
    const r = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-eo", "pipefail", script],
      {
        encoding: "utf8",
        env: {
          PATH: tools.path,
          RUNNER_TEMP: scratch(),
          REPOSITORY,
          DIGEST: D1,
          TAG: "v0.2.17",
          PRERELEASE: "true",
          GITHUB_SHA: SHA,
        },
      },
    );
    return {
      status: r.status,
      log: r.stdout + r.stderr,
      created: tools.calls().some((c) => c.includes("imagetools create")),
    };
  };
  // A re-run over the same digest: the tags already name it. Another digest: refused, nothing written.
  const same = promote(D1);
  expect(same.status).toBe(0);
  expect(same.created).toBe(true);
  const moved = promote(D2);
  expect(moved.status).not.toBe(0);
  expect(moved.log).toContain("refusing to move it");
  expect(moved.created).toBe(false);
});

// ---- G7 installs the public GHCR image ----

test("G7 installs and checks the public GHCR image, never our private registry", () => {
  // No sign-in anywhere, and nothing that names our registry.
  expect(cleanDeployText).not.toMatch(
    /docker\/login-action|docker login|crane/,
  );
  expect(cleanDeployText).not.toMatch(
    /XB_REGISTRY|XB_IMAGE_REPOSITORY|CUSTOMER_IMAGE/,
  );
  // The README block runs with its own image: XIONGBAO_IMAGE is cleared, so its GHCR default holds.
  const customer = step(cleanDeploy, "linux", "customer").run;
  expect(customer).toContain(
    "env -u GITHUB_TOKEN -u GH_TOKEN -u XIONGBAO_IMAGE",
  );
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const block = readme.slice(
    readme.indexOf("<!-- g7:linux:begin -->"),
    readme.indexOf("<!-- g7:linux:end -->"),
  );
  expect(block).toMatch(/XIONGBAO_IMAGE=\$\{XIONGBAO_IMAGE:-ghcr\.io\//);
  // The reference it checks against is the record's `ghcr`, even when images.xiongbao is the JCR copy.
  const ghcr = `ghcr.io/o/r@${D1}`;
  const jcr = `xiongbao-work-cn-north-1.jcr.service.jdcloud.com/xb/app@${D2}`;
  const record = (json) => {
    const evidence = scratch();
    const fixture = join(scratch(), "container-images.json");
    writeFileSync(fixture, JSON.stringify(json));
    const githubEnv = join(scratch(), "github-env");
    writeFileSync(githubEnv, "");
    const tools = stubs({
      gh: `cp ${JSON.stringify(fixture)} "\${@: -1}/container-images.json"`,
    });
    const result = run(
      cleanDeploy,
      "linux",
      "record",
      {
        TAG: "v0.2.17",
        EVIDENCE: evidence,
        GITHUB_ENV: githubEnv,
        GH_TOKEN: "x",
        GH_REPO: "o/r",
        DOWNLOAD_BASE_URL: "",
      },
      tools.path,
    );
    return { ...result, env: readFileSync(githubEnv, "utf8") };
  };
  const mirrored = record({
    images: { xiongbao: { reference: jcr } },
    ghcr: { reference: ghcr },
  });
  expect(mirrored.status).toBe(0);
  expect(mirrored.env).toBe(`EXPECTED_REFERENCE=${ghcr}\n`);
  const jcrOnly = record({ images: { xiongbao: { reference: jcr } } });
  expect(jcrOnly.status).not.toBe(0);
  expect(jcrOnly.env).toBe("");
  // And the running container must be that reference's repository, at the tag.
  expect(step(cleanDeploy, "linux", "digest").run).toContain(
    `"\${expected%@*}:$TAG"`,
  );
});

// ---- the device release (device-release.yml) follows the same rule ----

const device = load("device-release.yml");
// Read at job level (macos's `if:`) or in a job without an Environment (assemble), so they must be
// repository variables; docs/acceptance/HUMAN-STEPS.md says so. XB_DOWNLOAD_BUCKET is not one of them.
const DEVICE_REPO_LEVEL_VARS = [
  "DEVICE_RELEASE_MACOS",
  "DEVICE_RELEASE_REQUIRE_SIGNED",
];

test("device-release reads XB_DOWNLOAD_* only inside the device-release Environment", () => {
  expect(
    outsideEnvironment(device, "device-release.yml", DEVICE_REPO_LEVEL_VARS),
  ).toEqual([]);
  expect(DEVICE_REPO_LEVEL_VARS).not.toContain("XB_DOWNLOAD_BUCKET");
  const steps = readFileSync(
    join(root, "docs", "acceptance", "HUMAN-STEPS.md"),
    "utf8",
  );
  for (const name of DEVICE_REPO_LEVEL_VARS)
    expect(steps).toContain(`仓库变量 \`${name}`);
  // download-page follows what publish read inside the Environment.
  const publish = device.jobs.publish;
  expect(publish.environment).toBe("device-release");
  expect(publish.steps[0].id).toBe("channel");
  expect(publish.outputs).toEqual({
    download: expression("steps.channel.outputs.download"),
  });
  expect(device.jobs["download-page"].if).toBe(
    expression(
      "!cancelled() && needs.publish.result == 'success' && needs.publish.outputs.download == 'true'",
    ),
  );
  // Half a download page stops publish before the Release, naming what is missing.
  const channel = (env) =>
    run(device, "publish", "channel", {
      XB_DOWNLOAD_BUCKET: "",
      XB_DOWNLOAD_ENDPOINT: "",
      XB_DOWNLOAD_REGION: "",
      ...env,
    });
  const page = {
    XB_DOWNLOAD_BUCKET: "downloads",
    XB_DOWNLOAD_ENDPOINT: "https://s3.example.com",
    XB_DOWNLOAD_REGION: "cn-north-1",
  };
  for (const [env, message] of [
    [
      { ...page, XB_DOWNLOAD_ENDPOINT: "" },
      "XB_DOWNLOAD_BUCKET is set but XB_DOWNLOAD_ENDPOINT is not",
    ],
    [
      { ...page, XB_DOWNLOAD_REGION: "" },
      "XB_DOWNLOAD_BUCKET is set but XB_DOWNLOAD_REGION is not",
    ],
    [
      { XB_DOWNLOAD_ENDPOINT: "https://s3.example.com" },
      "XB_DOWNLOAD_ENDPOINT is set but XB_DOWNLOAD_BUCKET is not",
    ],
    [
      { ...page, XB_DOWNLOAD_ENDPOINT: "http://s3.example.com" },
      "XB_DOWNLOAD_ENDPOINT must start with https://",
    ],
  ]) {
    const refused = channel(env);
    expect([message, refused.status]).toEqual([message, 1]);
    expect(refused.log).toContain(`::error::${message}`);
    expect(refused.outputs).toEqual({});
  }
  const none = channel({});
  expect(none.status).toBe(0);
  expect(none.outputs).toEqual({ download: "false" });
  expect(none.log).toContain("::notice::");
  expect(channel(page).outputs).toEqual({ download: "true" });
  const order = publish.steps.map((s) => s.id ?? s.name);
  expect(order.indexOf("channel")).toBeLessThan(order.indexOf("publish"));
});

// ---- publishing the GitHub Release again ----

/**
 * Runs github-release's publish step against a stub `gh`. `release` is the existing Release (null:
 * none), `tagCommit` what the tag names on GitHub, `record` the container-images.json it carries.
 */
function publishRelease({
  release: existingRelease = null,
  tagCommit = SHA,
  annotated = false,
  record,
  viewError = "release not found",
}) {
  const state = scratch();
  const cwd = scratch();
  mkdirSync(join(cwd, "notes"));
  writeFileSync(join(cwd, "notes", "release-notes.md"), "notes");
  writeFileSync(
    join(cwd, "container-images.json"),
    JSON.stringify({ commit: SHA, ghcr: { digest: D1 } }),
  );
  if (record)
    writeFileSync(join(state, "container-images.json"), JSON.stringify(record));
  const s = JSON.stringify(state);
  const tools = stubs({
    gh: `case "$1 $2" in
  "release view")
    ${existingRelease ? `echo '${JSON.stringify({ tagName: existingRelease })}'` : `echo "${viewError}" >&2; exit 1`} ;;
  "api repos/O/r/git/ref/tags/v0.2.17")
    echo '${JSON.stringify({ object: { type: annotated ? "tag" : "commit", sha: annotated ? "f".repeat(40) : tagCommit } })}' ;;
  "api repos/O/r/git/tags/${"f".repeat(40)}") echo ${tagCommit} ;;
  "release download")
    if [ -f ${s}/container-images.json ]; then cp ${s}/container-images.json "\${@: -1}/"; else echo "no assets match the file pattern" >&2; exit 1; fi ;;
  "release upload" | "release create") ;;
  *) exit 2 ;;
esac`,
  });
  const script = join(scratch(), "publish.sh");
  writeFileSync(script, step(release, "github-release", "publish").run);
  const summary = join(scratch(), "summary");
  writeFileSync(summary, "");
  const r = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-eo", "pipefail", script],
    {
      cwd,
      encoding: "utf8",
      env: {
        PATH: tools.path,
        HOME: tmpdir(),
        RUNNER_TEMP: scratch(),
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_SHA: SHA,
        GH_TOKEN: "t",
        GH_REPO: "O/r",
        TAG: "v0.2.17",
        PRERELEASE: "false",
      },
    },
  );
  const calls = tools.calls();
  return {
    status: r.status,
    log: r.stdout + r.stderr,
    created: calls.filter((c) => c.startsWith("gh release create")),
    uploaded: calls.filter((c) => c.startsWith("gh release upload")),
  };
}

test("a first publish creates the Release from the existing tag", () => {
  const first = publishRelease({});
  expect(first.status).toBe(0);
  expect(first.created).toEqual([
    "gh release create v0.2.17 container-images.json --verify-tag --title v0.2.17 --notes-file notes/release-notes.md",
  ]);
  expect(first.uploaded).toEqual([]);
});

test("a re-run over its own Release replaces the record with --clobber instead of failing", () => {
  for (const options of [
    { release: "v0.2.17", record: { commit: SHA, ghcr: { digest: D1 } } },
    // An earlier upload that never made it: nothing to compare, the record goes up.
    { release: "v0.2.17" },
    { release: "v0.2.17", annotated: true },
  ]) {
    const rerun = publishRelease(options);
    expect([JSON.stringify(options), rerun.status]).toEqual([
      JSON.stringify(options),
      0,
    ]);
    expect(rerun.created).toEqual([]);
    expect(rerun.uploaded).toEqual([
      "gh release upload v0.2.17 container-images.json --clobber",
    ]);
  }
});

test("an existing Release from another commit, or with another image, is never touched", () => {
  for (const [options, message] of [
    [{ release: "v0.2.17", tagCommit: "9".repeat(40) }, "refusing to touch it"],
    [
      { release: "v0.2.17", annotated: true, tagCommit: "9".repeat(40) },
      "refusing to touch it",
    ],
    [
      {
        release: "v0.2.17",
        record: { commit: "9".repeat(40), ghcr: { digest: D1 } },
      },
      "Refusing to replace it",
    ],
    [
      { release: "v0.2.17", record: { commit: SHA, ghcr: { digest: D2 } } },
      "Refusing to replace it",
    ],
    [{ viewError: "HTTP 502: Bad Gateway" }, "could not tell whether Release"],
  ]) {
    const refused = publishRelease(options);
    expect([message, refused.status]).toEqual([message, 1]);
    expect(refused.log).toContain(message);
    expect(refused.created).toEqual([]);
    expect(refused.uploaded).toEqual([]);
  }
  // As written: --clobber only on the upload, and create still insists on the existing tag.
  const script = step(release, "github-release", "publish").run;
  expect(script).toContain(
    'gh release upload "$TAG" container-images.json --clobber',
  );
  expect(script).toMatch(/gh release create "\$TAG"[^\n]*\\\n\s+--verify-tag/);
});
