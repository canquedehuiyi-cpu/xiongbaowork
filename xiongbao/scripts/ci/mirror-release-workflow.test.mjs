// .github/workflows/mirror-release.yml copies an already published release to our own registry by
// hand. Its sign-in and copy steps must stay word for word the ones in release.yml's mirror job, and
// the sign-in step can exchange a JD Cloud AccessKey for a short-lived registry token. The steps are
// run here as written (bash, inputs from env), with a stub `pip`, a fake `jdcloud_sdk` package and
// a stub `gh` standing in for the network.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");
const workflows = join(root, ".github", "workflows");
const mirrorText = readFileSync(join(workflows, "mirror-release.yml"), "utf8");
const mirrorDoc = Bun.YAML.parse(mirrorText);
const releaseDoc = Bun.YAML.parse(
  readFileSync(join(workflows, "release.yml"), "utf8"),
);
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "mirror-release-"));
  dirs.push(dir);
  return dir;
}

const expression = (inner) => `\${{ ${inner} }}`;

function stepOf(doc, id) {
  const found = doc.jobs.mirror.steps.find((s) => s.id === id);
  if (!found) throw new Error(`no step ${id}`);
  return found;
}

const job = mirrorDoc.jobs.mirror;

test("the only trigger is a manual dispatch, from main, and nothing runs on a pull request", () => {
  expect(Object.keys(mirrorDoc.on)).toEqual(["workflow_dispatch"]);
  expect(Object.keys(mirrorDoc.on.workflow_dispatch.inputs)).toEqual(["tag"]);
  expect(mirrorDoc.on.workflow_dispatch.inputs.tag.required).toBe(true);
  expect(mirrorText).not.toContain("pull_request_target");
  expect(Object.keys(mirrorDoc.jobs)).toEqual(["mirror"]);
  const condition = job.if.replace(/\s+/g, " ").trim();
  expect(condition).toContain("github.event_name == 'workflow_dispatch'");
  expect(condition).toContain("github.ref == 'refs/heads/main'");
  expect(condition).not.toContain("||");
});

test("the job runs in the release Environment with the least permissions", () => {
  expect(job.environment).toBe("release");
  expect(job.permissions).toEqual({ contents: "read", packages: "read" });
  expect(mirrorDoc.permissions).toEqual({ contents: "read" });
});

test("every action is pinned to a full commit, crane to the release's version", () => {
  const uses = job.steps.map((s) => s.uses).filter(Boolean);
  expect(uses.length).toBeGreaterThan(0);
  for (const use of uses) expect(use).toMatch(/^[\w./-]+@[0-9a-f]{40}( |$)/);
  const own = releaseDoc.jobs.mirror.steps.find((s) =>
    s.uses?.startsWith("imjasonh/setup-crane@"),
  );
  const setup = job.steps.find((s) =>
    s.uses?.startsWith("imjasonh/setup-crane@"),
  );
  expect(setup.uses).toBe(own.uses);
  expect(setup.with.version).toBe("v0.22.1");
});

test("secrets appear only in the sign-in step's environment, and an input never reaches a script line", () => {
  for (const s of job.steps) {
    const holders = JSON.stringify({ run: s.run, with: s.with, if: s.if });
    expect(holders).not.toContain("secrets.");
    expect(s.run ?? "").not.toContain("inputs.");
    expect(s.run ?? "").not.toContain("${{");
    if (s.id === "login") continue;
    expect(JSON.stringify(s.env ?? {})).not.toContain("secrets.");
  }
  const secrets = Object.values(stepOf(mirrorDoc, "login").env).filter((v) =>
    String(v).includes("secrets."),
  );
  expect(secrets.sort()).toEqual(
    [
      "XB_JDCLOUD_ACCESS_KEY_ID",
      "XB_JDCLOUD_SECRET_ACCESS_KEY",
      "XB_REGISTRY_PASSWORD",
      "XB_REGISTRY_USERNAME",
    ]
      .map((name) => expression(`secrets.${name}`))
      .concat(expression("secrets.GITHUB_TOKEN"))
      .sort(),
  );
});

