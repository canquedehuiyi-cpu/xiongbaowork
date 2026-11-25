# Releasing

A release is one person choosing a version, and a reviewed pull request doing everything else. No
step involves a terminal, a tag pushed by hand, or an image built on somebody's laptop.

## Cutting one

1. Before cutting, [rebuild the changelog from the code](#rebuild-the-changelog-from-the-code).
2. Check `## Unreleased` in [CHANGELOG.md](../CHANGELOG.md) reads the way you want it to. It is the
   release notes. Nothing is generated from commit subjects, because a commit subject is written for
   the person reading the diff and these notes are for the person deciding whether to upgrade.
3. Run **Create release PR** from the Actions tab, choosing `patch`, `minor` or `major`. Leave
   `kind` as `stable`. Use `dry_run` first if you want to see the version and the notes without
   opening anything.
4. Review the pull request it opens. It updates `package.json`, promotes the changelog's
   `## Unreleased` heading to `## X.Y.Z`, and moves the Helm chart's `appVersion` to the same
   version.
5. Merge it. That is the publish.

Merging is the trigger, so a release is always a reviewed commit: on `main` for a stable release,
and on `release/X.Y` for a candidate, beta or final.

Do not push a `v*` tag by hand to release. A tag pushed by a person builds nothing and publishes
nothing.

`kind` chooses what the run releases: `stable` (the default), `rc`, `beta` or `final`. A plain
`patch`, `minor` or `major` from `main` is a `stable` release and works as described above. The
other three are for a release candidate or beta, and are described under
[Release candidates and betas](#release-candidates-and-betas) and
[Finishing a candidate](#finishing-a-candidate).

### Rebuild the changelog from the code

Entries added to `## Unreleased` since the last release are claims, not evidence, so none is
trusted as written. Before cutting a release, and before the first candidate or beta of one, go
through every change since the last release tag (`git log vX.Y.Z..origin/main` and each one's diff),
check it in the code, and write `## Unreleased` from what the code shows: keep an entry only where
the code proves it, rewrite one that overstates, understates or misdescribes the change, drop one
the code does not do, and add one for any change no entry mentions. Land it on `main` as a pull
request like any other.

## Release candidates and betas

A release candidate or beta is a version people can try before it is the release. It is published
where testers can find it, and nowhere that would hand it to everybody else.

Run **Create release PR** with `kind` set to `rc` or `beta`. `bump` matters only for the first one,
because it chooses the version the candidate is heading for. After that the version keeps counting,
so `0.3.0-rc.1` is followed by `0.3.0-rc.2`.

The first run, started from `main`, cuts the branch `release/X.Y` and opens a release PR into it.
`from` is optional and only applies to this first run. It names the commit on `main` to cut from, as
a full commit SHA or a branch name, and the default is the tip of `main`. A short SHA does not work.
The run refuses a commit that is not on `main`.

Every later candidate runs from `release/X.Y`, by choosing that branch in **Use workflow from**. A
second run from `main` is refused, because the branch already exists. A `from` on a later run is
refused too.

A fix goes onto `release/X.Y` through its own pull request, and then becomes the next candidate.
Merging the release PR is the publish, the same as for a release from `main`. The publish workflow
also runs on pushes to `release/**`, and decides from the merged pull request that a push is a
candidate, as it does for `main`. A stable release is never cut from a release branch.

Each candidate or beta is published as a GitHub prerelease. It is never Latest, so customers who
check for the latest release do not see it. Its images are tagged with the version and
`sha-<commit>`, and never `latest`.

A candidate does not promote the changelog. Its notes are what is under `## Unreleased` at that
moment, and the final promotes them, so
[rebuild the changelog from the code](#rebuild-the-changelog-from-the-code) on `main` before the
first candidate is cut.

`release-policy.json` describes one release: the versions it upgrades from, its database transition,
downtime and recovery, and the version it was written for. Publishing refuses a policy that names
another version. Its candidates, betas and final share it, so **Create release PR** moves its
`version` along within one release, `v0.3.0` to `v0.3.0-rc.1` to `v0.3.0`, and changes nothing
else. A policy written for an earlier release is left alone: write the new release's policy into
the release PR before merging it. A final may not change the policy beyond its version.

## Finishing a candidate

Run **Create release PR** with `kind` set to `final`, from `release/X.Y`. A final started from
`main` is refused, with a message telling you to run it from the release branch. `bump` has no
effect, because the version is the candidate's version without its suffix.

The tip of `release/X.Y` must carry a candidate tag. If the branch has moved on since its last
candidate, the run stops with "Cut a new candidate first". A final ships what a candidate was
tested as, so it is cut from the commit a candidate was published from and nothing newer.

The final release PR promotes the changelog and moves the same version files as any release. When
it merges, the publish workflow compares the release against its candidate before it builds
anything, and fails if anything else changed. The allowed difference is:

- the `version` in `package.json`
- `CHANGELOG.md`
- `appVersion` in `charts/xiongbao/Chart.yaml`

The final is a normal release: it becomes Latest, with its images tagged `latest`, only when no
newer release already is. A patch from `main` can be released while a newer final is out, and that
does not move Latest back.

The smoke journey is still required before a final. See
[The one thing CI cannot do](#the-one-thing-ci-cannot-do). The PR body asks for the result, as it
does for any stable release.

Afterwards the publish workflow opens a PR titled "Merge release/X.Y back into main". The version,
the changelog section and every fix made on the release branch exist only there until it merges.

The PR comes from `merge-back/vX.Y.Z`, not from `release/X.Y`. The workflow makes that branch at the
tip of `release/X.Y`. A push to `merge-back/vX.Y.Z` is not a release.

A PR opened by a workflow does not start CI, so push an empty commit to `merge-back/vX.Y.Z` or close
and reopen the PR before merging. If the merge conflicts, a person resolves it.

Merge the merge-back PR with a merge commit, not a squash, so main keeps the release branch's
history and the next merge-back does not conflict.

## What merging does

`publish-release.yml` runs on every push to `main` and to `release/**`, and starts by deciding
whether the commit is a release at all. It asks the API for the pull request that produced the
commit, and requires that the head branch matches `release/publish/vX.Y.Z`, with a `-rc.N` or
`-beta.N` suffix for a candidate or beta, that the branch is in this repository, and that the pull
request carries the `release` label. A fork can name a branch anything; it cannot add a label.

A version without a suffix merges into `main`, as a `stable` release, or into `release/X.Y`, as a
final. A candidate or beta merges only into the `release/X.Y` its version names. A labelled release
PR merged anywhere else fails the run. Cutting a plain `patch`, `minor` or `major` from `main` is
unchanged. What it publishes also includes the `sha-<commit>` image tag, as listed below.

Then, in order:

- the version in the tree is checked against the branch that is publishing it, and the changelog is
  checked for a section with that number
- the commit is checked, as described under [What has to be green](#what-has-to-be-green): the full
  CI suite, or, when the release PR changed only the release files on a commit main's CI passed,
  that run and the checks that read the release files
- one image is built and pushed to `ghcr.io/<owner>/<repository>`, tagged with the version, the
  commit as `sha-<commit>` and `latest` only when the release becomes Latest (a stable release with
  no newer release already out). A candidate or beta is never tagged `latest`
- the services `docker-compose.yml` can build are published too, one image each, at
  `ghcr.io/<owner>/<repository>-<service>`. Those are `linux/amd64` and `linux/arm64`, built on native
  runners of each architecture and joined into one manifest list, because the machines pulling them
  are laptops as well as servers. `.github/published-images.json` is the list, and CI fails if it
  stops matching the Dockerfiles in the tree
- a build provenance attestation is signed with the workflow's OIDC identity and pushed alongside
  every one of them
- the commit is tagged and a GitHub Release is created, carrying the changelog section as its notes
  (for a candidate or beta, what is under `## Unreleased`), `container-images.json`, the source
  archive, the chart and the release manifest as assets. A candidate or beta is marked as a
  prerelease and never Latest
- for a final cut from `release/X.Y`, the merge-back PR opens as described under
  [Finishing a candidate](#finishing-a-candidate)

## Our own registry: JD Cloud JCR

A release can copy its verified linux/amd64 image manifest to our own registry. The index around it,
with its provenance and SBOM attestations, stays on GHCR. Nothing happens until `XB_REGISTRY` is set
in the `release` Environment; then the `mirror` job in `release.yml` signs in and copies. This is for
servers in China, which pull from GHCR at about 24 KB/s.

JD Cloud's registry tokens last at most 24 hours, so no fixed password is stored. The job exchanges
an AccessKey for a six-hour token (copying a 1 GB image across the border can take over an hour) (`GetAuthorizationToken` of the `jdcloud_sdk` Python package) and
reads the user and password from the `docker login` command the API returns. The SDK is a source
archive checked against a hash written in `release.yml` and used without being built, and what it
imports is installed as hash-pinned wheels; both are installed in a shell with an empty environment,
so the installers are not handed any key (a same-user process could still read the parent's environment; the installers run no downloaded code). The token is not revoked after the job; it expires on its
own after six hours. Only the password is masked in logs: the user name is not a secret.

One-time setup:

1. In the JD Cloud console, create a registry (here `xiongbao-work`, region cn-north-1, URI
   `xiongbao-work-cn-north-1.jcr.service.jdcloud.com`) and a repository in it.
2. Create a sub-account whose policy allows only that registry's JCR actions: getting an
   authorization token, and pushing and pulling images. Create an AccessKey for it. Check the exact
   action names against the console's policy editor; they were not verified when this was written.
3. In the `release` Environment (Settings, Environments), set:

| Kind | Name | Value |
| --- | --- | --- |
| variable | `XB_REGISTRY` | the registry URI, no scheme and no path |
| variable | `XB_IMAGE_REPOSITORY` | the repository name, lowercase |
| variable | `XB_JDCLOUD_REGION` | `cn-north-1` |
| variable | `XB_JDCLOUD_REGISTRY_NAME` | `xiongbao-work` |
| secret | `XB_JDCLOUD_ACCESS_KEY_ID` | the sub-account's AccessKey ID |
| secret | `XB_JDCLOUD_SECRET_ACCESS_KEY` | its secret |

Set either these four JD Cloud settings or the fixed `XB_REGISTRY_USERNAME` and
`XB_REGISTRY_PASSWORD` secrets (for another registry), never both and never half of one: the
sign-in step stops with an error.

Two more things to set up on the GitHub side:

- The `release` Environment's deployment rules (branches and tags) must allow `main`, because
  `mirror-release.yml` runs from `main`; `release.yml` runs from a release tag, so tags stay allowed.
  Give the Environment required reviewers: it is what stands between a dispatch and the registry
  credentials, since the `main` condition in the workflow only concerns the ref that was dispatched.
- Before the next release tag, run `mirror-release.yml` once for a version that is already
  published (for example `v0.2.15`). It exercises the AccessKey, the SDK install and the push
  without touching a release: a first real call during a release would fail after the GHCR version
  tags have been set.

**Copying an older release.** Run **补同步镜像到自有仓库** (`mirror-release.yml`) from `main`, with the
tag, for example `v0.2.15`. It reads `container-images.json` of that Release, which must have been uploaded by the release
workflow, and takes the GHCR image under `images.openbot`, which must be this repository's own. The
digest in it must be the one the GHCR version tag has: the run stops otherwise. It then copies its linux/amd64 manifest to `<XB_REGISTRY>/<XB_IMAGE_REPOSITORY>:<tag>`
with the same sign-in and copy steps as `release.yml` (a test keeps their text identical), and writes
the target and the platform manifest's digest in the step summary. The Release and its assets are not
changed, so `container-images.json` keeps pointing at what it pointed at. A tag that already names a
different image is never moved; a re-run over the same copy succeeds.

The server pulls by digest, `<XB_REGISTRY>/<XB_IMAGE_REPOSITORY>@<platform manifest digest>`; see
[the deployment manual](deployment-xiongbao.md), section 7.

## Deploying a release

`container-images.json` pins a digest for every image the release published. Deploy those, not tags:

```sh
gh release download v0.1.0 --pattern container-images.json
docker run -p 3001:3001 --env-file .env \
  "$(jq -r .images.openbot.reference container-images.json)"
```

The same file is how a machine runs the stack without building any of it. Each key under `images`
is a service, so the references can be read straight out of it:

```sh
export COMPUTER_IMAGE="$(jq -r '.images["agent-computer"].reference' container-images.json)"
export SUPERVISOR_IMAGE="$(jq -r .images.supervisor.reference container-images.json)"
export BOT_IMAGE="$(jq -r '.images["agent-bot"].reference' container-images.json)"
export LANGGRAPH_IMAGE="$(jq -r '.images["agent-langgraph"].reference' container-images.json)"
export SERVER_IMAGE="$(jq -r .images.server.reference container-images.json)"
export IMAGE_PULL_POLICY=missing
docker compose up -d
```

`IMAGE_PULL_POLICY=missing` is what turns those names into pulls; without it every one of those
services builds from source, because a service with a `build` section builds by default whatever
its image is called. A pull that fails still falls back to building, so a machine with no toolchain
wants the `build` sections overridden away rather than this variable alone.

A tag can be moved to point at a different image; a digest cannot. The same digest that CI smoke
tested is the one that runs, and rolling back is the same command with an earlier version.

On Kubernetes the chart takes the same digest as `image.digest`; see
[charts/xiongbao/README.md](../charts/xiongbao/README.md#pin-the-image-by-digest).

Before deploying, you can check an image is the one this repository built. Every published image
carries its own attestation:

```sh
gh attestation verify oci://ghcr.io/canquedehuiyi-cpu/xiongbaowork:v0.1.0 -R canquedehuiyi-cpu/xiongbaowork
```

## What has to be green

Branch protection should require one check, `verify`, which fails unless every other job succeeded.
A job added to `ci.yml` is covered by it without anybody updating a list.

| check | what it would catch |
| --- | --- |
| `format, lint, types` | the ordinary things, across every workspace including `agent-computer` and the supervisor |
| `types (agent-computer)`, `types (supervisor)` | a type error in either deployable package, each checked on its own install |
| `native types` | a type error in the `mobile` app, which installs from its own npm lockfile |
| `computer (real browser)` | the agent-computer behaviour only a real Chromium shows, such as a password reaching the snapshot a model reads, a session cookie lost on restart, or WebRTC leaving around the egress filter |
| `tests` | a decision made wrongly, in isolation |
| `chart` | a Helm values file that renders a server which cannot start, across the self-hosted, EKS, EKS sandbox, GKE and AKS targets |
| `python harness regressions` | a provider-boundary regression in the Python Bot harnesses |
| `startup (macos-latest)`, `startup (windows-latest)` | the app's serve-or-build cache deciding wrongly on macOS or Windows |
| `build` | the app not compiling |
| `migrations` | a schema change with no migration, or a snapshot that has drifted |
| `image` | an image that builds but does not boot, or a supervised service that respawns |
| `component dockerfiles` | a Dockerfile a release would publish that no longer builds, or one the publish list has stopped covering |

`image` matters more than its position suggests. Everything above it can pass on a tree whose image
never starts, because nothing else here runs the thing it ships. It builds the container, boots it
with embedded PostgreSQL, waits for `/api/capabilities`, and fails if a supervised service is
respawning.

These checks gate the publish rather than the proposal, which is why the release PR arriving
without its own checks does not matter: a pull request opened by a workflow does not trigger them.
When the release PR merges, the publish workflow's `checks needed` job
(`scripts/release-ci-gate.ts`) decides whether they run again on the
release commit:

- When the release commit changes nothing but the release files from the commit it merged onto
  (its first parent), and main's CI passed on that commit, they do not. That commit's tree has been
  through all of them already. The release files are `CHANGELOG.md` and `release-policy.json`, which
  may change freely, and the `version` in `package.json` and `appVersion` in
  `charts/xiongbao/Chart.yaml`, which may change nothing else. Only a run of `ci.yml` for a push to this repository's `main`, at
  exactly that commit, counts; a pull request's run tests a merge of the PR, not the commit, and
  skips `image` unless it was labelled. A run still in progress is waited for, up to 40 minutes. In
  their place the job re-runs the checks that read the files the release did change: formatting and
  lint, the chart version against `package.json`, and every test that names
  `CHANGELOG.md` or `release-policy.json`.
- Otherwise they all run again, as before: when any other path is added, removed, renamed or
  changed, when a version file changes more than its version, or when main's CI on that commit
  failed, was cancelled, never ran, could not be read, or was still running after the wait.

The diff is read with renames turned off, so a source file moved onto a release file's name is still
seen as the source file it removed. Every commit on `main` keeps its own CI run for this (the
`concurrency` group in `ci.yml` is per commit on `main`), so a commit pushed while another's run was
in progress still gets a result. A final's parent is its candidate on `release/X.Y`, which main's CI
never ran on, so a final always runs the full suite.

**No secrets are required to release.** CI and **Create release PR** use only the built-in
`GITHUB_TOKEN`.

## The one thing CI cannot do

The smoke journey in `tests/smoke` is the only check that proves the parts are wired to each other:
the server reaches the supervisor, the supervisor builds a computer, the gateway decides before the
browser acts, and the trail records it. It cannot run in CI, and this is not a gap to be closed
later.

The journey talks to a deployment that is actually up: it reads `/api/capabilities` and
`/api/copilotkit/info`, mints a thread, and drives a Bot's browser. A hosted runner could hold the
`DATABASE_URL` and `KEY_ENCRYPTION_KEY` that `loadConfig` asks for, but it would also have to hold
the rest of the stack — the Bots, the supervisor, and one real computer per Bot. The `image` check
starts the container with placeholders precisely because nothing is contacted at start-up, and a
container brought up that way is not a deployment the journey can be pointed at.

So it is a step a person takes, on a machine with the stack running, before merging the release PR:

```sh
bash scripts/start.sh
export OPENBOT_SMOKE_COOKIE='better-auth.session_token=...'   # from a signed-in browser
bun run test:smoke
```

The session is the second half of "the stack running": the routes the journey proves
are behind `requireUser`, so a run without one answers 401 three times and says nothing about the
release. See [development.md](development.md#quality-checks) for where the cookie comes from.

The release PR asks for the result in a comment. That is deliberately a person rather than a robot:
it is the one gate that cannot be automated, so it is the one gate worth naming.
