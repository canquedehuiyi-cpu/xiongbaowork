import type { AbstractAgent } from "@ag-ui/client";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { computerGuidance } from "../../shared/bot-prompt";
import { isPersonBrowserId } from "../../shared/openbot-browser";
import { workOwner } from "../../shared/work-owner";
import { createActivityStore } from "./activity/activity";
import {
  auditRoutineStore,
  enterpriseControls,
  guardDeliveryStore,
  guardHostAccess,
  headlessTurnRefusal,
  installEnterpriseControls,
  modelNamedIn,
  proactiveAdmin,
  skillSharingAllowed,
  skillSharingInSnapshot,
} from "./admin/controls";
import { fixSettings } from "./admin/settings-store";
import {
  CoworkerUnavailableError,
  createActorAgentResolver,
} from "./agents/agent-resolver";
import { ownerTenantOfBot } from "./agents/bot-owner";
import {
  mintRunAssertion,
  type RunAssertion,
  readApprovedRunAssertion,
  readRunAssertion,
} from "./agents/callback-token";
import { canUseComputer } from "./agents/computer-access";
import { wireCoordination } from "./agents/coordination-wiring";
import { createAgentFetch } from "./agents/endpoint";
import { createHandoffDesk } from "./agents/handoff";
import { createHandoffRunner } from "./agents/handoff-runner";
import { startHandoffDelivery } from "./agents/handoff-wiring";
import { runsIsolated } from "./agents/isolation";
import {
  configureBotLifecycle,
  createBotLifecycleStore,
  guardBotTurn,
} from "./agents/lifecycle";
import { createBotReset } from "./agents/lifecycle-reset";
import { createAgentProfileStore } from "./agents/profile-store";
import type { AgentActor } from "./agents/profile-types";
import { isUnattended, runModeOf } from "./agents/run-mode";
import { createRuntimeAgentLoader } from "./agents/runtime-agents";
import { createSubagents, SUBAGENT_HANDED_BACK } from "./agents/subagent";
import { toolLimitRecorder } from "./agents/tool-limit";
import { serverTurnAdmission } from "./agents/turn-admission";
import {
  createWakeUpRunner,
  createWakeUpStore,
  wakeUpTools,
} from "./agents/wake-up";
import { createApp } from "./app";
import { createDecisionWaits } from "./approvals/decision-waits";
import { createApprovedActionExecutor } from "./approvals/execute";
import { createPersonResponseTick } from "./approvals/person-response-sweep";
import {
  createApprovalQuestions,
  type PersonQuestion,
  questionConversationBot,
  withQuestionParking,
} from "./approvals/questions";
import { waitForReplyInTranscript } from "./approvals/reply-in-transcript";
import { createApprovalResumeTick } from "./approvals/resume-sweep";
import { loadRuleVocabulary } from "./approvals/rule-vocabulary";
import { createApprovalStore } from "./approvals/store";
import { ApprovalRefusedError } from "./approvals/types";
import { createServerApprovalService } from "./approvals/wiring";
import {
  type AuditInitiator,
  addAuditTap,
  auditSink,
  createAgentTrailReader,
  createAuditReader,
  createAuditStore,
  DEPLOYMENT_INITIATOR,
  PERSON_INITIATOR,
  recordAuditEvent,
  recordPersonAuditEvent,
  recordPlatformAuditEvent,
} from "./audit";
import { readAuditVocabulary } from "./audit-ask";
import { startRetentionSweeps } from "./audit-retention";
import { createAuth, sessionLifetimeMs } from "./auth";
import { createAdminScope } from "./auth/admin-scope";
import {
  createDevRequireUser,
  DEV_ACTOR,
  initializeDevActorUser,
  provisionDevActorTenant,
  seedDevActorRole,
} from "./auth/dev-actor";
import { createEntra, withEntraBearer } from "./auth/entra";
import type { AuthService } from "./auth/guards";
import { createRequireUser, createRoleRepository } from "./auth/guards";
import { createIdentityProviderStore } from "./auth/identity-provider-store";
import { createOrganizationAuth } from "./auth/organization";
import { organizationUserStore } from "./auth/organization-store";
import {
  checkDatabaseCredential,
  checkServerReadiness,
  createRoleWriterLifecycle,
  createStartupLifecycle,
  resolveRlsEnforcementMode,
} from "./auth/role-writer-lifecycle";
import { initializeRoleWriter, stopRoleWriter } from "./auth/roles";
import {
  createAutomationHookDirectory,
  createAutomationHookRoutes,
} from "./automations/ingress-routes";
import { createAutomationRoutes } from "./automations/routes";
import {
  type AutomationFiring,
  createAutomationStore,
} from "./automations/store";
import {
  AUTOMATION_FIRE_KIND,
  type AutomationEvent,
  dispatchClaimedAutomations,
  offerDueAutomations,
} from "./automations/sweep";
import { createAutomationTargetRegistry } from "./automations/types";
import {
  createWakerAutomationExecutor,
  wakerflowAutomationTarget,
} from "./automations/waker-executor";
import { createAutonomousRoutes } from "./autonomous/routes";
import { createAutonomousStore } from "./autonomous/store";
import {
  avatarSourcesForActor,
  createAvatarSourceRoutes,
  createAvatarSourceStore,
} from "./avatar-sources";
import { openbotAddress } from "./browser/address";
import { botBrowserNetwork } from "./browser/bot-browser";
import { personBrowserEgressPolicy } from "./browser/egress";
import {
  botRecordRefusal,
  directBrowserComputers,
  gatewayBrowserComputers,
  personBrowserPlace,
  withPersonBrowsers,
} from "./browser/host";
import { personBrowserId, personBrowserInstallId } from "./browser/person";
import {
  loadAttachmentForTurn,
  markAttachmentsSent,
} from "./channels/attachments";
import {
  createChannelDispatch,
  createChannelDispatchRoutes,
} from "./channels/dispatch";
import {
  announceTaskUpdate,
  createChannelEventHub,
  startChannelActivityListener,
} from "./channels/events";
import {
  createGroupConversations,
  createGroupStore,
  groupSourceForRun,
} from "./channels/group";
import { createModelChoices } from "./channels/model-choice";
import { type ChannelStore, createChannelStore } from "./channels/routes";
import { createStallGuard } from "./channels/stall-guard";
import {
  forgetSettledSummaries,
  offerChannelsAwaitingSummary,
  summariseClaimedChannels,
} from "./channels/summary";
import { createThreadIdentity } from "./channels/thread-identity";
import { createChannelTitler } from "./channels/titler";
import { headlessComponentCatalog } from "./components/headless";
import { createSandboxedStore } from "./components/sandboxed";
import { createComponentStore } from "./components/store";
import {
  botOwnership,
  createComputerSeatResolver,
} from "./computer/computer-key";
import { createComputerGateway, localAppsAllowed } from "./computer/gateway";
import { createHeadlessComputerTools } from "./computer/headless-tools";
import { createPageFrameStore } from "./computer/page-frames";
import { startPolicyListener } from "./computer/policy-listener";
import {
  pushEgressPolicy,
  withPolicyPushOnWake,
} from "./computer/policy-network";
import {
  createPolicyStore,
  DEFAULT_ACTION_POLICY,
} from "./computer/policy-store";
import {
  createComputerProvider,
  describeComputerIsolation,
} from "./computer/provider";
import { createRunnerTransport } from "./computer/runner-transport";
import { createSnapshotStore } from "./computer/snapshot-store";
import { loadConfig } from "./config";
import {
  chooseOpenAIApi,
  deploymentModel,
  type LoadCurrentProject,
  mountCopilotRuntime,
  normalizeModelBaseUrls,
  runtimeModelForEnvironment,
  type ToolSelection,
} from "./copilot";
import {
  createCredentialAdminService,
  createCredentialStore,
  resolveModelApiKey,
} from "./credentials";
import { createDatabase } from "./db/client";
import { ROLE_FACTS_SQL } from "./db/rls-role";
import {
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  recorderConnections,
  users,
} from "./db/schema";
import { createDeliveryRouter, DELIVERY_WORK_KINDS } from "./delivery/router";
import { configuredDeliveryProviders } from "./delivery/routes";
import { createDeliveryScopes } from "./delivery/scope";
import { createDeliveryStore } from "./delivery/store";
import type { DeliveryScope } from "./delivery/types";
import { DeliveryRefusedError } from "./delivery/types";
import { createDeviceChannel, type DispatchTarget } from "./devices/channel";
import { createDeviceQueue } from "./devices/queue";
import {
  createQueuedResultNotices,
  createThreadResultPoster,
} from "./devices/queued-results";
import { createDeviceRoutes, createRunnerRoutes } from "./devices/routes";
import { createDeviceScreens } from "./devices/screen";
import { computerProviderFor, createDeviceSelector } from "./devices/selection";
import { createDeviceStore } from "./devices/store";
import { createDeviceTakeovers } from "./devices/takeover";
import { currentEdition, editionHasMemory, setEdition } from "./edition";
import {
  createHostAccessBroker,
  HostAccessRefusedError,
} from "./host-access/broker";
import { hostAccessTools } from "./host-access/tools";
import { startHttpServer } from "./http-server";
import { githubCallbackRoutes } from "./identity/github-callback";
import { retireIdentityLinks, retireOwnedAccounts } from "./identity/retire";
import { slackCodeRedeemer } from "./identity/slack-redeem";
import { createIdentityStore } from "./identity/store";
import { createIntelligenceClient } from "./intelligence-client";
import { reportIntelligenceEntitlement } from "./intelligence-entitlement-check";
import { createKnowledgeRoutes } from "./knowledge/routes";
import { createKnowledgeStore } from "./knowledge/store";
import { KNOWLEDGE_TOOL_NAMES, knowledgeTools } from "./knowledge/tools";
import { createSkillApprovalStore } from "./learning/approvals";
import { createAutoApprover } from "./learning/auto-approve";
import {
  createLearningAutoAssign,
  probeLearningContainer,
  withLearningAutoAssign,
} from "./learning/auto-assign";
import {
  cliLoginPresent,
  createLearningContainer,
  ensureLearningContainer,
  intelligenceApiOrigin,
  keyIntelligence,
  type LearningContainerCredentials,
  learningSetupInstructions,
} from "./learning/ensure-container";
import { createInspectorLearningReader } from "./learning/inspector";
import {
  createLearningModelCalls,
  learningModelEndpointFor,
} from "./learning/model-endpoint";
import { createLearningPeople } from "./learning/people";
import {
  createPersonalLearningSpaces,
  createPersonSpaceStore,
  type PersonalLearningSpaces,
  personalLearningContainerId,
} from "./learning/personal-space";
import { learningModelUnavailable } from "./learning/routes";
import {
  clearLearningRevisionFallback,
  createLearningRuntime,
} from "./learning/runtime";
import { learningScopes } from "./learning/scopes";
import {
  configuredLearningContainer,
  createLearningSettingsStore,
} from "./learning/settings";
import {
  createLearningSharingStore,
  createOpenSkillIndex,
} from "./learning/sharing";
import { createLocalLearningEngine } from "./local-learning/engine";
import { createMemoryDefaults } from "./memory/defaults";
import { createMemoryIngestion } from "./memory/ingestion";
import { createIntelligenceMemory } from "./memory/intelligence";
import { createMemoryRuntime } from "./memory/runtime";
import { createMemoryStore } from "./memory/store";
import { offeredMemoryTools } from "./memory/tools";
import { reportModelAvailability } from "./model-availability-check";
import { createModelCatalogue } from "./model-catalogue";
import { installDeepSeekThinkingOff } from "./models/deepseek-thinking";
import { createModelRoutes, createModelShelf } from "./models/routes";
import {
  createNamedAgentModelResolver,
  modelOf,
} from "./models/runtime-resolver";
import { databaseTokenCallSink } from "./models/token-metering";
import { createSignInNotifier, createSignInResumer } from "./passwords/resume";
import { createSignInService } from "./passwords/service";
import { createPasswordStore } from "./passwords/store";
import { createOnboardingStore } from "./people/onboarding";
import { createProfileStore } from "./people/profile";
import { createPeopleStore } from "./people/store";
import { createPersonaRoutes } from "./personas/routes";
import { createPersonaTemplateStore } from "./personas/store";
import { createActionStepRunner } from "./pipeline/action-step";
import { createPipelineRoutes } from "./pipeline/routes";
import { createPipelineStore } from "./pipeline/store";
import { createPipelineStepRunner } from "./pipeline/turn-channel";
import { createPlatformRoutes } from "./platform/routes";
import { appAccessTools } from "./plugins/app-access-tool";
import { showAppAccessTools } from "./plugins/show-app-access-tool";
import { useRoutineTools } from "./plugins/builtin-routines";
import { useStaffingTools } from "./plugins/builtin-staffing";
import { useComposioClient } from "./plugins/composio";
import { createAccountModeSwitch } from "./plugins/account-mode";
import { useArcadeClient } from "./plugins/arcade";
import { asComposioBroker, createArcadeClient } from "./plugins/arcade-adapter";
import { BROKERED_PROFILE } from "./plugins/access";
import { connectionOwners, connectionsHeldBy } from "./plugins/arcade-attempts";
import { assertActivatable, providerDecision } from "./plugins/broker";
import {
  ensureSingleUserIdentity,
  underOwnName,
  vendorNameFor,
} from "./plugins/single-user-identity";
import {
  arcadeVerifierNotice,
  ownsBrokerProject,
  selectProviderWiring,
  storedProvider,
} from "./plugins/provider-wiring";
import {
  createSharedAudience,
  createSharedUseStore,
} from "./plugins/shared-use-store";
import {
  brokerWithAccounts,
  createComposioClient,
} from "./plugins/composio-adapter";
import { openBotResources } from "./plugins/entra-access";
import { backfillComposioLogos } from "./plugins/logos";
import { redirectUriFor } from "./plugins/oauth";
import { startBrokeredRelist } from "./plugins/relist";
import {
  ensureAlwaysOnApp,
  ensurePersonalAskBeforeChanges,
  ensurePersonalLearning,
  ensurePersonalSkills,
  ensurePersonalSkillsOwned,
  personalDefaultAppsMemory,
  personalDefaultsDeps,
  personalGrantsLeftInTeam,
  startPersonalDefaultApps,
  withPersonalDefaults,
} from "./plugins/personal-defaults";
import { createPluginStore, type PluginStore } from "./plugins/store";
import {
  grantedSkills,
  grantedTools,
  REFUSAL_MARKER,
  vendorAnswer,
} from "./plugins/tools";
import { coworkerFaceAccess } from "./portraits/coworker-access";
import { createPortraitRoutes } from "./portraits/routes";
import { createPortraitStore } from "./portraits/store";
import { createProactiveEngine } from "./proactive/engine";
import { checkInOfferTools } from "./proactive/offer-tool";
import {
  createPrivateShareCheck,
  PRIVATE_SHARE_TOOL_REF,
} from "./proactive/private-share";
import {
  guardProactiveCallback,
  restrictCoordinationForRun,
  restrictToolsForRun,
} from "./proactive/restriction";
import {
  checkInCatalogue,
  checkInToolsFor,
  createCheckInScope,
} from "./proactive/scope";
import { createProactiveStore } from "./proactive/store";
import { createProjectContext } from "./projects/context";
import { createProjectRoutes } from "./projects/routes";
import { createProjectStore } from "./projects/store";
import { createProviderOAuthProxy } from "./provider-oauth";
import { createQuotaService } from "./quota/limits";
import { createQuotaRoutes } from "./quota/routes";
import { createRecorderExtension } from "./recorder/wiring";
import {
  abandonedWorkPhases,
  RECOVERY_PURGE_AFTER_MS,
  RECOVERY_SWEEP_KIND,
  sweepAbandonedWork,
} from "./recovery/abandoned-work";
import { createRequestActor } from "./request-actor";
import { createResponsibilityBindingStore } from "./responsibilities/bindings";
import {
  useGoalTools,
  withoutGoalCopiesInGoalRun,
} from "./responsibilities/chat-tools";
import {
  createEmailTriggerRoutes,
  createSnsVerifier,
  fetchText as fetchSnsText,
  inboundEmailConfigFromEnv,
} from "./responsibilities/email";
import {
  createSlackTriggerIngest,
  slackAccessFrom,
  useSlackChannelMembership,
  useSlackTriggerIngest,
} from "./responsibilities/slack";
import { createResponsibilityStore } from "./responsibilities/store";
import { responsibilityTools } from "./responsibilities/tools";
import { createTriggerIngressRoutes } from "./responsibilities/trigger-routes";
import { useTriggerTools } from "./responsibilities/trigger-tools";
import { createTriggerStore } from "./responsibilities/triggers";
import type { Responsibility } from "./responsibilities/types";
import { createServerResponsibilityEngine } from "./responsibilities/wiring";
import { createRoleGenerator } from "./roles/generator";
import { createRoleTemplateRoutes } from "./roles/routes";
import { createRoleTemplateStore, officialTemplatesFrom } from "./roles/store";
import {
  createTurnRunner,
  type RunnerLike,
  serverTurnAnswered,
  serverTurnScope,
} from "./routines/run-turn";
import { createRoutineRunner } from "./routines/runner";
import { createRoutineStore } from "./routines/store";
import { createIntentRouter } from "./routing/classify";
import {
  createModelCompleter,
  createSkillChooser,
  routingModelFor,
} from "./routing/model";
import { createSelfHostBanner } from "./self-host-banner";
import { createSetupSources, modelKeyOf } from "./setup/checklist";
import { createComputerCheck } from "./setup/computer-check";
import {
  ensureStaffingServer,
  staffingAppMemory,
  withStaffingDefault,
} from "./staffing/default-grant";
import { createStaffingExecutor } from "./staffing/executor";
import {
  createOwnerNameReader,
  createThreadVisibility,
} from "./staffing/routes";
import { createStaffingProposalStore } from "./staffing/store";
import { createTaskProjector } from "./tasks/projector";
import { createTaskRoutes } from "./tasks/routes";
import { createTaskRunner } from "./tasks/runner";
import { createTaskStore } from "./tasks/store";
import { createTaskTurn } from "./tasks/turn";
import { createTeamBots } from "./team-bots/team-bots";
import { createProductTelemetry } from "./telemetry/product";
import {
  deliveryLineage,
  productHeadlessBoundary,
} from "./telemetry/product-boundaries";
import { isAccessRevoked } from "./tenant/access";
import {
  asPlatform,
  capabilityFor,
  currentTenant,
  isTenantFramed,
  runAsTenant,
} from "./tenant/context";
import {
  createPackageStatusReader,
  deploymentNameOf,
  loadTenantPackage,
  synchronizeTenantPackage,
} from "./tenant-package";
import {
  createLocalThreadPlatform,
  createLocalThreadReader,
  type ThreadPlatform,
} from "./threads/local-platform";
import { PostgresAgentRunner } from "./threads/postgres-runner";
import { createTranslationRoutes } from "./translations/routes";
import { createTranslationStore, translatePending } from "./translations/store";
import { createTranslator } from "./translations/translator";
import { createUserInstructionsStore } from "./user-instructions";
import { createUserPreferencesStore } from "./user-preferences";
import { createVoiceSessionStore } from "./voice/sessions";
import { createVoiceSummarizer } from "./voice/summary";
import { createWakerGroupRoutes } from "./waker-groups/routes";
import { createWakerGroupStore } from "./waker-groups/store";
import { createFlowGenerator } from "./wakerflows/generator";
import { createFlowModelResolver } from "./wakerflows/model";
import { recoverInterruptedFlowRuns } from "./wakerflows/recovery";
import {
  createWakerFlowRoutes,
  createWakerFlowShareRoutes,
} from "./wakerflows/routes";
import { createWakerFlowStore, flowRunEventWriter } from "./wakerflows/store";
import { readAuditEvent, readWhatIfVocabulary } from "./what-if";
import { repeatAfterEach } from "./work/loop";
import { createWorkQueue, startWorkOfferedListener } from "./work/queue";

const config = loadConfig();
// Before anything resolves a capability or reads an enterprise setting. See edition.ts.
setEdition(config.edition);
// One person on their own machine is shown every model their credential lists; nothing narrows it.
if (config.singleUser)
  fixSettings({ modelAllowlist: { enabled: false, models: [] } });