test("the sign-in, copy and logout steps are the same text as release.yml's mirror job", () => {
  for (const id of ["login", "logout"]) {
    const here = stepOf(mirrorDoc, id);
    const there = stepOf(releaseDoc, id);
    expect([id, here.run]).toEqual([id, there.run]);
    // Keys and values: swapping which secret feeds which variable would not go unnoticed.
    expect([id, here.env ?? {}]).toEqual([id, there.env ?? {}]);
  }
  const here = stepOf(mirrorDoc, "copy");
  const there = stepOf(releaseDoc, "copy");
  expect(here.run).toEqual(there.run);
  expect(Object.keys(here.env)).toEqual(Object.keys(there.env));
  // The values reaching the copy step come from the release record read just before it.
  expect(here.env.REPOSITORY).toBe(
    expression("steps.record.outputs.repository"),
  );
  expect(here.env.DIGEST).toBe(expression("steps.record.outputs.digest"));
  expect(here.env.TAG).toBe(expression("steps.record.outputs.tag"));
  expect(here.env.XB_REGISTRY).toBe(there.env.XB_REGISTRY);
  expect(here.env.XB_IMAGE_REPOSITORY).toBe(there.env.XB_IMAGE_REPOSITORY);
  // And the sign-in step has the same job in release.yml: still gated by XB_REGISTRY there.
  expect(stepOf(releaseDoc, "login").if).toBe(
    expression("vars.XB_REGISTRY != ''"),
  );
  // The record is checked against GHCR between signing in and copying.
  const order = job.steps.map((s) => s.id);
  expect(order.indexOf("login")).toBeLessThan(order.indexOf("verify"));
  expect(order.indexOf("verify")).toBeLessThan(order.indexOf("copy"));
});

// ---- running steps ----

const PYTHON = Bun.which("python3");

function run(doc, id, env, { path = process.env.PATH, cwd = scratch() } = {}) {
  const output = join(scratch(), "github-output");
  writeFileSync(output, "");
  const script = join(scratch(), "step.sh");
  writeFileSync(script, stepOf(doc, id).run);
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

/** A fake of the parts of jdcloud_sdk the sign-in step imports, shaped like the real package. */
function fakeSdk(root) {
  const files = {
    "jdcloud_sdk/__init__.py": "",
    "jdcloud_sdk/core/__init__.py": "",
    "jdcloud_sdk/core/credential.py": `class Credential(object):
    def __init__(self, access_key, secret_key):
        self.access_key = access_key
        self.secret_key = secret_key
`,
    "jdcloud_sdk/core/logger.py": `class Logger(object):
    def __init__(self, level):
        self.level = level
    def log(self, level, message):
        if level <= self.level:
            print(message)
`,
    "jdcloud_sdk/services/__init__.py": "",
    "jdcloud_sdk/services/containerregistry/__init__.py": "",
    "jdcloud_sdk/services/containerregistry/apis/__init__.py": "",
    "jdcloud_sdk/services/containerregistry/client/__init__.py": "",
    "jdcloud_sdk/services/containerregistry/apis/GetAuthorizationTokenRequest.py": `class GetAuthorizationTokenRequest(object):
    def __init__(self, parameters):
        self.parameters = parameters


class GetAuthorizationTokenParameters(object):
    def __init__(self, regionId, registryName):
        self.regionId = regionId
        self.registryName = registryName
        self.expiredAfterHours = None

    def setExpiredAfterHours(self, expiredAfterHours):
        self.expiredAfterHours = expiredAfterHours
`,
    // Like the real client, it logs the response body at INFO level; the response comes from a file.
    "jdcloud_sdk/services/containerregistry/client/ContainerregistryClient.py": `import json
import os


class _Error(object):
    def __init__(self, status, code, message):
        self.status = status
        self.code = code
        self.message = message


class _Response(object):
    def __init__(self):
        self.request_id = "req"
        self.error = None
        self.result = None


class ContainerregistryClient(object):
    def __init__(self, credential, config=None, logger=None):
        self.credential = credential
        self.logger = logger

    def send(self, request):
        p = request.parameters
        with open(os.environ["FAKE_JD_CALLS"], "a") as calls:
            calls.write(json.dumps([self.credential.access_key, p.regionId, p.registryName, p.expiredAfterHours, self.logger.level]) + "\\n")
        body = open(os.environ["FAKE_JD_RESPONSE"]).read()
        self.logger.log(3, body)
        spec = json.loads(body)
        if "raise" in spec:
            raise RuntimeError(spec["raise"])
        response = _Response()
        if "error" in spec:
            response.error = _Error(spec["error"]["status"], spec["error"]["code"], spec["error"]["message"])
        else:
            response.result = spec["result"]
        return response
`,
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), text);
  }
}

