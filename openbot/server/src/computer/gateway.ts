/**
 * The only way an action reaches a Bot's computer.
 *
 * Reading a page is one thing; clicking a button on an external website is
 * another, and the difference is the whole product. The record is not a report written alongside the
 * work, it is the thing the action goes through, so it cannot be missing: an action that was not
 * recorded did not happen, because there is no path that acts without writing the row first.
 *
 * Three jobs, in this order:
 *
 *  1. Resolve the ref the caller sent into the element it actually points at, from the snapshot this
 *     server fetched. Never from what the caller said it was clicking.
 *  2. Ask the policy. Deny beats allow, an absent policy denies, and a broken rule denies.
 *  3. Write the row, whichever way the decision went, and only then act.
 *
 * Step 1 is the one that is easy to skip and fatal to skip. A gateway that decides on a label supplied
 * by the model is theatre: "never click Submit" is evaded by sending `{ref: "e13", name: "Continue"}`.
 * The refs are opaque to the caller precisely so that the server holds the mapping.
 */

// --- desktop control (sub-project 2) ---
import {
  type DesktopSnapshot,
  type DesktopWindow,
  snapshotForStorage,
} from "@openbot/shared/desktop-control";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
// --- app discovery (sub-project 3) ---
import { APP_ENABLE_TOOL } from "../approvals/policy";
import {
  type ApprovalCandidate,
  type ApprovalGate,
  ApprovalRefusedError,
  currentApprovalContext,
} from "../approvals/types";
import {
  type AuditInitiator,
  type AuditStore,
  recordAuditEvent,
} from "../audit";
import {
  DeviceOfflineError,
  isRunnerAddress,
  runnerAddress,
} from "../devices/channel";
import { DeviceDeliveryError } from "../devices/queue";
import {
  DEVICE_HUMAN_HAS_CONTROL,
  type DeviceTakeovers,
} from "../devices/takeover";
import type { ProjectRoot } from "../projects/context";
import { withUntrustedNotice } from "../untrusted-content";
// --- end app discovery ---
import {
  computerActionIdentity,
  computerActionOrigin,
} from "./action-identity";
import {
  AVAILABLE_HINT,
  CANDIDATE_EXPIRED,
  createCandidateCache,
  DEVICE_OFFLINE_ENABLE,
  type DiscoveredCandidate,
  discoveryGroups,
  INSTALLED_HINT,
  OLD_RUNNER,
  readDiscovery,
  readEnabled,
} from "./app-discovery";
import {
  ComputerStoppedError,
  type ComputerTransport,
  ComputerUnavailableError,
  createComputerTransport,
  HumanHasControlError,
  StaleSnapshotError,
} from "./client";
import { createDesktopMethods, type DesktopSubject } from "./desktop-gateway";
import { createDesktopWindowCache } from "./desktop-state";
// --- end desktop control ---
import { checkComputerAddress } from "./target";

export {
  ComputerUnavailableError,
  ElementNotFoundError,
  HandoffRequestError,
  HumanHasControlError,
  NavigationRefusedError,
  StaleSnapshotError,
  WorkspaceNotFoundError,
  WorkspaceRefusedError,
  WorkspaceRequestError,
  WorkspaceTooLargeError,
} from "./client";

import type { PageFrameStore } from "./page-frames";
import {
  type ActionPolicy,
  evaluateActionPolicy,
  type PolicyContext,
  type PolicyDecision,
  policyInitiator,
} from "./policy";
import type { ComputerProvider, ComputerUpdate } from "./provider";
import type {
  ActionResult,
  ClickInput,
  ComputerStatus,
  ControlState,
  DownloadFileInput,
  HumanInput,
  HumanInputResult,
  KeyInput,
  ListFilesInput,
  ListFilesResult,
  NavigateResult,
  ReadFileInput,
  ReadFileResult,
  ReadResult,
  RunCommandInput,
  RunCommandResult,
  ScreenshotResult,
  ScrollInput,
  SecretRequest,
  SecretResult,
  SignInCodeInput,
  SignInCodeResult,
  SignInFillInput,
  SignInFillResult,
  SnapshotElement,
  SnapshotResult,
  TypeInput,
  WriteFileInput,
  WriteFileResult,
} from "./schema";
import {
  createInMemorySnapshotStore,
  type SnapshotStore,
  type StoredSnapshot,
} from "./snapshot-store";

/** The rule a takeover refusal names on its audit row, so an operator can count them apart. */
export const DEVICE_TAKEOVER_RULE = "device.takeover";
/** The rule a refusal names when a coworker's current project cannot be used (story RES2, D9). */
export const PROJECT_UNAVAILABLE_RULE = "project.unavailable";
/** The rule a refusal names for a local app or app tool the device does not have (MCP bridge §5). */
export const APP_UNAVAILABLE_RULE = "app.unavailable";
const READ_ONLY_PROJECT =
  "当前项目是只读的：可以列出和读取文件，不能写文件或运行命令。如需修改，请让项目的主人把项目设为可写。";

export class ActionRefusedError extends Error {
  /** The rule that refused it, so the surface can show which one and an operator can find it. */
  readonly rule: string | null;

  constructor(reason: string, rule: string | null) {
    super(reason);
    this.name = "ActionRefusedError";
    this.rule = rule;
  }
}

/** Who is asking. The gateway records this; it does not decide it. */
export type ActionActor = {
  /** The signed-in person, or the local actor when authentication is not configured. */
  id: string;
  /** Null unless this is a real row in `users`, because the audit table has a foreign key to it. */
  userId?: string;
  /** What started this run; scheduled work must not inherit person initiation. */
  initiator?: AuditInitiator;
};

/**
 * One tool of a local app, as the device's own `apps.tools` listed it (device MCP bridge §3.4). The
 * annotations are the app's own hints; only this list, never the model's arguments, decides whether
 * a call may run without asking.
 */
export type AppTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    [key: string]: unknown;
  };
};

/** What `computer_apps` answers: each app by name, with its tools or why they could not be listed. */
export type ListAppsResult = {
  apps: { name: string; tools?: AppTool[]; error?: string }[];
  // --- app discovery (sub-project 3) ---
  available?: DiscoveredCandidate[];
  installed?: string[];
  hints?: { available: string; installed: string };
  discoveryError?: string;
  // --- end app discovery ---
};

/** What a local app's tool answered, or that the call waits for a machine that is away. */
export type AppCallResult =
  | {
      content: { type: "text"; text: string }[];
      structuredContent?: unknown;
      isError: boolean;
      truncated: boolean;
    }
  | { queued: true; key: string };

export type ComputerGatewayOptions = {
  /**
   * How an allowed action reaches the computer. Absent means HTTP to the located address, which is
   * what a deployment running its own container wants; a device-backed one passes a transport that
   * writes frames to the tenant's machine.
   */
  transport?: ComputerTransport;
  /**
   * Which machine this Bot's work is carried out on, when that is a tenant's device rather than one of
   * this deployment's containers (ticket 017).
   *
   * Asked before the provider is, and only for the address: the lifecycle, status and reset of a
   * computer still belong to the provider, because a machine the person owns has no image to update
   * and no state for this deployment to clear.
   */
  resolveDevice?: (
    botId: string,
  ) => Promise<{ tenantId: string; deviceId: string } | null>;
  /**
   * The local apps a machine reported on its heartbeat, `{ref, name}` and nothing else (device MCP
   * bridge §3.4). Asked for the machine `resolveDevice` answered; absent means no Bot here can use a
   * local app, and both app tools refuse.
   */
  deviceApps?: (machine: {
    tenantId: string;
    deviceId: string;
  }) => Promise<{ ref: string; name: string }[]>;
  // --- app discovery (sub-project 3) ---
  /**
   * Whether a frame can be written to the machine from this process now. False refuses an enable
   * before anything is asked; absent, the transport's own answer is the only one.
   */
  deviceReachable?: (machine: {
    tenantId: string;
    deviceId: string;
  }) => boolean;
  /** The app an enable just made, added to the machine's record until its next heartbeat. */
  rememberDeviceApp?: (
    machine: { tenantId: string; deviceId: string },
    app: { ref: string; name: string },
  ) => Promise<void>;
  // --- end app discovery ---
  /**
   * The person's read-only folders on their own machines (story F1, stage 2).
   *
   * A file read or listing that names a `root` is carried to the machine that folder is on, whichever
   * computer this Bot otherwise uses, and only when `resolve` answers one: in practice, only a
   * person's own 分身, in that person's run, for a folder one of its active sources names. Absent
   * means no folder can be named here at all, and a call that names one is refused. The transport is
   * the runner's, even in a deployment whose coworkers use a container.
   */
  folders?: {
    resolve: (
      botId: string,
      actorId: string,
      root: string,
    ) => Promise<{ tenantId: string; deviceId: string } | null>;
    transport: ComputerTransport;
  };
  /**
   * A coworker's current project on the machine an action resolves to (story RES2, spec §3.5).
   *
   * Asked for every file and shell call that names no root, once the machine is known (`resolveDevice`;
   * a deployment without one, cloud mode included, has no projects, decision D7). With a project, the
   * frame's `root` and `writable` are the project's, never the model's, and the policy, the row and
   * the approval gate see the path as `<root>/<path>`; with a refusal the action is refused and
   * recorded, and nothing is sent (D9); with null the call goes to the workspace as before.
   */
  projects?: {
    resolve: (
      botId: string,
      machine: { tenantId: string; deviceId: string },
    ) => Promise<ProjectRoot | null>;
  };
  /**
   * Who holds the wheel of a Bot's browser on a tenant's own machine (F2 stage 2).
   *
   * Asked for every governed action that resolves to a device: while a person holds it, or has been
   * asked to, the Bot's action is refused here, before anything is sent to the machine. The handover
   * calls answer from it too, because a device has no control state of its own to post to.
   */
  deviceTakeovers?: DeviceTakeovers;
  approvalGate?: ApprovalGate;
  /**
   * Why the gate would refuse an action outright, whatever its effect turns out to be (a disabled
   * tool, the team's host-command cap of `never`): asked before a local app's tool list is fetched,
   * because fetching it starts the app on the person's machine. Absent: nothing is asked early, and
   * the gate still decides in full.
   */
  approvalRefusal?: (
    candidate: ApprovalCandidate,
  ) => Promise<string | undefined>;
  /** The clock a device's cached tool list is aged by. Tests hand in their own. */
  now?: () => number;
  provider: ComputerProvider;
  auditStore: AuditStore;
  /** Absent denies everything. See evaluateActionPolicy. */
  policy: () => ActionPolicy | undefined;
  /** True on a laptop, where browsing private network addresses is required. */
  allowPrivateHosts?: boolean;
  /** The secret that agent-computer requires on each request. */
  token?: string;
  /** An injectable fetch implementation for focused gateway tests. */
  fetchImpl?: typeof fetch;
  /**
   * Where the snapshot a ref is resolved against is kept.
   *
   * A deployment passes the database-backed store, because the process that takes a snapshot is
   * rarely the one that resolves a ref from it. Absent, the gateway keeps snapshots in memory, which
   * is correct in one process and is what a unit test wants. See snapshot-store.ts.
   */
  snapshots?: SnapshotStore;
  /**
   * Where the frame a page was opened on is kept, so a reset can take them with the profile.
   *
   * Absent, a reset clears the profile and leaves the pictures, which is the wrong half of a promise
   * this deployment makes in as many words.
   */
  pageFrames?: PageFrameStore;
};