// The revision default was read into `config.learning`; the variable must not be read again later.
clearLearningRevisionFallback();
// Read with the rest of the configuration, where an empty variable is an absent one. See
// `serverPort` in config.ts for what `process.env.PORT ?? …` did with `PORT=` instead.
const port = config.port;
const roleWriterUrl = config.roleWriterDatabaseUrl;
// Neither subsequently spawned children nor configuration consumers receive this credential.
delete process.env.ROLE_WRITER_DATABASE_URL;
delete config.roleWriterDatabaseUrl;
if (!roleWriterUrl) {
  throw new Error(
    "ROLE_WRITER_DATABASE_URL is required; the application cannot write identity roles.",
  );
}
// Audit defect #8: decided before any connection opens, so a typo in the mode or the public 0054
// password stops the server here. Production, as config.ts reads it: trimmed.
const rlsEnforcement = resolveRlsEnforcementMode(process.env);
const production = process.env.NODE_ENV?.trim() === "production";
checkDatabaseCredential({
  url: config.databaseUrl,
  production,
  report: (event) =>
    production
      ? console.error(JSON.stringify(event))
      : console.warn(JSON.stringify(event)),
});
const database = createDatabase(config.databaseUrl);
const roleWriterLifecycle = createRoleWriterLifecycle({
  application: database,
  url: roleWriterUrl,
  create: (url) => createDatabase(url, { max: 1 }),
  initialize: initializeRoleWriter,
  stop: stopRoleWriter,
  close: async (writer) => {
    await writer.$client.close();
  },
});
const startupLifecycle = createStartupLifecycle({
  seal: () => roleWriterLifecycle.stop(),
});
startupLifecycle.final(() => database.$client.close());
let shutdownStarted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    void startupLifecycle.stop().then(
      () => process.exit(0),
      () => {
        console.error("Server shutdown is unconfirmed.");
        process.exit(1);
      },
    );
  });
}
await startupLifecycle.run(async (startup) => {
  // Resolve APP/RLS readiness before any consumer, producer, auth bootstrap or listening socket.
  await startup.step(() =>
    checkServerReadiness({
      read: async () => database.execute(sql.raw(ROLE_FACTS_SQL)),
      mode: rlsEnforcement,
      report: (event) => {
        if (event.type === "rls-role-check-unavailable")
          console.warn(JSON.stringify(event));
        else console.error(JSON.stringify(event));
      },
    }),
  );
  // After the readiness gate: a deployment pointed at the owner or a BYPASSRLS role must be refused as
  // a tenant-isolation failure, not reported as a role-writer contract error.
  await startup.step(() => roleWriterLifecycle.start());
  configureBotLifecycle({ database });
  await startup.step(() => initializeDevActorUser(database, config.singleUser));
  // After the user row: its admin role in `user_roles`, which RLS and the admin capability read.
  await startup.step(() => seedDevActorRole(database, config.singleUser));
  // After the user row exists: the actor gets a real Free subscription row (audit #7 follow-up).
  await startup.step(() =>
    provisionDevActorTenant(database, config.singleUser),
  );
  /*
   * Product analytics (telemetry/product.ts): off unless the operator turned the export on, and never
   * anything a person wrote. Every audit row passes it a copy of its event type.
   */
  const productTelemetry = await createProductTelemetry({
    privacyKey: config.keyEncryptionKey,
    deploymentId: config.deploymentId,
  });
  addAuditTap(productTelemetry.recordAudit);
  startup.acquireSync(
    () => productTelemetry,
    (telemetry) => telemetry.flush(),
  );
  const prepareProductRunInput = productHeadlessBoundary(productTelemetry);
  // A person's name and their own details, for /api/me and for what their Bots call them.
  const profileStore = createProfileStore(database);
  // The vault, built before the agent store because a customer's agent may sit behind a key and that
  // key belongs here rather than on the agent row. See agents/auth-header.ts.
  const credentialStore = createCredentialStore(database);
  // People's linked Slack and GitHub accounts (upstream #763), each person's own rows (G01).
  const identityStore = createIdentityStore(database, credentialStore);
  /*
   * CopilotKit Intelligence, only when this deployment is connected to one (R0, optional). It serves
   * Automatic Learning's published skills to each Bot's run, and keeps people's memory when the
   * deployment is entitled to it; threads stay in this database either way. Without
   * `INTELLIGENCE_API_KEY` none of this exists and every Bot is built as before. Built here, ahead of
   * the memory store that reads it; the constructor opens nothing.
   */
  const intelligenceClient = config.intelligence
    ? createIntelligenceClient(config.intelligence)
    : undefined;
  /*
   * Automatic Learning, only with a connected Intelligence (R0). Its settings are the deployment's,
   * and the `openbot` container is assigned automatically when nobody has chosen one (upstream #774).
   */
  /*
   * The environment's container, until the boot check finds this Intelligence has no such container
   * (learning/auto-assign.ts). A name left over from a setup against another Intelligence then gives
   * way to automatic assignment instead of failing every new thread (upstream #1363).
   */
  const configuredLearning = configuredLearningContainer(config.learning);
  const learningSettingsStore = intelligenceClient
    ? createLearningSettingsStore(database, configuredLearning)
    : undefined;
  /*
   * Who can create a Learning container here. First the runtime key itself, on an Intelligence that
   * lets a project key create one in its own project, at the address the server already uses. On one
   * that does not, a service token the operator configured (local evaluation installs), or a
   * CopilotKit CLI login on this machine, which is what a laptop running `bun run start` has: those
   * two only over HTTPS, or HTTP on loopback. None of them, and the log and Admin say exactly what to
   * run instead. Only with INTELLIGENCE_API_URL named: without it there is nowhere to create one.
   */
  const learningApiUrl = config.intelligence?.apiUrl?.replace(/\/+$/, "");
  const learningApiOrigin = (() => {
    if (!learningApiUrl) return undefined;
    try {
      return intelligenceApiOrigin(learningApiUrl);
    } catch {
      return undefined;
    }
  })();
  /** The credentials that can create a Learning container, for the `openbot` default and for each person's own space. */
  const learningCredentials = (): LearningContainerCredentials | undefined =>
    config.intelligence && learningApiUrl
      ? {
          directory: process.cwd(),
          apiUrl: learningApiOrigin ?? learningApiUrl,
          nonInteractive: true,
          key: keyIntelligence(
            learningApiUrl,
            config.intelligence.apiKey,
            config.intelligence.gatewayWsUrl,
          ),
          cliLogin: learningApiOrigin !== undefined && cliLoginPresent(),
          ...(config.learningSetup && learningApiOrigin
            ? {
                serviceToken: {
                  token: config.learningSetup.serviceToken,
                  projectId: config.learningSetup.projectId,
                },
              }
            : {}),
        }
      : undefined;
  const learningAutoAssign = (() => {
    if (!intelligenceClient || !learningSettingsStore) return undefined;
    const credentials = learningCredentials();
    const assign = createLearningAutoAssign({
      enabled: config.learningAutoAssign,
      configured: configuredLearning,
      store: learningSettingsStore,
      probe: (containerId) =>
        probeLearningContainer(intelligenceClient, containerId),
      ...(learningApiUrl
        ? {
            instructions: learningSetupInstructions(
              learningApiOrigin ?? learningApiUrl,
            ),
          }
        : {}),
      ...(credentials
        ? { create: () => ensureLearningContainer(credentials) }
        : {}),
      audit: createAuditStore(database),
    });
    /*
     * The assignment is the deployment's, whoever's read nudged it and whichever timer runs it, so it
     * always runs as `platform` (G01): the audit row it writes is nobody's.
     */
    return {
      ...assign,
      start: () => asPlatform(() => assign.start()),
      kick: () => asPlatform(() => assign.kick()),
      check: () => asPlatform(() => assign.check()),
    };
  })();
  const learningSettings =
    learningSettingsStore && learningAutoAssign
      ? withLearningAutoAssign(learningSettingsStore, learningAutoAssign)
      : learningSettingsStore;
  learningAutoAssign?.start();
  /*
   * Each person's own Learning space: every recording they make joins it, and every Bot they run uses
   * its Skills. Made with the same credential as the default container, on first need: when their
   * browser connects, and again on a capture pass if it is still missing. With no such credential a
   * missing space cannot be made, and the Recorder says so. Without Intelligence there is no space,
   * and the Recorder is told Learning is off.
   *
   * Each person's row is theirs (G01): read and written in their own frame. Their name is an identity
   * row, read as `platform`.
   */
  const personSpaceStore = createPersonSpaceStore(database);
  const personalLearningSpaces: PersonalLearningSpaces =
    intelligenceClient && learningSettings
      ? createPersonalLearningSpaces({
          readSettings: () => learningSettings.read(),
          snapshots: intelligenceClient,
          store: {
            confirmed: (userId) =>
              runAsTenant(userId, () => personSpaceStore.confirmed(userId)),
            confirm: (userId, containerId) =>
              runAsTenant(userId, () =>
                personSpaceStore.confirm(userId, containerId),
              ),
            forget: (userId) =>
              runAsTenant(userId, () => personSpaceStore.forget(userId)),
          },
          ...(learningCredentials()
            ? {
                create: (container) =>
                  createLearningContainer({
                    ...(learningCredentials() as LearningContainerCredentials),
                    container,
                  }),
              }
            : {}),
          nameFor: async (userId) =>
            (
              await asPlatform(() =>
                database
                  .select({ name: users.name })
                  .from(users)
                  .where(eq(users.id, userId))
                  .limit(1),
              )
            ).map((row) => row.name?.trim() || null)[0] ?? null,
        })
      : {
          containerFor: personalLearningContainerId,
          state: async () => ({ state: "learning-off", containerId: null }),
          kick: () => {},
        };
  const skillApprovalStore = createSkillApprovalStore(database);
  const learningSharingStore = createLearningSharingStore(database);
  /**
   * What everyone opened to every Bot, in memory: runs read this, never each person's space or the
   * table. Everyone's rows, so read as `platform`.
   */
  const openSkillIndex = createOpenSkillIndex({
    read: () => asPlatform(() => learningSharingStore.openSources()),
  });
  const learning =
    intelligenceClient && learningSettings
      ? createLearningRuntime({
          store: learningSettings,
          client: intelligenceClient,
          // The environment's container, or a saved default, that this Intelligence was found not to
          // have (upstream #1363/#1366).
          forgotten: (containerId) =>
            configuredLearning.forgotten(containerId) ||
            (learningSettingsStore?.isSetAside(containerId) ?? false),
          people: {
            containerFor: personalLearningSpaces.containerFor,
            openSkills: () => openSkillIndex.sources(),
            // Read on every run, never from the index: an approval made on another replica counts at
            // once. Other people's approvals, so as `platform`.
            withheld: (userIds) =>
              asPlatform(() => skillApprovalStore.withheld(userIds)),
            sharingAllowed: skillSharingInSnapshot,
          },
        })
      : undefined;
  const learningPeople = createLearningPeople(database);
  /** Reads one named skill from a container; throws when Learning or the read is unavailable, null when absent. */
  const skillIn = async (containerId: string, name: string) => {
    const read = await learning?.containerSkills(containerId);
    if (!read || "unavailable" in read) {
      throw new Error("Skills are unavailable.");
    }
    return read.skills.find((skill) => skill.name === name) ?? null;
  };
  const agentVault = {
    store: credentialStore,
    reader: credentialStore,
    encryptionKey: config.keyEncryptionKey,
  };
  /*
   * The tenant's own machines: paired by a code, kept present by a heartbeat, reached over a socket
   * the machine opened. See devices/store.ts and the upgrade branch below.
   */
  const deviceStore = createDeviceStore(database, {
    onRevoked: (target) => deviceChannel.revoke(target),
  });

  /*
   * Which of this tenant's machines can be written to from THIS process (ticket 017).
   *
   * Presence for the screen stays in `last_seen_at`; this is the socket table, because an action asked
   * of a device that is online on another replica would be written to nobody.
   */

  const deviceQueue = createDeviceQueue(database);
  /*
   * Told after every flush, so the outcome of an action that waited for an away machine reaches the
   * conversation that queued it. Assigned once the thread runner exists, further down.
   */
  let queuedResults: ReturnType<typeof createQueuedResultNotices> | undefined;
  const deviceChannel = createDeviceChannel({
    queue: deviceQueue,
    authorize: (target, version) => deviceStore.isRegistered(target, version),
    afterFlush: async (target) => queuedResults?.announce(target),
  });
  /*
   * The live screen of a coworker on one of those machines (F2 stage 2): frames up the runner's
   * socket, relayed to the people watching, input back down only from whoever holds the wheel.
   */
  const deviceScreens = createDeviceScreens({
    notify: (target, frame) => deviceChannel.notify(target, frame),
    holderOf: (target, botId) => deviceTakeovers.holder(target, botId),
    onViewerGone: (watch) => deviceTakeovers.viewerGone(watch),
  });
  /*
   * Who holds the wheel of a coworker's browser on one of those machines. The gateway asks it before
   * every action it would send there, and a person whose last screen closes hands the wheel back.
   */
  const deviceTakeovers = createDeviceTakeovers({
    stillWatching: (target, botId, userId) =>
      deviceScreens.watching(target, botId, userId),
    // In the device's own tenant: the handback happened on the owner's machine, to the owner's Bot.
    onReleasedOnDisconnect: ({ target, botId, userId }) =>
      void recordPersonAuditEvent(bootAuditStore, target.tenantId, {
        eventType: "computer.control_released",
        targetType: "computer",
        targetId: botId,
        payload: {
          bot: botId,
          actor: userId,
          device: target.deviceId,
          reason:
            "The person's live screen closed, so control went back to the coworker.",
        },
      }).catch(() => undefined),
  });
  /*
   * What this tenant's plan allows, read from their own subscription.
   *
   * One service, four write paths (ticket 022): a coworker, a machine, a connected model and a task all
   * ask it before they are written, and the answer they get is the same arithmetic the usage panel
   * shows.
   */
  const quota = createQuotaService(database);
  /*
   * Which model each coworker speaks with, read from this tenant's own model library.
   *
   * Built here rather than inside `copilot.ts`, because that module has never held the database handle
   * and this one already holds the vault: a binding is a row plus a key, and neither belongs in the
   * runtime wiring. Absent binding, absent model — the deployment's own answers, as before, but
   * metered now (audit defect #11): the runtime hands the resolver the deployment model it would have
   * spoken, and the resolver wraps it with the same meter a bound model gets.
   */
  /*
   * Where a tenant's model base URL may point (audit defect #6): only the development private-host
   * opt-in (refused in production by `config.ts`), so a developer's local provider still answers.
   *
   * Deliberately NOT `config.agentEndpointAllowedHosts`. Those are hosts an operator opened for agent
   * endpoints; reusing them here would hand every tenant (model routes need only `requireUser`) a
   * plain-http path to those internal services on any port, with the response read back as model
   * output. A model allowlist, if one is ever wanted, is its own setting, empty by default.
   */
  const modelOutbound = {
    // Read on its own, not through `config.computer`: a local model needs no Bot computer.
    allowPrivateHosts: config.modelEndpointsAllowPrivateHosts,
  };
  const tokenCallSink = databaseTokenCallSink(database);
  const resolveNamedAgentModel = createNamedAgentModelResolver(
    database,
    credentialStore,
    config.keyEncryptionKey,
    tokenCallSink,
    { outbound: modelOutbound },
  );
  const resolveAgentModel = modelOf(resolveNamedAgentModel, tokenCallSink);
  const agentProfileStore = createAgentProfileStore(
    database,
    config.managedAgent?.endpoint,
    agentVault,
  );
  // Read here rather than beside the synchronise below, because the package names the deployment and
  // the channel store needs that name before it can mint a thread id.
  const tenantPackage = await startup.step(() =>
    loadTenantPackage(config.tenantPackageDirectory),
  );
  // The package's id unless DEPLOYMENT_ID says otherwise, and the id the deployment was set up under
  // if the package has since been renamed. See `deploymentNameOf`, which frames its own read.
  const deploymentId =
    config.deploymentId ??
    (await startup.step(() => deploymentNameOf(database, tenantPackage)));
  const threadIdentity = createThreadIdentity(deploymentId);
  const baseChannelStore = createChannelStore(
    database,
    agentProfileStore,
    threadIdentity,
  );
  /**
   * A person spoke in one of their conversations. Bound once memory defaults exist (memory/defaults.ts):
   * a conversation with one Bot switches on that Bot's research and memory sources for this person.
   */
  let personSpoke:
    | ((ownerUserId: string, channelId: string) => void)
    | undefined;
  const channelStore: ChannelStore = {
    ...baseChannelStore,
    async recordActivity(actor, channelId, activity, source) {
      await baseChannelStore.recordActivity(actor, channelId, activity, source);
      if (activity.agentId === null) personSpoke?.(actor.id, channelId);
    },
  };
  const channelEvents = createChannelEventHub();
  /**
   * Which components each Bot may answer with.
   *
   * Nothing is seeded here. The catalogue is a fact about the build; a fork that ships four components
   * of its own should start with four rows, and the only thing that can enumerate them is
   * the app that compiled them. It announces itself on load; this process learns what exists from that,
   * and owns only what may be done with it.
   */
  const componentStore = createComponentStore(database);
  // Its own connection is held for the life of the process; announced activity from any instance
  // arrives here and is fanned out to connected members.
  await startup.acquire(
    () => startChannelActivityListener(config.databaseUrl, channelEvents),
    (listener) => listener.stop(),
  );
  const roleRepository = createRoleRepository(database);
  const runtimeAgentsForActor = createRuntimeAgentLoader(
    database,
    agentVault,
    config.managedAgent,
  );
  /*
   * Unscoped on purpose: whoever builds a Bot opens the frame of the person it is for — the runtime
   * around each whole request (or the catalogue frame for nobody), a hop around its `agentFor`, and
   * `buildAgentFor` around a routine's owner. Read outside a frame, a person's own Bots are invisible
   * and addressing one answers "Agent not found" with nothing on screen.
   */
  await startup.step(() =>
    synchronizeTenantPackage(
      database,
      tenantPackage,
      /*
       * In a deployment with no sign-in there is exactly one person, and the package's channels are
       * theirs; without this they belong to nobody and every one of them answers "Could not load this
       * channel." A deployment with providers gets its channels per person when that person is
       * provisioned instead -- see ticket 004 -- so nothing is claimed here on their behalf.
       */
      config.singleUser ? [DEV_ACTOR.id] : [],
    ),
  );
  /*
   * Built before `auth`, because the deny list is consulted during sign-in and the store is what
   * holds it. It needs the administrator list too, so it can tell the screen which people the
   * deployment's configuration has already decided about.
   */
  const peopleStore = createPeopleStore(
    database,
    config.auth?.initialAdminEmails ?? [],
    /*
     * Removing somebody retires what they connected: their plugin credentials and connections, and
     * their linked outside accounts (which keep resolving to them, now refused; the tokens are revoked
     * and every link needs reconnecting). Both halves run whichever fails, and the failure is rethrown
     * after (see retireOwnedAccounts).
     *
     * A closure, because `pluginStore` is built further down: this has to exist before `auth` does,
     * and that one needs the vault and the policy. `pluginStore` is read only when the closure runs —
     * an administrator or the directory removing somebody, never during module initialisation — so by
     * then the binding is there. The linked-account half writes its audit rows through a store made
     * on its own transaction, so it reads no later binding (`bootAuditStore` included). It runs as
     * the removed person, whose rows the links and their trail are (G01).
     */
    (userId, by) =>
      retireOwnedAccounts({
        plugins: () => pluginStore.retireConnectionsFor(userId, by),
        identities: () =>
          runAsTenant(userId, () =>
            retireIdentityLinks(
              database,
              credentialStore,
              (executor) => createAuditStore(executor),
              userId,
              by,
            ),
          ),
        // Removing somebody ends their sessions, so it ends their browsers' Recorders too.
        recorders: () => signOutRecorders(userId, "person_removed"),
      }),
  );
  const identityProviderStore = createIdentityProviderStore(database);
  /*
   * Built before `auth` for the same reason the people store is: sign-in writes to the trail, and the
   * store that receives those rows has to exist before anything can sign in.
   */
  const signInAuditStore = createAuditStore(database);
  /*
   * A person's sign-in ending here ends their browsers' Recorders with it, however it ends: they sign
   * out, their sessions are ended (by them, an administrator, the directory, the identity provider),
   * or they are removed. Retried, and when it still fails the sign-in does not end either
   * (recorder/sign-out.ts). Called only once something ends, which comes after the Recorder's wiring
   * below exists. Their connections are their own rows, so it runs as them (G01).
   */
  const signOutRecorders = (userId: string, ending: string) =>
    runAsTenant(userId, () => recorderExtension.signOut(userId, ending));
  // Its own const so the Recorder can re-check a stored session through `verifySessionQuietly`.
  const organizationAuth = config.organizationAuthUrl
    ? createOrganizationAuth({
        authorityUrl: config.organizationAuthUrl,
        materializeUser: organizationUserStore(database),
        signOutRecorders,
      })
    : undefined;
  // Its own const so the Recorder's connections can last as long as one of its sessions does.
  const betterAuth =
    !organizationAuth && config.auth
      ? createAuth(
          config,
          database,
          (email) => peopleStore.isRevoked(email),
          signInAuditStore,
          {
            signOutRecorders,
            // Read when somebody signs in, by which time `entra` below exists.
            vouchesForMicrosoftToken: (token: string): boolean =>
              entra?.vouches(token) ?? false,
          },
        )
      : undefined;
  /*
   * Microsoft Entra on both sides: a person's app calling OpenBot with their Entra token, and a server
   * an admin marked as reached as the signed-in person called with a token Entra issues for them.
   * Built on Better Auth's sign-in, so only where Microsoft sign-in is what this deployment runs.
   *
   * TENANT-ISOLATED. Everything Entra reads or writes here happens before (or apart from) a person's
   * own work: who a token belongs to, whether they are still admitted, their stored Microsoft sign-in
   * and the tokens minted from it are identity rows, which carry no tenant and are read as `platform`
   * (G01), like the request guard reads a session. What the person then does runs in their own frame,
   * opened by the guard once `sessionFrom` has named them.
   */
  const entraService =
    betterAuth && config.auth?.microsoft
      ? createEntra({
          microsoft: config.auth.microsoft,
          authConfig: config.auth,
          auth: betterAuth,
          database,
          isRevoked: (email) => peopleStore.isRevoked(email),
        })
      : undefined;
  const entra = entraService
    ? {
        sessionFrom: (headers: Headers) =>
          asPlatform(() => entraService.sessionFrom(headers)),
        tokenFor: (userId: string, scope: string) =>
          asPlatform(() => entraService.tokenFor(userId, scope)),
        vouches: (token: string) => entraService.vouches(token),
      }
    : undefined;
  // The plugin store takes `entra` too, for MCP servers an admin marked as reached as the signed-in
  // person (on-behalf-of, X6): see `createPluginStore` below.
  const auth: AuthService | undefined =
    organizationAuth ??
    (betterAuth && entra ? withEntraBearer(betterAuth, entra) : betterAuth);
  /*
   * Who is asking, for a CopilotKit request: one resolver, because a run has two questions to answer
   * about the same person, whose threads and memory these are and which coworkers they may run.
   *
   * Asked of the identity tables, which are the deployment's, before there is anybody to act as:
   * `platform`, like the request guard (G01). So is a Recorder's token, answered only on the capture
   * pass, and only after the Recorder's wiring below exists.
   *
   * An unauthenticated request resolves to a person who owns nothing rather than an error
   * (`identifyActor`), so the runtime can still describe itself: `mountCopilotRuntime` reads that
   * `/info` in the catalogue frame (`system`), where no person's row and no team row is visible, and
   * refuses this actor every other runtime route, because a thread must belong to somebody (G01-E P16f).
   */
  const { resolveRequestActor, identifyUser, identifyActor } =
    createRequestActor({
      singleUser: config.singleUser,
      // Framed as `platform` by the Recorder's wiring itself (recorder/wiring.ts).
      resolveRecorder: (request) => recorderExtension.resolve(request),
      getSession: async (headers) =>
        (await asPlatform(() => auth?.api.getSession({ headers }))) ?? null,
      rolesForUser: (id) => asPlatform(() => roleRepository.rolesForUser(id)),
    });
  // Where a person's own OpenBot browser may go: not where Bots may, but where their browser on their
  // own laptop would (browser/egress.ts). On a host-side computer of people's browsers that is their
  // own desktop, so everywhere.
  const personBrowserPolicy = personBrowserEgressPolicy({
    native: config.browser !== undefined,
    allowPrivateHosts: config.computer?.allowPrivateHosts ?? false,
    openbotUrls: [config.publicUrl, config.appUrl],
    // Without the optional Intelligence there is no gateway for the Recorder to stream to.
    gatewayUrl: config.intelligence?.gatewayWsUrl ?? "",
  });
  // Each computer is pushed its network policy on the way to the action that woke it, because a
  // computer refuses every connection until one arrives (see `withPolicyPushOnWake`).
  // Device mode with no container of its own still gets a gateway: its actions go to the tenant's
  // machines, and the provider only answers lifecycle questions (audit defect #12).
  // A person's own browser is found where it runs (OPENBOT_BROWSER_URL, else the same provider) and
  // pushed theirs.
  const computerProvider = computerProviderFor(
    config.tenantRuntime,
    config.computer
      ? withPolicyPushOnWake(
          withPersonBrowsers(
            createComputerProvider(config.computer),
            config.browser?.url,
            config.edition,
          ),
          {
            policyForBot: (botId) =>
              isPersonBrowserId(botId)
                ? Promise.resolve(personBrowserPolicy)
                : enterpriseControls()?.policyForBot(botId),
            ...(config.computer.token ? { token: config.computer.token } : {}),
            ...(config.webBotAuth ? { webBotAuth: config.webBotAuth } : {}),
          },
        )
      : undefined,
  );
  /** Why Record is refused in a Bot's browser here, or undefined where each Bot has a computer of its
   * own, or the one computer is the one person's (the personal edition). */
  const recordRefused =
    botRecordRefusal(computerProvider, config.edition) ?? undefined;

  if (computerProvider?.warm) {
    void computerProvider.warm();
  }
  // What Bots may do on their computers. Configuration supplies the deployment's default; an
  // administrator can change it while running, and a restart returns to the configured one.
  const policyStore = createPolicyStore(
    config.computer?.policy ?? DEFAULT_ACTION_POLICY,
    database,
  );
  // A boundary an administrator set is read back before the first action is decided, so a restart no
  // longer silently returns to the configured default.
  const policySource = await startup.step(() => policyStore.load());
  /*
   * And kept current afterwards.
   *
   * A boundary an administrator changes arrives at one server. Without this, every other server keeps
   * enforcing what it read at boot, so a new deny rule stops roughly one action in N while the screen
   * and the audit row both report success. See policy-listener.ts.
   */
  await startup.acquire(
    () => startPolicyListener(config.databaseUrl, policyStore),
    (listener) => listener.stop(),
  );

  /*
   * Record which boundary this process started with.
   *
   * The trail records the boundary a process starts with, so later audit reads can distinguish the
   * configured default from any administrator-updated policy that was persisted before restart.
   *
   * Not awaited and never fatal. A deployment must not fail to start because its audit trail is
   * unavailable, and the row is a note for a reader rather than something the server depends on.
   */
  const bootAuditStore = createAuditStore(database);
  // The display components a Bot can draw in a turn with no browser, as the toolkit's turn reads them.
  const headlessComponents = headlessComponentCatalog({
    store: componentStore,
    audit: auditSink(bootAuditStore),
  });
  // One store: the gateway writes through it, a route reads it, and the sweep below takes the old ones out.
  const pageFrameStore = createPageFrameStore(database);
  let deliveryNotifications: (
    scope: DeliveryScope,
    input: {
      id: string;
      text: string;
      kind: "reply" | "question" | "approval";
      requestId?: string;
    },
  ) => Promise<void> = async () => {
    throw new Error("Delivery is not initialized.");
  };
  const authoriseQuestion = async (question: PersonQuestion) => {
    const source = await sourceForCoordinationRun({
      ...question,
      botId: questionConversationBot(question),
      depth: 0,
    });
    if (question.channelId && source?.channelId !== question.channelId)
      throw new ApprovalRefusedError("The saved question source has changed.");
    if (!source)
      throw new ApprovalRefusedError(
        "That conversation is no longer available to this Bot and person.",
      );
    if (
      !(await agentProfileStore.get(
        await actorFor(question.actorId),
        question.botId,
      ))
    )
      throw new ApprovalRefusedError("That Bot is no longer available to you.");
  };
  // The board projector: approvals, runs and routines project into tasks.
  const boardProjector = createTaskProjector(
    database,
    (tenantId) => {
      // Same announce rail the channel roster listens on, so a second server
      // instance's board moves too, not just this process's sockets. The helper
      // runs the lazy statement and logs its failure; it never rejects.
      void announceTaskUpdate(database, tenantId);
    },
    quota,
  );
  /*
   * Spec I3: a run that asked its person a question parks its card in 需要操作, and the answer moves it
   * back. The questions write through the plain projector, and every card the runners finish goes through
   * `withQuestionParking`: `ask_person` lets the turn end, so a park written while it was running would be
   * overwritten by that close.
   */
  const approvalQuestions = createApprovalQuestions(
    database,
    authoriseQuestion,
    boardProjector,
  );
  const taskProjector = withQuestionParking(boardProjector, approvalQuestions);
  const storedApprovals = createApprovalStore(database, taskProjector);

  /*
   * Restart recovery (`taskProjector.reclaimAbandoned` and the run reapers) is started below, once the
   * pipeline store exists — inside `startup.acquireSync`, so importing this file never starts a timer.
   * See `recovery/abandoned-work.ts`.
   */
  /*
   * The deployment's approval service (approvals/wiring.ts): the stored approvals, told the person's
   * channel when one opens; the question store above; and a computer tool resumed only when its call
   * is really saved in the conversation it claims to come from. Everything it reads that is built
   * further down is reached through a closure, read when an approval opens, never now.
   */
  const approvalService = createServerApprovalService({
    storedApprovals,
    config,
    sourceForCoordinationRun: (run) => sourceForCoordinationRun(run),
    agentProfileStore,
    actorFor: (ownerUserId) => actorFor(ownerUserId),
    database,
    authoriseQuestion,
    routineIntelligence: {
      getThreadMessages: (input) =>
        routineIntelligence.getThreadMessages(input),
    },
    approvalComputerTools: (ownerUserId, agentId, initiator) =>
      approvalComputerTools(ownerUserId, agentId, initiator),
    review: (prompt, signal) => reviewActions(prompt, signal),
    questions: approvalQuestions,
    /*
     * An approved action is carried out by the server itself, fenced on the approval row: claimed
     * once (approved → consumed) before it runs, its answer saved once before the conversation is
     * continued, and never run again after a crash (that ends as "outcome unknown"). See
     * `docs/restart-recovery.md`. The Root-attested ports are not composed here.
     */
    settlement: "database",
    // Assigned further down, once delivery is wired.
    notify: (scope, input) => deliveryNotifications(scope, input),
  });
  // Check-ins' settings, items, run ledger and pings. See proactive/store.ts.
  const proactiveStore = createProactiveStore(database);
  // Housekeeping on a schedule: audit rows when asked for, screenshots and the check-in ledger always,
  // one timer. See audit-retention.ts.
  startup.acquireSync(
    () =>
      startRetentionSweeps(
        config.databaseUrl,
        config.auditRetentionDays,
        pageFrameStore,
        { proactive: proactiveStore },
      ),
    (resource) => resource.stop(),
  );
  /*
   * In device mode, whose machine a coworker's action runs on (tickets 017 and 018, audit defect #12).
   *
   * The coworker's owner, read from the rows that already exist (`agents/bot-owner.ts`): a Bot belongs
   * to the person who registered it, team Bot or not, and the machines in `registered_devices` are theirs. Nothing here asks the caller
   * which tenant or which device it meant — an address that came from a request body would be the
   * beginning of a very short product.
   *
   * Each task picks one of the tenant's machines and keeps it (see devices/selection.ts). A machine that
   * is away is still a valid pick: the channel parks the action in the durable queue and runs it when
   * the runner reconnects, instead of throwing it away. It never falls back to this deployment's
   * container — a person who said "run on my machine" and got a browser on somebody else's server is not
   * a degraded mode but a wrong answer.
   */
  const deviceSelector = createDeviceSelector({
    // The Bot's OWNER (G01-E): a team Bot is stamped `team`, which has no machines, so the stamp is
    // not the answer for it; its profile's owner is. Read as a narrow identity lookup in bot-owner.ts.
    ownerOf: (botId) => ownerTenantOfBot(database, botId),
    // In the owner's own frame (device store), whoever's turn asked.
    devicesOf: (tenantId) => deviceStore.list(tenantId),
    isReachable: (target) => deviceChannel.isReachable(target),
  });
  async function deviceForBot(botId: string): Promise<DispatchTarget> {
    return await deviceSelector.forBot(botId);
  }

  /*
   * Story RES2: projects on the person's own machines. The context answers, per action, which project
   * a coworker works in on the machine the action resolved to (and refuses rather than falls back,
   * D9), and per run what its prompt says about it. Device mode only (D7): cloud mode has no machine.
   */
  const projectStore = createProjectStore(database);
  const projectContext = createProjectContext(database);
  const loadCurrentProjectForActor =
    (_actorId: string): LoadCurrentProject =>
    async (agentId) =>
      config.tenantRuntime === "device"
        ? projectContext.forPrompt(
            agentId,
            await deviceForBot(agentId).catch(() => null),
          )
        : null;

  /**
   * The same answer in the one form the task board takes: a machine id, or nothing.
   *
   * Asked once when a task opens, with that task's own ref, so the card names the machine the task
   * picked and the task's actions follow it there. Cloud mode records no machine and neither does a
   * tenant with none paired — a conversation that happened without a device still happened, so the
   * board says nothing rather than guessing (tickets 017 and 020).
   */
  async function deviceIdForBot(
    agentId: string,
    taskRef?: string,
  ): Promise<string | null> {
    if (config.tenantRuntime !== "device") return null;
    return await (taskRef
      ? deviceSelector.forTask(agentId, taskRef)
      : deviceSelector.forBot(agentId)
    ).then(
      (target) => target.deviceId,
      () => null,
    );
  }

  /** Where the computer tools act, so their descriptions tell the model the truth (G5, 2026-11-06). */
  const computerMachine =
    config.tenantRuntime === "device"
      ? ("device" as const)
      : ("workspace" as const);
  /**
   * Whether a coworker gets the local-app tools (device MCP bridge §4.1): device mode, and a run that
   * is the Bot owner's own, since the apps are on the owner's paired machine. A teammate using a
   * shared Bot, an admin, or a catalogue Bot (no owner) gets none; the gateway refuses them too.
   */
  const usesDeviceApps = async (agentId: string, actorId: string) =>
    computerMachine === "device" &&
    localAppsAllowed({
      machine: computerMachine,
      owner: await ownerTenantOfBot(database, agentId).catch(() => null),
      actorId,
    });
  /**
   * Whose computer a Bot runs on: the person it acts for, unless the Bot is isolated and its owner
   * still holds the switch (`runsIsolated`, agents/isolation.ts). A provider that cannot make a
   * computer for one Bot (the one shared computer) gives every Bot a seat for the person instead.
   *
   * Facts about the Bot, not anybody's data, and asked from whoever's frame the action runs in (a
   * teammate on a Team Bot reads its owner's switch): so as `platform`, like any "who is this".
   */
  const computerSeats = computerProvider
    ? createComputerSeatResolver({
        runsIsolated: (botId) =>
          asPlatform(() => runsIsolated(database, botId)),
        bot: (botId) => asPlatform(() => botOwnership(database)(botId)),
        canIsolate: computerProvider.isolation === "per-person",
      })
    : undefined;
  const computerGateway = computerProvider
    ? createComputerGateway({
        provider: computerProvider,
        ...(computerSeats ? { seats: computerSeats } : {}),
        // Who each person's computer belongs to, for the admin list. Identity rows, so as `platform`.
        people: async (ids) =>
          new Map(
            (
              await asPlatform(() =>
                database
                  .select({
                    id: users.id,
                    name: users.name,
                    email: users.email,
                  })
                  .from(users)
                  .where(inArray(users.id, ids)),
              )
            ).map((row) => [row.id, { name: row.name, email: row.email }]),
          ),
        /*
         * Whose OpenBot browser each one is: the server minted its Recorder connection under the
         * browser's own install id. Every person's connections, so as `platform`.
         */
        browserOwners: async (computerIds) => {
          const rows = await asPlatform(() =>
            database
              .selectDistinct({ userId: recorderConnections.userId })
              .from(recorderConnections)
              .where(
                and(
                  eq(recorderConnections.via, "openbot-browser"),
                  inArray(
                    recorderConnections.installId,
                    computerIds.map(personBrowserInstallId),
                  ),
                ),
              ),
          );
          const wanted = new Set(computerIds);
          return new Map(
            rows
              .map((row) => [personBrowserId(row.userId), row.userId] as const)
              .filter(([computerId]) => wanted.has(computerId)),
          );
        },
        // Device mode carries the action to the tenant's own machine; cloud mode is untouched.
        ...(config.tenantRuntime === "device"
          ? {
              transport: createRunnerTransport(deviceChannel),
              resolveDevice: deviceForBot,
              // Only `{ref, name}` per app, as the machine's heartbeat reported them (MCP bridge §3.4).
              deviceApps: async (machine) =>
                (await deviceStore.list(machine.tenantId)).find(
                  (device) => device.deviceId === machine.deviceId,
                )?.apps ?? [],
              // --- app discovery (sub-project 3) ---
              deviceReachable: (machine) => deviceChannel.isReachable(machine),
              rememberDeviceApp: (machine, app) =>
                deviceStore.rememberApp(
                  machine.tenantId,
                  machine.deviceId,
                  app,
                ),
              // --- end app discovery ---
              deviceTakeovers,
              // RES2: the frame's root is the coworker's current project, never the model's.
              projects: { resolve: projectContext.resolve },
            }
          : {}),
        /*
         * Story F1, stage 2: a 分身's read-only folders on its person's own machines. Always the
         * runner's transport, even when coworkers otherwise use this deployment's container, because
         * the folder is on the machine and nowhere else. Asked per call: a removed source, or a folder
         * the machine stopped reporting, is not read. The store is built further down; this runs
         * only once a turn is underway.
         */
        folders: {
          resolve: (botId, actorId, root) =>
            avatarSourceStore.folderFor(botId, actorId, root),
          transport: createRunnerTransport(deviceChannel),
        },
        auditStore: bootAuditStore,
        approvalGate: approvalService.gate,
        // Asked before a local app's tool list starts the app on the machine (MCP bridge §4).
        approvalRefusal: approvalService.refusal,
        policy: () => policyStore.get(),
        // In Postgres, so the ref a click carries resolves against the snapshot that produced it even
        // when the snapshot was taken by another server. A Map here would be blank on every replica
        // but the one that snapshotted, and the boundary would decide with no element to look at.
        snapshots: createSnapshotStore(database),
        // So wiping a profile takes the pictures of its signed-in pages with it, which is what the
        // sentence on that button already promised.
        pageFrames: pageFrameStore,
        allowPrivateHosts: config.computer?.allowPrivateHosts,
        token: config.computer?.token,
      })
    : undefined;

  /**
   * What a Bot can reach beyond its own computer.
   *
   * Built here rather than beside the component store because it needs the policy, and it needs the
   * same policy the computer gateway enforces rather than one of its own. A deployment that has said
   * "this Bot may not change anything in Jira" has said one thing, and it should not matter whether
   * the change would arrive through a browser or through a tool call.
   */
  const sandboxedStore = createSandboxedStore(database, bootAuditStore);

  /**
   * Composio, built ONCE: the client the transport calls through and the broker behind the app
   * directory are the same client, and the store below and the routes further down share it.
   *
   * ONE CLIENT, TWO SEAMS, INSTALLED TWO DIFFERENT WAYS, because the two are reached two different
   * ways. The transport is reached as a MODULE — `transportFor` maps a kind to one, exactly as the
   * builtin routines transport above is reached — so there is no constructor to hand a client to and
   * the registry is built at IMPORT TIME, long before there is configuration to read. That is why the
   * actions seam is installed globally, from here, the one place that has the key. The broker has no
   * such problem: it is an ordinary argument, passed to the store and to `createApp`.
   *
   * A DEPLOYMENT WITH NO KEY INSTALLS NEITHER, which is the state the transport is written for rather
   * than an edge of it. The seam stays null and every Composio listing and call refuses saying the
   * connector is not configured here; the store gets no broker and the app directory says the same.
   * Installing a client built from an absent key would turn all of that into a vendor error at first
   * use, which sends an operator looking for a broken Composio instead of at their own configuration.
   */
  /*
   * X5：按配置选出唯一的连接应用提供商（上游 `selectProviderWiring`）。只配 COMPOSIO_API_KEY、不设
   * OPENBOT_BROKER_PROVIDER 时构造的就是以前那一个 Composio 客户端；指明了却没 key、或两个 key 都配了
   * 却没指明，服务起不来（只说变量名，不说值）。Arcade 时它的 broker 桥接成 fork 的形状交给 store 与路由。
   */
  const brokerWiring = selectProviderWiring(config, {
    composio: (apiKey) => createComposioClient(apiKey),
    arcade: (apiKey, options) => createArcadeClient(apiKey, options),
  });
  const composio = brokerWiring.clients.composio;
  const arcade = brokerWiring.clients.arcade;
  if (composio) useComposioClient(composio.actions);
  if (arcade) useArcadeClient(arcade.actions);
  // 部署用的 broker：adapter 的 broker 加上逐个列账号（上游 #1298）；Arcade 时是桥接后的 broker。
  /*
   * 启动时要跨所有租户做的三件事，在同一个平台帧里（不新增平台入口），放在建 store 之前：
   *
   * 一、启用检查（上游 `assertActivatable`）：另一个提供商还持有连接时拒绝启用这一个，直接换环境变量会
   * 留下谁也撤销不了的账号。要等，启动在它失败时停下。
   *
   * 二、这个部署的存储读写哪一家的连接（上游 `storedProvider`，#1017）。这与「哪个 broker 是活动的」是
   * 两个问题：配置指明了就是它；一个 key 都没有（key 后来撤了）时由实际持有的行说它们属于谁，于是留下的
   * Arcade 连接仍读作 Arcade 的，页面如实显示，而不是被当成 Composio 的行读丢。两家都持有行而没有活动的
   * 提供商时拒绝启动：那样的部署里启用任何一边都会被第一条拒绝，所以这里说清楚手动的出路。store、账号
   * 模式与路由都拿这一个值。
   *
   * 三、自带应用的刷新与个人版的默认应用（下面那一段）要用建好的 store，所以它在这个帧里开始、等 store
   * 建好再往下走；之后每一步仍在平台帧里。不 await：启动不等它。
   */
  const storeBuilt = Promise.withResolvers<PluginStore>();
  const storedBrokerProvider = await runAsTenant("platform", async () => {
    if (brokerWiring.provider) {
      const other = brokerWiring.provider === "arcade" ? "composio" : "arcade";
      assertActivatable(
        brokerWiring.provider,
        await connectionsHeldBy(database, other),
      );
    }
    const stored = storedProvider(
      providerDecision(config),
      await connectionOwners(database),
    );
    void (async () => {
      const pluginStore = await storeBuilt.promise;
      /*
       * 「招聘与组群」这个应用：没有它，小管家的默认授予读不到工具。添加应用不授予任何人什么。团队版只在第一次
       * 添加，管理员之后删掉就不再加回来；个人版和 Routines 一样一直在。
       */
      await ensureStaffingServer(
        pluginStore,
        staffingAppMemory(database),
      ).catch((error: unknown) =>
        console.warn(
          "[plugins] 没能添加「招聘与组群」应用，小管家暂时不会招人：",
          error instanceof Error ? error.message : error,
        ),
      );
      if (currentEdition() !== "personal") {
        await pluginStore.refreshOwnListings();
        /*
         * 同一个库从个人版换成团队版时，个人默认写下的宽授予原样生效。只提醒，不删：删掉哪些是管理员的决定。
         */
        if (await personalGrantsLeftInTeam(database))
          console.warn(
            "[plugins] 这个库里还有个人版替每位员工写下的授予（granted_by 以 openbot: 开头）。团队版由管理员逐个授予，请在插件页核对并收回不需要的。",
          );
        return;
      }
      startup.acquireSync(
        () => ({
          stop: startPersonalDefaultApps(
            pluginStore,
            personalDeps,
            personalDefaultAppsMemory(database),
          ),
        }),
        (resource) => resource.stop(),
      );
      return ensureAlwaysOnApp(pluginStore, personalDeps);
    })().catch((error: unknown) => {
      console.warn(
        "[plugins] OpenBot's own apps' tools could not be brought up to date:",
        error instanceof Error ? error.message : error,
      );
    });
    return stored;
  });
  if (!brokerWiring.provider && storedBrokerProvider !== "composio") {
    console.warn(
      `[plugins] 没有设置任何连接应用提供商的 API key，所以没有活动的 broker：连接应用现在既不能连接也不能断开。已有的连接读作 ${BROKERED_PROFILE[storedBrokerProvider].vendor} 的。`,
    );
  }

  /*
   * 单用户安装在 broker 那边自己的名字（上游 #927），在 store 解析任何人的账号之前定下。每台单用户安装的
   * 那个人都是 `dev-local-user`，没有这一步，共用一把 key 的每台安装在厂商那边共用一组账号。仍记在那个
   * 共享名下的连接在这里退役（只删本地行），从不在厂商那边结束。见 `ensureSingleUserIdentity`。
   * 要登录的部署这里什么也不写，换名函数原样交回每个人自己的 id。
   */
  const vendorNameOf = vendorNameFor(
    await startup.step(() =>
      ensureSingleUserIdentity(database, {
        singleUser: config.singleUser,
        provider: brokerWiring.provider,
      }),
    ),
  );
  const builtBroker = composio
    ? brokerWithAccounts(composio)
    : arcade
      ? asComposioBroker(arcade.broker)
      : undefined;
  // store 与路由拿到的是同一个换过名的 broker：路由自己发起的授权也以这台安装自己的名字发出。
  const composioBroker = builtBroker
    ? underOwnName(builtBroker, vendorNameOf)
    : undefined;
  if (arcade) {
    const notice = arcadeVerifierNotice(config.publicUrl, {
      ownsProject: ownsBrokerProject(config),
    });
    if (notice) console.warn(`[plugins] ${notice}`);
  }

  /**
   * The private sign-in form and the Passwords vault. A Bot asks to be signed in; the person answers
   * in a form outside the conversation; the computer types the login. See passwords/service.ts.
   */
  const signInService = computerGateway
    ? createSignInService({
        store: createPasswordStore(database),
        gateway: computerGateway,
        // The admin switch, read at call time; installed further down, and absent in scripts.
        passwordManagerEnabled: async (ownerUserId) =>
          (await enterpriseControls()?.capabilityFor(
            ownerUserId,
            "passwordManager",
          )) ?? true,
        encryptionKey: config.keyEncryptionKey,
        auditStore: bootAuditStore,
        notify: createSignInNotifier({
          database,
          appUrl: config.appUrl,
          notify: (scope, input) => deliveryNotifications(scope, input),
        }),
        onResolved: (request) =>
          createSignInResumer({
            database,
            resumeResponsibility: (owner, runId, result) =>
              responsibilityStore.resumeWaiting(owner, runId, result),
            continueTurn: ({
              ownerUserId,
              botId,
              snapshot,
              result,
              messageId,
            }) =>
              approvalContinuationRunner({
                ownerUserId,
                routineId: "sign-in",
                agentId: botId,
                threadId: snapshot.threadId,
                instruction: "",
                initiator: snapshot.initiator ?? PERSON_INITIATOR,
                continuation: { snapshot, result, messageId },
              }),
            recordReply: async ({
              ownerUserId,
              channelId,
              botId,
              text,
              messageId,
            }) => {
              await channelStore.recordActivity(
                await actorFor(ownerUserId),
                channelId,
                { text, agentId: botId, at: new Date() },
                { id: messageId },
              );
            },
          })(request),
      })
    : undefined;

  /*
   * 个人版的默认（`plugins/personal-defaults.ts`，X4）：个人版里应用列出的每个工具给每位员工，新技能给每位
   * 员工，每位员工都参与自动学习。授予在那一个人（`DEV_ACTOR`）的帧里写。团队版里包装原样放行。
   */
  const personalDeps = personalDefaultsDeps(
    database,
    DEV_ACTOR.id,
    bootAuditStore,
  );
  /*
   * 共享使用批准（X3，上游 #757）：谁可以驾驶用到 Shared 应用团队账号的运行。批准记在员工主人名下，
   * 闸门在主人帧里只读它（`plugins/shared-use-store.ts`）。职责的触发来源由同一个存储读，读不到的职责
   * 按外部输入处理。
   */
  const sharedUseStore = createSharedUseStore(database);
  const sharedAudience = createSharedAudience(
    database,
    sharedUseStore,
    bootAuditStore,
  );
  const storeWithoutDefaults = createPluginStore({
    database,
    auditStore: bootAuditStore,
    credentials: credentialStore,
    encryptionKey: config.keyEncryptionKey,
    policy: () => policyStore.get(),
    approvalGate: approvalService.gate,
    // A connector send to other people asks the owner first. See plugins/share-target.ts.
    privateShareCheck: createPrivateShareCheck({
      approvals: approvalService.store,
    }),
    /*
     * Where a vendor sends people back, for a vendor whose client this deployment registers itself.
     *
     * The same value the connect and callback routes build, from the same config field, because it has
     * to match what was registered character for character. Undefined without a public URL, which is
     * the honest state: there is nowhere for a consent flow to come back to, so there is nothing worth
     * registering.
     */
    redirectUri: config.publicUrl
      ? redirectUriFor(config.publicUrl)
      : undefined,
    /*
     * The same client the transport seam above was installed with, never a second one. Enabling an
     * app writes the row here and creates the auth config at the vendor, and a store holding a
     * different client from the one the call goes out through is two deployments' worth of state
     * behind one screen. Undefined without a key, which leaves enabling an app refused rather than
     * attempted.
     */
    broker: composioBroker,
    // 只有单用户安装带上换名；要登录的部署不给这个选项，store 与以前完全一样。
    ...(config.singleUser ? { personVendorId: vendorNameOf } : {}),
    /*
     * Entra on-behalf-of, for a server an admin marked as reached as the signed-in person (上游
     * #931). The framed door above: the person's sign-in and the tokens minted from it are identity
     * rows read as `platform`, while the call that asks runs in the person's own frame. With it go
     * the resources the deployment registered (MICROSOFT_OAUTH_OBO_RESOURCES) and OpenBot's own API,
     * so a scope is only ever minted for a registered resource and sent to its host (X6, I-2).
     */
    ...(entra && config.auth?.microsoft
      ? {
          entra: {
            tokenFor: entra.tokenFor,
            resources: config.auth.microsoft.oboResources ?? [],
            own: openBotResources(
              config.auth.microsoft.clientId,
              config.auth.microsoft.apiScope,
            ),
          },
        }
      : {}),
    /*
     * The asker's consent for a call on their own Microsoft sign-in through somebody else's Team
     * Bot, asked against the row the token is sent for (X6, re-review N-1). `teamBots` is built
     * further down; this is only called once requests run.
     */
    entraConsent: ({ actorId, botId, serverId }) =>
      teamBots.ownSignInConsent(actorId, botId, serverId),
    // 只在不是 Composio 时给：只配 COMPOSIO_API_KEY 或什么都没配、也没有 Arcade 行的部署，store 与以前一样。
    ...(storedBrokerProvider === "arcade"
      ? { brokerProvider: "arcade" as const }
      : {}),
    sharedUse: sharedAudience.gate,
    sharedAdmits: sharedAudience.admitsPerson,
    responsibilitySources: sharedUseStore.sourcesOf,
  });
  /*
   * 小管家默认会招人、组群（`staffing/default-grant.ts`）：在这个人自己的运行帧里读小管家的授予时补一次，
   * 两个版本都一样，不跨租户。
   */
  const pluginStore = withStaffingDefault(
    withPersonalDefaults(storeWithoutDefaults, personalDeps, bootAuditStore),
    {
      database,
      disabled: (avatarId) =>
        approvalService.disabledTools(currentTenant(), avatarId),
    },
  );
  /*
   * 应用的账号模式 Personal ⇄ Shared（X1，上游 #757）：切到 Shared 时写「写之前先问」团队规则，团队账号
   * 的身份由部署 id 铸出。
   */
  const accountModes = createAccountModeSwitch({
    store: pluginStore,
    teamRules: storedApprovals.policy,
    deploymentId,
    audit: bootAuditStore,
    ...(storedBrokerProvider === "arcade"
      ? { provider: "arcade" as const }
      : {}),
  });

  // Logo metadata is optional; a vendor outage must not prevent the API from starting.
  if (composio) {
    void backfillComposioLogos(database, composio.broker).catch(() => {
      console.warn(
        "Composio app logos could not be updated. Existing icons remain available; missing logos will be retried on the next restart.",
      );
    });
  }

  /*
   * 个人版：先替还没做过选择的人把「改动之前先问」打开，再开始任何授予（下面的常开应用与默认应用）。写不进去
   * 只记警告：之后每一次给员工应用动作之前都会再写一次，写不进去那次就不给。
   */
  await ensurePersonalAskBeforeChanges(personalDeps).catch((error: unknown) =>
    console.warn(
      `[plugins] 没能在启动时打开「改动之前先问」，给员工应用动作之前会再试：${error instanceof Error ? error.message : String(error)}`,
    ),
  );
  /*
   * 自带应用（Routines、Google Drive、百度网盘）保存的工具，刷新到这一版的代码（见
   * `refreshOwnListings`）。跨所有租户读 `mcp_servers`、按每台服务器的 tenant 写 `mcp_tools`，所以
   * 在平台帧里跑。不 await：启动不等它，失败只记日志，保存的清单照常可用，下次启动再试。
   *
   * X5：同一个平台帧里先做连接应用提供商的启用检查（上游 `assertActivatable`）：另一个提供商还持有
   * 连接时拒绝启用这一个，直接换环境变量会留下谁也撤销不了的账号。这一步要等，启动在它失败时停下。
   *
   * 个人版里还要在刷新之后把 Routines 加上（没有时）并把每个应用的全部工具给每位员工
   * （`ensureAlwaysOnApp`，先刷新、后授予，所以这一版新加的工具同一次启动就到每位员工手上）。两件事放在
   * 同一条链上，不会有两次刷新同时替换同一个应用的工具行。
   *
   * 个人版的默认应用（Parallel 联网搜索）也在这同一个平台帧里开始：添加应用、要它的工具都是写 `team` 行的
   * 服务器级的事；重试的计时器在这一帧里排下，之后每一次重试仍在平台帧里。授予由 `personalDeps` 在那个人
   * 自己的帧里写。
   */
  // 平台帧在上面（建 store 之前）已经打开，里面那一段等的就是这一下：store 建好了，开始刷新与默认应用。
  storeBuilt.resolve(pluginStore);

  if (currentEdition() === "personal") {
    /*
     * 个人版的技能与学习（X4）。每一步失败都只是警告：每位员工第一次被列出或运行时会再查一次，下一次启动
     * 也会再试。它们只碰那个人自己的行和部署的学习设置，在他自己的帧里做。
     */
    const warnPersonal = (what: string) => (error: unknown) =>
      console.warn(
        `[plugins] ${what}，下一次启动会再试：${error instanceof Error ? error.message : String(error)}`,
      );
    await ensurePersonalSkills(pluginStore, personalDeps).catch(
      warnPersonal("没能在启动时把技能给每位员工"),
    );
    await ensurePersonalSkillsOwned(database, DEV_ACTOR, bootAuditStore).catch(
      warnPersonal("没能把你写的技能记为你的"),
    );
    await ensurePersonalLearning(personalDeps, bootAuditStore).catch(
      warnPersonal("没能让每位员工都参与自动学习"),
    );
  }

  /*
   * 工具按旧版清单读法存下的 Composio 应用，重新列一次，让升级上来的部署记下和全新安装一样的东西
   * （见 `relistOutdatedBrokeredApps`）。只有配置了 Composio 才启动。不 await；还有应用落后就按退避
   * 间隔重试，退避表每一档都走到，在最长一档上连续失败 3 次才放弃；同一个应用只报一次。每一轮跨所有租户读写 `mcp_servers`/`mcp_tools`，所以在平台帧里跑。
   */
  if (composio) {
    startup.acquireSync(
      () => ({
        stop: startBrokeredRelist({
          relistOutdatedBrokeredApps: (options) =>
            runAsTenant("platform", () =>
              pluginStore.relistOutdatedBrokeredApps(options),
            ),
        }),
      }),
      (resource) => resource.stop(),
    );
  }

  /**
   * Routines, and the one moment its tools are told what to act on.
   *
   * The builtin transport is reached as a MODULE — `transportFor` maps a kind to one — so there is no
   * constructor to hand a store to and no request-time seam either: the transport registry is built at
   * import time, long before there is a database. So the store is installed here, once, from the place
   * that already owns building stores. Without this call the four tools are advertised and every one of
   * them refuses, which is the honest behaviour for a deployment that never wired it, and would be a
   * silent outage for this one.
   */
  const routineStore = createRoutineStore(database);
  useRoutineTools(routineStore);
  // 个人版的常开应用、技能与学习在上面 `ensureAlwaysOnApp` 一段里接上（X4）。
  const responsibilityStore = createResponsibilityStore(database, {
    resolveTarget: async (ownerUserId, agentId, channelId) => {
      const actor = await actorFor(ownerUserId);
      const [bot, channel] = await Promise.all([
        agentProfileStore.get(actor, agentId),
        channelStore.get(actor, channelId),
      ]);
      return bot && channel?.active && channel.agentIds.includes(agentId)
        ? { threadId: channel.threadId }
        : null;
    },
  });
  const responsibilityBindings = createResponsibilityBindingStore(database, {
    store: credentialStore,
    reader: credentialStore,
    encryptionKey: config.keyEncryptionKey,
  });
  /*
   * Event triggers. Every kind authenticates with its vendor's own scheme and then goes through the
   * responsibility engine's one ingest (event + run + queue in one transaction), so dispatch is the
   * same headless AG-UI path as every other responsibility run. `responsibilityEngine` is read at
   * delivery time, long after it is constructed further down.
   */
  /*
   * Slack access: the owner's own linked Slack identity comes from the delivery bindings (read at call
   * time; `deliveryStore` is built further down), and channel membership from the Slack pairing via
   * `useSlackChannelMembership`. Until the pairing installs that, Slack triggers are refused.
   */
  const slackAccess = slackAccessFrom(async (ownerUserId, teamId) => {
    const bindings = await deliveryStore.listBindings(ownerUserId);
    return (
      bindings.find(
        (binding) =>
          binding.transport === "slack" &&
          binding.realm === teamId &&
          binding.enabled,
      )?.identity ?? null
    );
  });
  const responsibilityTriggerStore = createTriggerStore(
    database,
    {
      store: credentialStore,
      reader: credentialStore,
      encryptionKey: config.keyEncryptionKey,
    },
    { slackAccess },
  );
  const triggerIngressDeps = {
    directory: responsibilityTriggerStore.directory,
    ingest: (event: unknown) => responsibilityEngine.ingest(event),
    auditStore: bootAuditStore,
  };
  const inboundEmail = inboundEmailConfigFromEnv(process.env);
  const responsibilityTriggers = {
    store: responsibilityTriggerStore,
    emailDomain: inboundEmail?.domain ?? null,
    ingressRoutes: createTriggerIngressRoutes(triggerIngressDeps),
    emailRoutes: inboundEmail
      ? createEmailTriggerRoutes({
          ...triggerIngressDeps,
          config: inboundEmail,
          verify: createSnsVerifier(fetchSnsText),
          confirmSubscription: fetchSnsText,
        })
      : null,
  };
  // The Slack pairing calls `ingestSlackEvent` from responsibilities/slack.ts; this installs it.
  useSlackTriggerIngest(
    createSlackTriggerIngest({ ...triggerIngressDeps, slackAccess }),
  );
  // Bots manage triggers from chat through the builtin Routines transport; keys never reach the model.
  useTriggerTools({
    triggers: responsibilityTriggerStore,
    responsibilities: responsibilityStore,
    publicUrl: config.publicUrl ?? null,
    emailDomain: inboundEmail?.domain ?? null,
  });
  // And goals, through the same transport: asked for a goal, a Bot makes one. See chat-tools.ts.
  useGoalTools({
    store: responsibilityStore,
    // Read when a goal is run, long after the engine further down is made.
    engine: { ingest: (event) => responsibilityEngine.ingest(event) },
    conversationFor: routineStore.conversationFor,
    linkRoutine: routineStore.linkGoal,
  });

  /**
   * Where a Bot handing work to another gets decided.
   *
   * The queue is the one #216 shipped, shared with the idle-computer culler and with routines: durable
   * work claimed by whichever replica gets to it, leased so a dead replica's work comes back. A hop is
   * that, because the Bot being addressed will very likely run on a different pod from the Bot that
   * addressed it, and a hop held in memory is lost the moment either is rescheduled.
   */
  const handoffDesk = createHandoffDesk({
    queue: createWorkQueue(database),
    profiles: agentProfileStore,
    // Read per hop and never held, so revoking a grant applies to the next hop rather than after a
    // restart.
    mayAddress: async (fromBotId, toBotId) =>
      (
        await pluginStore
          .botsReachableFrom(fromBotId)
          // A grant that cannot be read is not a grant. Failing closed here costs a hop; failing open
          // would let a Bot address one nobody gave it because the database blinked.
          .catch(() => [] as string[])
      ).includes(toBotId),
    // The same grants, listed, so a name that matches no Bot is answered with the ones it may ask.
    addressable: (fromBotId) => pluginStore.botsReachableFrom(fromBotId),
    /*
     * Deferred rather than passed directly, because `actorFor` is defined further down with the rest
     * of the run-building collaborators. It is only ever called during a hop, long after this module
     * has finished loading.
     */
    actorFor: (userId) =>
      // Null rather than a throw: see the seam's own note. A role that cannot be read is not a role,
      // and the hop is refused with a sentence rather than ending the run in silence.
      actorFor(userId).catch(() => null),
    auditStore: bootAuditStore,
    caps: config.handoff,
    // The asking conversation, told it is now waiting on the Bot it asked. See `onOffered`.
    onOffered: (threadId) => channelStore.signalWork(threadId),
  });

  // The deployment's own boot notes, so `platform`: unframed they were `system`, which every tenant's
  // trail shows (G01).
  void recordPlatformAuditEvent(bootAuditStore, {
    eventType: "computer.policy_loaded",
    targetType: "policy",
    initiator: DEPLOYMENT_INITIATOR,
    payload: {
      ...policyStore.get(),
      source:
        policySource === "the database"
          ? "an administrator, saved in this deployment"
          : config.computer?.policy
            ? "configuration"
            : "the built-in default",
      note:
        policySource === "the database"
          ? "Set while running and kept. A restart returns to this."
          : "The deployment default. Anything an administrator sets from here is kept.",
    },
  }).catch(() => undefined);

  /*
   * Record whether each Bot has a computer of its own.
   *
   * A shared provider is a fine way to run on a laptop, but the shared isolation state must be visible
   * rather than inferred.
   */
  const isolation = describeComputerIsolation(computerProvider);

  void recordPlatformAuditEvent(bootAuditStore, {
    eventType: "computer.isolation_loaded",
    targetType: "computer",
    initiator: DEPLOYMENT_INITIATOR,
    payload: {
      isolation: isolation.isolation,
      note: isolation.note,
    },
  }).catch(() => undefined);

  console.info(
    JSON.stringify({
      type: "computer-isolation",
      provider: computerProvider ? computerProvider.name : "none",
      isolation: isolation.isolation,
      ...(isolation.warning ? { warning: isolation.warning } : {}),
    }),
  );
  // Which computer a coworker acts on, and why, once per boot. Production with TENANT_RUNTIME unset
  // is `device` (F6), so a deployment whose Bots now ask for a paired machine can see the reason here.
  console.info(
    JSON.stringify({
      type: "tenant-runtime",
      runtime: config.tenantRuntime,
      reason: config.tenantRuntimeReason,
    }),
  );
  /**
   * One Bot's endpoint must not take down the platform.
   *
   * Restarting a remote agent while a run is in flight resets the socket. The rejection reaches the top
   * of the process, and Bun kills the whole server: every other person's conversation, every other Bot
   * and the admin surface go with it, because somebody redeployed their own agent.
   *
   * That blast radius is created by design the moment people can register their own endpoints,
   * so it belongs to that feature. A remote agent is untrusted infrastructure: it will restart, it will
   * time out, it will close a stream halfway through, and none of that is exceptional.
   *
   * Logged loudly rather than swallowed. A process that hides unhandled rejections is worse than one
   * that dies, so this prints the full reason and keeps serving; what it must never do is stay quiet.
   */
  process.on("unhandledRejection", (reason) => {
    console.error(
      JSON.stringify({
        type: "unhandled-rejection",
        message: reason instanceof Error ? reason.message : String(reason),
        code:
          reason && typeof reason === "object" && "code" in reason
            ? String((reason as { code: unknown }).code)
            : undefined,
        note: "The server kept running. A remote agent's connection failing must not stop everyone else.",
      }),
    );
  });

  /**
   * The watch on Bot streams, built once and shared by every run.
   *
   * It has to outlive the request that opens a stream: the sweep that notices a silent one is still
   * running long after the run request has been answered, because in Intelligence mode that request is
   * answered in about a second and the Bot keeps writing for as long as it has something to say.
   *
   * The same audit store as everything else, so a Bot that hangs is recorded beside what Bots do.
   */
  const stallGuard = createStallGuard({
    stallMs: config.agentStallTimeoutMs,
    auditStore: bootAuditStore,
  });

  // Before anything reads the model environment: blank base URLs removed, Anthropic given its `/v1`.
  normalizeModelBaseUrls();
  // DeepSeek 的思考模式要求传回每一轮的思考内容，员工的历史里没有，所以对它的对话请求关闭思考。
  // 见 models/deepseek-thinking.ts；`DEEPSEEK_THINKING=enabled` 保留 DeepSeek 自己的默认。
  if (installDeepSeekThinkingOff()) {
    console.info(
      JSON.stringify({ type: "deepseek-thinking", thinking: "disabled" }),
    );
  }
  const runtimeModel = runtimeModelForEnvironment(tenantPackage.model);
  /**
   * Where local Intelligence's Learning thinks on the person's plan, with a record of what became of
   * each call so Settings can say why a run failed. Absent off a plan or without Desktop's secret.
   */
  const learningModelEndpoint = learningModelEndpointFor(
    runtimeModel.plan,
    process.env.OPENBOT_LEARNING_MODEL_TOKEN,
    createLearningModelCalls(),
  );
  // And before any Bot's model is resolved: behind a gateway, the API that model takes tools on (chooseOpenAIApi).
  if (chooseOpenAIApi(runtimeModel) === "responses")
    console.info(
      JSON.stringify({
        type: "openai-api",
        api: "responses",
        model: runtimeModel.defaultModel,
        message: `${runtimeModel.defaultModel} takes tools only through the Responses API, so the built-in Bots call /responses at OPENAI_BASE_URL. Set COPILOTKIT_OPENAI_API=chat to call /chat/completions instead.`,
      }),
    );

  /** The deployment's model key, resolved per call so a credential rotated a moment ago is used next. */
  const resolveRuntimeModelApiKey = () =>
    resolveModelApiKey({
      encryptionKey: config.keyEncryptionKey,
      reader: credentialStore,
      provider: runtimeModel.provider,
      keyId: tenantPackage.model.credentialSecretRef,
      environment: process.env,
    });

  /*
   * Kept, with a stamp naming the key it asked about, so the setup checklist can repeat the answer
   * for that key and say "not checked yet" for any other: whether the key can call the model the Bots
   * run on. A key without access to it otherwise passes every start-up check and fails at the first
   * message, in front of whoever sent it. The checklist's "Check again" asks again through the same
   * function. Never rejects: a failed read reads as not checked.
   */
  const checkModelAvailability = () =>
    reportModelAvailability({
      provider: runtimeModel.provider,
      model: runtimeModel.defaultModel,
      apiKey: resolveRuntimeModelApiKey,
    });
  /*
   * Where nobody is behind a read of the deployment's own model key, it is read as `platform` (G01):
   * the check at boot, and the model list's reads at boot, on its timer and on a provider's refusal.
   * The key is the deployment's (`credentialSecretRef`, a `system` row), never a person's.
   */
  const asDeployment = <T>(work: () => T): T => asPlatform(work);
  // At boot there is nobody to act as: the deployment's own key is read as `platform` (G01).
  const modelCheckAtBoot = asDeployment(async () => {
    const { stamp } = await modelKeyOf({
      plan: Boolean(runtimeModel.plan),
      provider: runtimeModel.provider,
      keyId: tenantPackage.model.credentialSecretRef,
      credentials: credentialStore,
      environment: process.env,
    });
    return { outcome: await checkModelAvailability(), stamp };
  }).catch(() => undefined);

  const intentRouter = createIntentRouter({
    complete: createModelCompleter({
      model: runtimeModel,
      /*
       * Picking a Bot sits between send and the conversation opening; see `routingModelFor`. Never a
       * model the admin's allowlist leaves out: the router then stays on the deployment's own model,
       * which the allowlist already governs for every run.
       */
      fastModel: () => {
        const fast = routingModelFor(runtimeModel, process.env);
        const allowlist =
          enterpriseControls()?.snapshot()?.settings.modelAllowlist;
        return fast &&
          (!allowlist?.enabled ||
            allowlist.models.includes(`${runtimeModel.provider}/${fast}`))
          ? fast
          : undefined;
      },
      resolveApiKey: resolveRuntimeModelApiKey,
    }),
  });

  /**
   * Pass one of tool selection, on the model the built-in Bots run on: their key, or their plan's
   * harness. See `createSkillChooser`. Built once rather than per request, because it holds nothing
   * about a person.
   */
  const chooseSkills = createSkillChooser(
    runtimeModel,
    resolveRuntimeModelApiKey,
  );

  /**
   * The approval reviewer's model: the deployment's own, with its key or on its plan's harness (see
   * `createModelCompleter`). It fails closed on an error or a timeout (`reviewAction`).
   */
  const reviewActions = createModelCompleter({
    model: runtimeModel,
    resolveApiKey: resolveRuntimeModelApiKey,
  });

  /**
   * M5: a read for one of upstream's admin drafting routes, across every person when the request
   * holds the admin capability (`requireAdminUser` in app.ts mounts it), as the audit list reads as
   * `platform` (G01-E P7). Anyone else reads in their own frame; the routes answer them with
   * `requireAdmin` before any read.
   */
  const adminRead = <T>(work: () => T): T =>
    capabilityFor(currentTenant()) === "admin" ? asPlatform(work) : work();

  /**
   * Writes a boundary from an admin's description, and reads it back (computer/policy-translate.ts),
   * and likewise team approval rules, a Bot's actions in one app, the network allowlist and the
   * guidance for auto-review (upstream #1372/#1381/#1396/#1397/#1398/#1399). The deployment's own
   * model, with longer to answer than the router: an admin pressed a button and is waiting for a rule,
   * which is a longer answer than a router's one name, and a reasoning model spends seconds before it
   * starts.
   */
  const writeBoundaries = createModelCompleter({
    model: runtimeModel,
    resolveApiKey: resolveRuntimeModelApiKey,
    timeoutMs: 45_000,
    // Room for the thinking a current Claude model does before it answers, which counts against it.
    maxTokens: 16_000,
  });

  /**
   * Reads an admin's question about the audit trail as filters, and reads the filters back
   * (audit-ask.ts, upstream #1380). The deployment's own model, given as long as a boundary's writer
   * for the same reason: an admin pressed Ask and is waiting.
   */
  const askTheAuditTrail = createModelCompleter({
    model: runtimeModel,
    resolveApiKey: resolveRuntimeModelApiKey,
    timeoutMs: 45_000,
    maxTokens: 16_000,
  });

  /** Reads "what would happen if…" as one action (what-if.ts, upstream #1402), for an admin who pressed Ask. */
  const readWhatIfQuestions = createModelCompleter({
    model: runtimeModel,
    resolveApiKey: resolveRuntimeModelApiKey,
    timeoutMs: 45_000,
    maxTokens: 16_000,
  });

  /**
   * The models a person may pick for a Bot's run, and how hard each can think, asked of whatever
   * serves the model: the provider, the gateway in OPENAI_BASE_URL, or a signed-in plan's own listing.
   * One person on their own machine picks from all of them; in a team, people pick among the models an
   * admin allowed (Admin, Providers), and get the default until there are any. Read now and then every
   * few hours in the background, and early when a provider refuses a model; never per message.
   */
  const modelCatalogue = createModelCatalogue({
    model: runtimeModel,
    // A picker or a run reads in its own request's frame; the background reads have none.
    apiKey: () =>
      isTenantFramed()
        ? resolveRuntimeModelApiKey()
        : asDeployment(resolveRuntimeModelApiKey),
    ...(config.singleUser
      ? {}
      : {
          allowlist: () =>
            enterpriseControls()?.snapshot()?.settings.modelAllowlist,
        }),
  });
  startup.acquireSync(
    () => modelCatalogue.start(),
    (stop) => stop(),
  );

  /** Each person's pick per conversation, saved through `/api/channels/:id/model` and read per run. */
  const modelChoices = createModelChoices({
    database,
    model: runtimeModel,
    catalogue: modelCatalogue,
  });

  const hostAccessBroker = createHostAccessBroker(Date.now, {
    approvalGate: approvalService.gate,
    commandPolicy: (actorId) => approvalService.hostCommandPolicy(actorId),
  });

  // Tools run here, not in the browser. Each connector still executes through the plugin store, so the
  // grant, the policy and the audit row are exactly where they were. Host-folder tools are also
  // server-dispatched: the selected Bot and the signed-in owner are bound here, then the desktop worker
  // receives only opaque grant ids and relative paths.
  // Memory lives in CopilotKit Intelligence when this deployment is connected and entitled to it, and in
  // OpenBot's own tables when it is not; see memory/store.ts.
  const personalMemoryStore = createMemoryStore(
    database,
    intelligenceClient
      ? {
          intelligence: createIntelligenceMemory({
            client: intelligenceClient,
          }),
        }
      : {},
  );
  // A person's knowledge base (D08): read by their bound Wakers through two tools, edited at /api/knowledge.
  const knowledgeStore = createKnowledgeStore(database);
  /*
   * The Recorder extension (recorder/wiring.ts): a person's browser connected to OpenBot, its capture
   * pass and its routes. Each person's recordings join their own Learning space (above).
   */
  const recorderExtension = createRecorderExtension({
    config,
    database,
    organizationAuth,
    roleRepository,
    peopleStore,
    personalSpaces: personalLearningSpaces,
    auditStore: bootAuditStore,
    ...(betterAuth
      ? { sessionLifetimeMs: await sessionLifetimeMs(betterAuth) }
      : {}),
    // A connection is made or ended exactly when its row is written: both in one transaction.
    auditFor: (executor) => createAuditStore(executor),
    // Recording summaries come from the optional Intelligence, at the address its client resolved.
    ...(intelligenceClient && config.intelligence
      ? {
          intelligence: {
            apiUrl: intelligenceClient.ɵgetApiUrl(),
            apiKey: config.intelligence.apiKey,
          },
        }
      : {}),
  });
  /*
   * Connections whose lifetime has run out already resolve to nobody; this ends them for good, with
   * the sealed organization session any of them still held, and writes their rows. Every replica runs
   * it, and each row is ended once. Every person's connections, so as `platform` (the loop's frame).
   */
  startup.acquireSync(
    () =>
      repeatAfterEach(async () => {
        try {
          await recorderExtension.connections.expire();
        } catch (error) {
          console.error(
            JSON.stringify({
              type: "recorder-expiry-sweep-error",
              error: error instanceof Error ? error.name : "UnknownError",
              timestamp: new Date().toISOString(),
            }),
          );
        }
      }, 60_000),
    (resource) => resource.stop(),
  );
  /*
   * The personal edition has one reviewer, who is DEV_ACTOR (it requires single-user mode, which admits
   * every request as DEV_ACTOR), so what its Bots learn is approved for them while automatic approval
   * is on: once shortly after boot, so what waited while the app was closed doesn't wait another 15
   * minutes, then every 15 minutes. Only with Intelligence, which is where Learning's proposals are.
   * The approvals are DEV_ACTOR's own rows, so the sweep runs as them (G01).
   */
  const autoApprover =
    intelligenceClient && learningSettings
      ? createAutoApprover({
          manage: intelligenceClient.experimental.learning,
          enabled: async () =>
            currentEdition() === "personal" &&
            ((await learningSettings.read()).autoApprove ?? true),
          sources: async () =>
            learningScopes({
              edition: "personal",
              userId: DEV_ACTOR.id,
              settings: await learningSettings.read(),
            }),
          approvals: skillApprovalStore,
          userId: DEV_ACTOR.id,
          audit: bootAuditStore,
        })
      : undefined;
  if (autoApprover && currentEdition() === "personal") {
    const sweepAutoApprovals = () =>
      void runAsTenant(DEV_ACTOR.id, () => autoApprover.sweep()).catch(
        (error) =>
          console.error(
            JSON.stringify({
              type: "learning-auto-approve-sweep-error",
              error: error instanceof Error ? error.name : "UnknownError",
              timestamp: new Date().toISOString(),
            }),
          ),
      );
    startup.acquireSync(
      () => {
        const first = setTimeout(sweepAutoApprovals, 10_000);
        first.unref?.();
        const every = setInterval(sweepAutoApprovals, 15 * 60_000);
        every.unref?.();
        return { first, every };
      },
      ({ first, every }) => {
        clearTimeout(first);
        clearInterval(every);
      },
    );
  }
  const memoryIngestion = createMemoryIngestion({
    store: personalMemoryStore,
    plugins: pluginStore,
    canUseBot: async (owner, bot) =>
      (await pluginStore.agentOwner(bot)) === owner ||
      (await agentProfileStore.get(await actorFor(owner), bot)) !== null,
  });
  /*
   * Memory sources and background research, on by default for each person and Bot, and never switched
   * back on once the person turns one down. See memory/defaults.ts. Each entry runs as the person it
   * is for, whose rows the defaults are (G01).
   */
  const memoryDefaults = createMemoryDefaults({
    database,
    ingestion: memoryIngestion,
    sources: config.memoryDefaults.sources,
    research: config.memoryDefaults.research,
    edition: config.edition,
    channelBots: async (ownerUserId, channelId) =>
      (await channelStore.get(await actorFor(ownerUserId), channelId))
        ?.agentIds ?? null,
    // The same rule research delivery uses, read when a person speaks (long after it is defined).
    canDeliver: async (ownerUserId, channelId, agentId) =>
      (await deliveryScopeFor(ownerUserId, channelId, agentId)) !== null,
    mintThreadId: () => threadIdentity.mint(),
    // Read when a Bot turn starts, long after `teamBots` below is defined.
    publishedByAnother: (ownerUserId, agentId) =>
      teamBots.publishedByAnother(ownerUserId, agentId),
  });
  personSpoke = (ownerUserId, channelId) =>
    runAsTenant(ownerUserId, () =>
      memoryDefaults.personSpoke(ownerUserId, channelId),
    );
  /*
   * Nothing of it in the personal edition: no memory in a turn, no sync. See memory/runtime.ts. A
   * Bot's turn switches on its memory sources as the person it is for (G01); the sweep runs as
   * `platform` and each person's rows are synced and mirrored as that person (memory/store.ts).
   */
  const memoryRuntime = createMemoryRuntime({
    edition: config.edition,
    defaults: {
      botTurn: (ownerUserId, botId) =>
        runAsTenant(ownerUserId, () =>
          memoryDefaults.botTurn(ownerUserId, botId),
        ),
    },
    ingestion: memoryIngestion,
    store: personalMemoryStore,
  });
  startup.acquireSync(
    () => repeatAfterEach(memoryRuntime.sweep, 60_000),
    (resource) => resource.stop(),
  );
  // Follow-ups a Bot schedules for itself, on the shared work queue. See agents/wake-up.ts.
  const wakeUpStore = createWakeUpStore(database, {
    auditStore: bootAuditStore,
  });
  /** Team Bots: published Bots, their audiences, and teammates' consent to their own accounts. */
  const teamBots = createTeamBots({
    database,
    connectedServers: async (userId) =>
      new Set(
        [
          ...(await pluginStore.connectionsFor(userId)),
          ...(await pluginStore.brokeredConnectionsFor(userId)),
        ].map((connection) => connection.serverId),
      ),
  });
  /*
   * What a check-in may read: the apps each person connected with their own account, through the
   * tools that say they only read, and never another person's account through a Team Bot. See
   * proactive/scope.ts and proactive/restriction.ts. Read afresh per question, so a connection
   * withdrawn or a label changed applies on the next call.
   *
   * M3: upstream's plugin store says per server whose credential it runs on (`ownCredential`) and per
   * tool whether its catalogue labels it a read (`labelledRead`), and lists a person's own connections
   * (`ownConnections`). Until the plugins session brings those, they are read from what this store
   * has: a server is the person's own where they hold a connection to it (their OAuth grant or their
   * brokered account), and a tool reads where it is recorded as a read and not destructive.
   */
  const ownConnections = async (userId: string) =>
    new Set(
      [
        ...(await pluginStore.connectionsFor(userId)),
        ...(await pluginStore.brokeredConnectionsFor(userId)),
      ].map((connection) => connection.serverId),
    );
  const checkInScope = createCheckInScope({
    catalogue: checkInCatalogue(pluginStore),
    ownConnections,
    unaskedOwnAccount: (ownerUserId, agentId) =>
      teamBots.unaskedOwnAccount(ownerUserId, agentId),
  });

  /*
   * Every tool a run is granted, less the ones disabled for this person and Bot (SEC1 D4): a `deny`
   * in the team's, the Bot owner's or the person's own rules leaves it out of what the model is
   * offered, and the approval gate behind each one still refuses it if it is called anyway.
   */
  const loadToolsForActor =
    (actorId: string, initiator: AuditInitiator = PERSON_INITIATOR) =>
    async (botId: string) => {
      const [tools, disabled] = await Promise.all([
        loadGrantedToolsForActor(actorId, initiator, botId),
        approvalService.disabledTools(actorId, botId),
      ]);
      return tools.filter((tool) => !disabled(tool.ref));
    };
  const loadGrantedToolsForActor = async (
    actorId: string,
    initiator: AuditInitiator,
    botId: string,
  ) => [
    ...wakeUpTools({
      store: wakeUpStore,
      ownerUserId: actorId,
      agentId: botId,
      initiator,
    }),
    ...offeredMemoryTools(config.edition, {
      store: personalMemoryStore,
      ingestion: memoryIngestion,
      ownerUserId: actorId,
      agentId: botId,
    }),
    // 上游在这里给每位员工 `show_app_access`；fork 放在下面 `request_app_access` 旁边（X2）。
    /*
     * Held by every Bot: offering a check-in on what the person just looked at, which the card turns
     * on only if they accept. A read; see the file. The engine is made further down, and a tool is
     * only ever built for a run, long after.
     */
    ...checkInOfferTools({
      ownerUserId: actorId,
      agentId: botId,
      allowed: (owner) => proactiveEngine.allowed(owner),
      list: (owner) => proactiveStore.list(owner),
    }),
    ...(await knowledgeTools({
      store: knowledgeStore,
      ownerUserId: actorId,
      agentId: botId,
    })),
    ...(await grantedTools({
      store: pluginStore,
      botId,
      actorId,
      initiator,
      // A Team Bot reaches its owner's accounts, and a teammate's own only with their consent.
      credentialActorFor: teamBots.credentialActorFor(actorId, botId),
      // 账号可选（上游 #1298）只告诉在用自己账号的人；别人的 Team Bot 不告诉，读法不花同意。
      offersAccountsOf:
        (await teamBots.unaskedOwnAccount(actorId, botId)) === null
          ? actorId
          : null,
    })),
    // 申请访问：用不了某个应用时替对方向管理员申请（迁移 0153）。只建一条本租户的申请，不碰应用。
    // 类型与浏览器入口同一个判定，broker 应用的状态要知道 Composio 配没配，否则 broker 应用会被读成没打开。
    ...appAccessTools({
      store: pluginStore,
      botId,
      actorId,
      composioConfigured: Boolean(composioBroker),
      ...(composioBroker ? { directory: () => composioBroker.listApps() } : {}),
    }),
    // 看应用权限（X2，上游 `show_app_access`）：把一个应用对这个人是什么画成卡片。只读，不建申请。
    ...showAppAccessTools({
      store: pluginStore,
      botId,
      actorId,
      composioConfigured: Boolean(composioBroker),
      ...(composioBroker ? { directory: () => composioBroker.listApps() } : {}),
    }),
    ...hostAccessTools({
      broker: hostAccessBroker,
      botId,
      actorId,
      auditStore: bootAuditStore,
      initiator,
    }),
  ];

  /** One person's standing instructions, for both the /api/settings routes and every run they start. */
  const userInstructionsStore = createUserInstructionsStore(database);

  /*
   * What this person has told every built-in coworker they run.
   *
   * Per actor and read per build, for the reason every other per-person fact here is: somebody who
   * edits their instructions and sends a message expects the message to land on the new ones, and a
   * value captured at boot would serve the whole deployment whatever the first person to sign in had
   * written.
   */
  const loadInstructionsForActor = (actorId: string) => () =>
    userInstructionsStore.read(actorId);

  /*
   * The information sources a person declared for their 分身 (story F1), read per build for the
   * reason the instructions above are: a source added or removed applies to the next run. Answered
   * only for the asker's own 分身; every other Bot gets none without a read.
   */
  const avatarSourceStore = createAvatarSourceStore(database, {
    /*
     * Stage 3 (S3, S4): a notebook is attached through the person's knowledge base and a connector
     * through the plugin store, so the 分身 reads them with the knowledge tools and the granted
     * connector tools above, under the same bindings, grants, SEC1 rules and approval gate.
     */
    knowledge: knowledgeStore,
    plugins: pluginStore,
    /*
     * Spec §6.5: removing a local folder's source also asks its machine to forget the folder. Only
     * while the machine is connected, so it is never parked for a machine that is away: the forget is
     * a courtesy on top of the real guarantee, which is that the gateway no longer reads through a
     * removed source at all. A machine that was away still offers the folder on its own screen, and
     * nothing can read it through this source.
     */
    onFolderRevoked: ({ tenantId, deviceId, rootRef }) => {
      const target = { tenantId, deviceId };
      if (!deviceChannel.isReachable(target)) return;
      void deviceChannel
        .dispatch(
          target,
          "roots.forget",
          { ref: rootRef },
          15_000,
          `roots.forget/${rootRef}`,
        )
        .catch(() => undefined);
    },
  });
  const loadAvatarSourcesForActor = avatarSourcesForActor(avatarSourceStore);

  /*
   * The file behind an attachment reference, read when a turn turns out to name one.
   *
   * Read per turn rather than held, for the reason the bytes are in the database at all: a message
   * carries a `/api/attachments/<id>` URL, and a model provider is not going to go and fetch it. The
   * row is fetched here and the bytes go up inline, so the Bot sees the file the person attached
   * instead of a link it cannot follow.
   *
   * Built per actor and passed to both turn paths — the request path through `mountCopilotRuntime` and
   * a routine's turn through `buildAgentFor` — so a routine firing at three in the morning inlines
   * exactly as a person's chat turn does, on exactly the same footing.
   *
   * NARROWED BY ACTOR AND BY CONVERSATION, and not silent. The reference reaches the loader out of
   * browser-supplied message content, so a turn can name an attachment in a channel the asker was
   * never in — or in one they ARE in but which is not the channel this turn is running in.
   * `loadAttachmentForTurn` answers both with the same membership join the fetch route uses plus the
   * run's own thread, and null when there is no row this person may see here.
   * `resolveAttachmentParts` fails the turn on that null rather than letting a Bot read a file back
   * to somebody who cannot open it.
   *
   * The thread is the CLOSURE'S ARGUMENT rather than something baked in beside the actor, because one
   * of these is built per actor per request and then used for however many runs that request makes;
   * a thread captured here would be the first run's, silently, for all of them.
   *
   * A PURE READ. `attachedAt` is written by the send rather than by anything here; see
   * `markAttachmentsSentForActor` below.
   */
  const loadAttachmentForActor =
    (actorId: string) => (id: string, threadId: string) =>
      loadAttachmentForTurn(database, { actorId, threadId }, id);

  /**
   * That the files on a message went out in it, recorded when a turn turns out to be a send.
   *
   * Bound per actor and handed to the same two turn paths as the reader above, so a routine's send at
   * three in the morning is recorded exactly as a person's chat turn is. `inlineAttachments`
   * (copilot.ts) calls it with the ids on the message being asked about and no others: history is
   * replayed on every turn and by whoever is running it, so nothing behind that message is evidence
   * of a send.
   *
   * NARROWED BY ACTOR, and more strictly than the reader is. Reading is scoped to channel
   * membership, because members are meant to see each other's sent files; recording a send is scoped
   * to the UPLOADER, because `attachedAt` is what the sweeper, the upload cap and the withdrawal
   * route all read as "this file rode in a message somebody sent" — and a member who could write it
   * on a colleague's staged row would freeze that colleague's own withdrawal at 409 and leave the row
   * unsweepable. See `markAttachmentsSent` in channels/attachments.ts.
   *
   * AND NARROWED BY CONVERSATION, taking the thread as an argument for the reason the reader does.
   * A stamp written against a channel that never saw the file freezes the row the same way, and is
   * reached without any colleague being involved: one person, two channels of their own, a file
   * named from the wrong one.
   */
  const markAttachmentsSentForActor =
    (actorId: string) => (ids: readonly string[], threadId: string) =>
      markAttachmentsSent(database, { actorId, threadId }, ids);

  /*
   * What the deployment tells a remote Bot about the run it is starting.
   *
   * Signed here, where the encryption key lives, so the runtime module never holds a secret. The Bot
   * hands this back when it calls a tool, and it is where the Bot id and the person's name come
   * from: its own token proves which agent is calling, this proves who it is calling for, and
   * neither is read out of the request body any more.
   */
  const signRunForActor =
    (
      actorId: string,
      initiator: AuditInitiator = PERSON_INITIATOR,
      // How deep in a Bot-to-Bot chain a headless turn already is; see createGroupConversations.
      depth?: number,
    ) =>
    (
      botId: string,
      runId: string,
      threadId?: string,
      previousAssertion?: unknown,
    ) => {
      const previous = readRunAssertion(
        previousAssertion,
        config.keyEncryptionKey,
      );
      if (previous?.handoff) {
        if (previous.botId !== botId || previous.actorId !== actorId)
          throw new Error(
            "The delegated run identity does not match this Bot and owner.",
          );
        return previousAssertion as string;
      }
      return mintRunAssertion(
        {
          botId,
          actorId,
          runId,
          threadId,
          initiator,
          ...(depth ? { depth } : {}),
        },
        config.keyEncryptionKey,
      );
    };

  /*
   * Which vendors this deployment connects to, held by a Bot or not.
   *
   * A Bot holding no grants used to be told nothing about connectors at all, so it treated a
   * connected vendor as an ordinary website and browsed to it: a Bot with no Drive grant opened
   * Google's sign-in page and asked a person to sign in to an account the deployment had already
   * connected. Naming them lets it say which one it has not been granted instead.
   *
   * Only the ones whose tools were listed: an app whose sign-in never finished is not connected, and
   * was being named to every Bot as one an administrator could grant (upstream `connectedSystems`,
   * which the fork's plugins/tools.ts does not have yet, so the same filter is written out here).
   *
   * Read per request rather than held, because a connector added a minute ago has to count.
   * Let failures reach buildAgents, which reports the missing guidance once and keeps the run usable.
   */
  const loadVendors = async () =>
    (await pluginStore.listServers())
      .filter((server) => server.tools.length > 0)
      .map((server) => server.id);

  /*
   * How a run's tools are narrowed to the ones it is about.
   *
   * A model picks the right tool reliably out of about ten, and a deployment of this template
   * clears that as soon as it connects a second vendor. Past it the wrong tool gets called, or
   * none does and the answer comes from memory, and neither says so. So a Bot holding more than a
   * handful is offered the tools of the skills that match the message rather than everything at
   * once. See `plugins/selection.ts`.
   *
   * This narrows the offer and nothing else. What a Bot may call is the grant, checked in
   * `callTool` with the policy and the audit row exactly as before, so every path through here can
   * be wrong without a Bot gaining anything. That is also why every failure below is silent and
   * lands on the whole catalogue: the narrowing is worth an accuracy point, never a capability.
   */
  const selectionForActor = (actorId: string): ToolSelection => ({
    loadSkills: (botId) => grantedSkills({ store: pluginStore, botId }),
    // The deployment's own model and key, the same pair the intent router uses, so selection is
    // never a second thing to configure. It throws on a missing key, which reads as "could not
    // choose" and leaves the whole catalogue offered.
    choose: chooseSkills,
    record: async (botId, selection) => {
      await recordAuditEvent(bootAuditStore, {
        eventType: "mcp.tools_discovered",
        targetType: "bot",
        targetId: botId,
        actorUserId: actorId,
        payload: {
          bot: botId,
          reason: selection.reason,
          granted: selection.granted,
          offered: selection.offered.length,
          skills: selection.skills,
          // M3: upstream also records `limit`, when the offer was cut to what one request may carry
          // (`fitToolLimit`); the fork's plugins/selection.ts does not cut it yet.
        },
      });
    },
  });

  // Every run dials the stored endpoint again, so the check that was applied when it was
  // registered has to be applied to wherever it redirects now.
  // Absent computer configuration means nothing opted into private hosts, which is the safe
  // reading and the same one `createApp` takes.
  const agentFetch = createAgentFetch({
    allowPrivateHosts: config.computer?.allowPrivateHosts === true,
    // Named addresses are reachable on every hop, not only the one that was registered.
    allowedHosts: config.agentEndpointAllowedHosts,
    // The deployment's own agent, at exactly its configured addresses: a local deployment keeps it
    // on loopback, which the private-network check would otherwise refuse on every run.
    managedEndpoints: [
      config.managedAgent?.endpoint,
      config.managedAgent?.alsoRun,
    ].filter((url): url is URL => url !== undefined),
    // An agent the person runs on their own loopback, reached from this server's container.
    ...(config.thisMachineHost
      ? { thisMachineHost: config.thisMachineHost }
      : {}),
    // The refusal is what the run already knows; this is what the deployment knows. Written here
    // rather than in `endpoint.ts` so that file keeps deciding and nothing else, the way the
    // target check it reuses does.
    onRefusal: ({ address, reason }) => {
      void recordAuditEvent(bootAuditStore, {
        eventType: "agent.dial_refused",
        targetType: "agent_endpoint",
        targetId: address,
        payload: { address, reason },
      }).catch((error) => {
        // A trail that cannot be written must not take a refusal down with it: the request is
        // already refused by the time this runs, and the alternative to a logged failure here is
        // an unhandled rejection.
        console.error("Could not record a refused agent dial.", error);
      });
    },
  });

  /**
   * Who a routine acts as, resolved the way {@link resolveRequestActor} resolves it.
   *
   * THE ROLE IS READ, NOT ASSUMED. Which coworkers exist is decided per person and an administrator
   * sees Bots a user does not, so hardcoding `role: "user"` here would hide an administrator's own Bots
   * from their own routine — the routine would fail with "that Bot is no longer registered" for a Bot
   * sitting in front of them in chat. This asks the same repository the request path asks, so a routine
   * sees exactly the coworkers its owner sees.
   */
  const actorFor = async (ownerUserId: string): Promise<AgentActor> => {
    // One person, and they are an administrator. The id stays the routine owner's rather than being
    // rewritten to DEV_ACTOR's: in this mode they are the same person, and if they ever were not,
    // silently borrowing the dev actor's identity would be worse than finding nothing.
    if (config.singleUser) return { id: ownerUserId, role: DEV_ACTOR.role };
    const roles = await roleRepository.rolesForUser(ownerUserId);
    if (!roles.includes("admin") && !roles.includes("user")) {
      throw new Error("A routine requires an authorized owner.");
    }
    return {
      id: ownerUserId,
      role: roles.includes("admin") ? "admin" : "user",
    };
  };

  /*
   * A run's source conversation: a channel's own thread, or a Bot's thread in a group conversation.
   * The group lookup applies the same live-membership and own-Bot checks. See channels/group.ts.
   */
  const sourceForCoordinationRun = async (run: RunAssertion) =>
    (await channelSourceForRun(run)) ?? groupSourceForRun(database, run);
  const channelSourceForRun = async (run: RunAssertion) => {
    if (!run.threadId) return null;
    const sources = await database
      .select({ channelId: channels.id, botId: channelAgents.agentId })
      .from(intelligenceChannelMappings)
      .innerJoin(
        channels,
        eq(channels.id, intelligenceChannelMappings.channelId),
      )
      .innerJoin(
        channelMemberships,
        and(
          eq(channelMemberships.channelId, channels.id),
          eq(channelMemberships.userId, run.actorId),
        ),
      )
      .innerJoin(channelAgents, eq(channelAgents.channelId, channels.id))
      .where(
        and(
          eq(intelligenceChannelMappings.threadId, run.threadId),
          eq(intelligenceChannelMappings.userId, run.actorId),
          isNull(channels.deletedAt),
        ),
      );
    return (
      sources.find((source) => source.botId === run.botId) ??
      (run.handoff ? (sources[0] ?? null) : null)
    );
  };
  /*
   * Bots coordinating with each other and with people: handing work on, asking a person a question,
   * and the per-run tools a Bot is given for both (agents/coordination-wiring.ts).
   */
  const { coordination, coordinationForActor } = wireCoordination({
    handoffDesk,
    config,
    approvalService,
    agentProfileStore,
    actorFor,
    channelSourceForRun,
    database,
    pluginStore,
    bootAuditStore,
    peopleStore,
    sourceForCoordinationRun,
    channelStore,
    // Assigned further down, once delivery is wired.
    notify: (scope, input) => deliveryNotifications(scope, input),
  });

  /**
   * One Bot, built for a routine's turn, as its owner.
   *
   * Per turn rather than per boot, for the same reason the request path rebuilds: a Bot registered or
   * edited since the last firing has to count, and a private coworker must be absent for everybody but
   * its owner. No header and no request are involved — the owner is asserted by construction, from the
   * routine row — which is the whole point of doing it here rather than adding an impersonation path to
   * a public route.
   */
  const buildAgentFor = async ({
    ownerUserId,
    agentId,
    initiator,
    depth,
    subagent,
  }: {
    ownerUserId: string;
    agentId: string;
    initiator: AuditInitiator;
    depth?: number;
    /** A subagent's run: the same Bot with no coordination. See agents/subagent.ts. */
    subagent?: boolean;
  }) => {
    const actor = await actorFor(ownerUserId);
    let agent: AbstractAgent | undefined;
    try {
      // In the owner's frame, the whole build: the roster, what the Bot holds, its model binding.
      agent = await runAsTenant(actor.id, () =>
        actorAgentResolver.resolveAgentForActor(actor, agentId, {
          initiator,
          depth,
          ...(subagent ? { subagent } : {}),
        }),
      );
    } catch (error) {
      if (!(error instanceof CoworkerUnavailableError)) throw error;
    }
    if (!agent) {
      /*
       * Named, and raised rather than swallowed. The routine's Bot was deleted, or made private by
       * somebody else, or the owner lost the role that could see it. The runner turns this into a
       * failed run row with this sentence on it, the first failure is said once in the channel, and
       * the fatigue rule switches the routine off after ten — which is exactly the right handling for
       * a routine pointed at something that is not coming back.
       */
      const error = new Error(
        `That Bot is no longer registered, so this routine has nothing to run: ${agentId}.`,
      );
      error.name = "RoutineBotNotRegistered";
      throw error;
    }
    return agent;
  };

  /*
   * The thread store and the turn runner are the same object, built once from this deployment's database:
   * the store behind a runner is a process singleton, so a second runner would be a second view of one
   * conversation. The "platform" a headless turn asks its five questions of (create the thread, read it,
   * take / renew / give back its lock) is the stand-in in `threads/local-platform.ts`, answering them
   * out of that runner and these tables. A routine's turn therefore lands in the same conversation a
   * person's chat turn does, and is read back by the same code that reads a person's.
   */
  const localThreadRunner = new PostgresAgentRunner(
    database,
    taskProjector,
    quota,
    // The board records a machine when the coworker has one, and nothing in cloud mode:
    // a conversation that happened without a device still happened (ticket 017).
    deviceIdForBot,
  );

  /*
   * A queued device action's outcome, posted by its Bot into the conversation that queued it, through
   * this same runner so it is an ordinary turn of that conversation. The roster is bumped the way a
   * relayed handoff answer bumps it.
   */
  queuedResults = createQueuedResultNotices({
    queue: deviceQueue,
    post: createThreadResultPoster({
      database,
      runner: localThreadRunner,
      announce: async ({ origin, text }) => {
        const [mapped] = await database
          .select({ channelId: intelligenceChannelMappings.channelId })
          .from(intelligenceChannelMappings)
          .where(eq(intelligenceChannelMappings.threadId, origin.threadId))
          .limit(1);
        if (!mapped) return;
        const actor = await actorFor(origin.actorId).catch(() => null);
        if (!actor) return;
        await channelStore.recordActivity(actor, mapped.channelId, {
          text,
          agentId: origin.botId,
          at: new Date(),
        });
      },
    }),
  });

  const routineIntelligence: ThreadPlatform =
    createLocalThreadPlatform(localThreadRunner);

  const routineAgentRunner: RunnerLike = localThreadRunner;

  /*
   * The unattended turn: one coworker, one instruction, no browser.
   *
   * Named rather than inlined because two features ask for exactly this and must not drift — a routine
   * firing, and one step of a crew's pipeline (ticket 021, ADR-0001 = A). Both are "the person is not in
   * the conversation, so every gate has to be met by the channel itself": the pause guard, the "Use Bots"
   * and model-allowlist refusals, the thread lock, the governed computer tools and the same audit trail.
   * A second copy of this wiring would be a place where one of those could be quietly missing.
   */
  const unattendedTurnRunner = createTurnRunner({
    prepareRunInput: prepareProductRunInput,
    onKnownStop: productTelemetry.stopKnown,
    intelligence: routineIntelligence,
    runner: routineAgentRunner,
    components: headlessComponents,
    buildAgentFor,
    toolsForTurn: async ({ ownerUserId, agentId, initiator }) => {
      if (!computerGateway) return [];
      const actor = await actorFor(ownerUserId);
      const profile = await agentProfileStore.get(actor, agentId);
      if (!profile) throw new Error("That Bot is not available to this owner.");
      // A Team Bot's teammate uses the Bot, not its owner's signed-in computer.
      if (!canUseComputer(profile, actor)) return [];
      return createHeadlessComputerTools({
        gateway: computerGateway,
        seat: await computerGateway.seatFor(agentId, actor.id),
        actor: { id: actor.id, userId: actor.id, initiator },
        auditStore: bootAuditStore,
        ...(signInService ? { signIn: signInService } : {}),
        machine: computerMachine,
        apps: await usesDeviceApps(agentId, actor.id),
        disabled: await approvalService.disabledTools(actor.id, agentId),
      });
    },
  });

  const routineRunner = createRoutineRunner({
    routineStore,
    channelStore,
    // An unattended firing is board work (ticket 020): the same projector a person's turn writes
    // through, the same monthly ceiling that refuses a fifty-first conversation, and the same machine
    // resolution — so a routine that ran on the laptop reads as having run on the laptop.
    board: taskProjector,
    quota,
    deviceIdOf: deviceIdForBot,
    // Spec J5: a ban freezes the queue. Asked here, at the firing, because nothing else on this path
    // consults `revoked_access` — the session and page layers do, a clock does not.
    accessRevokedOf: (userId: string) => isAccessRevoked(database, userId),
    runTurn: unattendedTurnRunner,
  });

  /**
   * Subagents: every Bot's way to give part of its work to a fresh run of itself (agents/subagent.ts).
   *
   * A subagent's turn is a background turn like a routine's, on the same runner and with the same
   * computer, built as a subagent so it holds no coordination. Its approval requests are withdrawn
   * without resuming its thread, because the action goes back to the conversation instead. It runs in
   * the frame of the run that asked, which is the person's.
   */
  const subagents = createSubagents({
    turn: {
      prepareRunInput: prepareProductRunInput,
      onKnownStop: productTelemetry.stopKnown,
      admission: serverTurnAdmission,
      // The server's own ports, as every other headless turn has them (routines/run-turn.ts).
      modelNamedIn,
      answered: serverTurnAnswered,
      scope: serverTurnScope,
      intelligence: routineIntelligence,
      runner: routineAgentRunner,
      toolsForTurn: ({ ownerUserId, agentId, initiator }) =>
        approvalComputerTools(ownerUserId, agentId, initiator),
    },
    buildAgentFor: (input) => buildAgentFor({ ...input, subagent: true }),
    withdrawApprovals: async (ownerUserId, runId) =>
      approvalService.store.policy?.withdrawPending(
        ownerUserId,
        SUBAGENT_HANDED_BACK,
        (action) => action.runId === runId,
        { resume: false },
      ),
    asksEveryStep: async (ownerUserId, threadId) =>
      (await approvalService.store.asksEveryChange?.(ownerUserId, threadId)) ===
      true,
  });

  /*
   * Spec I6: may THIS person use THIS coworker — asked per step, and never substituted.
   *
   * The two ways a Bot can be the caller's are the ones the memory ingestion already asks, because a
   * crew is a grouping and not a grant: being listed beside a coworker cannot widen who may address it.
   * An administrator's ban freezes the work the same way it freezes a routine firing (spec J5), and the
   * monthly ceiling is asked by the store before the first card exists. Named once, because the
   * pipeline and the WakerFlow Save must ask the same question.
   */
  const canUseCoworker = async (ownerUserId: string, agentId: string) => {
    if (await isAccessRevoked(database, ownerUserId)) return false;
    return (
      (await pluginStore.agentOwner(agentId)) === ownerUserId ||
      (await agentProfileStore.get(await actorFor(ownerUserId), agentId)) !==
        null
    );
  };

  /**
   * The crew's pipeline (ticket 021): a template's ordered steps, run as unattended turns.
   *
   * No new execution channel is built here, which is the whole point of ADR-0001 = A — one step asks the
   * same runner a routine firing asks, so the pause gate, the allowlist, the thread lock and the audit
   * trail are the ones that already have suites.
   */
  const pipelineStore = createPipelineStore({
    database,
    board: taskProjector,
    executeStep: createPipelineStepRunner({ runTurn: unattendedTurnRunner }),
    // Spec I6, asked per step and never substituted: see `canUseCoworker` above.
    canUse: canUseCoworker,
    quota,
    // WF8: a WakerFlow run's state changes and questions, written with the change itself.
    events: flowRunEventWriter,
    /*
     * WF7 action steps: ADR-0001's 2026-11-04 exception, one fixed MCP call per step with no turn.
     * The same pause guard and headless controls a turn asks, then the plugin grant, then the
     * governed `callTool` with its approval gate. A refusal before the call writes its own row.
     */
    actions: createActionStepRunner({
      guardTurn: (input) => guardBotTurn(input),
      refusal: (input) => headlessTurnRefusal(input),
      granted: async ({ agentId, tool }) =>
        (await pluginStore.decide("mcp", tool, agentId)).allowed,
      callTool: (input) => pluginStore.callTool(input),
      audit: (event) =>
        recordAuditEvent(bootAuditStore, {
          eventType: "mcp.call_rejected",
          targetType: "mcp_tool",
          targetId: event.tool,
          initiator: event.initiator,
          payload: {
            actor: event.actorId,
            bot: event.botId,
            refusal: `wakerflow_action_${event.gate}`,
            reason: event.reason,
          },
        }),
    }),
  });

  /**
   * WakerFlow (spec D10): a saved plan compiles to a hidden crew and a template, and a run of it is
   * this same pipeline's run — the same step runner, the same governance, the same board cards. The
   * coworker check is the pipeline's own, asked again on every Save. The deployment's own model is
   * not offered for planning until that product decision is made.
   */
  const wakerFlowStore = createWakerFlowStore({
    database,
    pipeline: pipelineStore,
    board: taskProjector,
    canUse: canUseCoworker,
    models: createFlowModelResolver({
      database,
      encryptionKey: config.keyEncryptionKey,
      allowPlatformModel: false,
      outbound: modelOutbound,
    }),
    generator: createFlowGenerator(),
    quota,
    // WF7: an action step's tool is granted to its coworker and not disabled by SEC1.
    actionTool: async ({ actor, agentId, tool }) => {
      if (!(await pluginStore.decide("mcp", tool, agentId)).allowed)
        return `员工没有被授权使用工具 ${tool}。`;
      if ((await approvalService.disabledTools(actor, agentId))(tool))
        return `工具 ${tool} 已被设为禁用。`;
      return null;
    },
  });

  /*
   * Restart recovery (audit defect #10): close what a dead process left "in progress".
   *
   * Every replica runs this; the work-queue lease in `sweepAbandonedWork` lets one replica per
   * five-minute bucket do the work, and every phase is a conditional, database-clocked UPDATE that a
   * second runner would find nothing for. Nothing is replayed: abandoned routine firings are closed as
   * skipped, abandoned crew runs and their cards as failed, and stale routine/responsibility cards as
   * failed, each in the tenant recorded on its own row. Approved-action resume is NOT part of this —
   * it stays gated on a Root-attested release (see the `approval.resume` loop below).
   */
  const recoveryQueue = createWorkQueue(database);
  const recoveryOwner = workOwner("recovery");
  const recoveryPhases = abandonedWorkPhases({
    routineStore,
    reapPipelineRuns: (input) => pipelineStore.reapAbandoned(input),
    recoverFlowRuns: (input) =>
      recoverInterruptedFlowRuns(database, taskProjector, input),
    board: taskProjector,
  });
  startup.acquireSync(
    () =>
      repeatAfterEach(async () => {
        try {
          const report = await sweepAbandonedWork({
            queue: recoveryQueue,
            owner: recoveryOwner,
            phases: recoveryPhases,
          });
          if (
            report.won &&
            (report.routineRuns ||
              report.pipelineRuns ||
              report.cards ||
              report.failed.length ||
              report.leaseLost)
          )
            console.warn(
              JSON.stringify({ type: "restart-recovery-sweep", ...report }),
            );
        } catch (error) {
          console.error(
            JSON.stringify({
              type: "restart-recovery-sweep-error",
              error: error instanceof Error ? error.message : String(error),
              timestamp: new Date().toISOString(),
            }),
          );
        }
      }, 60_000),
    (resource) => resource.stop(),
  );
  startup.acquireSync(
    () =>
      repeatAfterEach(
        async () => {
          try {
            await recoveryQueue.purge({
              kind: RECOVERY_SWEEP_KIND,
              olderThanMs: RECOVERY_PURGE_AFTER_MS,
            });
          } catch (error) {
            console.warn(
              JSON.stringify({
                type: "restart-recovery-purge-failed",
                reason: error instanceof Error ? error.message : String(error),
              }),
            );
          }
        },
        60 * 60 * 1_000,
      ),
    (resource) => resource.stop(),
  );

  /**
   * The runtime, and the two things beside it a hop needs.
   *
   * `agentFor` builds the addressed Bot exactly the way a person's run builds it, and `history` reads
   * the conversation through the same client. Taken from here rather than assembled again, because a
   * Bot built by parallel wiring drifts the first time one of these arguments changes, and the drift is
   * invisible: it runs, and quietly holds different tools or a different role from the one the person
   * is talking to.
   */
  /*
   * The one way a Bot is built for a person (upstream f4bc60b, "stop building a Bot four ways"): a
   * person's chat request, a hop's delivery and a routine's or responsibility's headless turn all ask
   * this, so the Bot a person talks to and the Bot that works at three in the morning cannot hold
   * different tools, grants, model or role.
   *
   * The roster loader is unscoped: every caller opens the frame of the person it is for — the runtime
   * around each whole request (or the catalogue frame for nobody), a hop around its `agentFor`, and
   * `buildAgentFor` above around the owner.
   */

  const actorAgentResolver = createActorAgentResolver({
    productTelemetry,
    loadAgents: runtimeAgentsForActor,
    model: runtimeModel,
    resolveModelApiKey: resolveRuntimeModelApiKey,
    // The model the person picked for this conversation, or the catalogue's default.
    // Given what started the run, so a run nobody is watching can think harder (upstream #1407).
    pickedModelForActor: (actorId, initiator) => (input) =>
      modelChoices.forRun(actorId, input.threadId, {
        unattended: isUnattended(runModeOf(initiator)),
      }),
    stallGuard,
    /*
     * Restricted by who started the run: a check-in reads only what the person connected (scope.ts).
     * A person's own turn is not restricted. A goal's run holds the goal's own tools; the Routines
     * copies would be a second set.
     */
    loadToolsForActor: (actorId, initiator) =>
      restrictToolsForRun(
        initiator,
        actorId,
        withoutGoalCopiesInGoalRun(
          initiator,
          loadToolsForActor(actorId, initiator),
        ),
        checkInScope,
      ),
    // M3: upstream also passes `loadAppsForActor` (which apps each Bot can use for this person, from
    // the plugin store's `appAccessForBot`); the resolver here does not take it.
    signRunForActor,
    // Whenever this deployment has a computer to drive — a container or, with TENANT_RUNTIME=device,
    // the person's paired machine — every built-in Bot is told how its tools go together.
    computerGuidance: computerProvider ? computerGuidance : undefined,
    loadVendors,
    selectionForActor,
    agentFetch,
    /*
     * What a Bot may reach past itself for: another Bot, and a person, then a subagent of its own,
     * offered on every run. Made per run and per person: which Bots may be reached is decided against
     * the roster that person can see, and the caps need to know how deep the chain already is and
     * where an answer belongs.
     */
    handoffForActor: (actorId, initiator, depth) =>
      restrictCoordinationForRun(initiator, async (botId, input) => [
        ...(await coordinationForActor(
          actorId,
          initiator,
          depth,
        )(botId, input)),
        subagents.toolForRun({
          actorId,
          botId,
          threadId: input.threadId,
          runId: input.runId,
          // The subagent carries on the asking run's task, on the asking run's surface.
          ...productTelemetry.lineageOf(actorId, input.forwardedProps),
          initiator: initiator ?? PERSON_INITIATOR,
          ...(depth ? { depth } : {}),
        }),
      ]),
    // What this person has told every coworker of theirs, in every channel. See user-instructions.ts.
    loadInstructionsForActor,
    // What a Bot calls the person, once they have told OpenBot their name.
    loadNameForActor: async (actorId) => {
      const profile = await profileStore.read(actorId);
      return profile.needsName ? null : profile.name;
    },
    // The files on a message, and that they went out in a send — only the person's own.
    loadAttachmentForActor,
    markAttachmentsSentForActor,
    ...(memoryRuntime.loadForActor
      ? { loadPersonalMemoryForActor: memoryRuntime.loadForActor }
      : {}),
    recordToolLimitRefusalForActor: toolLimitRecorder(bootAuditStore),
    resolveAgentModel,
    // What a person declared about where their material is, told to their own 分身 only (story F1).
    loadAvatarSourcesForActor,
    // The project each coworker works in on the person's machine (story RES2).
    loadCurrentProjectForActor,
    // Published Automatic Learning skills, only with a connected Intelligence.
    acquireLearnedSkills: learning?.acquire,
  });

  /**
   * The runtime, and the two things beside it a hop needs. `agentFor` builds the addressed Bot through
   * the same resolver, and `history` reads the conversation through the same store.
   */
  const copilotRuntime = mountCopilotRuntime(
    config,
    actorAgentResolver,
    identifyUser,
    identifyActor,
    {
      productTelemetry,
      // The cards a Bot asks with in the conversation, saved while they wait on the person.
      decisionWaits: createDecisionWaits(database),
      // A run started or ended on a thread; light the channel it belongs to. Fire-and-forget.
      onRunBusy: (input) => {
        void channelStore
          .signalBusy(input.threadId, input.busy)
          .catch(() => {});
      },
      // The thread store, and the runtime's runner: one object, `threads/postgres-runner.ts`.
      localRunner: localThreadRunner,
      // The Recorder's capture pass: only a connected browser gets through (recorder/wiring.ts).
      trajectoryCapture: recorderExtension.trajectoryCapture,
    },
  );

  /*
   * The deployment's responsibility engine (responsibilities/wiring.ts): a goal's turn, with the
   * computer when the Bot may use it and the goal's own tools, its reply posted to the channel it
   * watches. An event that woke a coworker is board work too (ticket 020): same projector, same
   * ceiling, same machine resolution as every other unattended firing; and a goal woken for a banned
   * workspace stays in place until the ban is lifted (spec J5).
   */
  const responsibilityEngine = createServerResponsibilityEngine({
    productTelemetry,
    database,
    responsibilityStore,
    routineIntelligence,
    routineAgentRunner,
    componentCatalog: headlessComponents,
    buildAgentFor,
    actorFor,
    computerGateway,
    agentProfileStore,
    bootAuditStore,
    signInService,
    channelStore,
    // Assigned further down, once delivery is wired.
    notify: (scope, input) => deliveryNotifications(scope, input),
    board: taskProjector,
    quota,
    deviceIdOf: deviceIdForBot,
    accessRevokedOf: (userId: string) => isAccessRevoked(database, userId),
    machine: computerMachine,
    appsFor: usesDeviceApps,
    disabledFor: (actorId, agentId) =>
      approvalService.disabledTools(actorId, agentId),
  });
  /**
   * A turn for a responsibility that is not one of the engine's own firings: a person answering the
   * question its run asked. Same tools, same initiator and the same run to report progress against,
   * so the Bot can carry on with the goal instead of being unable to record it.
   */
  const responsibilityAnswerTurn = ({
    responsibility,
    responsibilityRunId,
  }: {
    responsibility: Responsibility;
    responsibilityRunId: string | undefined;
  }) => {
    const initiator: AuditInitiator = {
      kind: "responsibility",
      id: responsibility.id,
    };
    const tools = responsibilityTools({
      store: responsibilityStore,
      engine: responsibilityEngine,
      ownerUserId: responsibility.ownerUserId,
      agentId: responsibility.agentId,
      channelId: responsibility.channelId,
      ...(responsibilityRunId ? { responsibilityRunId } : {}),
    });
    return createTurnRunner({
      prepareRunInput: prepareProductRunInput,
      onKnownStop: productTelemetry.stopKnown,
      intelligence: routineIntelligence,
      runner: routineAgentRunner,
      components: headlessComponents,
      buildAgentFor: (input) => buildAgentFor({ ...input, initiator }),
      toolsForTurn: async () => [
        ...(await approvalComputerTools(
          responsibility.ownerUserId,
          responsibility.agentId,
          initiator,
        )),
        ...tools.map((tool) => ({
          definition: {
            name: tool.name,
            description: tool.description,
            parameters: z.toJSONSchema(tool.parameters),
          },
          execute: (args: unknown) => tool.execute(args),
        })),
      ],
    });
  };
  startup.acquireSync(
    () =>
      repeatAfterEach(async () => {
        try {
          const report = await responsibilityEngine.dispatch({
            owner: workOwner("responsibility"),
            limit: 1,
          });
          if (
            report.succeeded.length ||
            report.failed.length ||
            report.waiting.length ||
            report.busy.length
          )
            console.info(
              JSON.stringify({ type: "responsibility-dispatch", ...report }),
            );
        } catch (error) {
          console.error(
            JSON.stringify({
              type: "responsibility-dispatch-error",
              error: error instanceof Error ? error.message : String(error),
              timestamp: new Date().toISOString(),
            }),
          );
        }
      }, 2_000),
    (resource) => resource.stop(),
  );

  const approvalQueue = createWorkQueue(database);
  const approvalOwner = workOwner("approval");
  const approvalComputerTools = async (
    ownerUserId: string,
    agentId: string,
    initiator: AuditInitiator,
  ) => {
    const actor = await actorFor(ownerUserId);
    const profile = await agentProfileStore.get(actor, agentId);
    if (!profile)
      throw new ApprovalRefusedError("That Bot is no longer available to you.");
    // A Team Bot's teammate uses the Bot, not its owner's signed-in computer.
    return computerGateway && canUseComputer(profile, actor)
      ? createHeadlessComputerTools({
          gateway: computerGateway,
          seat: await computerGateway.seatFor(agentId, actor.id),
          actor: { id: actor.id, userId: actor.id, initiator },
          auditStore: bootAuditStore,
          ...(signInService ? { signIn: signInService } : {}),
          machine: computerMachine,
          apps: await usesDeviceApps(agentId, actor.id),
        })
      : [];
  };
  const executeApprovedAction = createApprovedActionExecutor({
    sourceFor: sourceForCoordinationRun,
    gate: approvalService.gate,
    computerTools: approvalComputerTools,
    hostTools: ({ actorId, botId, initiator }) =>
      hostAccessTools({
        broker: hostAccessBroker,
        botId,
        actorId,
        initiator,
        auditStore: bootAuditStore,
      }),
    callTool: (input) => pluginStore.callTool(input),
    credentialActorFor: (actorId, botId, ref) =>
      teamBots.credentialActorFor(actorId, botId)(ref),
    coordinationCall: (input) => coordination.call(input),
    readRun: (value) =>
      readApprovedRunAssertion(value, config.keyEncryptionKey),
    answer: vendorAnswer,
    privateShareToolRef: PRIVATE_SHARE_TOOL_REF,
    refusalMarker: REFUSAL_MARKER,
    personInitiator: PERSON_INITIATOR,
  });
  // Declared before the approval-resume loop, which settles an automation firing an approval held.
  // AUT3: a WakerFlow target is accepted once it can be carried out, through the WakerFlow store.
  const automationTargets = createAutomationTargetRegistry();
  automationTargets.register(wakerflowAutomationTarget(wakerFlowStore));
  const automationStore = createAutomationStore(database, {
    executors: automationTargets,
  });
  const approvalContinuationRunner = createTurnRunner({
    prepareRunInput: prepareProductRunInput,
    onKnownStop: productTelemetry.stopKnown,
    intelligence: routineIntelligence,
    runner: routineAgentRunner,
    components: headlessComponents,
    buildAgentFor,
    toolsForTurn: async ({ ownerUserId, agentId, initiator }) =>
      approvalComputerTools(ownerUserId, agentId, initiator),
  });
  /*
   * The approval resume loop (approvals/resume-sweep.ts): claim a decided approval, carry it out in
   * its owner's frame, and pick the waiting turn back up — a goal run, a group conversation, a crew's
   * step or a routine run — then tell the channel, once the reply is there to read.
   */
  startup.acquireSync(
    () =>
      repeatAfterEach(
        createApprovalResumeTick({
          approvalQueue,
          approvalOwner,
          approvalService,
          executeApprovedAction,
          database,
          responsibilityStore,
          // Read when an approval is resumed, long after the group conversations below are made.
          groupConversations: {
            continueWaiting: (approvalId, run) =>
              groupConversations.continueWaiting(approvalId, run),
          },
          approvalContinuationRunner,
          channelStore,
          actorFor,
          // Assigned further down, once delivery is wired.
          notify: (scope, input) => deliveryNotifications(scope, input),
          transcriptHolds: waitForReplyInTranscript({
            read: async ({ ownerUserId, threadId }) =>
              (
                await routineIntelligence.getThreadMessages({
                  threadId,
                  userId: ownerUserId,
                })
              ).messages,
          }),
          pipeline: pipelineStore,
          automations: automationStore,
        }),
        2_000,
      ),
    (resource) => resource.stop(),
  );
  const deliveryStore = createDeliveryStore(database);
  const deliveryProviders = configuredDeliveryProviders(
    config.publicUrl ??
      config.auth?.baseUrl ??
      `http://localhost:${config.port}`,
  );
  // Slack channel membership for triggers is answered by OpenTag, which holds the workspace token.
  useSlackChannelMembership((input) =>
    deliveryProviders.slack
      ? deliveryProviders.slack.isMember(input)
      : Promise.resolve(false),
  );
  /*
   * The person's conversation with a Bot, as delivery addresses it, and whether a scope still names
   * one they can reach: the channel's own thread, or that Bot's own thread in a group. See
   * delivery/scope.ts.
   */
  const { scopeFor: deliveryScopeFor, authorise: authoriseDeliveryScope } =
    createDeliveryScopes({
      database,
      people: peopleStore,
      actorFor,
      channels: channelStore,
      bots: agentProfileStore,
    });
  const deliveryRouter = createDeliveryRouter({
    store: deliveryStore,
    queue: createWorkQueue(database),
    owner: workOwner("delivery"),
    providers: deliveryProviders,
    authoriseScope: authoriseDeliveryScope,
    scopeFor: deliveryScopeFor,
    notifyEvent: (event) => responsibilityEngine.ingest(event),
    runTurn: async (input) => {
      if (!(await authoriseDeliveryScope(input)))
        throw new Error(
          "The delivery owner no longer has access to this conversation.",
        );
      const actor = await actorFor(input.ownerUserId);
      await channelStore.recordActivity(
        actor,
        input.channelId,
        { text: input.text, agentId: null, at: new Date() },
        { id: `delivery-input:${input.runId}` },
      );
      await channelStore.signalBusy(input.threadId, true);
      try {
        const result = await approvalContinuationRunner({
          ownerUserId: input.ownerUserId,
          tenantId: input.tenantId,
          routineId: `delivery:${input.runId}`,
          runId: input.runId,
          agentId: input.agentId,
          threadId: input.threadId,
          instruction: input.text,
          userMessage: {
            id: `delivery:${input.runId}`,
            role: "user",
            content: input.text,
          },
          initiator: PERSON_INITIATOR,
          telemetry: deliveryLineage(input.source, input.runId),
          signal: input.signal,
        });
        if (result.replyText)
          await channelStore.recordActivity(
            actor,
            input.channelId,
            { text: result.replyText, agentId: input.agentId, at: new Date() },
            { id: `delivery-reply:${input.runId}` },
          );
        return result;
      } finally {
        await channelStore.signalBusy(input.threadId, false);
      }
    },
    audit: (event) =>
      recordAuditEvent(bootAuditStore, {
        actorUserId: event.ownerUserId,
        initiator: PERSON_INITIATOR,
        eventType:
          event.kind === "inbound"
            ? "delivery.received"
            : event.kind === "sms_opt_out"
              ? "delivery.opted_out"
              : event.state === "failed"
                ? "delivery.failed"
                : "delivery.sent",
        targetType: "channel",
        targetId: event.channelId,
        payload: { deliveryId: event.id, kind: event.kind, state: event.state },
      }),
  });
  deliveryNotifications = (scope, input) => deliveryRouter.notify(scope, input);

  /*
   * Started work: an item a check-in raised, started by the person, runs as a task in a conversation
   * of its own with the item's Bot, as the person's own turn through the approval continuation runner,
   * so every send or change meets the approval gate. See tasks/runner.ts. Its turns are claimed off
   * the shared work queue and run in the tenant stamped on the claimed row (G01).
   */
  const taskStore = createTaskStore(database);
  const taskRunner = createTaskRunner({
    database,
    store: taskStore,
    channels: channelStore,
    actorFor,
    queue: createWorkQueue(database),
    owner: workOwner("tasks"),
    scopeFor: deliveryScopeFor,
    runTask: createTaskTurn({
      channels: channelStore,
      actorFor,
      runTurn: approvalContinuationRunner,
    }),
  });
  // The backstop for a task's turn a crash or a restart left behind; Start runs one at once.
  startup.acquireSync(
    () =>
      repeatAfterEach(async () => {
        try {
          await taskRunner.sweep();
        } catch (error) {
          console.error(
            JSON.stringify({
              type: "task-sweep-error",
              error: error instanceof Error ? error.name : "UnknownError",
              timestamp: new Date().toISOString(),
            }),
          );
        }
      }, 60_000),
    (resource) => resource.stop(),
  );

  /*
   * Check-ins: a Bot reading its owner's apps quietly in the background, restricted to reads by its
   * initiator (see proactive/restriction.ts), through the same headless turn runner and work queue as
   * routines. What one raises is listed in the app at once and reaches the person in a ping, at most
   * one an hour, folding every Bot's items (proactive/ping.ts). Started items run as tasks (above).
   *
   * Each check-in files its own card on the board (story C2); see `ProactiveEngineDeps.board`.
   * M3: product decision pending on whether an hourly check-in should open a card and charge quota.
   */
  const proactiveEngine = createProactiveEngine({
    store: proactiveStore,
    // A check-in forms memories only where there is memory.
    ...(editionHasMemory(config.edition)
      ? { memory: personalMemoryStore }
      : {}),
    queue: createWorkQueue(database),
    owner: workOwner("proactive"),
    board: taskProjector,
    // Only a check-in that raises something files a card and counts against the month.
    quota,
    runTurn: createTurnRunner({
      prepareRunInput: prepareProductRunInput,
      onKnownStop: productTelemetry.stopKnown,
      intelligence: routineIntelligence,
      runner: routineAgentRunner,
      buildAgentFor,
      // Only the run's own tools and refusals: no computer, no components.
      toolsForTurn: (input) => proactiveEngine.toolsForTurn(input),
      turnTimeoutMs: 3 * 60_000,
    }),
    resolveScope: deliveryScopeFor,
    // The organization's Check-ins switch and per-Bot daily cap, read fresh on every check.
    admin: proactiveAdmin,
    // A ping: push once to each phone, one message per chat platform, the app list at once.
    attention: deliveryRouter,
    tasks: taskRunner,
    /*
     * Nothing the person connected that this Bot can read means a check-in could find nothing: it
     * never reaches the model. Otherwise these are the apps its instruction names, and every other
     * tool the Bot holds is answered with a refusal if the model calls it anyway.
     */
    ...checkInToolsFor(
      (ownerUserId) => loadToolsForActor(ownerUserId),
      checkInScope,
    ),
    catalogue: pluginStore,
    mintThreadId: () => threadIdentity.mint(),
  });
  startup.acquireSync(
    () =>
      repeatAfterEach(async () => {
        try {
          await proactiveEngine.sweep();
        } catch (error) {
          console.error(
            JSON.stringify({
              type: "proactive-sweep-error",
              error: error instanceof Error ? error.name : "UnknownError",
              timestamp: new Date().toISOString(),
            }),
          );
        }
      }, 60_000),
    (resource) => resource.stop(),
  );
  /*
   * 本地学习（L1，local-learning/engine.ts）：每人每天读自己最近的对话，用那位员工的模型提出技能
   * 草案，等本人在设置「学习」里审。对话不出库；模型调用经 `resolveAgentModel` 计到这个人名下，
   * 本月任务额度用完就跳过。多副本时同一个人只有一个副本认领（带条件的 upsert）。
   * `OPENBOT_LOCAL_LEARNING=off` 时不建、不扫。
   */
  const localLearningEngine = config.localLearning
    ? createLocalLearningEngine({
        database,
        quota,
        modelFor: async (agentId) => {
          try {
            const key = await resolveRuntimeModelApiKey();
            return await resolveAgentModel(
              agentId,
              key ? deploymentModel(runtimeModel, key) : undefined,
            );
          } catch {
            return null;
          }
        },
        skillsFor: async (agentId) =>
          (await pluginStore.listForAgent(agentId)).skills.map(
            (skill) => skill.title,
          ),
      })
    : undefined;
  if (localLearningEngine)
    startup.acquireSync(
      () =>
        repeatAfterEach(async () => {
          try {
            await localLearningEngine.sweep();
          } catch (error) {
            console.error(
              JSON.stringify({
                type: "local-learning-sweep-error",
                error: error instanceof Error ? error.name : "UnknownError",
                timestamp: new Date().toISOString(),
              }),
            );
          }
        }, 30 * 60_000),
      (resource) => resource.stop(),
    );
  /*
   * Automations (D06 AUT1/AUT3/AUT4, C2/C3): a person's standing "run this Waker when..." rules.
   *
   * One loop, both halves of `automations/sweep.ts`: due triggers become work items in their owner's
   * frame, then claimed items become firings, each run by the Waker executor through the same
   * unattended turn runner as a routine (same gates, same card, same ceiling). WakerFlow targets have
   * no executor until D10, so the store refuses them at save time.
   */
  const automationQueue = createWorkQueue(database);
  const wakerAutomationExecutor = createWakerAutomationExecutor({
    store: automationStore,
    channels: channelStore,
    actorFor,
    runTurn: unattendedTurnRunner,
    board: taskProjector,
    quota,
    deviceIdOf: deviceIdForBot,
    accessRevokedOf: (userId: string) => isAccessRevoked(database, userId),
    // AUT3: a WakerFlow target starts one run through the same path as the WakerFlow page's 运行.
    wakerflows: wakerFlowStore,
  });
  const automationSweep = {
    store: automationStore,
    queue: automationQueue,
    owner: workOwner("automation"),
    executors: {
      waker: (firing: AutomationFiring, event?: AutomationEvent) =>
        wakerAutomationExecutor.run(firing, event),
      wakerflow: (firing: AutomationFiring, event?: AutomationEvent) =>
        wakerAutomationExecutor.run(firing, event),
    },
    // A turn can take minutes; it must not hold the next pass's offers past their grace window.
    background: (run: () => Promise<void>) => {
      void run();
    },
  };
  /*
   * AUT2: an event (public hook or signed-in API call) is queued straight away; this starts a
   * dispatch at once rather than at the next 30-second pass. Claims are leased, so it may overlap
   * the loop safely, and the loop is still what drains the queue if a wake-up is lost.
   *
   * WOKEN BY THE QUEUE'S OWN NOTIFICATION, NOT BY THE REQUEST (G01-E I5). Every offer says its kind
   * aloud on commit (`work/queue.ts`), and the listener runs the dispatch as `platform` with no
   * request behind it, like the loop. Starting it from the request instead would mean opening
   * `platform` on a member's (or a signed-out caller's) path, or dispatching inside that person's
   * frame, where every other owner's claimed item would be refused as cross-tenant and dropped.
   * It also wakes the replica that did not take the request.
   */
  let automationDispatching = false;
  let automationDispatchAgain = false;
  const dispatchAutomationsNow = async () => {
    if (automationDispatching) {
      automationDispatchAgain = true;
      return;
    }
    automationDispatching = true;
    try {
      do {
        automationDispatchAgain = false;
        await dispatchClaimedAutomations(automationSweep);
      } while (automationDispatchAgain);
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "automation-dispatch-now-error",
          error: error instanceof Error ? error.name : "UnknownError",
          timestamp: new Date().toISOString(),
        }),
      );
    } finally {
      automationDispatching = false;
    }
  };
  await startup.acquire(
    () =>
      startWorkOfferedListener(config.databaseUrl, (kind) => {
        if (kind === AUTOMATION_FIRE_KIND) void dispatchAutomationsNow();
      }),
    (listener) => listener.stop(),
  );
  const automationIngress = {
    queue: automationQueue,
    signingPepper: config.keyEncryptionKey,
    auditStore: bootAuditStore,
  };
  startup.acquireSync(
    () =>
      repeatAfterEach(async () => {
        try {
          await offerDueAutomations(automationSweep);
          const report = await dispatchClaimedAutomations(automationSweep);
          if (report.fired.length || report.skipped.length) {
            console.info(
              JSON.stringify({ type: "automation-dispatch", ...report }),
            );
          }
        } catch (error) {
          console.error(
            JSON.stringify({
              type: "automation-sweep-error",
              error: error instanceof Error ? error.name : "UnknownError",
              timestamp: new Date().toISOString(),
            }),
          );
        }
      }, 30_000),
    (resource) => resource.stop(),
  );
  /*
   * Follow-ups a Bot scheduled for itself: one headless turn each, through the same turn runner as a
   * routine, into the person's conversation with that Bot. See agents/wake-up.ts.
   */
  const wakeUpQueue = createWorkQueue(database);
  const wakeUpRunner = createWakeUpRunner({
    queue: wakeUpQueue,
    store: wakeUpStore,
    owner: workOwner("wake-up"),
    actorFor,
    channels: channelStore,
    runTurn: createTurnRunner({
      prepareRunInput: prepareProductRunInput,
      onKnownStop: productTelemetry.stopKnown,
      intelligence: routineIntelligence,
      runner: routineAgentRunner,
      components: headlessComponents,
      buildAgentFor,
      toolsForTurn: async ({ ownerUserId, agentId, initiator }) => {
        if (!computerGateway) return [];
        const actor = await actorFor(ownerUserId);
        const profile = await agentProfileStore.get(actor, agentId);
        if (!profile)
          throw new Error("That Bot is not available to this owner.");
        // A Team Bot's teammate uses the Bot, not its owner's signed-in computer.
        if (!canUseComputer(profile, actor)) return [];
        return createHeadlessComputerTools({
          gateway: computerGateway,
          seat: await computerGateway.seatFor(agentId, actor.id),
          actor: { id: actor.id, userId: actor.id, initiator },
          auditStore: bootAuditStore,
          ...(signInService ? { signIn: signInService } : {}),
          machine: computerMachine,
          apps: await usesDeviceApps(agentId, actor.id),
          disabled: await approvalService.disabledTools(actor.id, agentId),
        });
      },
    }),
    notify: (scope, input) => deliveryNotifications(scope, input),
  });
  startup.acquireSync(
    () =>
      repeatAfterEach(async () => {
        try {
          const report = await wakeUpRunner.sweep();
          if (report.ran.length || report.skipped.length)
            console.info(JSON.stringify({ type: "bot-follow-up", ...report }));
        } catch (error) {
          console.error(
            JSON.stringify({
              type: "bot-follow-up-error",
              error: error instanceof Error ? error.message : String(error),
              timestamp: new Date().toISOString(),
            }),
          );
        }
      }, 5_000),
    (resource) => resource.stop(),
  );
  startup.acquireSync(
    () =>
      repeatAfterEach(async () => {
        await wakeUpRunner.reap().catch(() => 0);
      }, 60 * 60_000),
    (resource) => resource.stop(),
  );
  DELIVERY_WORK_KINDS.map((kind) =>
    startup.acquireSync(
      () =>
        repeatAfterEach(async () => {
          try {
            await deliveryRouter.sweep(kind);
          } catch (error) {
            console.error(
              JSON.stringify({
                type: "delivery-worker-error",
                kind,
                errorType: error instanceof Error ? error.name : "UnknownError",
              }),
            );
          }
        }, 2_000),
      (resource) => resource.stop(),
    ),
  );

  const personResponseOwner = workOwner("person-response");
  /**
   * Conversations with several Bots. Each Bot turn is an ordinary headless AG-UI turn into that Bot's
   * own group thread, built exactly as a routine's is, so governance, learning and the computer tools
   * apply unchanged; Bots answering each other reuse the handoff desk's grant and caps.
   */
  const staffingProposalStore = createStaffingProposalStore(database);
  const groupConversations = createGroupConversations({
    store: createGroupStore(database, () => threadIdentity.mint()),
    queue: createWorkQueue(database),
    owner: workOwner("group"),
    roster: async (ownerUserId, channelId) => {
      const actor = await actorFor(ownerUserId);
      const channel = await channelStore.get(actor, channelId);
      if (!channel || channel.agentIds.length < 2) return null;
      const bots: { id: string; name: string }[] = [];
      for (const agentId of channel.agentIds) {
        const profile = await agentProfileStore.get(actor, agentId);
        if (profile) bots.push({ id: agentId, name: profile.name });
      }
      return bots;
    },
    runTurn: createTurnRunner({
      prepareRunInput: prepareProductRunInput,
      onKnownStop: productTelemetry.stopKnown,
      intelligence: routineIntelligence,
      runner: routineAgentRunner,
      components: headlessComponents,
      buildAgentFor,
      toolsForTurn: async ({ ownerUserId, agentId, initiator }) => {
        if (!computerGateway) return [];
        const actor = await actorFor(ownerUserId);
        const profile = await agentProfileStore.get(actor, agentId);
        if (!profile)
          throw new Error("That Bot is not available to this owner.");
        // A Team Bot's teammate uses the Bot, not its owner's signed-in computer.
        if (!canUseComputer(profile, actor)) return [];
        return createHeadlessComputerTools({
          gateway: computerGateway,
          seat: await computerGateway.seatFor(agentId, actor.id),
          actor: { id: actor.id, userId: actor.id, initiator },
          auditStore: bootAuditStore,
          ...(signInService ? { signIn: signInService } : {}),
          machine: computerMachine,
          apps: await usesDeviceApps(agentId, actor.id),
          disabled: await approvalService.disabledTools(actor.id, agentId),
        });
      },
    }),
    caps: config.handoff,
    // The handoff desk's own grant check, read per hop and failing closed.
    mayAddress: async (fromBotId, toBotId) =>
      (
        await pluginStore
          .botsReachableFrom(fromBotId)
          .catch(() => [] as string[])
      ).includes(toBotId),
    auditStore: bootAuditStore,
    /*
     * An ask in a group is board work too (ticket 019, spec B1-B2).
     *
     * The same projector a person's browser turn and a routine firing write through, keyed by the turn's
     * own run id -- which is also the id an approval raised inside that turn is filed under, so the card
     * lands in 需要操作 when the coworker stops to ask, and comes back on its own when the person answers.
     */
    board: taskProjector,
    activity: async (turn, agentId, text, sourceId) =>
      channelStore.recordActivity(
        await actorFor(turn.ownerUserId),
        turn.channelId,
        { text, agentId, at: new Date() },
        { id: sourceId },
      ),
    busy: async (turn, busy) =>
      channelStore.signalChannelBusy(
        await actorFor(turn.ownerUserId),
        turn.channelId,
        busy,
      ),
    // A group is shared (`team`), so the people later added to it read it in their own frames.
    createChannel: async (ownerUserId, agentIds, options) =>
      channelStore.create(await actorFor(ownerUserId), agentIds, options),
    // Adding a Bot to an existing group passes the same access filter as naming it at creation.
    canUseBot: async (ownerUserId, agentId) =>
      Boolean(
        await agentProfileStore.get(await actorFor(ownerUserId), agentId),
      ),
    // The owner says whether a Bot's words may reach the other people in a group.
    privateShare: createPrivateShareCheck({ approvals: approvalService.store }),
    // A Team Bot's consent card raised in a group turn is drawn in the shared transcript.
    listenForConsent: (ownerUserId, agentId) =>
      teamBots.listenForConsent(ownerUserId, agentId),
  });
  startup.acquireSync(
    () =>
      repeatAfterEach(async () => {
        try {
          while (await groupConversations.sweep()) {}
        } catch (error) {
          console.error(
            JSON.stringify({
              type: "group-sweep-error",
              error: error instanceof Error ? error.message : String(error),
              timestamp: new Date().toISOString(),
            }),
          );
        }
      }, 1_000),
    (resource) => resource.stop(),
  );

  /*
   * 「招聘与组群」：员工替本人起草提议的工具，与 Routines 一样是按模块解析的内置传输，所以依赖在这里交一次。
   * 它只起草；执行走 `/api/proposals` 与执行器（见下面 `coworker.staffing`），以本人登录的身份。模型名单与员工的模型选择器同一份
   * （`GET /api/models`），角色模板只读本人的与套件的官方卡片。
   */
  useStaffingTools({
    database,
    proposals: staffingProposalStore,
    profiles: agentProfileStore,
    plugins: pluginStore,
    composioConfigured: Boolean(composioBroker),
    ...(composioBroker ? { directory: () => composioBroker.listApps() } : {}),
    routines: routineStore,
    groups: groupConversations,
    catalogue: createModelShelf({ database, quota }),
    roleTemplates: createRoleTemplateStore({
      database,
      profiles: agentProfileStore,
      official: () => officialTemplatesFrom(tenantPackage.agents),
    }),
    auditStore: bootAuditStore,
  });

  /*
   * `@` a coworker inside a 1:1 conversation (spec B2, B3): a card on the board with the coworker named
   * as executor, and the turn run here, on the channel's own thread, as that coworker. The same
   * unattended runner a routine firing uses, so the pause gate, the "Use Bots" and model-allowlist
   * refusals and the audit trail are the ones that already have suites. See channels/dispatch.ts.
   */
  const channelDispatch = createChannelDispatch({
    queue: createWorkQueue(database),
    owner: workOwner("channel-dispatch"),
    board: taskProjector,
    channel: (actor, channelId) => channelStore.get(actor, channelId),
    // The same two ways a coworker can be the caller's that the memory ingestion asks, and a ban
    // freezes this work as it freezes a routine firing (spec J5).
    bot: async (actor, agentId) => {
      if (await isAccessRevoked(database, actor.id)) return null;
      const profile = await agentProfileStore.get(actor, agentId);
      if (profile) return { id: agentId, name: profile.name };
      return (await pluginStore.agentOwner(agentId)) === actor.id
        ? { id: agentId, name: agentId }
        : null;
    },
    actorFor,
    runTurn: unattendedTurnRunner,
    activity: async ({ actor, channelId, pinnedAgentId, text, sourceId }) =>
      channelStore.recordActivity(
        actor,
        channelId,
        { text, agentId: pinnedAgentId, at: new Date() },
        { id: sourceId },
      ),
    busy: (threadId, busy) => channelStore.signalBusy(threadId, busy),
    deviceIdOf: deviceIdForBot,
  });
  startup.acquireSync(
    () =>
      repeatAfterEach(async () => {
        try {
          while (await channelDispatch.sweep()) {}
        } catch (error) {
          console.error(
            JSON.stringify({
              type: "channel-dispatch-sweep-error",
              error: error instanceof Error ? error.message : String(error),
              timestamp: new Date().toISOString(),
            }),
          );
        }
      }, 1_000),
    (resource) => resource.stop(),
  );

  /*
   * A person's answer to a Bot's question (approvals/person-response-sweep.ts): claimed, checked
   * against where it was asked, the turn that asked resumed in the answer's own tenant, and the reply
   * posted back to the channel the question came from. The card that asked goes on to review (I3).
   */
  startup.acquireSync(
    () =>
      repeatAfterEach(
        createPersonResponseTick({
          approvalQueue,
          personResponseOwner,
          authoriseQuestion,
          approvalContinuationRunner,
          responsibilityStore,
          responsibilityAnswerTurn,
          sourceForCoordinationRun,
          channelStore,
          actorFor,
          notify: (scope, input) => deliveryNotifications(scope, input),
          board: taskProjector,
        }),
        2_000,
      ),
    (resource) => resource.stop(),
  );

  /**
   * Delivering hops, on every replica.
   *
   * A loop rather than a schedule, because a hop is somebody waiting for an answer rather than
   * housekeeping: the culler's minute-granularity CronJob would be an unexplainable pause in a
   * conversation. Every replica sweeps, and the queue decides which of them gets which hop, so adding a
   * replica adds delivery capacity rather than contention.
   *
   * Only where the capability is switched on. A deployment with a depth cap of zero never has a hop to
   * deliver, and a loop polling for work that cannot exist is a query a second for nothing.
   */
  /*
   * Both zeros switch the capability off, so both have to stop the loop.
   *
   * Gated on the depth alone, a deployment that set the fan-out cap to zero still swept every two
   * seconds for hops that can never be offered: roughly forty thousand claim transactions per replica
   * per day, for a feature it had turned off.
   */
  /**
   * The queue's own wake-up, when handing work between Bots is switched on at all.
   *
   * Held at module scope so the shutdown below can give its connection back. Undefined on a
   * deployment with the capability off, which is a deployment that never started one.
   */

  if (config.handoff.maxDepth > 0 && config.handoff.maxPerRun > 0) {
    // The runner, its delivery, and the loop and queue wake-up that drive them (agents/handoff-wiring.ts),
    // owned by the startup scope so a stopped server gives their connection back.
    await startHandoffDelivery({
      productTelemetry,
      config,
      database,
      bootAuditStore,
      actorFor,
      copilotRuntime,
      threadIdentity,
      groupConversations,
      channelStore,
      board: taskProjector,
      quota,
      startup,
    });
  }

  /*
   * And dropping the hops that are over, whether or not the capability is switched on.
   *
   * OUTSIDE THE GATE ABOVE, deliberately. A deployment that switches handing work off still has
   * whatever it made while it was on, and rows that stop being reaped are rows that stay at the head
   * of the queue: switched back on a month later, the first thing that happens is a month-old question
   * being delivered to somebody who has long since stopped waiting. Reaping is housekeeping about the
   * past rather than part of the feature.
   *
   * Every replica reaps; the statement is a delete by age, so two doing it is the same as one doing it.
   * Its own loop rather than a phase of the sweep, so an hour of failing to reap never delays an answer.
   */
  const reaper = createHandoffRunner({
    queue: createWorkQueue(database),
    owner: workOwner("reaper"),
    sign: () => "",
    auditStore: bootAuditStore,
    // Never called: `reap` deletes rows by age and claims nothing.
    delivery: {
      deliver: async () => {
        throw new Error("the reaper does not deliver hops");
      },
    },
  });
  startup.acquireSync(
    () =>
      repeatAfterEach(
        async () => {
          try {
            const purged = await reaper.reap();
            if (purged > 0) {
              console.info(
                JSON.stringify({ type: "bot-handoff-reaped", purged }),
              );
            }
          } catch (error) {
            console.warn(
              "[handoff] hops that are over could not be dropped:",
              error instanceof Error ? error.message : error,
            );
          }
        },
        60 * 60 * 1_000,
      ),
    (resource) => resource.stop(),
  );

  /*
   * 中文 for skills and plugins that arrived in English: their names, summaries, tool descriptions and
   * instructions as the screens show them (migration 0145). Reads queue what has no translation yet;
   * this loop asks the deployment's model for a few at a time. Display only: what a model is given
   * stays the original. A deployment with no model key simply keeps showing the originals.
   */
  const textTranslationStore = createTranslationStore(database);
  const translateToChinese = createTranslator(
    createModelCompleter({
      model: runtimeModel,
      resolveApiKey: resolveRuntimeModelApiKey,
      timeoutMs: 60_000,
      maxTokens: 4096,
    }),
  );
  startup.acquireSync(
    () =>
      repeatAfterEach(async () => {
        try {
          const report = await runAsTenant("platform", () =>
            translatePending(textTranslationStore, translateToChinese),
          );
          if (report.translated > 0 || report.failed > 0) {
            console.info(
              JSON.stringify({ type: "text-translations", ...report }),
            );
          }
        } catch (error) {
          console.warn(
            "[translations] skills and plugins could not be translated:",
            error instanceof Error ? error.message : error,
          );
        }
      }, 15_000),
    (resource) => resource.stop(),
  );

  /*
   * Naming conversations, in the API process rather than `worker/`, which the single-image container
   * does not run. Its own loop, so a slow model never delays a hop.
   */
  const channelSummaries = {
    database,
    queue: createWorkQueue(database),
    transcript: routineIntelligence,
    title: createChannelTitler({
      provider: runtimeModel.provider,
      model: runtimeModel.defaultModel,
      ...(runtimeModel.plan ? { plan: runtimeModel.plan } : {}),
      resolveApiKey: resolveRuntimeModelApiKey,
    }),
    owner: workOwner("summariser"),
  };
  startup.acquireSync(
    () =>
      repeatAfterEach(async () => {
        try {
          await offerChannelsAwaitingSummary(channelSummaries);
          const report = await summariseClaimedChannels(channelSummaries);
          if (report.written.length > 0) {
            console.info(
              JSON.stringify({
                type: "channel-summaries",
                written: report.written,
              }),
            );
          }
          // Same pass: one statement, deletes by age, and two replicas running it changes nothing.
          await forgetSettledSummaries(channelSummaries);
        } catch (error) {
          // Never fatal, and never loud enough to drown the log: a deployment with no model configured
          // reaches this on every pass, and it has not gone wrong, it simply has no titles.
          console.warn(
            "[channels] conversations could not be named:",
            error instanceof Error ? error.message : error,
          );
        }
      }, 10_000),
    (resource) => resource.stop(),
  );

  /*
   * Enterprise controls (server/src/admin): capability switches, SSO-required, SCIM offboarding,
   * computer termination, network policy push, Action Recording, the model allowlist and the
   * OpenTelemetry/SIEM export of the audit trail. Installed before the app so the computer boundary,
   * the HTTP gate and the guarded stores below all see it from the first request.
   */
  await startup.acquire(
    () =>
      installEnterpriseControls({
        database,
        databaseUrl: config.databaseUrl,
        auditStore: bootAuditStore,
        personBrowserPolicy,
        // While a person records in a Bot's browser, the Recorder there reaches OpenBot and the
        // gateway; the Bot does not.
        duringRecording: botBrowserNetwork({
          connections: recorderExtension.connections,
          openbotUrls: [config.publicUrl, config.appUrl],
          gatewayUrl: config.intelligence?.gatewayWsUrl ?? "",
        }),
        ...(computerProvider ? { provider: computerProvider } : {}),
        ...(config.computer?.token
          ? { computerToken: config.computer.token }
          : {}),
        ...(config.webBotAuth ? { webBotAuth: config.webBotAuth } : {}),
        builtInModel: `${runtimeModel.provider}/${runtimeModel.defaultModel}`,
        // The bound model by the resolver's own decision, so the allowlist and the usage row name the
        // model a run actually speaks — the deployment's, once a binding's key is revoked.
        agentModelName: async (agentId) =>
          (await resolveNamedAgentModel(agentId))?.name ?? null,
        // The run gate records and judges the model a built-in run will use: the person's pick, or the
        // default the catalogue chose.
        pickedModel: async (actorId, threadId) =>
          (await modelChoices.forRun(actorId, threadId)).model,
        people: peopleStore,
        initialAdminEmails: config.auth?.initialAdminEmails ?? [],
        // Every person's live Recorder connections are read as `platform`; ending one person's runs
        // as them (see `signOutRecorders`).
        recorders: {
          holders: () =>
            asPlatform(() => recorderExtension.connections.holders()),
          signOut: signOutRecorders,
        },
      }),
    (controls) => controls.stop(),
  );
  guardDeliveryStore(
    deliveryStore,
    bootAuditStore,
    (message) => new DeliveryRefusedError(message),
  );
  guardHostAccess(
    hostAccessBroker,
    (message) => new HostAccessRefusedError(message),
  );
  auditRoutineStore(routineStore, bootAuditStore);

  // Said once, at boot, whether Intelligence will let this deployment use what it is licensed for. A
  // self-hosted Intelligence without a licence refuses memory quietly; this is the line that says why.
  if (intelligenceClient)
    void reportIntelligenceEntitlement({
      entitlements: () => intelligenceClient.getRuntimeEntitlements(),
    });

  const identityGithubCallback =
    config.githubApp && config.publicUrl
      ? githubCallbackRoutes({
          clientId: config.githubApp.clientId,
          clientSecret: config.githubApp.clientSecret,
          publicUrl: config.publicUrl,
          appUrl: config.appUrl,
          encryptionKey: config.keyEncryptionKey,
          // The people table is the deployment's: read as `platform`, as the request guard does (G01).
          personIsActive: async (userId) => {
            const person = await asPlatform(() => peopleStore.find(userId));
            return person !== undefined && !person.revoked;
          },
          credentials: credentialStore,
          identity: identityStore,
          auditStore: bootAuditStore,
        })
      : undefined;

  const app = createApp(
    config,
    auth,
    roleRepository,
    createAuditReader(database),
    createCredentialAdminService(
      config.keyEncryptionKey,
      credentialStore,
      createAuditStore(database),
    ),
    createPackageStatusReader(database),
    // The runtime call: the model, per-actor agent loading, and the two identity
    // functions are how a run is attributed to a person.
    copilotRuntime.handler,
    // The only path to an acting call.
    computerGateway,
    policyStore,
    // Bots as durable objects, and the channels they run in.
    agentProfileStore,
    channelStore,
    channelEvents,
    // The same store the boot row uses, so a Bot's own refusal lands in the trail beside its actions.
    bootAuditStore,
    componentStore,
    // MCP servers and packaged skills. Judged by the same policy the computer actions are, read
    // fresh on every call for the same reason: a rule added a moment ago applies to the next call.
    pluginStore,
    // Components authored in the browser. Their governance is the component store's; this owns only
    // the source, which is the part a rebuild would otherwise have owned.
    sandboxedStore,
    // How a thread that has no channel is named, so the direct Bot chat is in the same namespace.
    threadIdentity,
    // Who has signed in, and what an administrator may do about them.
    peopleStore,
    // The enterprise identity providers registered here. Read as facts about the deployment rather
    // than through Better Auth's own listing, which answers per person. See identity-provider-store.ts.
    identityProviderStore,
    // Chooses the coworker for an untagged message, on the deployment's own model and key.
    intentRouter,
    // What a browsing turn's screen looked like when it finished, so the transcript can show it later.
    pageFrameStore,
    // What a due routine actually does: a turn, run as its owner, into the thread they will open.
    routineRunner,
    // A person's own standing instructions: the list, and a switch to stop one.
    routineStore,
    // Where each person is in first-run onboarding, read by /api/me and written by the wizard.
    createOnboardingStore(database),
    // The same store every run reads through `loadInstructionsForActor`, so the screen a person edits
    // and the prompt their coworker is built from can never be two different pieces of text.
    userInstructionsStore,
    // The same database every other store here is built from, so a channel's staged and sent files
    // live behind the same connection as the messages that reference them.
    database,
    // Native host-folder sessions are session-only: grants disappear with this server process and the
    // desktop worker must authenticate with a fresh token for this run.
    hostAccessBroker,
    process.env.OPENBOT_DESKTOP_HOST_TOKEN,
    async (input) => {
      const proactiveRefusal = await guardProactiveCallback(
        input,
        checkInScope,
      );
      if (proactiveRefusal) return proactiveRefusal;
      const coordinated = await coordination.call(input);
      if (coordinated) return coordinated;
      const followUp = wakeUpTools({
        store: wakeUpStore,
        ownerUserId: input.actorId,
        agentId: input.botId,
        ...(input.initiator ? { initiator: input.initiator } : {}),
      }).find((candidate) => candidate.name === input.name);
      if (followUp) {
        const text = await followUp.execute(input.args);
        return { text, isError: text.startsWith(REFUSAL_MARKER) };
      }
      const { name, args, botId, actorId, initiator } = input;
      const memory = offeredMemoryTools(config.edition, {
        store: personalMemoryStore,
        ingestion: memoryIngestion,
        ownerUserId: actorId,
        agentId: botId,
      }).find((candidate) => candidate.name === name);
      if (memory) {
        const text = await memory.execute(args);
        return { text, isError: text.startsWith(REFUSAL_MARKER) };
      }
      if (KNOWLEDGE_TOOL_NAMES.has(name)) {
        // Offered only to a Waker its owner bound a notebook to; anything else is a refusal.
        const knowledge = (
          await knowledgeTools({
            store: knowledgeStore,
            ownerUserId: actorId,
            agentId: botId,
          })
        ).find((candidate) => candidate.name === name);
        const text = knowledge
          ? await knowledge.execute(args)
          : `${REFUSAL_MARKER} No knowledge notebook is shared with this Waker.`;
        return { text, isError: text.startsWith(REFUSAL_MARKER) };
      }
      if (!name.startsWith("host_")) return null;
      const tool = hostAccessTools({
        broker: hostAccessBroker,
        botId,
        actorId,
        auditStore: bootAuditStore,
        ...(initiator ? { initiator } : {}),
      }).find((candidate) => candidate.name === name);
      if (!tool) {
        return {
          text: `${REFUSAL_MARKER} That host tool is not available for this Bot right now.`,
          isError: true,
        };
      }
      const text = await tool.execute(args);
      return { text, isError: text.startsWith(REFUSAL_MARKER) };
    },
    // The app directory, behind the same client the plugin store and the transport already share.
    // Absent without a key, which leaves the routes reporting no broker rather than listing apps
    // nobody could connect.
    composioBroker
      ? {
          broker: composioBroker,
          ...(composio ? { guides: composio.guides } : {}),
          accountModes,
          ...(arcade
            ? { provider: "arcade" as const, arcade: arcade.broker }
            : {}),
          sharedUse: { store: sharedUseStore, audience: sharedAudience },
        }
      : undefined,
    process.env.OPENBOT_MODEL_OAUTH_FILE?.trim()
      ? createProviderOAuthProxy(process.env.OPENBOT_MODEL_OAUTH_FILE.trim())
      : undefined,
    createUserPreferencesStore(database),
    {
      store: createVoiceSessionStore(database, channelStore),
      summarize: createVoiceSummarizer({
        model: runtimeModel,
        resolveApiKey: resolveRuntimeModelApiKey,
      }),
      channels: channelStore,
    },
    {
      productTelemetry,
      approvals: approvalService,
      // M3: upstream also passes `shared: { modes, use }` (shared use and shared accounts); not adopted.
      ...(signInService ? { passwords: signInService } : {}),
      recorder: recorderExtension,
      // A Bot's browser, worked by the person holding its wheel: its bar and Record, wherever Bots
      // have computers.
      ...(computerGateway
        ? {
            botBrowser: {
              recorder: recorderExtension,
              openbotUrl: openbotAddress(config),
              /*
               * The Bot's policy, which `botBrowserNetwork` widens while a recording runs, to the
               * computer of the seat the recording is on: the person's own, or the isolated Bot's.
               * Under that computer's own token.
               */
              pushPolicy: async (seat) => {
                const policy = await enterpriseControls()?.policyForBot(
                  seat.botId,
                );
                if (!policy) return;
                const token = computerGateway.tokenFor(seat);
                await pushEgressPolicy(
                  await computerGateway.locate(seat),
                  seat.botId,
                  policy,
                  {
                    ...(token ? { token } : {}),
                    ...(config.webBotAuth
                      ? { webBotAuth: config.webBotAuth }
                      : {}),
                  },
                );
              },
              singleUser: config.singleUser,
              // Where every Bot shares one computer, Record is refused in all their browsers.
              ...(recordRefused ? { recordRefused } : {}),
            },
          }
        : {}),
      /*
       * Only where a person's browser can run: a host-side computer of people's browsers, computers
       * Bots run on that give each its own, or the personal edition's one computer. Where every Bot
       * shares one, the routes have no computers and say why (browser/host.ts).
       */
      ...(computerGateway || config.browser
        ? {
            browser: {
              ...personBrowserPlace({
                provider: computerProvider,
                browserUrl: config.browser?.url,
                edition: config.edition,
                computers: () =>
                  computerGateway
                    ? gatewayBrowserComputers(
                        computerGateway,
                        config.browser?.url,
                      )
                    : directBrowserComputers({
                        browserUrl: (config.browser as { url: string }).url,
                        policy: personBrowserPolicy,
                        ...(config.browser?.token
                          ? { token: config.browser.token }
                          : {}),
                      }),
              }),
              recorder: recorderExtension,
              openbotUrl: openbotAddress(config),
              // On a single-user OpenBot the person is its admin: a setup failure is theirs to see to.
              singleUser: config.singleUser,
            },
          }
        : {}),
      ...(learningModelEndpoint
        ? { learningModel: learningModelEndpoint }
        : {}),
      // Upstream #1372/#1381/#1396/#1397/#1398/#1399: drafts written from an admin's description.
      boundaryWriter: writeBoundaries,
      approvalRules: {
        vocabulary: () => adminRead(() => loadRuleVocabulary(database)),
      },
      // Upstream #1380: questions about the audit trail in plain English.
      auditQuestions: {
        complete: askTheAuditTrail,
        vocabulary: () =>
          adminRead(() =>
            readAuditVocabulary(database, () => policyStore.get()),
          ),
      },
      /*
       * Upstream #1402, "what would happen if…": the stores the live path decides from, the same
       * boundary, controls snapshot, grants and gate. Read across people as an administrator reads
       * the trail (`adminRead`), since the question may be about anybody's Bot.
       */
      whatIf: {
        complete: readWhatIfQuestions,
        vocabulary: () => adminRead(() => readWhatIfVocabulary(database)),
        readers: {
          policy: () => policyStore.get(),
          enterprise: () => {
            const controls = enterpriseControls();
            return controls ? { snapshot: controls.snapshot() } : null;
          },
          grant: (ref, botId) =>
            adminRead(() => pluginStore.decide("mcp", ref, botId)),
          ...(approvalService.store.policy
            ? {
                approvals: {
                  policy: approvalService.store.policy,
                  rules: (owner: string) =>
                    adminRead(() => approvalService.store.rules(owner)),
                },
              }
            : {}),
        },
        event: (id) => adminRead(() => readAuditEvent(database, id)),
      },
      /*
       * Settings, Learning: who else's Bots use a person's own learned Skills. Only with the optional
       * Intelligence, which is where Learning is.
       */
      ...(learning && learningSettings && intelligenceClient
        ? {
            personalLearning: {
              store: learningSharingStore,
              ...(learningModelEndpoint?.calls
                ? { modelCalls: learningModelEndpoint.calls }
                : {}),
              approvals: skillApprovalStore,
              ...(autoApprover ? { autoApprover } : {}),
              skillsOf: (userId: string) => learning.personalSkills(userId),
              skillOf: (userId: string, name: string) =>
                skillIn(personalLearningSpaces.containerFor(userId), name),
              containerSkills: (id: string) => learning.containerSkills(id),
              invalidate: () => openSkillIndex.invalidate(),
              sharingAllowed: skillSharingAllowed,
              manage: intelligenceClient.experimental.learning,
              modelUnavailable: learningModelUnavailable(process.env),
              recordingTitles: recorderExtension.recordingTitles,
              settings: learningSettings,
              scopesFor: async (actor: { id: string }) =>
                learningScopes({
                  edition: currentEdition(),
                  userId: actor.id,
                  settings: await learningSettings.read(),
                }),
            },
          }
        : {}),
      delivery: {
        authenticated: {
          store: deliveryStore,
          router: deliveryRouter,
          scopeFor: deliveryScopeFor,
          listConversations: async (owner, cursor) =>
            channelStore.list(await actorFor(owner), { cursor, limit: 100 }),
          history: (scope) =>
            routineIntelligence.getThreadMessages({
              threadId: scope.threadId,
              userId: scope.ownerUserId,
            }),
          slack: deliveryProviders.slack,
          twilio: deliveryProviders.sms,
          pushProjectId: deliveryProviders.pushProjectId,
        },
        webhooks: {
          store: deliveryStore,
          router: deliveryRouter,
          approvals: approvalService,
          scopeFor: deliveryScopeFor,
          slack: deliveryProviders.slack,
          twilio: deliveryProviders.sms,
          identity: slackCodeRedeemer(identityStore, bootAuditStore),
        },
      },
      memory: { store: personalMemoryStore, ingestion: memoryIngestion },
      proactive: { store: proactiveStore, engine: proactiveEngine },
      localLearning: { database, engine: localLearningEngine },
      // Upstream's started work, at `/api/bot-tasks` (`/api/tasks` is the board, mounted below).
      tasks: { store: taskStore, runner: taskRunner },
      responsibilities: {
        store: responsibilityStore,
        engine: responsibilityEngine,
        bindings: responsibilityBindings,
        triggers: responsibilityTriggers,
      },
      groups: groupConversations,
      staffing: {
        store: staffingProposalStore,
        executor: createStaffingExecutor({
          database,
          proposals: staffingProposalStore,
          profiles: agentProfileStore,
          quota,
          plugins: pluginStore,
          composioConfigured: Boolean(composioBroker),
          ...(composioBroker
            ? { directory: () => composioBroker.listApps() }
            : {}),
          routines: routineStore,
          channels: channelStore,
          groups: groupConversations,
          portraits: createPortraitStore(database),
          auditStore: bootAuditStore,
          // Owner approvals of a Shared app are withdrawn with the owner's grants, as in `DELETE /give`.
          shared: { store: sharedUseStore, audience: sharedAudience },
        }),
        canSeeThread: createThreadVisibility(database),
        ownerName: createOwnerNameReader(database),
      },
      teamBots,
      // AUT3: the WakerFlow target is registered above, so the form may offer it.
      wakerflowAutomations: true,
      lifecycle: {
        lifecycle: createBotLifecycleStore(database),
        reset: createBotReset({
          database,
          softDeleteChannel: (actor, channelId) =>
            channelStore.softDelete(actor, channelId),
        }),
        activity: createActivityStore(database),
        wakeUps: wakeUpStore,
        profiles: agentProfileStore,
        tasks: taskRunner,
        auditStore: bootAuditStore,
        auditTrail: createAgentTrailReader(database),
      },
      // Upstream's model catalogue, at `/api/model-catalogue` (`/api/models` is the library, below).
      models: modelCatalogue,
      modelChoices,
      // The checklist onboarding ends on. Facts and verdicts about this configuration, never values.
      setup: createSetupSources({
        productName: tenantPackage.productName,
        config,
        environment: process.env,
        model: {
          provider: runtimeModel.provider,
          keyId: tenantPackage.model.credentialSecretRef,
          defaultModel: runtimeModel.defaultModel,
          plan: Boolean(runtimeModel.plan),
          check: checkModelAvailability,
        },
        credentials: credentialStore,
        modelCheckAtBoot,
        // M3: the checklist's "Back end" row is upstream's required Intelligence. Intelligence is
        // optional in this fork (R0), so without it the row reads as unreachable.
        entitlements: () =>
          intelligenceClient
            ? intelligenceClient.getRuntimeEntitlements()
            : Promise.reject(new Error("Intelligence is not connected.")),
        computer: Boolean(config.computer),
        computerCheck: createComputerCheck({
          provider: computerProvider,
          controls: enterpriseControls,
          ...(config.computer?.token ? { token: config.computer.token } : {}),
          ...(config.webBotAuth ? { webBotAuth: config.webBotAuth } : {}),
        }),
        apps: {
          configured: Boolean(composio || arcade),
          provider:
            brokerWiring.provider ?? config.brokerProvider ?? "composio",
        },
        chat: Boolean(deliveryProviders.slack),
      }),
    },
    // "Is this conversation still here", answered from this deployment's own `threads` table.
    createLocalThreadReader(database),
    // The plan ceilings, so a coworker created over them is refused by the write path (ticket 022).
    quota,
    // Automatic Learning's admin page, only with a connected Intelligence (R0).
    learningSettings && intelligenceClient
      ? {
          store: learningSettings,
          ...(learningAutoAssign ? { autoAssign: learningAutoAssign } : {}),
          status: learning?.status,
          // Read directly: the runtime client refuses a snapshot without dashboard links.
          ...(config.intelligence
            ? {
                inspect: createInspectorLearningReader({
                  apiUrl: intelligenceClient.ɵgetApiUrl(),
                  apiKey: config.intelligence.apiKey,
                }),
              }
            : {}),
          manage: intelligenceClient.experimental.learning,
          modelUnavailable: learningModelUnavailable(process.env),
          skills: learning?.containerSkills,
          approvals: skillApprovalStore,
          // Everyone who has a space, for an administrator's review: across people, so as `platform`.
          people: () => asPlatform(() => learningPeople()),
          personSkill: (userId: string, name: string) =>
            skillIn(personalLearningSpaces.containerFor(userId), name),
          invalidate: () => openSkillIndex.invalidate(),
          recordingTitles: recorderExtension.recordingTitles,
        }
      : undefined,
    // The self-host bar: the operator's switch, and hidden for a deployment paying for Intelligence.
    createSelfHostBanner({
      enabled: config.selfHostBanner,
      ...(intelligenceClient
        ? { entitlements: () => intelligenceClient.getRuntimeEntitlements() }
        : {}),
    }),
    identityStore,
    identityGithubCallback,
    profileStore,
  );

  /*
   * The operator screen (ticket 006): who this deployment serves and the two
   * levers over a tenant. Guarded by `admin` inside; reads run under the
   * `platform` session scope the store sets, never under a person's.
   */
  app.route(
    "/api/platform",
    createPlatformRoutes(
      database,
      config.singleUser
        ? createDevRequireUser(config.singleUserAccess)
        : createRequireUser(auth as AuthService, roleRepository),
      signInAuditStore,
      // Spec J5's cross-tenant reads, through the admin capability like `/api/admin/audit-events`.
      {
        adminScope: createAdminScope({ roleRepository }),
        auditReader: createAuditReader(database),
      },
    ),
  );

  /*
   * `POST /api/channels/:channelId/dispatch` (spec B2): mounted beside the channel routes, behind the
   * same session guard, so the offer and the card are written in the caller's own tenant.
   */
  app.route(
    "/api/channels",
    createChannelDispatchRoutes(
      channelDispatch,
      config.singleUser
        ? createDevRequireUser(config.singleUserAccess)
        : createRequireUser(auth as AuthService, roleRepository),
    ),
  );

  /*
   * The task board (ticket 007): the projector is the only writer, these
   * routes are the read side, and both run under the caller's tenant scope.
   */
  app.route(
    "/api/tasks",
    createTaskRoutes(
      database,
      config.singleUser
        ? createDevRequireUser(config.singleUserAccess)
        : createRequireUser(auth as AuthService, roleRepository),
      taskProjector,
    ),
  );

  /*
   * The tenant model library (ticket 011): provider templates plus one's own
   * keys, encrypted in the same vault as everything else.
   */
  app.route(
    "/api/models",
    createModelRoutes(
      database,
      config.singleUser
        ? createDevRequireUser(config.singleUserAccess)
        : createRequireUser(auth as AuthService, roleRepository),
      credentialStore,
      config.keyEncryptionKey,
      quota,
      { outbound: modelOutbound },
    ),
  );

  /*
   * The tenant's persona templates (ticket 014): named characters a coworker can
   * be given, copied onto the coworker rather than referenced, so retiring a
   * template never reaches into a conversation that is already running.
   */
  /*
   * The tenant's machines (ticket 016): the owner's screen mints a pairing code,
   * the runner spends it, and presence is the last moment either of them heard
   * from the device.
   *
   * `/api/runner` sits outside the session guard on purpose — a machine being set
   * up has no session, and the code on the person's screen is the credential. Its
   * writes are scoped to the tenant that minted the code, never to a tenant named
   * by the caller.
   */
  /*
   * What this tenant's plan allows and what they have used (ticket 022), plus the manual tier switch:
   * this product takes no payment, so the only honest upgrade control is the row that moves.
   */
  app.route(
    "/api/quota",
    createQuotaRoutes(
      database,
      quota,
      config.singleUser
        ? createDevRequireUser(config.singleUserAccess)
        : createRequireUser(auth as AuthService, roleRepository),
    ),
  );

  app.route(
    "/api/devices",
    createDeviceRoutes(
      deviceStore,
      config.singleUser
        ? createDevRequireUser(config.singleUserAccess)
        : createRequireUser(auth as AuthService, roleRepository),
      deviceQueue,
      (target) => {
        void deviceChannel.flush(target).catch(() => undefined);
      },
    ),
  );
  app.route("/api/runner", createRunnerRoutes(deviceStore, quota));

  // Story RES2: the signed-in person's projects on their own machines, in their own frame.
  app.route(
    "/api/projects",
    createProjectRoutes(
      projectStore,
      config.singleUser
        ? createDevRequireUser(config.singleUserAccess)
        : createRequireUser(auth as AuthService, roleRepository),
      {
        isReachable: (target) => deviceChannel.isReachable(target),
        dispatch: (target, action, payload, timeoutMs) =>
          deviceChannel.dispatch(target, action, payload, timeoutMs),
      },
    ),
  );

  // Story F1: the information sources of the signed-in person's own 分身, in their own frame.
  app.route(
    "/api/me/avatar/sources",
    createAvatarSourceRoutes(
      avatarSourceStore,
      config.singleUser
        ? createDevRequireUser(config.singleUserAccess)
        : createRequireUser(auth as AuthService, roleRepository),
    ),
  );

  app.route(
    "/api/agents",
    createAutonomousRoutes(
      createAutonomousStore(database),
      config.singleUser
        ? createDevRequireUser(config.singleUserAccess)
        : createRequireUser(auth as AuthService, roleRepository),
    ),
  );

  /*
   * AUT2: an automation's public event entry. No session: the trigger's secret (Bearer, or a Standard
   * Webhooks signature) is the credential, and the tenant is the one the trigger row names. Mounted
   * before `/api/automations` so the signed-in routes never see a hook delivery.
   */
  app.route(
    "/api/automations/hooks",
    createAutomationHookRoutes({
      ...automationIngress,
      directory: createAutomationHookDirectory(database),
    }),
  );

  // A person's automations (D06): per-route session guard, tenant from the session frame only.
  app.route(
    "/api/automations",
    createAutomationRoutes(
      automationStore,
      config.singleUser
        ? createDevRequireUser(config.singleUserAccess)
        : createRequireUser(auth as AuthService, roleRepository),
      automationIngress,
    ),
  );

  app.route(
    "/api/waker-groups",
    createWakerGroupRoutes(
      createWakerGroupStore(database),
      config.singleUser
        ? createDevRequireUser(config.singleUserAccess)
        : createRequireUser(auth as AuthService, roleRepository),
    ),
  );

  // 头像: the faces people chose for coworkers and groups (migration 0144).
  app.route(
    "/api/portraits",
    createPortraitRoutes(
      createPortraitStore(database),
      coworkerFaceAccess(agentProfileStore),
      config.singleUser
        ? createDevRequireUser(config.singleUserAccess)
        : createRequireUser(auth as AuthService, roleRepository),
    ),
  );

  app.route(
    "/api/translations",
    createTranslationRoutes(
      textTranslationStore,
      pluginStore,
      config.singleUser
        ? createDevRequireUser(config.singleUserAccess)
        : createRequireUser(auth as AuthService, roleRepository),
    ),
  );

  // The crew's pipelines (ticket 021): the templates a workspace can run, and the runs it pressed.
  app.route(
    "/api/group-pipelines",
    createPipelineRoutes(
      pipelineStore,
      config.singleUser
        ? createDevRequireUser(config.singleUserAccess)
        : createRequireUser(auth as AuthService, roleRepository),
    ),
  );

  // WakerFlow (spec D10): plans, their planning requests and their runs, next to the pipelines they compile to.
  app.route(
    "/api/wakerflows",
    createWakerFlowRoutes({
      store: wakerFlowStore,
      requireUser: config.singleUser
        ? createDevRequireUser(config.singleUserAccess)
        : createRequireUser(auth as AuthService, roleRepository),
    }),
  );
  // WF9: a shared Flow's preview and import, in the signed-in importer's own frame.
  app.route(
    "/api/wakerflow-shares",
    createWakerFlowShareRoutes({
      store: wakerFlowStore,
      requireUser: config.singleUser
        ? createDevRequireUser(config.singleUserAccess)
        : createRequireUser(auth as AuthService, roleRepository),
    }),
  );

  app.route(
    "/api/personas",
    createPersonaRoutes(
      createPersonaTemplateStore(database),
      config.singleUser
        ? createDevRequireUser(config.singleUserAccess)
        : createRequireUser(auth as AuthService, roleRepository),
    ),
  );

  // Role templates (story ROLE1): the person's own, and the package's seed cards as read-only ones.
  const officialRoleTemplates = officialTemplatesFrom(tenantPackage.agents);
  app.route(
    "/api/role-templates",
    createRoleTemplateRoutes(
      createRoleTemplateStore({
        database,
        profiles: agentProfileStore,
        official: () => officialRoleTemplates,
        // Smart generation: the person's own model library only (D7), like WakerFlow planning.
        models: createFlowModelResolver({
          database,
          encryptionKey: config.keyEncryptionKey,
          allowPlatformModel: false,
          outbound: modelOutbound,
        }),
        generator: createRoleGenerator(),
        quota,
      }),
      config.singleUser
        ? createDevRequireUser(config.singleUserAccess)
        : createRequireUser(auth as AuthService, roleRepository),
    ),
  );

  // A person's knowledge base (D08, story RES1): notebooks, text sources and read-only Waker bindings.
  app.route(
    "/api/knowledge",
    createKnowledgeRoutes(
      knowledgeStore,
      config.singleUser
        ? createDevRequireUser(config.singleUserAccess)
        : createRequireUser(auth as AuthService, roleRepository),
    ),
  );

  /*
   * The front door (http-server.ts): one Bun server for the app, the live screen and terminal
   * proxies, the channel sockets, and the tenant's own machines' runner and screen sockets.
   */
  startup.acquireSync(
    () =>
      startHttpServer({
        port,
        config,
        resolveRequestActor,
        agentProfileStore,
        computerGateway,
        devices: {
          store: deviceStore,
          channel: deviceChannel,
          screens: deviceScreens,
        },
        app,
      }),
    (server) => server.stop(true),
  );

  if (config.singleUser) {
    // Loud, every boot. A server that is not checking who is asking should never be a quiet default.
    console.warn(
      "No identity provider is configured, so every request is treated as " +
        `${DEV_ACTOR.email} (administrator). Configure GOOGLE_OAUTH_*, ` +
        "MICROSOFT_OAUTH_* or OKTA_OAUTH_* before anybody else can reach this.",
    );
  }

  console.info(`OpenBot server listening on http://127.0.0.1:${port}`);
});