const USER = "jcr-user-Qx7";
const PASSWORD = "tok-Zp9/secret+value=";
const ACCESS_KEY = "AKIDexample123456";
const SECRET_KEY = "sk-example-abcdef";
const REGISTRY = "xiongbao-work-cn-north-1.jcr.service.jdcloud.com";

const FIXED = {
  XB_REGISTRY_USERNAME: "fixed-user",
  XB_REGISTRY_PASSWORD: "fixed-pw",
};
const JD = {
  XB_JDCLOUD_ACCESS_KEY_ID: ACCESS_KEY,
  XB_JDCLOUD_SECRET_ACCESS_KEY: SECRET_KEY,
  XB_JDCLOUD_REGION: "cn-north-1",
  XB_JDCLOUD_REGISTRY_NAME: "xiongbao-work",
};

/** Runs the sign-in step. `response` is what the fake API answers, as JSON. */
function login(env, response, options = {}) {
  const temp = scratch();
  const bin = join(temp, "bin");
  mkdirSync(bin);
  const sdk = join(temp, "sdk");
  fakeSdk(sdk);
  const calls = join(temp, "pip-calls");
  writeFileSync(calls, "");
  // Every command of the install records the environment it ran in.
  const envs = join(temp, "install-envs");
  writeFileSync(envs, "");
  const archive = join(temp, "sdk.tgz");
  mkdirSync(join(temp, "pkg", "jdcloud_sdk-4.1.0"), { recursive: true });
  writeFileSync(join(temp, "pkg", "jdcloud_sdk-4.1.0", "README"), "sdk");
  spawnSync("tar", ["-czf", archive, "-C", join(temp, "pkg"), "."]);
  const sha = join(temp, "sha-input");
  const downloads = join(temp, "downloads");
  writeFileSync(downloads, "");
  const jdCalls = join(temp, "jd-calls");
  writeFileSync(jdCalls, "");
  const responseFile = join(temp, "response.json");
  writeFileSync(responseFile, JSON.stringify(response ?? {}));
  // python3 is the real one, except that `-m venv DIR` makes a directory whose pip only records its
  // arguments and whose python sees the fake SDK.
  writeFileSync(
    join(bin, "python3"),
    `#!/usr/bin/env bash
if [ "$1" = -m ] && [ "$2" = venv ]; then
  dir="\${@: -1}"
  mkdir -p "$dir/bin"
  printf '#!/usr/bin/env bash\\nprintf "%%s\\\\n" "$*" >> ${JSON.stringify(calls)}\\nenv >> ${JSON.stringify(envs)}\\n' > "$dir/bin/pip"
  printf '#!/usr/bin/env bash\\nPYTHONPATH=${JSON.stringify(sdk)}:\\$PYTHONPATH exec ${JSON.stringify(PYTHON)} "$@"\\n' > "$dir/bin/python"
  chmod +x "$dir/bin/pip" "$dir/bin/python"
  exit 0
fi
exec ${JSON.stringify(PYTHON)} "$@"
`,
  );
  chmodSync(join(bin, "python3"), 0o755);
  // curl copies a source archive to --output; sha256sum records what it was asked to check and
  // fails when the test says the hash does not match.
  writeFileSync(
    join(bin, "curl"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(downloads)}
env >> ${JSON.stringify(envs)}
while [ $# -gt 0 ]; do
  if [ "$1" = --output ]; then cp ${JSON.stringify(archive)} "$2"; fi
  shift
done
`,
  );
  writeFileSync(
    join(bin, "sha256sum"),
    `#!/usr/bin/env bash
env >> ${JSON.stringify(envs)}
cat > ${JSON.stringify(sha)}
[ ! -e ${JSON.stringify(join(temp, "hash-mismatch"))} ]
`,
  );
  chmodSync(join(bin, "curl"), 0o755);
  chmodSync(join(bin, "sha256sum"), 0o755);
  if (options.hashMismatch) writeFileSync(join(temp, "hash-mismatch"), "");
  const github = join(temp, "github-env");
  writeFileSync(github, "");
  const environment = {
    XB_REGISTRY: REGISTRY,
    XB_IMAGE_REPOSITORY: "xb/app",
    XB_REGISTRY_USERNAME: "",
    XB_REGISTRY_PASSWORD: "",
    XB_JDCLOUD_ACCESS_KEY_ID: "",
    XB_JDCLOUD_SECRET_ACCESS_KEY: "",
    XB_JDCLOUD_REGION: "",
    XB_JDCLOUD_REGISTRY_NAME: "",
    GHCR_USERNAME: "someone",
    GHCR_TOKEN: "ghcr-token-e5f6",
    RUNNER_TEMP: temp,
    GITHUB_ENV: github,
    FAKE_JD_CALLS: jdCalls,
    FAKE_JD_RESPONSE: responseFile,
    ...env,
  };
  for (const name of options.omit ?? []) delete environment[name];
  const result = run(mirrorDoc, "login", environment, {
    path: `${bin}:${process.env.PATH}`,
  });
  const config = join(temp, "own-channel-docker", "config.json");
  return {
    ...result,
    temp,
    pip: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean),
    envs: readFileSync(envs, "utf8"),
    downloads: readFileSync(downloads, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean),
    sha: existsSync(sha) ? readFileSync(sha, "utf8") : null,
    api: readFileSync(jdCalls, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
    githubEnv: readFileSync(github, "utf8"),
    config: existsSync(config)
      ? JSON.parse(readFileSync(config, "utf8"))
      : null,
  };
}

const basic = (user, password) =>
  Buffer.from(`${user}:${password}`).toString("base64");
const ghcrAuth = { auth: basic("someone", "ghcr-token-e5f6") };
const answer = (
  loginCmdLine,
  wrap = (data) => ({ authorizationData: data }),
) => ({
  result: wrap({
    authorizationToken: "not-the-source-of-the-login",
    loginCmdLine,
    expiresAt: 1,
  }),
});
const command = `docker login -u ${USER} -p '${PASSWORD}' ${REGISTRY}`;

test("a fixed user and password still sign in as before, without touching Python", () => {
  const result = login(FIXED);
  expect(result.status).toBe(0);
  expect(result.config).toEqual({
    auths: {
      [REGISTRY]: { auth: basic("fixed-user", "fixed-pw") },
      "ghcr.io": ghcrAuth,
    },
  });
  expect(result.pip).toEqual([]);
  expect(result.api).toEqual([]);
  expect(result.githubEnv).toBe(
    `DOCKER_CONFIG=${join(result.temp, "own-channel-docker")}\n`,
  );
  expect(existsSync(join(result.temp, "own-channel-jcr"))).toBe(false);
});

test("a fixed sign-in with one half missing keeps its own error", () => {
  for (const [env, missing] of [
    [{ XB_REGISTRY_USERNAME: "u" }, "XB_REGISTRY_PASSWORD"],
    [{ XB_REGISTRY_PASSWORD: "p" }, "XB_REGISTRY_USERNAME"],
    [{ ...FIXED, XB_IMAGE_REPOSITORY: "" }, "XB_IMAGE_REPOSITORY"],
    [{}, "XB_REGISTRY_USERNAME"],
  ]) {
    const result = login(env);
    expect(result.status).not.toBe(0);
    expect(result.log).toContain(`XB_REGISTRY is set but ${missing} is not.`);
    expect(result.config).toBeNull();
  }
});

test("a JD Cloud AccessKey is exchanged for a six-hour token that signs in", () => {
  const result = login(JD, answer(command));
  expect(result.status).toBe(0);
  expect(result.config).toEqual({
    auths: {
      [REGISTRY]: { auth: basic(USER, PASSWORD) },
      "ghcr.io": ghcrAuth,
    },
  });
  // The API was asked for this registry's token, for six hours, with the SDK's logger silenced.
  expect(result.api).toEqual([
    [ACCESS_KEY, "cn-north-1", "xiongbao-work", 6, -1],
  ]);
  // The SDK's source archive is checked against a hash written in the step and never built; what
  // it imports is installed as wheels only, each with its hash, without dependency resolution.
  expect(result.downloads).toHaveLength(1);
  expect(result.downloads[0]).toMatch(
    /--proto =https .*https:\/\/files\.pythonhosted\.org\/.*jdcloud_sdk-4\.1\.0\.tar\.gz$/,
  );
  expect(result.sha).toMatch(/^[0-9a-f]{64} {2}.*sdk\.tar\.gz\n$/);
  expect(result.pip).toHaveLength(1);
  for (const flag of [
    "--require-hashes",
    "--no-deps",
    "--only-binary :all:",
    "--target",
  ])
    expect(result.pip[0]).toContain(flag);
  const script = stepOf(mirrorDoc, "login").run;
  expect(script).not.toMatch(/pip install[^\n]*jdcloud/);
  const pins = script.match(
    /^[a-z0-9-]+==[\d.]+ --hash=sha256:[0-9a-f]{64}$/gm,
  );
  expect(pins?.map((pin) => pin.split("==")[0])).toEqual([
    "requests",
    "urllib3",
    "idna",
    "certifi",
    "charset-normalizer",
  ]);
  expect(script).toContain(result.sha.slice(0, 64));
  // No installer, and nothing it unpacked, ran with a secret in its environment.
  expect(result.envs).toContain("WORK=");
  for (const secret of [
    ACCESS_KEY,
    SECRET_KEY,
    "ghcr-token-e5f6",
    "XB_JDCLOUD",
    "GHCR_TOKEN",
    "XB_REGISTRY_PASSWORD",
  ])
    expect(result.envs).not.toContain(secret);
  // Nothing of it is left behind, and the config directory is private.
  expect(existsSync(join(result.temp, "own-channel-jcr"))).toBe(false);
  expect(statSync(join(result.temp, "own-channel-docker")).mode & 0o077).toBe(
    0,
  );
  expect(result.githubEnv).toBe(
    `DOCKER_CONFIG=${join(result.temp, "own-channel-docker")}\n`,
  );
});

test("the token and the AccessKey stay out of every output, and the token is masked first", () => {
  const result = login(JD, answer(command));
  expect(result.status).toBe(0);
  expect(result.log).not.toContain(ACCESS_KEY);
  expect(result.log).not.toContain(SECRET_KEY);
  // The only lines that name the user or password are the masks, which the runner hides.
  const naming = result.log
    .split("\n")
    .filter((line) => line.includes(USER) || line.includes(PASSWORD));
  expect(naming).toEqual([`::add-mask::${PASSWORD}`]);
  expect(result.log).not.toContain("not-the-source-of-the-login");
  // Not as an argument either: the script puts none of them on a command line.
  const script = stepOf(mirrorDoc, "login").run;
  expect(script).not.toMatch(/jq[^\n]*--arg (username|password)/);
});

test("the login command may spell its options in the other usual ways", () => {
  for (const loginCmdLine of [
    `docker login --username ${USER} --password '${PASSWORD}' ${REGISTRY}`,
    `docker login --username=${USER} --password='${PASSWORD}' ${REGISTRY}`,
    `docker login ${REGISTRY} -p '${PASSWORD}' -u ${USER}`,
  ]) {
    const result = login(JD, answer(loginCmdLine));
    expect([loginCmdLine, result.status]).toEqual([loginCmdLine, 0]);
    expect(result.config.auths[REGISTRY].auth).toBe(basic(USER, PASSWORD));
  }
  // Wherever the API puts the data in the result, the login command is found.
  for (const wrap of [
    (data) => data,
    (data) => ({ authorizationData: [data] }),
    (data) => ({ data: { authorizationData: data } }),
  ]) {
    const result = login(JD, answer(command, wrap));
    expect(result.status).toBe(0);
    expect(result.config.auths[REGISTRY].auth).toBe(basic(USER, PASSWORD));
  }
});

test("both ways configured, or only part of the JD Cloud settings, is an error", () => {
  const both = login({ ...FIXED, ...JD }, answer(command));
  expect(both.status).not.toBe(0);
  expect(both.log).toContain("configure only one");
  const mixed = login(
    { ...FIXED, XB_JDCLOUD_REGION: "cn-north-1" },
    answer(command),
  );
  expect(mixed.status).not.toBe(0);
  expect(mixed.log).toContain("configure only one");
  for (const [name] of Object.entries(JD)) {
    const partial = login({ ...JD, [name]: "" }, answer(command));
    expect(partial.status).not.toBe(0);
    expect(partial.log).toContain(`XB_JDCLOUD_* settings but ${name} is not.`);
    expect(partial.config).toBeNull();
    expect(partial.api).toEqual([]);
    expect(partial.pip).toEqual([]);
  }
  const noRepository = login(
    { ...JD, XB_IMAGE_REPOSITORY: "" },
    answer(command),
  );
  expect(noRepository.status).not.toBe(0);
  expect(noRepository.log).toContain("but XB_IMAGE_REPOSITORY is not.");
});

test("an answer without a usable login command stops the step without printing it", () => {
  const bad = [
    { result: { authorizationData: { authorizationToken: "bm90LXVzZWQ=" } } },
    answer(`docker login ${REGISTRY}`),
    answer(`docker login -u ${USER} ${REGISTRY}`),
    answer(`docker login -u ${USER} -p`),
    answer(`docker login -u ${USER} -p 'unterminated ${REGISTRY}`),
    { error: { status: "FAILED", code: 403, message: `denied ${PASSWORD}` } },
    { raise: `connection to ${REGISTRY} with ${SECRET_KEY} failed` },
  ];
  for (const response of bad) {
    const result = login(JD, response);
    expect([JSON.stringify(response), result.status]).toEqual([
      JSON.stringify(response),
      1,
    ]);
    expect(result.log).toContain("::error::");
    expect(result.log).not.toContain(PASSWORD);
    expect(result.log).not.toContain(SECRET_KEY);
    expect(result.config).toBeNull();
    expect(existsSync(join(result.temp, "own-channel-jcr"))).toBe(false);
  }
});