export interface ComputerGateway {
  readonly provider: ComputerProvider;
  locate(botId: string): Promise<string>;
  status(botId: string): Promise<ComputerStatus>;
  screenshot(botId: string): Promise<ScreenshotResult>;
  snapshot(botId: string): Promise<SnapshotResult>;
  read(botId: string): Promise<ReadResult>;
  navigate(
    botId: string,
    actor: ActionActor,
    url: string,
    toolCallId?: string,
  ): Promise<NavigateResult>;
  click(
    botId: string,
    actor: ActionActor,
    input: ClickInput,
    signal?: AbortSignal,
  ): Promise<ActionResult>;
  type(
    botId: string,
    actor: ActionActor,
    input: TypeInput,
    signal?: AbortSignal,
  ): Promise<ActionResult>;
  key(
    botId: string,
    actor: ActionActor,
    input: KeyInput,
    signal?: AbortSignal,
  ): Promise<ActionResult>;
  scroll(
    botId: string,
    actor: ActionActor,
    input: ScrollInput,
  ): Promise<ActionResult>;
  readFile(
    botId: string,
    actor: ActionActor,
    input: ReadFileInput,
  ): Promise<ReadFileResult>;
  downloadFile(
    botId: string,
    actor: ActionActor,
    input: DownloadFileInput,
    signal?: AbortSignal,
  ): Promise<{
    body: ReadableStream<Uint8Array>;
    bytes: number;
    name: string;
  }>;
  listFiles(
    botId: string,
    actor: ActionActor,
    input: ListFilesInput,
  ): Promise<ListFilesResult>;
  runCommand(
    botId: string,
    actor: ActionActor,
    input: RunCommandInput,
    signal?: AbortSignal,
  ): Promise<RunCommandResult>;
  writeFile(
    botId: string,
    actor: ActionActor,
    input: WriteFileInput,
  ): Promise<WriteFileResult>;
  /** The local apps on the owner's paired machine, and each one's tools (device MCP bridge §3.4). */
  listApps(
    botId: string,
    actor: ActionActor,
    input: { app?: string },
    signal?: AbortSignal,
  ): Promise<ListAppsResult>;
  /** One tool of a local app on the owner's paired machine, governed like a command. */
  callApp(
    botId: string,
    actor: ActionActor,
    input: { app: string; tool: string; args?: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<AppCallResult>;
  // --- app discovery (sub-project 3) ---
  /** One app found on the owner's paired machine made usable, always with the owner's approval. */
  enableApp(
    botId: string,
    actor: ActionActor,
    input: { candidate: string },
    signal?: AbortSignal,
  ): Promise<{ enabled: { name: string; tools: AppTool[] }; next: string }>;
  // --- end app discovery ---
  /**
   * Whether this person may use the local apps and the desktop of this Bot's owner's machine at all:
   * the same question `listApps` and `listDesktopWindows` ask before anything else, answered without
   * asking the machine, recording a row or deciding a policy. Only for what a surface offers; every
   * call is still decided in full by its own method.
   */
  localToolsAllowed(botId: string, actor: ActionActor): Promise<boolean>;
  /**
   * Where this deployment's computer tools act: `device` when commands land on a person's paired
   * machine (the same condition as `TENANT_RUNTIME=device`, which is when `resolveDevice` is wired),
   * else `workspace`. For what a surface tells the model; it decides nothing.
   */
  machine(): "workspace" | "device";
  control(botId: string, requestId?: string): Promise<ControlState>;
  requestHelp(
    botId: string,
    actor: ActionActor,
    reason: string,
    toolCallId?: string,
  ): Promise<ControlState>;
  takeControl(
    botId: string,
    actor: ActionActor,
    requestId: string,
  ): Promise<ControlState>;
  releaseControl(
    botId: string,
    actor: ActionActor,
    requestId: string,
  ): Promise<ControlState>;
  cancelControl(
    botId: string,
    actor: ActionActor,
    requestId: string,
  ): Promise<ControlState>;
  requestSecret(
    botId: string,
    actor: ActionActor,
    input: SecretRequest,
  ): Promise<ControlState>;
  supplySecret(
    botId: string,
    actor: ActionActor,
    text: string,
  ): Promise<SecretResult>;
  /** Fill and submit a login form on the Bot's current page. See passwords/service.ts. */
  signIn(
    botId: string,
    input: SignInFillInput,
    signal?: AbortSignal,
  ): Promise<SignInFillResult>;
  /** Type the verification code a site asked for after the password. See passwords/service.ts. */
  signInCode(
    botId: string,
    input: SignInCodeInput,
    signal?: AbortSignal,
  ): Promise<SignInCodeResult>;
  humanInput(botId: string, input: HumanInput): Promise<HumanInputResult>;
  computers(): Promise<{
    isolation: "per-bot" | "shared";
    computers: {
      botId: string;
      running: boolean;
      startedAt: string | null;
      egress?: string | null;
      updateAvailable?: boolean;
    }[];
  }>;
  stopComputer(
    botId: string,
    actor: ActionActor,
  ): Promise<{ wasRunning: boolean }>;
  resetComputer(
    botId: string,
    actor: ActionActor,
  ): Promise<{ cleared: boolean }>;
  /** Move a computer onto the current image, keeping its files and sign-ins. */
  updateComputer(botId: string, actor: ActionActor): Promise<ComputerUpdate>;
  // --- desktop control (sub-project 2) ---
  /** The windows on the owner's paired machine (desktop viewing, read only). */
  listDesktopWindows(
    botId: string,
    actor: ActionActor,
    signal?: AbortSignal,
  ): Promise<{ untrusted: string; windows: DesktopWindow[] }>;
  /** One window's control tree, and its screenshot when asked; a sensitive title asks first. */
  snapshotDesktop(
    botId: string,
    actor: ActionActor,
    input: { windowId: string; from?: string; screenshot?: boolean },
    signal?: AbortSignal,
  ): Promise<{ untrusted: string } & DesktopSnapshot>;
  // --- end desktop control ---
}

export function createComputerGateway(
  options: ComputerGatewayOptions,
): ComputerGateway {
  const { provider, auditStore } = options;
  /*
   * How an allowed action is carried. HTTP to this deployment's own computer unless the caller says
   * otherwise: a device-backed gateway passes a transport that writes frames to a machine the tenant
   * owns, and every line above that call — policy, approval, audit — is the same either way.
   */
  const transport =
    options.transport ??
    createComputerTransport({
      ...(options.token ? { token: options.token } : {}),
      ...(options.allowPrivateHosts !== undefined
        ? { allowPrivateHosts: options.allowPrivateHosts }
        : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  /**
   * Where the snapshot a ref is resolved against lives.
   *
   * Not a `Map` in this process. It describes the live contents of a browser window, and the process
   * that took it is rarely the one that resolves a ref from it: OpenBot is several servers behind a
   * load balancer, and consecutive calls on one conversation land on different ones. Kept in memory,
   * the mapping is absent on every replica but the one that snapshotted, so the ref resolves to
   * nothing, the policy decides with no element in front of it, and the audit row cannot name what
   * was touched. The store puts it in Postgres, and the generation carried on every action keeps a
   * ref from a superseded page from resolving to whatever now holds it. See snapshot-store.ts.
   */
  const snapshots = options.snapshots ?? createInMemorySnapshotStore();
  const pageFrames = options.pageFrames;

  /**
   * Where this Bot's computer is, checked before anything is sent to it.
   *
   * The provider decides the address, and a provider is a plug: it can be this deployment's own
   * supervisor on loopback or a backend somewhere else answering over its own API. Either way the
   * address goes straight into `fetch` carrying this deployment's computer token, so it is worth
   * confirming it is an address we speak to rather than whatever came back.
   *
   * Not the navigation check. That one refuses private hosts, which is the right answer for where a
   * Bot may browse and the wrong one here, where loopback is the normal case.
   */
  async function locate(botId: string): Promise<string> {
    /*
     * A device answers for itself.
     *
     * Asked first and answered with an address the transport writes a frame to: this deployment never
     * hosts the machine, so there is no container to locate, and the person's own computer is where
     * the action belongs.
     */
    const device = await options.resolveDevice?.(botId);
    if (device) return runnerAddress(device);
    const address = await provider.locate(botId);
    /*
     * A device is not an address.

     * The guard below exists because the located address is about to be `fetch`ed with this
     * deployment's computer token in its headers. A `runner:` address is fetched by nothing: it names a
     * socket the machine opened and authenticated with its own device token, so there is no host to
     * vouch for and no credential to leak to it. Letting it through `checkComputerAddress` would refuse
     * every device on a URL that was never a URL.
     */
    if (isRunnerAddress(address)) return address;
    const verdict = checkComputerAddress(address);
    if (!verdict.allowed) {
      throw new ComputerUnavailableError(verdict.reason);
    }
    return verdict.url;
  }

  /**
   * The machine whose takeover state answers this Bot's handovers, or null for a container.
   *
   * Only with a takeover registry: without one a device-mode gateway keeps the old behaviour of
   * posting the handover to the transport, which a runner refuses.
   */
  async function takeoverTarget(
    botId: string,
  ): Promise<{ tenantId: string; deviceId: string } | null> {
    if (!options.deviceTakeovers || !options.resolveDevice) return null;
    return options.resolveDevice(botId);
  }

  async function get<T>(
    botId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<T> {
    return transport.call<T>(
      await locate(botId),
      botId,
      path,
      undefined,
      signal,
    );
  }

  /**
   * `address` is this action's own `/ensure`, when the caller has already made it.
   *
   * Locating twice for one action is two calls to the supervisor to learn the same thing, and worse,
   * they can disagree: the run the action was decided against would not be the run it was sent to.
   * Passing the address through means the check and the send are the same trip.
   */
  async function post<T>(
    botId: string,
    path: string,
    payload: unknown,
    signal?: AbortSignal,
    timeoutMs?: number,
    address?: string,
  ): Promise<T> {
    return transport.post<T>(
      address ?? (await locate(botId)),
      botId,
      path,
      payload,
      signal,
      timeoutMs,
      computerActionIdentity.getStore()
        ? JSON.stringify([botId, path, computerActionIdentity.getStore()])
        : undefined,
    );
  }

  /**
   * This action's own `/ensure`, or nothing when it cannot be made.
   *
   * A computer that cannot be located is not a verdict this may reach on its own. The action still
   * has to be decided and recorded, and the attempt failing is what writes the failure row beside the
   * decision; throwing here would take the action off the trail entirely. So a failure answers
   * "unknown", which leaves the generation check where it was and leaves the address to the attempt.
   */
  async function locateForAction(botId: string): Promise<string | undefined> {
    try {
      return await locate(botId);
    } catch {
      return undefined;
    }
  }

  /*
   * The transport's deadline for a command, which is a backstop and not the limit.
   *
   * The shell enforces the real one: 120s by default, 600s at most, and it answers with `timedOut`
   * so the person is told the command was stopped rather than that the computer went quiet. This
   * only has to outlast it. Below the shell's maximum, the transport gave up first and the person was
   * told the computer did not respond while the command ran on to completion inside the container.
   */
  const COMMAND_BACKSTOP_MS = 615_000;

  /*
   * A download has no command-like budget of its own. The computer refuses oversized files before
   * streaming, but a large permitted file can still outlive the ordinary request deadline on a slow
   * link. Five minutes is a backstop, not a size limit.
   */
  const DOWNLOAD_BACKSTOP_MS = 300_000;

  /** Read-only, so it passes straight through. Nothing has changed and there is nothing to decide. */
  async function screenshot(botId: string): Promise<ScreenshotResult> {
    return get<ScreenshotResult>(botId, "/screenshot");
  }

  /**
   * Read-only for the page, but it writes the resolution table the boundary reads.
   *
   * Nothing on the page changes and there is nothing to decide, so the snapshot itself passes
   * straight through. What it does record is the ref-to-element mapping every later action on this
   * computer is resolved against, and it records it where another replica can read it: the click that
   * uses these refs will almost certainly arrive on a different process. The write is awaited before
   * the refs are returned, so the snapshot cannot be resolved against on one server before it exists
   * on the store.
   */
  async function snapshot(botId: string): Promise<SnapshotResult> {
    const base = await locate(botId);
    /*
     * Which run this is, asked before the page is drawn rather than after it.
     *
     * After `locate`, because on a supervisor that is the `/ensure` that reports it. But before
     * `/snapshot`, because the two answers have to describe the same browser and asking afterwards
     * does not guarantee it: a computer replaced while the snapshot was being taken would have its
     * dead page stamped with the run of the browser that replaced it, so every ref on that page would
     * resolve against the live run and the live run's own snapshots would be refused for being older.
     *
     * Asked first, a replacement in that window leaves a row carrying a run that is already gone.
     * Nothing resolves against it and the next snapshot supersedes it, which is the direction this is
     * allowed to fail in.
     */
    const run = await sessionOf(botId);
    const result = await transport.call<SnapshotResult>(
      base,
      botId,
      "/snapshot",
      { method: "POST" },
    );
    await snapshots.save(botId, {
      snapshotId: result.snapshotId,
      url: result.url,
      elements: new Map(
        result.elements.map((element) => [element.ref, element]),
      ),
      ...run,
    });
    // Element names and values are whatever the page says they are, so they are marked too.
    return withUntrustedNotice(result, "web page", SNAPSHOT_FIELDS);
  }

  /**
   * Which run of the computer this is, shaped to spread into a snapshot.
   *
   * Absent for a provider that cannot say, and absent if asking fails: a session that cannot be read
   * must not stop a snapshot being recorded, because a snapshot nobody stored is a ref that resolves
   * to nothing and a boundary deciding with no element in front of it.
   */
  async function sessionOf(botId: string): Promise<{ session?: string }> {
    if (!provider.sessionOf) return {};
    try {
      const session = await provider.sessionOf(botId);
      return session ? { session } : {};
    } catch {
      return {};
    }
  }

  async function read(botId: string): Promise<ReadResult> {
    // Page text is outside content: marked here, once, so the headless tools and the browser's
    // routes hand the model the same envelope. See untrusted-content.ts.
    return withUntrustedNotice(
      await get<ReadResult>(botId, "/read"),
      "web page",
      PAGE_FIELDS,
    );
  }

  /**
   * Resolve a ref against the snapshot the server holds, and only against the one it came from.
   *
   * Returns undefined for an unknown ref rather than throwing, because the policy still has to run:
   * an action on an element we cannot identify must still receive a policy decision, and a deny rule
   * written against a page a Bot has not snapshotted should still refuse it.
   *
   * A ref resolves only when its generation matches the stored snapshot's. A ref carrying a
   * superseded generation resolves to nothing rather than to whatever now holds that ref: the policy
   * must never decide on an element the caller has already scrolled off the page. The computer makes
   * the same generation check when the action reaches it; this one keeps the decision and the audit
   * row honest before it gets there, on whichever replica the action landed.
   */
  function resolve(
    stored: StoredSnapshot | undefined,
    ref: string | undefined,
    snapshotId: number | undefined,
    /**
     * The run of the computer the action is reaching, when the provider can say.
     *
     * Undefined means unknown, not mismatched: a provider that could not be asked leaves the
     * generation check exactly as it was, rather than refusing every ref it holds.
     */
    session?: string,
  ): SnapshotElement | undefined {
    if (!ref || !stored || stored.snapshotId !== snapshotId) return undefined;
    /*
     * A generation is only unique within one run of the computer.
     *
     * A replaced container counts from one again, so a ref the model is still holding from the run
     * before matches a row nothing has overwritten, and the element handed to the policy belongs to
     * a page that no longer exists. `resetComputer` clears the row for that reason and is the only
     * thing that does; the supervisor replacing a computer whose image changed does not, and the
     * server is never told. Comparing the run closes both.
     */
    if (session && stored.session && stored.session !== session) {
      return undefined;
    }
    return stored.elements.get(ref);
  }

  /**
   * Decide, record, then act.
   *
   * The audit row is written before the action runs, not after it succeeds. An allowed action that
   * later fails is still part of the audit sequence, and a trail that only contains successes cannot
   * show that sequence.
   */
  async function govern<T>(
    toolName: string,
    botId: string,
    actor: ActionActor,
    subject: {
      ref?: string;
      /** The generation the ref came from. A ref only resolves against its own snapshot. */
      snapshotId?: number;
      filePath?: string;
      targetUrl?: string;
      key?: string;
      /** The command a shell call is about to run, so a rule can be written against it. */
      command?: string;
      /** The person's Stop, on its way to the browser. See the acting methods below. */
      signal?: AbortSignal;
      /**
       * The machine this call goes to when the call itself decided it (a read-only folder's), rather
       * than this Bot's own computer. Named on the row and told to the gate in its place.
       */
      device?: { tenantId: string; deviceId: string };
      /**
       * Why this call cannot be carried out at all, decided before the policy (a coworker's current
       * project that cannot be used, story RES2 D9). Recorded as a refusal; nothing is sent.
       */
      refusal?: string;
      /** The rule that refusal names. Absent: the project rule. */
      refusalRule?: string;
      // --- desktop control (sub-project 2) ---
      /** The desktop window a read is for, from the machine's own window list (never the model's). */
      desktop?: DesktopSubject;
      // --- end desktop control ---
      /**
       * A local app's tool this call is about (device MCP bridge §3.4): the app's name and the tool.
       * Whether the device's own list marks it read-only and not destructive comes from `resolveApp`,
       * never from the model's arguments; unknown means not read-only.
       */
      app?: {
        name: string;
        tool: string;
        readOnly?: boolean;
        description?: string;
      };
      /**
       * How to learn the rest of `app` from the machine (its tool list), asked only once the action
       * has got past a takeover, a refusal, the deployment's policy and an outright refusal by the
       * gate, and before the gate decides. May refuse (a tool the list does not have).
       */
      resolveApp?: () => Promise<{ readOnly: boolean; description?: string }>;
      // --- app discovery (sub-project 3) ---
      /**
       * A discovered app this call enables: its candidate reference, name and where it was found.
       * Always a write, asked about by the app's name; the source is for the card and the row.
       */
      enable?: { candidate: string; name: string; source: string };
      // --- end app discovery ---
    },
    run: (address?: string) => Promise<T>,
  ): Promise<T> {
    const { ref, filePath, snapshotId } = subject;
    // Loaded from the store, not this process's memory: the snapshot these refs belong to was very
    // likely taken by another replica, and resolving against a local map would find nothing there.
    const stored = await snapshots.load(botId);
    /*
     * LOCATE FIRST, THEN ASK WHICH RUN THAT WAS. The order is the check.
     *
     * On the supervisor, `sessionOf` answers with what the last `/ensure` reported, and until this
     * action has made its own, the last one belongs to the action before it. Asking first compared
     * the stored snapshot against the previous action's run, which is the same run on every action
     * but the first one after a replacement — exactly the action the check exists to catch. The
     * click after a replaced container was allowed and the one after that refused, which is a
     * guarantee arriving one action too late. The shared provider has no `/ensure` to read back, so
     * there it is a live `/run` call of its own — one extra round trip per ref-citing action —
     * which asks after `locate` for the same reason even though `locate` there is a string.
     *
     * Only for an action that cites a ref. Nothing else is resolved against a snapshot, so nothing
     * else needs the run, and a scroll or a file read should not have to reach the supervisor before
     * the policy has even seen it. The address that comes back is the one the attempt then uses, so
     * on the supervisor this costs no extra call for the actions that do need it.
     */
    const address = ref ? await locateForAction(botId) : undefined;
    const { session } = ref ? await sessionOf(botId) : { session: undefined };
    const element = resolve(stored, ref, snapshotId, session);
    // For a navigation the relevant page is the one being opened, not the one already loaded. Using
    // the stored URL would mean `page.host == "..."` could never match the destination, which is the
    // only thing a rule about navigation would ever want to say.
    // A desktop read is not about the browser: its row and rules never see the page last browsed.
    const pageUrl = toolName.startsWith("computer_desktop_")
      ? ""
      : (subject.targetUrl ?? stored?.url ?? "");

    const intent = intentOf(toolName, subject.key);
    // Which app and tool, on every row this action writes; never the arguments.
    const appRow = subject.app
      ? { app: { name: subject.app.name, tool: subject.app.tool } }
      : // --- app discovery (sub-project 3) ---
        subject.enable
        ? { app: { name: subject.enable.name, source: subject.enable.source } }
        : // --- end app discovery ---
          {};
    // --- desktop control (sub-project 2) ---
    // Which window, by its title and process; never what was read from it.
    const desktopRow = subject.desktop
      ? {
          desktop: {
            windowId: subject.desktop.windowId,
            title: subject.desktop.title,
            process: subject.desktop.process,
            screenshot: subject.desktop.screenshot,
          },
        }
      : {};
    // --- end desktop control ---

    /*
     * Every field is bound, present or not.
     *
     * A missing one is not an absent field to CEL, it is an unknown identifier, and cel-js throws on
     * those. A thrown deny rule counts as a match, on purpose, so that a mistyped deny refuses rather
     * than quietly permitting. Together those two correct behaviours produced a wrong one: a rule
     * naming a field this action does not have refused the action.
     *
     * `deny: contains(command, "rm -rf")` is the example the docs give, and while `command` was
     * spread in only for a shell call, that rule threw on every click, keypress, navigation and file
     * read in the deployment and refused all of them. So did any rule naming `key`, `file` or
     * `element` from an action that has none.
     *
     * Neutral rather than absent: `contains("", "rm -rf")` is false, which is the honest answer to
     * "is this click running rm -rf". The audit row below still omits what did not happen, because a
     * trail should not claim a click had a command.
     */
    const context: PolicyContext = {
      tool: { name: toolName },
      bot: { id: botId },
      actor: { id: actor.id },
      page: { url: pageUrl, host: hostOf(pageUrl) },
      ...(intent ? { intent } : {}),
      key: subject.key ?? "",
      element: element
        ? {
            ref: element.ref,
            role: element.role,
            name: element.name,
            type: element.type ?? "",
          }
        : { ref: "", role: "", name: "", type: "" },
      file: filePath
        ? describeFile(filePath)
        : { path: "", name: "", extension: "" },
      command: subject.command ?? "",
      initiator: policyInitiator(actor.initiator),
      // Neutral, like the fields above: this is not an MCP call, but a `deny: mcp.effect == "write"`
      // names `mcp`, and cel-js throws on an unbound identifier — which fails closed and would refuse
      // every browser action the moment an operator wrote a rule about their tools. Empty server and
      // tool and an empty effect match no MCP rule, so a boundary drawn around MCP leaves the browser
      // alone. The MCP context carries the browser fields empty for the mirror of this reason.
      mcp: { server: "", tool: "", effect: "" },
    };

    const decision = evaluateActionPolicy(options.policy(), context);
    /*
     * Which of the tenant's machines this is carried out on, asked once for both the row below and
     * the approval gate. A resolver that fails is not "this deployment's container": in device mode
     * the action can only go to a machine, so the gate is told it is one (SEC1 D5, fail closed).
     */
    const target =
      subject.device ??
      (options.resolveDevice
        ? await options.resolveDevice(botId).catch(() => "unknown" as const)
        : null);
    /*
     * A person has the wheel of this Bot's browser on this machine: refused here, before the approval
     * gate and before `run`, so nothing reaches the device at all (F2 stage 2).
     *
     * Not a policy verdict, and the row says so by naming its own rule. Nothing about the action is
     * wrong; it is the wrong moment for the Bot to act, which is why the Bot is handed the same
     * "a person has control" the container's computer answers with, and its turn waits for the
     * handback instead of failing.
     */
    if (
      target &&
      target !== "unknown" &&
      options.deviceTakeovers?.blocks(target, botId)
    ) {
      const handoff = options.deviceTakeovers.current(target, botId);
      await write(auditStore, {
        toolName,
        botId,
        actor,
        element,
        ref,
        ...(subject.key ? { key: subject.key } : {}),
        ...(subject.command ? { command: subject.command } : {}),
        filePath,
        pageUrl,
        decision: {
          allowed: false,
          mode: decision.mode,
          matched: DEVICE_TAKEOVER_RULE,
          source: "deny",
          forward: false,
          reason: DEVICE_HUMAN_HAS_CONTROL,
        },
        device: target.deviceId,
      });
      throw new HumanHasControlError(
        DEVICE_HUMAN_HAS_CONTROL,
        handoff?.id,
        handoff,
      );
    }
    /*
     * The coworker's current project cannot be used here (story RES2, D9): refused and recorded with
     * the reason, before the approval gate, and never redirected to the workspace.
     */
    if (subject.refusal) {
      await write(auditStore, {
        toolName,
        botId,
        actor,
        element,
        ref,
        ...(subject.command ? { command: subject.command } : {}),
        filePath,
        pageUrl,
        decision: {
          allowed: false,
          mode: decision.mode,
          matched: subject.refusalRule ?? PROJECT_UNAVAILABLE_RULE,
          source: "deny",
          forward: false,
          reason: subject.refusal,
        },
        refusal: subject.refusal,
        device: target && target !== "unknown" ? target.deviceId : null,
        ...appRow,
        // --- desktop control (sub-project 2) ---
        ...desktopRow,
        // --- end desktop control ---
      });
      throw new ActionRefusedError(
        subject.refusal,
        subject.refusalRule ?? PROJECT_UNAVAILABLE_RULE,
      );
    }
    await write(auditStore, {
      toolName,
      botId,
      actor,
      element,
      ref,
      ...(subject.key ? { key: subject.key } : {}),
      ...(subject.command ? { command: subject.command } : {}),
      filePath,
      pageUrl,
      decision,
      /*
       * Which of the tenant's machines this was carried out on, when that is a machine and not one of
       * this deployment's containers (ticket 017).
       *
       * Asked of the same resolver the dispatch uses and read leniently: a row that named a device the
       * person could not see would be worse than one that omits it, and the refusal for an unreachable
       * machine is already in the outcome of the action itself.
       */
      device: target && target !== "unknown" ? target.deviceId : null,
      ...appRow,
      // --- desktop control (sub-project 2) ---
      ...desktopRow,
      // --- end desktop control ---
    });
    if (!decision.forward) {
      throw new ActionRefusedError(decision.reason, decision.matched);
    }

    let result: T;
    try {
      /*
       * A citation that was made and could not be honoured is refused, not carried out.
       *
       * `resolve` answering undefined leaves the element half of the context all-empty, and empty is
       * the honest neutral value for an action that names no element: it is what stops a rule about
       * one action surface throwing on another. It is the wrong answer for an action that named a ref
       * and did not get one. Every element-keyed rule then evaluates against empty strings, so a deny
       * that exists to stop this exact click does not match, the shipped default permits, and the
       * click lands on whatever that ref is now. The rule did not decline to match. It was never
       * shown the element.
       *
       * The computer's own staleness check does not make this safe. It compares the citation against
       * its own counter, so it catches the cases where the two disagree; the case that matters is the
       * one where the computer is content and only this server is out of step, which is what a
       * computer restarting its generation counter under a stored row leaves behind.
       *
       * Only a cited ref, and only against a snapshot this server actually holds. Scroll, a
       * page-level keypress, a shell call and a file read name no element, so they have nothing to
       * have failed to resolve. A computer this server has no snapshot for at all is a different
       * situation: there is no page here to judge the citation against, the computer is the only
       * party that can, and refusing locally would take its answer away, including the one that says
       * a person has taken the wheel. What is refused here is a citation this server can see is stale.
       *
       * Thrown from inside the attempt, after the decision row, on purpose: an action whose ref
       * resolves to nothing is still an action somebody tried to take, and refusing it before the row
       * was written would be a way to act without appearing on the trail. The failure row beside it is
       * what stops the trail claiming a permitted action was carried out when nothing was sent.
       */
      if (ref && stored && !element) {
        throw new StaleSnapshotError(
          `${ref} is not on the page this computer is showing, so nothing can be checked against it before acting. Take a fresh snapshot and use the refs it returns.`,
        );
      }
      const continuation = currentApprovalContext();
      /*
       * A local app's tool list is fetched here and no earlier: fetching it starts the app on the
       * person's machine, so a call already refused (a takeover, the policy above, a disabled tool or
       * the team's cap of `never`) must not get as far as starting it.
       */
      let app = subject.app;
      if (app && subject.resolveApp) {
        const refused = await options.approvalRefusal?.({
          actorId: actor.id,
          botId,
          toolRef: toolName,
          effect: "write",
          scope: `${app.name}/${app.tool}`,
          args: continuation?.args ?? {},
          subject: { runner: target !== null },
          ...(continuation ? { continuation } : {}),
        });
        if (refused) throw new ApprovalRefusedError(refused);
        app = { ...app, ...(await subject.resolveApp()) };
      }
      const approval = await options.approvalGate?.({
        actorId: actor.id,
        botId,
        toolRef: toolName,
        effect: app
          ? app.readOnly === true
            ? "read"
            : "write"
          : ["activate", "type", "write_file", "run_command"].includes(
                intent ?? "",
              )
            ? "write"
            : "read",
        /*
         * A local app's tool is its own target, so a rule or an "always allow" names one tool of one
         * app rather than every tool the app has.
         */
        // --- desktop control (sub-project 2): a window by its process, the listing as `desktop` ---
        scope: subject.desktop
          ? `desktop/${subject.desktop.process}`
          : toolName === "computer_desktop_windows"
            ? "desktop"
            : // --- end desktop control ---
              app
              ? `${app.name}/${app.tool}`
              : filePath
                ? filePath.split("/").slice(0, -1).join("/") || "workspace"
                : subject.command
                  ? "workspace"
                  : hostOf(pageUrl) || "browser",
        ...(app?.description
          ? { display: { description: app.description } }
          : {}),
        args: continuation?.args ?? {
          ...subject,
          signal: undefined,
          device: undefined,
          refusal: undefined,
          refusalRule: undefined,
          app: undefined,
          resolveApp: undefined,
          // --- app discovery (sub-project 3) ---
          enable: undefined,
          // --- end app discovery ---
          // --- desktop control (sub-project 2) ---
          desktop: undefined,
          // --- end desktop control ---
        },
        /*
         * A local app's tool is named by the app and the tool alone. Its description is for the card
         * only (`display`): the device reports it afresh each time, and not at all while it is away,
         * so it is not part of the action an approval binds.
         */
        // --- desktop control (sub-project 2): the window's title and process, never its contents ---
        target: subject.desktop
          ? {
              window: {
                title: subject.desktop.title,
                process: subject.desktop.process,
              },
              screenshot: subject.desktop.screenshot,
            }
          : // --- end desktop control ---
            app
            ? { app: app.name, tool: app.tool }
            : {
                pageUrl,
                ...(element ? { element, snapshotId } : {}),
                ...(filePath ? { filePath } : {}),
              },
        /*
         * What this call will actually run and touch, from this call site rather than from the
         * model's arguments, for the gate's dangerous-command and sensitive-path floors and the
         * team's host-command cap on a paired machine (SEC1 §4.3, §4.4, D5).
         */
        subject: {
          ...(subject.command !== undefined
            ? { command: subject.command }
            : {}),
          ...(filePath !== undefined ? { path: filePath } : {}),
          runner: target !== null,
          // The device-list verdict for a local app's tool, for the app-tool floor (§4.4).
          ...(app ? { appTool: { readOnly: app.readOnly === true } } : {}),
          // --- desktop control (sub-project 2) ---
          // The window's title and the word it matched, for the desktop-window floor (§4.2).
          ...(subject.desktop
            ? {
                desktop: {
                  title: subject.desktop.title,
                  ...(subject.desktop.sensitiveWord
                    ? { sensitiveWord: subject.desktop.sensitiveWord }
                    : {}),
                },
              }
            : {}),
          // --- end desktop control ---
        },
        // --- app discovery (sub-project 3) ---
        /*
         * Enabling a discovered app: a write on the owner's machine, named by the app. The candidate
         * is part of the action an approval binds; where it was found is for the card only.
         */
        ...(subject.enable
          ? {
              effect: "write",
              scope: subject.enable.name,
              display: { description: subject.enable.source },
              target: {
                candidate: subject.enable.candidate,
                name: subject.enable.name,
              },
              subject: { runner: true },
            }
          : {}),
        // --- end app discovery ---
        continuation,
      });
      /*
       * Where this action's outcome belongs if it has to wait for a machine that is away: the run's
       * own conversation, held by the server, never the model's arguments.
       */
      const origin = continuation?.threadId
        ? {
            botId,
            actorId: actor.id,
            threadId: continuation.threadId,
            ...(continuation.toolCallId
              ? { toolCallId: continuation.toolCallId }
              : {}),
          }
        : undefined;
      result =
        approval && "replay" in approval
          ? (approval.replay as T)
          : origin
            ? await computerActionOrigin.run(origin, () => run(address))
            : await run(address);
      await approval?.complete(
        toolName === "computer_desktop_snapshot"
          ? snapshotForStorage(result as { image?: unknown })
          : result,
      );
    } catch (error) {
      if (error instanceof HeadlessToolSuspension) throw error;
      /**
       * A permitted action that did not happen gets its own row.
       *
       * Without this the trail lies by omission. The row above says the policy allowed the call, and
       * a reader takes "allowed" to mean "it happened".
       *
       * Writing the decision before acting is still right, because an allowed action may have partial
       * effects before failing. The failure row records the outcome separately from the policy
       * decision.
       *
       * It carries the same subject the decision row did, and for the same reasons: a shell call
       * that failed part-way is the row somebody most needs to name the command from, and a keypress
       * that failed is still the difference between a submitted form and a typed letter. Leaving
       * them off also chose the wrong element branch below, because "this action never had an
       * element" is decided by the command and the file path — so a failed command claimed a
       * snapshot lookup that never happened.
       */
      await write(auditStore, {
        toolName,
        botId,
        actor,
        element,
        ref,
        ...(subject.key ? { key: subject.key } : {}),
        ...(subject.command ? { command: subject.command } : {}),
        filePath,
        pageUrl,
        decision,
        failure: error instanceof Error ? error.message : "The action failed.",
        ...appRow,
        // --- desktop control (sub-project 2) ---
        ...desktopRow,
        // --- end desktop control ---
        // A person pressing Stop mid-action is not the computer failing. The message still says so;
        // this keeps the row's type a stop, so a count of failed actions does not read every Stop as
        // an outage.
        ...(error instanceof ComputerStoppedError ? { stopped: true } : {}),
      });
      throw error;
    }
    // The element's label, attached on the way out, so the transcript can say what was acted on
    // instead of quoting a ref. The computer cannot supply this: it knows the ref, and the resolved
    // snapshot lives here. File calls carry their own path already, so there is nothing to add.
    return element && result && typeof result === "object"
      ? { ...result, element: { role: element.role, name: element.name } }
      : result;
  }

  /**
   * A read or a listing in one of the person's read-only folders (story F1, stage 2).
   *
   * The folder is resolved first, and an unknown one is refused before anything is decided or sent:
   * there is no machine to name on a row and nothing to ask about. A known one goes through `govern`
   * like every other file call, with the path the policy, the row and the approval gate see written
   * as `<root>/<path>`. So the SEC1 sensitive-path floor matches a `.env` inside a folder exactly as it
   * matches one in the workspace, an approval for a workspace folder does not cover a local one, and
   * the row says which folder was read. Only the two reads exist: nothing here writes.
   */
  async function inFolder<T>(
    toolName: "computer_read_file" | "computer_list_files",
    botId: string,
    actor: ActionActor,
    root: string,
    path: string | undefined,
    route: "/files/read" | "/files/list",
  ): Promise<T> {
    const machine =
      typeof root === "string" && options.folders
        ? await options.folders.resolve(botId, actor.id, root)
        : null;
    if (!options.folders || !machine) {
      throw new ComputerUnavailableError(
        "That folder is not one of the person's shared folders, or it is no longer shared. Only the folders listed in your information sources can be read.",
      );
    }
    const relative = path?.trim() ? path : ".";
    const transport = options.folders.transport;
    return govern(
      toolName,
      botId,
      actor,
      { filePath: `${root}/${relative}`, device: machine },
      () =>
        transport.post<T>(
          runnerAddress(machine),
          botId,
          route,
          { root, ...(path === undefined ? {} : { path }) },
          undefined,
          undefined,
          computerActionIdentity.getStore()
            ? JSON.stringify([
                botId,
                route,
                root,
                computerActionIdentity.getStore(),
              ])
            : undefined,
        ),
    );
  }

  /**
   * The project a file or shell call of this coworker runs in, or null for its workspace (story RES2).
   * Only once the machine is known; a resolver that fails is left to the ordinary path, which fails
   * the same way for every other call.
   */
  async function projectOf(botId: string) {
    if (!options.projects || !options.resolveDevice) return null;
    const machine = await options.resolveDevice(botId).catch(() => null);
    if (!machine) return null;
    const root = await options.projects.resolve(botId, machine);
    return root ? { machine, root } : null;
  }

  /**
   * One file or shell call in the coworker's current project (story RES2, spec §3.5).
   *
   * The frame is built here: every field of the model's arguments that could name a folder (`root`,
   * `writable`, `cwd`) is dropped, and the project's root, and `writable` for a write, are written
   * in. The path the policy, the row and the approval gate see is `<root>/<path>`, so the SEC1
   * sensitive-path floor and a workspace approval apply as they do anywhere, and a dangerous command
   * is held exactly as in the workspace. A read-only project refuses a write or a command here,
   * recorded, before the machine is asked; the runner would refuse it too.
   */
  async function inProject<T>(
    toolName: string,
    botId: string,
    actor: ActionActor,
    project: NonNullable<Awaited<ReturnType<typeof projectOf>>>,
    route: "/files/read" | "/files/list" | "/files/write" | "/exec",
    payload: object,
    subject: { filePath?: string; command?: string; signal?: AbortSignal },
    writes: boolean,
    timeoutMs?: number,
  ): Promise<T> {
    const { machine, root } = project;
    const refusal = !root.ok
      ? root.reason
      : writes && !root.writable
        ? READ_ONLY_PROJECT
        : undefined;
    const filePath =
      subject.filePath === undefined
        ? undefined
        : root.ok
          ? `${root.rootRef}/${subject.filePath}`
          : subject.filePath;
    return govern(
      toolName,
      botId,
      actor,
      {
        ...(filePath !== undefined ? { filePath } : {}),
        ...(subject.command !== undefined ? { command: subject.command } : {}),
        ...(subject.signal ? { signal: subject.signal } : {}),
        device: machine,
        ...(refusal ? { refusal } : {}),
      },
      () => {
        if (!root.ok)
          throw new ActionRefusedError(root.reason, PROJECT_UNAVAILABLE_RULE);
        const {
          root: _root,
          writable: _writable,
          cwd: _cwd,
          ...rest
        } = payload as Record<string, unknown>;
        return transport.post<T>(
          runnerAddress(machine),
          botId,
          route,
          {
            ...rest,
            root: root.rootRef,
            ...(writes ? { writable: true } : {}),
          },
          subject.signal,
          timeoutMs,
          computerActionIdentity.getStore()
            ? JSON.stringify([
                botId,
                route,
                root.rootRef,
                computerActionIdentity.getStore(),
              ])
            : undefined,
        );
      },
    );
  }

  /**
   * The device's own tool lists, per tenant, machine and app (`tenant/device/ref`), kept five minutes
   * (device MCP bridge §3.4). This is what the approval decision reads; a list that is not here and
   * cannot be fetched counts as "not read-only".
   */
  const appTools = new Map<string, { tools: AppTool[]; at: number }>();
  const now = options.now ?? Date.now;

  /**
   * The machine this Bot's local apps are on, and the apps it reported. Refuses a Bot with none, and
   * anyone but its owner: the machine is the owner's (its tenant is the owner's own), and so are the
   * apps on it. The tools are not offered to anyone else either; this is the second lock.
   */
  async function appsOf(botId: string, actor: ActionActor) {
    if (!options.resolveDevice || !options.deviceApps) {
      throw new ComputerUnavailableError(NO_LOCAL_APPS);
    }
    const machine = await options.resolveDevice(botId);
    if (!machine) throw new ComputerUnavailableError(NO_LOCAL_APPS);
    if (machine.tenantId !== actor.id)
      throw new ActionRefusedError(OWNER_ONLY, APP_UNAVAILABLE_RULE);
    return { machine, apps: await options.deviceApps(machine) };
  }

  /**
   * One app's tools, asked of the machine itself. Only while the machine is connected: the runner
   * transport sends a listing straight to the socket, never through the queue. An answer that is not
   * a list (a queued receipt, anything malformed) is "no list": thrown, and never cached.
   */
  async function fetchAppTools(
    machine: { tenantId: string; deviceId: string },
    botId: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<AppTool[]> {
    const output = await transport.post<unknown>(
      runnerAddress(machine),
      botId,
      "/apps/tools",
      { app: ref },
      signal,
      APP_LIST_BACKSTOP_MS,
    );
    const listed =
      output && typeof output === "object" && !("queued" in output)
        ? (output as { tools?: unknown }).tools
        : undefined;
    if (!Array.isArray(listed))
      throw new ComputerUnavailableError(
        "设备没有返回这个本机应用的工具列表。",
      );
    const tools = readAppTools(listed);
    const key = `${machine.tenantId}/${machine.deviceId}/${ref}`;
    appTools.delete(key);
    appTools.set(key, { tools, at: now() });
    // Insertion order is age order: the oldest entries go first once there are too many.
    for (const old of appTools.keys()) {
      if (appTools.size <= APP_TOOLS_CACHE_LIMIT) break;
      appTools.delete(old);
    }
    return tools;
  }

  /** The cached list when it is fresh, otherwise a fresh one; undefined when it cannot be had. */
  async function appToolsFor(
    machine: { tenantId: string; deviceId: string },
    botId: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<AppTool[] | undefined> {
    const cached = appTools.get(
      `${machine.tenantId}/${machine.deviceId}/${ref}`,
    );
    if (cached && now() - cached.at < APP_TOOLS_TTL_MS) return cached.tools;
    try {
      return await fetchAppTools(machine, botId, ref, signal);
    } catch (error) {
      // The person's Stop is a stop, and a paused device is paused: neither is a missing list to ask
      // about, and the model is told which it was.
      if (signal?.aborted || error instanceof DeviceDeliveryError) throw error;
      return undefined;
    }
  }

  // --- app discovery (sub-project 3) ---
  /** What each machine's last listing found, for the enable that follows it. */
  const candidates = createCandidateCache(now);

  /** The apps the machine could offer and the software it has no app for. Never fails the listing. */
  async function discoverGroups(
    machine: { tenantId: string; deviceId: string },
    botId: string,
    apps: { name: string }[],
    signal?: AbortSignal,
  ): Promise<Partial<ListAppsResult>> {
    try {
      const read = readDiscovery(
        await transport.post<unknown>(
          runnerAddress(machine),
          botId,
          "/apps/discover",
          {},
          signal,
          DISCOVER_BACKSTOP_MS,
        ),
      );
      if (!read)
        return { discoveryError: DISCOVERY_FAILED("没有收到有效的回答") };
      candidates.remember(machine, read.candidates);
      const groups = discoveryGroups(
        read,
        apps.map((app) => app.name),
      );
      if (!groups.available.length && !groups.installed.length) return {};
      return {
        ...(groups.available.length ? { available: groups.available } : {}),
        ...(groups.installed.length ? { installed: groups.installed } : {}),
        hints: { available: AVAILABLE_HINT, installed: INSTALLED_HINT },
      };
    } catch (error) {
      // Only the person's Stop ends the call. Anything else (a paused device included) is said in
      // `discoveryError` and leaves the listed apps as they are.
      if (signal?.aborted) throw error;
      // The reason may come from the device: cut it.
      const reason = cutUtf8(error instanceof Error ? error.message : "", 200);
      return {
        discoveryError: reason.startsWith("Nothing on this machine handles")
          ? OLD_RUNNER
          : DISCOVERY_FAILED(reason || "原因不明"),
      };
    }
  }

  /**
   * One candidate as the machine's config says now, asked of the machine when no listing here still
   * holds it. Undefined: the machine does not know it (expired, or never issued). A failure to ask
   * is a refusal with the reason, cut; only the person's Stop is thrown as it is.
   */
  async function lookUpCandidate(
    machine: { tenantId: string; deviceId: string },
    botId: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<
    { found?: DiscoveredCandidate & { enabled: boolean } } | { refusal: string }
  > {
    try {
      const read = readDiscovery(
        await transport.post<unknown>(
          runnerAddress(machine),
          botId,
          "/apps/discover",
          { candidate: ref },
          signal,
          DISCOVER_BACKSTOP_MS,
        ),
      );
      if (!read) return { refusal: DISCOVERY_FAILED("没有收到有效的回答") };
      return {
        found: read.candidates.find((candidate) => candidate.candidate === ref),
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof DeviceOfflineError)
        return { refusal: DEVICE_OFFLINE_ENABLE };
      const reason = cutUtf8(error instanceof Error ? error.message : "", 200);
      return {
        refusal: reason.startsWith("Nothing on this machine handles")
          ? OLD_RUNNER
          : DISCOVERY_FAILED(reason || "原因不明"),
      };
    }
  }

  /** A tool list the machine just gave, kept as `fetchAppTools` keeps one. */
  function keepAppTools(
    machine: { tenantId: string; deviceId: string },
    ref: string,
    tools: AppTool[],
  ) {
    const key = `${machine.tenantId}/${machine.deviceId}/${ref}`;
    appTools.delete(key);
    appTools.set(key, { tools, at: now() });
    for (const old of appTools.keys()) {
      if (appTools.size <= APP_TOOLS_CACHE_LIMIT) break;
      appTools.delete(old);
    }
  }
  // --- end app discovery ---

  return {
    provider,
    locate,
    screenshot,
    snapshot,
    read,
    // --- desktop control (sub-project 2) ---
    ...createDesktopMethods({
      resolveDevice: options.resolveDevice,
      approvalRefusal: options.approvalRefusal,
      hasApprovalGate: options.approvalGate !== undefined,
      govern,
      post,
      windows: createDesktopWindowCache({ now }),
    }),
    // --- end desktop control ---

    /*
     * `appsOf`'s own preconditions, as a yes or no: device mode (a machine to resolve and its apps to
     * read), and the machine this Bot resolves to is the asker's own. Anything that fails, a Bot with
     * no paired machine included, is no.
     */
    async localToolsAllowed(botId: string, actor: ActionActor) {
      if (!options.resolveDevice || !options.deviceApps) return false;
      try {
        const machine = await options.resolveDevice(botId);
        return !!machine && machine.tenantId === actor.id;
      } catch {
        return false;
      }
    },

    machine() {
      return options.resolveDevice ? "device" : "workspace";
    },

    status(botId: string): Promise<ComputerStatus> {
      return provider.status(botId);
    },

    /**
     * Handovers, recorded but not policy-gated.
     *
     * The policy constrains what a Bot may do. A person taking the wheel is the escape hatch that
     * makes a governed Bot usable at all, and a rule able to lock somebody out of their own browser
     * halfway through a login would be a worse failure than anything it prevented. So these write the
     * row and do not ask. What IS recorded is the period: who, when, and why the Bot asked, the fact
     * an investigator wants is that a human drove this browser between two times.
     */
    async requestHelp(
      botId: string,
      actor: ActionActor,
      reason: string,
      toolCallId?: string,
    ) {
      const device = await takeoverTarget(botId);
      const state = device
        ? (options.deviceTakeovers as DeviceTakeovers).request(
            device,
            botId,
            reason,
            toolCallId ? "model" : "manual",
            toolCallId,
          )
        : await post<ControlState>(botId, "/control/request", {
            reason,
            ...(toolCallId ? { toolCallId } : {}),
          });
      await writeControlEvent(auditStore, "computer.help_requested", {
        botId,
        actor,
        reason,
      });
      return state;
    },

    async takeControl(botId: string, actor: ActionActor, requestId: string) {
      const device = await takeoverTarget(botId);
      const state = device
        ? (options.deviceTakeovers as DeviceTakeovers).take(
            device,
            botId,
            actor.id,
            requestId,
          )
        : await post<ControlState>(botId, "/control/take", {
            requestId,
          });
      await writeControlEvent(auditStore, "computer.control_taken", {
        botId,
        actor,
        // Carried onto the row so the trail says what the person was handed, not merely that they
        // took over.
        reason: state.reason,
      });
      return state;
    },

    async releaseControl(botId: string, actor: ActionActor, requestId: string) {
      const device = await takeoverTarget(botId);
      const state = device
        ? (options.deviceTakeovers as DeviceTakeovers).release(
            device,
            botId,
            requestId,
          )
        : await post<ControlState>(botId, "/control/release", {
            requestId,
          });
      await writeControlEvent(auditStore, "computer.control_released", {
        botId,
        actor,
      });
      return state;
    },

    async cancelControl(botId: string, actor: ActionActor, requestId: string) {
      const device = await takeoverTarget(botId);
      const state = device
        ? (options.deviceTakeovers as DeviceTakeovers).cancel(
            device,
            botId,
            requestId,
          )
        : await post<ControlState>(botId, "/control/cancel", {
            requestId,
          });
      await writeControlEvent(auditStore, "computer.help_cancelled", {
        botId,
        actor,
      });
      return state;
    },

    async control(botId: string, requestId?: string): Promise<ControlState> {
      const device = await takeoverTarget(botId);
      if (device)
        return (options.deviceTakeovers as DeviceTakeovers).state(
          device,
          botId,
          requestId,
        );
      return get<ControlState>(
        botId,
        `/control${requestId ? `?requestId=${encodeURIComponent(requestId)}` : ""}`,
      );
    },

    /** Return every computer that the configured provider owns. */
    async computers() {
      const computers = await provider.list();
      return {
        isolation: provider.isolation,
        computers: computers.map((computer) => ({
          botId: computer.botId,
          running: computer.status === "running",
          startedAt: computer.startedAt ?? null,
          egress: computer.egress,
          ...(computer.updateAvailable !== undefined
            ? { updateAvailable: computer.updateAvailable }
            : {}),
        })),
      };
    },

    /**
     * Stop a computer's browser, keeping what it knows.
     *
     * Audited, unlike the read above, because a person reached in and stopped something. Recorded
     * whether or not a browser was actually running: "she pressed stop and nothing was running" is a
     * fact worth having, and a trail that only records effective actions cannot tell you what somebody
     * tried.
     */
    async stopComputer(botId: string, actor: ActionActor) {
      const result = await provider.stop(botId);
      await writeControlEvent(auditStore, "computer.stopped", {
        botId,
        actor,
        reason: result.wasRunning
          ? "the computer was stopped"
          : "the computer was already stopped",
      });
      return result;
    },

    /**
     * Wipe a computer's profile.
     *
     * The most destructive button we have. Every login the Bot had is gone and no undo exists, so the
     * row is written whatever happens next.
     */
    /**
     * Move a computer onto the image this deployment now runs.
     *
     * Only a provider that can say a computer is out of date offers it. The row is written for a
     * computer that was already current too, so the trail shows the button was pressed.
     */
    async updateComputer(botId: string, actor: ActionActor) {
      if (!provider.update) {
        throw new ComputerUnavailableError(
          `The ${provider.name} computer provider has no computer image of its own to update.`,
        );
      }
      const result = await provider.update(botId);
      await writeControlEvent(auditStore, "computer.updated", {
        botId,
        actor,
        reason: !result.updated
          ? "the computer was already on the current image, or had none"
          : result.wasRunning
            ? `the computer is restarting on ${result.to}, keeping its files and sign-ins`
            : `the computer will start on ${result.to} when it is next used`,
      });
      return result;
    },

    async resetComputer(botId: string, actor: ActionActor) {
      const result = await provider.reset(botId);
      /*
       * The row goes in HERE, before the two deletes below, because this line is the point of no
       * return: the profile is already gone and nothing after it can put the logins back.
       *
       * Both clears are Postgres deletes, and a connection reset, a failover or a statement timeout
       * in either used to throw before the row was written -- leaving a computer wiped with nothing
       * on the trail to say who wiped it, which is the one outcome the note above rules out. The
       * failure still propagates, so the caller is told the clears did not finish.
       */
      await writeControlEvent(auditStore, "computer.reset", {
        botId,
        actor,
        reason: result.cleared
          ? "the computer and its saved state were deleted"
          : "no saved state was present to delete",
      });
      // The refs the last snapshot handed out describe a page that no longer exists, and a fresh
      // computer counts generations from one again, so the row has to go with the profile.
      await snapshots.clear(botId);
      /*
       * And the pictures, which are the part that made the promise above untrue.
       *
       * "Every login the Bot had is gone" was said while screenshots of the signed-in pages stayed
       * in the database: an inbox, an admin console, a bank statement, still readable from the
       * transcript by anybody who could reach that Bot. A reset that leaves those has not reset
       * anything a person would recognise as private.
       */
      await pageFrames?.clear(botId);
      return result;
    },

    /**
     * Asking for a secret, and supplying one.
     *
     * Both are audited, and neither records the value. The row says a secret was asked for, what it
     * was called, and which field it went in, the things an investigator needs in order to know a
     * human credential entered this session. The value itself is on one path only, from a person's
     * keyboard to the page, and is not on this one.
     */
    async requestSecret(
      botId: string,
      actor: ActionActor,
      input: SecretRequest,
    ) {
      const state = await post<ControlState>(botId, "/control/secret", input);
      await writeControlEvent(auditStore, "computer.secret_requested", {
        botId,
        actor,
        reason: `${input.label} (into ${input.ref})`,
      });
      return state;
    },

    /**
     * Typing a person's login into the Bot's browser, from the private sign-in form.
     *
     * The credential arrives from the passwords module and goes straight to the computer. It is not
     * audited here, not returned, and not logged; the passwords module writes the row, without it.
     */
    signIn(botId: string, input: SignInFillInput, signal?: AbortSignal) {
      return post<SignInFillResult>(
        botId,
        "/sign-in/fill",
        input,
        signal,
        SIGN_IN_BACKSTOP_MS,
      );
    },

    /** The code a site asked for once the password was in, on the same path and terms as the login. */
    signInCode(botId: string, input: SignInCodeInput, signal?: AbortSignal) {
      return post<SignInCodeResult>(
        botId,
        "/sign-in/code",
        input,
        signal,
        SIGN_IN_BACKSTOP_MS,
      );
    },

    async supplySecret(botId: string, actor: ActionActor, text: string) {
      const result = await post<SecretResult>(botId, "/human/secret", { text });
      await writeControlEvent(auditStore, "computer.secret_supplied", {
        botId,
        actor,
        // Length, never content. Enough to show something real was entered.
        reason: `${result.characters} characters`,
      });
      return result;
    },

    async humanInput(
      botId: string,
      input: HumanInput,
    ): Promise<HumanInputResult> {
      const { kind, ...payload } = input;
      /*
       * Checked here as well as at the route, because this is where it becomes a path.
       *
       * `kind` is typed as one of four gestures and a type is not a check: the route casts a parsed
       * body to this shape, so whatever arrived is whatever the caller sent. Interpolated into the
       * path below, a value like `../exec` reaches a different endpoint of the computer's API
       * altogether, carrying this deployment's computer token. This method is also the one acting
       * path that writes no audit row, deliberately, so a call that went somewhere else leaves
       * nothing behind that would say so.
       */
      if (!HUMAN_GESTURES.has(kind)) {
        throw new Error(
          `A person's input is one of ${[...HUMAN_GESTURES].join(", ")}, not ${JSON.stringify(kind)}.`,
        );
      }
      return post<HumanInputResult>(botId, `/human/${kind}`, payload);
    },

    /**
     * Opening a page, through the gateway so it lands in the audit trail.
     *
     * The transport applies its target guard before it sends a request. This is
     * the minimum rule that applies even when the action policy permits the URL.
     */
    navigate(
      botId: string,
      actor: ActionActor,
      url: string,
      toolCallId?: string,
    ) {
      return govern(
        "computer_navigate",
        botId,
        actor,
        { targetUrl: url },
        async () =>
          transport.navigate(
            await locate(botId),
            botId,
            url,
            toolCallId ?? computerActionIdentity.getStore(),
          ),
      ).then((result) => withUntrustedNotice(result, "web page", PAGE_FIELDS));
    },

    click(
      botId: string,
      actor: ActionActor,
      input: ClickInput,
      signal?: AbortSignal,
    ) {
      return govern(
        "computer_click",
        botId,
        actor,
        {
          ref: input.ref,
          snapshotId: input.snapshotId,
          ...(signal ? { signal } : {}),
        },
        (address) =>
          post<ActionResult>(
            botId,
            "/click",
            input,
            signal,
            undefined,
            address,
          ),
      );
    },

    type(
      botId: string,
      actor: ActionActor,
      input: TypeInput,
      signal?: AbortSignal,
    ) {
      return govern(
        "computer_type",
        botId,
        actor,
        {
          ref: input.ref,
          snapshotId: input.snapshotId,
          /*
           * `submit` presses Enter once the text is in, so this call is a keypress as well as a
           * typing one and the policy has to see both halves. Without the key here, an agent refused
           * on clicking the button and refused on pressing Enter types into the field with
           * `submit: true` instead, and the form goes through against a rule written to stop exactly
           * that. It is what the trail is missing too: a row with no key says a field was filled in,
           * not that the form was sent.
           */
          ...(input.submit ? { key: "Enter" } : {}),
          ...(signal ? { signal } : {}),
        },
        (address) =>
          post<ActionResult>(botId, "/type", input, signal, undefined, address),
      );
    },

    key(
      botId: string,
      actor: ActionActor,
      input: KeyInput,
      signal?: AbortSignal,
    ) {
      return govern(
        "computer_key",
        botId,
        actor,
        // The key is part of the subject, so a rule can tell Enter from a letter. Form submission can
        // happen through a keypress as well as a click, so the policy context carries the key.
        {
          ref: input.ref,
          snapshotId: input.snapshotId,
          key: input.key,
          ...(signal ? { signal } : {}),
        },
        (address) =>
          post<ActionResult>(botId, "/key", input, signal, undefined, address),
      );
    },

    scroll(botId: string, actor: ActionActor, input: ScrollInput) {
      return govern("computer_scroll", botId, actor, {}, () =>
        post<ActionResult>(botId, "/scroll", input),
      );
    },

    /**
     * The file tools, governed like everything else.
     *
     * The read is governed too, unlike reading a page. A page was permitted when it was opened; the
     * workspace accumulates whatever a Bot has saved across every task it has ever run, so which of
     * those files it may read back is a real question for a deployment to be able to answer.
     */
    async readFile(botId: string, actor: ActionActor, input: ReadFileInput) {
      if (input.root !== undefined) {
        return inFolder<ReadFileResult>(
          "computer_read_file",
          botId,
          actor,
          input.root,
          input.path,
          "/files/read",
        ).then((result) =>
          // The person's own files, but files all the same: what is in them is not an instruction.
          withUntrustedNotice(result, "local folder file", ["text"]),
        );
      }
      const project = await projectOf(botId);
      if (project) {
        return inProject<ReadFileResult>(
          "computer_read_file",
          botId,
          actor,
          project,
          "/files/read",
          input,
          { filePath: input.path },
          false,
        ).then((result) =>
          withUntrustedNotice(result, "project file", ["text"]),
        );
      }
      return govern(
        "computer_read_file",
        botId,
        actor,
        { filePath: input.path },
        () => post<ReadFileResult>(botId, "/files/read", input),
      ).then((result) =>
        // A workspace file is whatever the Bot downloaded or was sent, so it is outside content.
        withUntrustedNotice(result, "workspace file", ["text"]),
      );
    },

    /**
     * The bytes leave the workspace, which is a different permission from letting a Bot read them.
     *
     * The decision and audit row use `computer_download_file` / `download_file`; a deployment can
     * therefore allow `computer_read_file` while refusing this, or the reverse. The computer returns
     * a stream, so the size limit is enforced there before any bytes are sent.
     */
    downloadFile(
      botId: string,
      actor: ActionActor,
      input: DownloadFileInput,
      signal?: AbortSignal,
    ) {
      return govern(
        "computer_download_file",
        botId,
        actor,
        { filePath: input.path, ...(signal ? { signal } : {}) },
        async () => {
          const download = await transport.download(
            await locate(botId),
            botId,
            `/files/download?path=${encodeURIComponent(input.path)}`,
            signal,
            DOWNLOAD_BACKSTOP_MS,
          );
          return {
            ...download,
            name: describeFile(input.path).name || "download",
          };
        },
      );
    },

    /**
     * Listing is governed too, and for the same reason the read is: what a Bot has accumulated over
     * every task it has run is worth being able to restrict. A rule denying a folder hides it from the
     * listing as well as from reads, which is the consistent answer.
     */
    async listFiles(botId: string, actor: ActionActor, input: ListFilesInput) {
      if (input.root !== undefined) {
        return inFolder<ListFilesResult>(
          "computer_list_files",
          botId,
          actor,
          input.root,
          input.path,
          "/files/list",
        );
      }
      const project = await projectOf(botId);
      if (project) {
        return inProject<ListFilesResult>(
          "computer_list_files",
          botId,
          actor,
          project,
          "/files/list",
          input,
          { filePath: input.path ?? "." },
          false,
        );
      }
      return govern(
        "computer_list_files",
        botId,
        actor,
        { filePath: input.path ?? "." },
        () => post<ListFilesResult>(botId, "/files/list", input),
      );
    },

    /**
     * A command, judged before it runs.
     *
     * The same four steps as a click: resolve, decide, record, act. The policy sees the command
     * text, so a deployment can refuse a shell outright with `intent == "run_command"` or refuse
     * particular commands, and either way the attempt is a row in the trail whether or not it ran.
     */
    async runCommand(
      botId: string,
      actor: ActionActor,
      input: RunCommandInput,
      caller?: AbortSignal,
    ) {
      const project = await projectOf(botId);
      if (project) {
        return inProject<RunCommandResult>(
          "computer_run_command",
          botId,
          actor,
          project,
          "/exec",
          input,
          { command: input.command, ...(caller ? { signal: caller } : {}) },
          true,
          COMMAND_BACKSTOP_MS,
        ).then((result) =>
          withUntrustedNotice(result, "command output", ["stdout", "stderr"]),
        );
      }
      return govern(
        "computer_run_command",
        botId,
        actor,
        { command: input.command, ...(caller ? { signal: caller } : {}) },
        () =>
          post<RunCommandResult>(
            botId,
            "/exec",
            input,
            caller,
            COMMAND_BACKSTOP_MS,
          ),
      ).then((result) =>
        // What a command prints can be anything it fetched, so the output is marked.
        withUntrustedNotice(result, "command output", ["stdout", "stderr"]),
      );
    },

    async writeFile(botId: string, actor: ActionActor, input: WriteFileInput) {
      const project = await projectOf(botId);
      if (project) {
        return inProject<WriteFileResult>(
          "computer_write_file",
          botId,
          actor,
          project,
          "/files/write",
          input,
          { filePath: input.path },
          true,
        );
      }
      return govern(
        "computer_write_file",
        botId,
        actor,
        { filePath: input.path },
        () => post<WriteFileResult>(botId, "/files/write", input),
      );
    },

    /**
     * The owner's local apps on their paired machine, by name, each with the tools its machine lists
     * now (device MCP bridge §3.4). A read: governed and recorded, never asked about. An app whose
     * tools cannot be listed says why in its own entry and does not fail the others.
     */
    async listApps(
      botId: string,
      actor: ActionActor,
      input: { app?: string },
      signal?: AbortSignal,
    ) {
      const { machine, apps } = await appsOf(botId, actor);
      const named =
        input.app === undefined ? undefined : findApp(apps, input.app);
      const refusal =
        input.app !== undefined && !named
          ? noSuchApp(input.app, apps)
          : undefined;
      const result = await govern(
        "computer_apps",
        botId,
        actor,
        {
          device: machine,
          ...(signal ? { signal } : {}),
          ...(refusal ? { refusal, refusalRule: APP_UNAVAILABLE_RULE } : {}),
        },
        async (): Promise<ListAppsResult> => {
          const listed: ListAppsResult["apps"] = [];
          for (const app of named ? [named] : apps) {
            try {
              listed.push({
                name: app.name,
                tools: await fetchAppTools(machine, botId, app.ref, signal),
              });
            } catch (error) {
              listed.push({
                name: app.name,
                error:
                  error instanceof Error ? error.message : "没有取到工具列表。",
              });
            }
          }
          // --- app discovery (sub-project 3) ---
          if (named) return { apps: listed };
          return {
            apps: listed,
            ...(await discoverGroups(machine, botId, apps, signal)),
          };
          // --- end app discovery ---
        },
      );
      // Tool names and descriptions are whatever the app says they are.
      return withUntrustedNotice(result, "local app", [
        "apps",
        "available",
        "installed",
        "discoveryError",
      ]);
    },

    /**
     * One tool of a local app, judged before it runs (device MCP bridge §3.4, §4).
     *
     * The app is found by name among the apps the machine reported, so the frame carries a reference
     * this server holds, never one the model wrote. The tool is looked up in the machine's own list,
     * fresh or at most five minutes old, inside `govern` once nothing has refused the call yet: a
     * tool the list does not have is refused and nothing is sent; a list that cannot be had is "not
     * read-only". Only that list says whether the call may run without asking. The app's answer is
     * outside content and comes back marked as such.
     */
    async callApp(
      botId: string,
      actor: ActionActor,
      input: { app: string; tool: string; args?: Record<string, unknown> },
      signal?: AbortSignal,
    ) {
      const { machine, apps } = await appsOf(botId, actor);
      const app = findApp(apps, input.app);
      const refusal = app ? undefined : noSuchApp(input.app, apps);
      const resolveApp = async (known: { ref: string; name: string }) => {
        const tools = await appToolsFor(machine, botId, known.ref, signal);
        const tool = tools?.find((candidate) => candidate.name === input.tool);
        if (tools && !tool)
          throw new ActionRefusedError(
            `「${known.name}」没有名为「${input.tool}」的工具（已有：${tools.map((candidate) => candidate.name).join("、") || "无"}）`,
            APP_UNAVAILABLE_RULE,
          );
        return {
          readOnly:
            tool?.annotations?.readOnlyHint === true &&
            tool.annotations.destructiveHint !== true,
          ...(tool?.description ? { description: tool.description } : {}),
        };
      };
      const result = await govern<AppCallResult>(
        "computer_app_call",
        botId,
        actor,
        {
          device: machine,
          app: { name: app?.name ?? input.app, tool: input.tool },
          ...(app ? { resolveApp: () => resolveApp(app) } : {}),
          ...(signal ? { signal } : {}),
          ...(refusal ? { refusal, refusalRule: APP_UNAVAILABLE_RULE } : {}),
        },
        () =>
          post<AppCallResult>(
            botId,
            "/apps/call",
            { app: app?.ref, tool: input.tool, args: input.args ?? {} },
            signal,
            APP_CALL_BACKSTOP_MS,
            runnerAddress(machine),
          ),
      );
      return "queued" in result
        ? result
        : withUntrustedNotice(result, "local app", [
            "content",
            "structuredContent",
          ]);
    },

    // --- app discovery (sub-project 3) ---
    /**
     * One app found on the owner's machine, enabled there (app discovery, spec §3). Always asked
     * about; nothing before the card is sent anywhere but the machine itself, and a step that fails
     * opens no card and queues nothing. The frame carries the candidate reference and nothing else;
     * the card, the rows and the answer carry the app's name and where it was found, never its
     * command, arguments or environment, which never leave the machine.
     */
    async enableApp(
      botId: string,
      actor: ActionActor,
      input: { candidate: string },
      signal?: AbortSignal,
    ) {
      const { machine } = await appsOf(botId, actor);
      // Always asked: with nobody to ask, nothing is enabled.
      if (!options.approvalGate)
        throw new ComputerUnavailableError(NO_ENABLE_APPROVAL);
      /** Refused and recorded, before the card: nothing is sent. */
      const refuse = (
        refusal: string,
        enable?: { candidate: string; name: string; source: string },
      ) =>
        govern<never>(
          APP_ENABLE_TOOL,
          botId,
          actor,
          {
            device: machine,
            refusal,
            refusalRule: APP_UNAVAILABLE_RULE,
            ...(enable ? { enable } : {}),
          },
          async () => {
            throw new ActionRefusedError(refusal, APP_UNAVAILABLE_RULE);
          },
        );
      let found = candidates.find(machine, input.candidate);
      /*
       * A disabled tool or the team's cap of `never`: refused, and recorded like any refusal, before
       * the machine is asked anything (not even to look the candidate up). Asked by the app's name,
       * as the gate asks, when the listing already named it; otherwise by the reference, which only
       * a rule for every app matches, and a rule on the name is the gate's to apply before the
       * enable is sent.
       */
      const continuation = currentApprovalContext();
      const refused = await options.approvalRefusal?.({
        actorId: actor.id,
        botId,
        toolRef: APP_ENABLE_TOOL,
        effect: "write",
        scope: found?.name ?? input.candidate,
        args: continuation?.args ?? {},
        subject: { runner: true },
        ...(continuation ? { continuation } : {}),
      });
      if (refused)
        return refuse(
          refused,
          found
            ? {
                candidate: found.candidate,
                name: found.name,
                source: found.source,
              }
            : undefined,
        );
      if (options.deviceReachable?.(machine) === false)
        return refuse(DEVICE_OFFLINE_ENABLE);
      /*
       * Asked of the device when the listing has nothing on it, and again when the listing says it
       * is enabled: the owner may have switched it off in the device window since, and "already
       * enabled" is only said on a fresh answer.
       */
      if (!found || found.enabled) {
        const looked = await lookUpCandidate(
          machine,
          botId,
          input.candidate,
          signal,
        );
        if ("refusal" in looked) return refuse(looked.refusal);
        found = looked.found;
      }
      if (!found) return refuse(CANDIDATE_EXPIRED);
      const enable = {
        candidate: found.candidate,
        name: found.name,
        source: found.source,
      };
      if (found.status !== "ready")
        return refuse(
          found.note
            ? `「${found.name}」暂时不能启用：${found.note}`
            : `「${found.name}」暂时不能启用。`,
          enable,
        );
      if (found.enabled)
        return refuse(
          `「${found.name}」已经启用了，可以直接用 computer_app_call 调用。`,
          enable,
        );
      const result = await govern(
        APP_ENABLE_TOOL,
        botId,
        actor,
        { device: machine, enable, ...(signal ? { signal } : {}) },
        async () => {
          let output: unknown;
          try {
            output = await transport.post<unknown>(
              runnerAddress(machine),
              botId,
              "/apps/enable",
              { candidate: input.candidate },
              signal,
              APP_ENABLE_BACKSTOP_MS,
            );
          } catch (error) {
            if (error instanceof DeviceOfflineError)
              throw new ComputerUnavailableError(DEVICE_OFFLINE_ENABLE);
            // A runner from before enabling (it lists, but has no `apps.enable`): said in Chinese.
            if (
              error instanceof Error &&
              error.message.startsWith("Nothing on this machine handles")
            )
              throw new ComputerUnavailableError(OLD_RUNNER_ENABLE);
            throw error;
          }
          const read = readEnabled(output);
          if (!read)
            throw new ComputerUnavailableError(
              "设备没有返回有效的启用结果，请稍后用 computer_apps 再查看一次。",
            );
          candidates.markEnabled(machine, input.candidate);
          /*
           * Usable at once rather than after the next heartbeat. A record that cannot be written now
           * is caught up by that heartbeat, and does not undo an app the machine already enabled.
           */
          await options
            .rememberDeviceApp?.(machine, read.app)
            .catch((error: unknown) => {
              console.warn(
                JSON.stringify({
                  type: "device-app-remember-failed",
                  tenantId: machine.tenantId,
                  deviceId: machine.deviceId,
                  error: cutUtf8(String(error), 500),
                }),
              );
            });
          const tools = readAppTools(read.tools);
          keepAppTools(machine, read.app.ref, tools);
          return {
            enabled: { name: read.app.name, tools },
            next: `现在可以用 computer_app_call 调用「${read.app.name}」的工具了。`,
          };
        },
      );
      // Tool names and descriptions are whatever the app says they are.
      return withUntrustedNotice(result, "local app", ["enabled"]);
    },
    // --- end app discovery ---
  };
}

/**
 * Whether a run may use a Bot's local apps (device MCP bridge §4.1): on a device, and only when the
 * run is the Bot owner's own, since the apps are on the owner's computer and hold the owner's keys.
 * A teammate using a shared Bot, an admin, or a catalogue Bot (no owner) gets neither app tool, as a
 * 分身's local folders are the person's own (`folderFor` in avatar-sources.ts).
 */
export function localAppsAllowed(input: {
  machine: "device" | "workspace";
  owner: string | null;
  actorId: string;
}): boolean {
  return (
    input.machine === "device" &&
    input.owner !== null &&
    input.owner === input.actorId
  );
}

/** Why someone other than the Bot's owner cannot use the owner's local apps. */
const OWNER_ONLY =
  "本机应用在员工主人自己的电脑上，只有员工的主人本人才能让员工使用。";

/** Why a Bot has no local apps to use: not device mode, or no owner's machine to use them on. */
const NO_LOCAL_APPS =
  "本机应用只能在员工主人自己配对的电脑上使用，这个员工现在用不了。";
/** The device's tool lists are trusted for this long (device MCP bridge §3.4). */
const APP_TOOLS_TTL_MS = 300_000;
const APP_TOOLS_CACHE_LIMIT = 1000;
/*
 * Backstops that outlast the runner's own deadlines: start 20s + list 20s for a list; for a call on a
 * fresh connection start 20s + list 20s + call 120s, with room to spare.
 */
const APP_LIST_BACKSTOP_MS = 45_000;
// --- app discovery (sub-project 3) ---
const DISCOVER_BACKSTOP_MS = 30_000;
/** The runner's own deadlines for an enable: start 20s + list 20s, with room to spare. */
const APP_ENABLE_BACKSTOP_MS = 60_000;
const OLD_RUNNER_ENABLE =
  "主人电脑上的设备端版本较旧，更新后才能启用本机应用。";
const NO_ENABLE_APPROVAL = "这里没有可以请主人批准的地方，不能启用本机应用。";
const DISCOVERY_FAILED = (reason: string) =>
  `这次没能查看主人电脑上的其他应用：${reason}`;
// --- end app discovery ---
export const APP_CALL_BACKSTOP_MS = 170_000;

/** At most `limit` bytes of UTF-8, never ending in half a character. */
function cutUtf8(text: string, limit: number): string {
  const bytes = new TextEncoder().encode(text);
  return bytes.length <= limit
    ? text
    : new TextDecoder().decode(bytes.slice(0, limit)).replace(/\uFFFD+$/, "");
}

/** An app by the name the model used, without regard to case or surrounding spaces. */
function findApp(
  apps: { ref: string; name: string }[],
  name: string,
): { ref: string; name: string } | undefined {
  const wanted = name.trim().toLowerCase();
  return apps.find((app) => app.name.trim().toLowerCase() === wanted);
}

function noSuchApp(name: string, apps: { name: string }[]): string {
  return `这台电脑上没有名为「${name}」的本机应用（已有：${apps.map((app) => app.name).join("、") || "无"}）`;
}

/**
 * A machine's tool list, kept to the shape this server reads. Untrusted input: an entry without a
 * name, or with one over 128 characters, is dropped, a description is cut to 1 KB of UTF-8, and
 * annotations are kept only as an object.
 */
function readAppTools(value: unknown[]): AppTool[] {
  return value.flatMap((entry): AppTool[] => {
    if (!entry || typeof entry !== "object") return [];
    const { name, description, inputSchema, annotations } = entry as Record<
      string,
      unknown
    >;
    if (typeof name !== "string" || !name || name.length > 128) return [];
    return [
      {
        name,
        ...(typeof description === "string"
          ? { description: cutUtf8(description, 1024) }
          : {}),
        ...(inputSchema !== undefined ? { inputSchema } : {}),
        ...(annotations &&
        typeof annotations === "object" &&
        !Array.isArray(annotations)
          ? { annotations: annotations as AppTool["annotations"] }
          : {}),
      },
    ];
  });
}

/**
 * Split a path into the parts a rule wants to match on.
 *
 * Lower-cased, because a rule forbidding `.env` must also catch `.ENV`; the
 * operator should have anticipated. Same reasoning as the case-insensitive `contains` in policy.ts.
 */
export function describeFile(path: string): {
  path: string;
  name: string;
  extension: string;
} {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return {
    path,
    name,
    // A leading dot is the whole name of a dotfile, not an extension: `.env` has no extension, and the
    // rule for it is written against `name`.
    extension: dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
  };
}

/**
 * One audit row for one decision.
 *
 * Deliberately absent: the text that was typed. The row says which field was filled and
 * how many characters went into it, and never the value, because a form field is where a password, a
 * card number and a one-time code live. `audit.ts` would redact a key literally called `text`, but
 * relying on that would mean the secret was placed in the payload and caught on the way past; it is
 * simpler and stronger for it never to be put there. `element.name` is a label a page displays, not
 * something a person typed, so it is safe and it is the part an investigator actually needs.
 */
/**
 * What an action does, from what the gateway already knows.
 *
 * Derived here rather than passed in by each call site, so a new acting route cannot arrive
 * without an intent and fall outside every rule written in terms of one.
 *
 * Enter and Space are activations. They press whatever has focus, so a rule about activation must
 * cover keypresses as well as clicks.
 */
const ACTIVATING_KEYS = new Set(["Enter", "NumpadEnter", "Space", " "]);

/**
 * What a person's mouse and keyboard produce, and the whole of what `/human/<kind>` may name.
 *
 * A set rather than the union type alone, because the type is erased before the value gets here: the
 * route parses a JSON body and casts it to the input shape, so the check has to exist at runtime on
 * the side that builds the path.
 */
const HUMAN_GESTURES = new Set(["click", "type", "key", "scroll"]);

export function intentOf(
  toolName: string,
  key: string | undefined,
): PolicyContext["intent"] {
  switch (toolName) {
    case "computer_click":
      return "activate";
    case "computer_key":
    // A type carrying `submit` ends in Enter, and the same reasoning applies to it: what the
    // keypress does is press whatever the form activates, whichever tool asked for it.
    case "computer_type":
      return key && ACTIVATING_KEYS.has(key) ? "activate" : "type";
    case "computer_navigate":
      return "navigate";
    case "computer_read":
    case "computer_snapshot":
    case "computer_screenshot":
    case "computer_scroll":
      return "read";
    case "computer_read_file":
      return "read_file";
    case "computer_download_file":
      return "download_file";
    case "computer_write_file":
      return "write_file";
    case "computer_run_command":
      return "run_command";
    case "computer_list_files":
      return "list_files";
    // Listing a machine's local apps changes nothing; calling one of their tools runs a program there.
    case "computer_apps":
      return "read";
    case "computer_app_call":
      return "app_call";
    // --- app discovery (sub-project 3) ---
    // Enabling an app starts a program there too: a rule against app calls covers enabling one.
    case "computer_app_enable":
      return "app_call";
    // --- end app discovery ---
    // --- desktop control (sub-project 2) ---
    // Listing the windows and reading one change nothing on the desktop.
    case "computer_desktop_windows":
    case "computer_desktop_snapshot":
      return "read";
    // --- end desktop control ---
    default:
      return undefined;
  }
}

async function write(
  auditStore: AuditStore,
  entry: {
    toolName: string;
    botId: string;
    actor: ActionActor;
    element: SnapshotElement | undefined;
    ref: string | undefined;
    /** Which key, for a keypress. Recorded because a keypress can act without naming a button. */
    key?: string | undefined;
    filePath: string | undefined;
    pageUrl: string;
    /** The device the action was dispatched to, in device mode. */
    device?: string | null;
    decision: PolicyDecision;
    /** The command a shell call ran, so the trail says what was run and not merely that something was. */
    command?: string;
    /** Set only when a permitted action was attempted and did not succeed. */
    failure?: string;
    /** Set when that non-success was a person pressing Stop, so the row is typed a stop, not a failure. */
    stopped?: boolean;
    /** Why the action could not be carried out at all, said in the row (story RES2, D9). */
    refusal?: string;
    /**
     * The local app and tool a `computer_app_call` named, never its arguments; or the app and its
     * source an enable named (app discovery), never its command.
     */
    app?: { name: string; tool?: string; source?: string };
    // --- desktop control (sub-project 2) ---
    /** The desktop window a read was for, by title and process; never what was read from it. */
    desktop?: {
      windowId: string;
      title: string;
      process: string;
      screenshot: boolean;
    };
    // --- end desktop control ---
  },
) {
  await recordAuditEvent(auditStore, {
    // A failure is its own kind of event, not a variant of "allowed": the whole point of the extra row
    // is that a reader can tell an action that happened from one that was permitted and then did not.
    // A stop is a third kind again: the action did not happen, but nothing broke, so it is neither a
    // failure to be counted as an outage nor an action that was carried out.
    eventType: entry.stopped
      ? "computer.action_stopped"
      : entry.failure
        ? "computer.action_failed"
        : entry.decision.allowed
          ? "computer.action_allowed"
          : "computer.action_refused",
    targetType: "computer",
    targetId: entry.botId,
    initiator: entry.actor.initiator,
    // Only ever a real users row. The audit table has a foreign key to it, so writing the local
    // development actor's id here makes every action fail on a constraint violation instead of being
    // recorded. Who it was is in the payload either way.
    ...(entry.actor.userId ? { actorUserId: entry.actor.userId } : {}),
    payload: {
      action: entry.toolName,
      bot: entry.botId,
      actor: entry.actor.id,
      page: entry.pageUrl,
      ref: entry.ref ?? null,
      // Which machine it ran on, when the answer was a machine.
      device: entry.device ?? null,
      /*
       * The key, where there is one. A keypress can submit a form from inside a text field, so the
       * element it was aimed at is not always the thing it acted on. Without the key, the trail
       * cannot distinguish a form-submitting Enter from typing a letter.
       */
      ...(entry.key ? { key: entry.key } : {}),
      // The path, never the contents. A Bot writes down what it was told, so a file body is exactly as
      // sensitive as text typed into a form field, and for the same reason it is not put here.
      ...(entry.filePath ? { file: entry.filePath } : {}),
      /*
       * The command, in full, and its output never.
       *
       * The opposite call from the file body above, deliberately. A command IS the action, so a
       * trail recording that a Bot "ran something" answers nothing anyone would ask it. Its output
       * is the file body of this pair, and stays out.
       */
      ...(entry.command ? { command: entry.command } : {}),
      /*
       * The element, where the action named one.
       *
       * KEYED ON THE REF, not on the kind of action. An unresolved element is worth recording
       * plainly rather than as an absent field that reads like a logging gap, but that only applies
       * when the Bot pointed at something and the server could not say what: a ref it holds and the
       * snapshot no longer does. Deciding it by elimination instead put "not in the current
       * snapshot" on every navigation, every file read and every command, which is the reverse of
       * the intent. Those actions did not fail to identify an element; they never had one, and a
       * trail that says otherwise sends a reader looking for a snapshot that was never taken.
       */
      element: entry.element
        ? {
            role: entry.element.role,
            name: entry.element.name,
            ...(entry.element.type ? { type: entry.element.type } : {}),
          }
        : entry.ref
          ? "not in the current snapshot"
          : undefined,
      ...(entry.failure ? { failure: entry.failure } : {}),
      ...(entry.refusal ? { refusal: entry.refusal } : {}),
      ...(entry.app ? { app: entry.app } : {}),
      // --- desktop control (sub-project 2) ---
      ...(entry.desktop ? { desktop: entry.desktop } : {}),
      // --- end desktop control ---
      decision: {
        allowed: entry.decision.allowed,
        mode: entry.decision.mode,
        source: entry.decision.source,
        rule: entry.decision.matched,
        /** Present so the trail explains a dry-run row that was recorded as refused but still ran. */
        carriedOut: entry.decision.forward,
      },
    },
  });
}

/**
 * The host a rule can match on, or empty.
 *
 * Empty means "no page", which is the accurate answer before a Bot has snapshotted anything, and it is
 * the only case that occurs in practice: the URL comes from Playwright's own `page.url()` by way of the
 * snapshot cache. Worth stating explicitly because a `page.host == "..."` deny rule would not match an
 * empty host, so a boundary that must not be evadable should also key on the tool, the element or the
 * file rather than on the host alone.
 */
/**
 * One row for a handover.
 *
 * Separate from `write` because a handover has no element, no file and no policy decision, forcing it
 * through the same shape would mean inventing a decision that was never asked for, and a row claiming
 * a policy allowed something it never saw is exactly the kind of comfortable fiction this trail exists
 * to avoid.
 */
async function writeControlEvent(
  auditStore: AuditStore,
  eventType:
    | "computer.help_requested"
    | "computer.help_cancelled"
    | "computer.control_taken"
    | "computer.control_released"
    | "computer.secret_requested"
    | "computer.secret_supplied"
    | "computer.stopped"
    | "computer.reset"
    | "computer.updated",
  entry: {
    botId: string;
    actor: ActionActor;
    reason?: string;
  },
) {
  await recordAuditEvent(auditStore, {
    eventType,
    targetType: "computer",
    targetId: entry.botId,
    initiator: entry.actor.initiator,
    ...(entry.actor.userId ? { actorUserId: entry.actor.userId } : {}),
    payload: {
      bot: entry.botId,
      actor: entry.actor.id,
      ...(entry.reason ? { reason: entry.reason } : {}),
    },
  });
}

/** The fields of a page read that come from the page itself. */
const PAGE_FIELDS = ["title", "text"] as const;
const SNAPSHOT_FIELDS = ["title", "elements"] as const;

/** A two-step login can take two page loads and a wait for a code field; this outlasts the computer's own waits. */
const SIGN_IN_BACKSTOP_MS = 75_000;

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