test("a registry host or repository path that is not valid is refused before any sign-in", () => {
  const host = login(
    { ...JD, XB_REGISTRY: "https://x.example" },
    answer(command),
  );
  expect(host.status).not.toBe(0);
  expect(host.log).toContain("XB_REGISTRY must be a registry host");
  expect(host.api).toEqual([]);
});

test("unset variables are not an error before the sign-in is chosen", () => {
  // GitHub sets every listed variable, to an empty string at least; set -u must not matter either way.
  const fixed = login(FIXED, undefined, {
    omit: Object.keys(JD),
  });
  expect(fixed.status).toBe(0);
  const none = login({}, undefined, {
    omit: [...Object.keys(JD), "XB_REGISTRY_USERNAME", "XB_REGISTRY_PASSWORD"],
  });
  expect(none.status).not.toBe(0);
  expect(none.log).toContain(
    "XB_REGISTRY is set but XB_REGISTRY_USERNAME is not.",
  );
  const jd = login(JD, answer(command), {
    omit: ["XB_REGISTRY_USERNAME", "XB_REGISTRY_PASSWORD"],
  });
  expect(jd.status).toBe(0);
});

test("a source archive that does not match its hash stops the step before any key is used", () => {
  const result = login(JD, answer(command), { hashMismatch: true });
  expect(result.status).not.toBe(0);
  expect(result.api).toEqual([]);
  expect(result.pip).toEqual([]);
  expect(result.config).toBeNull();
  expect(existsSync(join(result.temp, "own-channel-jcr"))).toBe(false);
});

test("only the password is masked, and it is escaped the way workflow commands are", () => {
  // A user name that is a part of the registry host would blank the job's outputs if it were masked.
  const result = login(
    JD,
    answer(`docker login -u jdcloud -p 'a%b' ${REGISTRY}`),
  );
  expect(result.status).toBe(0);
  const masks = result.log
    .split("\n")
    .filter((l) => l.startsWith("::add-mask::"));
  expect(masks).toEqual(["::add-mask::a%25b"]);
  expect(result.config.auths[REGISTRY].auth).toBe(basic("jdcloud", "a%b"));
});

test("a login command for another registry than XB_REGISTRY is refused without printing it", () => {
  const result = login(
    JD,
    answer(`docker login -u ${USER} -p '${PASSWORD}' other-registry.example`),
  );
  expect(result.status).not.toBe(0);
  expect(result.log).toContain("another registry than XB_REGISTRY");
  expect(result.log).not.toContain(PASSWORD);
  expect(result.log).not.toContain(USER);
  expect(result.config).toBeNull();
});

// ---- the release record ----

const OWNER = { login: "github-actions[bot]" };

function record(env, release, uploader = OWNER) {
  const temp = scratch();
  const bin = join(temp, "bin");
  mkdirSync(bin);
  const calls = join(temp, "calls");
  writeFileSync(calls, "");
  writeFileSync(join(temp, "fixture.json"), JSON.stringify(release));
  writeFileSync(
    join(temp, "release.json"),
    JSON.stringify({
      assets: [
        { name: "other.txt", id: 7, uploader },
        { name: "container-images.json", id: 42, uploader },
      ],
    }),
  );
  // gh api <path>: the release answers with its assets, the asset itself with the file.
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash
printf 'gh %s\\n' "$*" >> ${JSON.stringify(calls)}
case "$*" in
  *releases/tags/v0.2.15*) cat ${JSON.stringify(join(temp, "release.json"))} ;;
  *releases/tags/*) exit 1 ;;
  *releases/assets/42*) cat ${JSON.stringify(join(temp, "fixture.json"))} ;;
  *) exit 2 ;;
esac
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  const result = run(
    mirrorDoc,
    "record",
    {
      GH_TOKEN: "t",
      GH_REPO: "O/r",
      INPUT_TAG: "v0.2.15",
      XB_REGISTRY: REGISTRY,
      RUNNER_TEMP: temp,
      ...env,
    },
    { path: `${bin}:${process.env.PATH}` },
  );
  return {
    ...result,
    calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean),
  };
}

const DIGEST = `sha256:${"a".repeat(64)}`;
const release = (openbot) => ({
  version: "0.2.15",
  images: { xiongbao: { repository: "x" }, openbot },
});
const OWN_IMAGE = { repository: "ghcr.io/o/r", digest: DIGEST };

test("the release record names this repository's GHCR image, read through the REST API", () => {
  const ok = record({}, release(OWN_IMAGE));
  expect(ok.status).toBe(0);
  expect(ok.outputs).toEqual({
    repository: "ghcr.io/o/r",
    digest: DIGEST,
    tag: "v0.2.15",
  });
  expect(ok.calls.join("\n")).not.toContain("graphql");
  const refused = [
    record({ INPUT_TAG: "main" }, release(OWN_IMAGE)),
    record({ INPUT_TAG: "v0.2.15; id" }, release(OWN_IMAGE)),
    record({ INPUT_TAG: "v9.9.9" }, release(OWN_IMAGE)),
    record({ XB_REGISTRY: "" }, release(OWN_IMAGE)),
    record({}, release({ ...OWN_IMAGE, repository: "evil.example/o/r" })),
    // Another owner's image on GHCR is as good as any other as far as the registry is concerned.
    record({}, release({ ...OWN_IMAGE, repository: "ghcr.io/other/repo" })),
    record({}, release({ ...OWN_IMAGE, repository: "ghcr.io/o/r/extra" })),
    record({}, release({ ...OWN_IMAGE, digest: "latest" })),
    record({}, { images: {} }),
    // A record somebody else attached to the Release is not believed.
    record({}, release(OWN_IMAGE), { login: "someone" }),
  ];
  for (const result of refused) {
    expect(result.status).not.toBe(0);
    expect(result.outputs).toEqual({});
  }
});

test("the record is checked against the version tag on GHCR before anything is copied", () => {
  const verify = (digestOnGhcr) => {
    const temp = scratch();
    const bin = join(temp, "bin");
    mkdirSync(bin);
    const calls = join(temp, "calls");
    writeFileSync(calls, "");
    writeFileSync(
      join(bin, "crane"),
      `#!/usr/bin/env bash
printf 'crane %s\\n' "$*" >> ${JSON.stringify(calls)}
echo ${digestOnGhcr}
`,
    );
    chmodSync(join(bin, "crane"), 0o755);
    const result = run(
      mirrorDoc,
      "verify",
      { REPOSITORY: "ghcr.io/o/r", DIGEST, TAG: "v0.2.15" },
      { path: `${bin}:${process.env.PATH}` },
    );
    return {
      ...result,
      calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean),
    };
  };
  const ok = verify(DIGEST);
  expect(ok.status).toBe(0);
  expect(ok.calls).toEqual(["crane digest ghcr.io/o/r:v0.2.15"]);
  const moved = verify(`sha256:${"b".repeat(64)}`);
  expect(moved.status).not.toBe(0);
  expect(moved.log).toContain("::error::");
});
