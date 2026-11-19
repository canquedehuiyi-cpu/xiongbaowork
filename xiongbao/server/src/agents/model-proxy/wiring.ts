import type { CredentialSecretReader } from "../../credentials";
import type { Database } from "../../db/client";
import {
  boundModelName,
  createAgentUpstreamResolver,
} from "../../models/runtime-resolver";
import type { ModelTokenCallSink } from "../../models/token-metering";
import type { OutboundPolicy } from "../../net/outbound-guard";
import type { QuotaService } from "../../quota/limits";
import { runAsTenant } from "../../tenant/context";
import { loadDeviceAcpEmployee } from "../runtime-agents";
import {
  type AcpModelAccess,
  type AgentModelProxyConfig,
  createAcpModelAccess,
} from "./access";
import { type AgentModelProxy, createAgentModelProxy } from "./proxy";
import { type AgentModelTokens, createAgentModelTokens } from "./token";

/**
 * The model proxy of this deployment and what hands its passes out: one token minter shared by the
 * proxy that checks them and the `acp.open` that issues them.
 */
export type AgentModelService = {
  tokens: AgentModelTokens;
  proxy: AgentModelProxy;
  access: AcpModelAccess;
};

/** A sentence when the tenant is over its plan's monthly task allowance, else null. */
export async function overMonthlyAllowance(
  quota: Pick<QuotaService, "planFor" | "usageFor">,
  tenantId: string,
): Promise<string | null> {
  const [plan, usage] = await Promise.all([
    quota.planFor(tenantId),
    quota.usageFor(tenantId),
  ]);
  const allowed = plan.limits.tasksPerMonth;
  return usage.tasks > allowed
    ? `本月任务额度已用完（${usage.tasks}/${allowed}），升级套餐或等下个月再继续。`
    : null;
}

export function createAgentModelService(options: {
  database: Database;
  credentials: CredentialSecretReader;
  encryptionKey: string;
  sink: ModelTokenCallSink;
  quota?: Pick<QuotaService, "planFor" | "usageFor">;
  outbound: OutboundPolicy;
  config: AgentModelProxyConfig;
  /** The proxy's address as a cloud computer reaches it (`readAgentModelComputerUrl`). */
  computerBaseUrl?: string | undefined;
  environment?: Readonly<Record<string, string | undefined>>;
}): AgentModelService {
  const { database, config } = options;
  const tokens = createAgentModelTokens({
    encryptionKey: options.encryptionKey,
  });
  const resolve = createAgentUpstreamResolver(
    database,
    options.credentials,
    options.encryptionKey,
    options.environment ? { environment: options.environment } : {},
  );
  const quota = options.quota;
  const proxy = createAgentModelProxy({
    tokens,
    // Asked in the tenant's own frame (the proxy opens it): a deleted employee, one that is not an
    // external employee any more, or another tenant's is not found.
    employeeActive: async (claims) => {
      const employee = await loadDeviceAcpEmployee(database, claims.agentId);
      return employee?.ownerUserId === claims.tenantId;
    },
    resolveUpstream: (claims) => resolve(claims.agentId),
    ...(quota
      ? { quota: (tenantId: string) => overMonthlyAllowance(quota, tenantId) }
      : {}),
    sink: options.sink,
    outbound: options.outbound,
    ...(config.perMinute ? { perMinute: config.perMinute } : {}),
  });
  const access = createAcpModelAccess({
    tokens,
    baseUrl: config.baseUrl,
    ...(options.computerBaseUrl === undefined
      ? {}
      : { computerBaseUrl: options.computerBaseUrl }),
    boundModel: async (tenantId, agentId) => {
      const name = await runAsTenant(tenantId, () =>
        boundModelName(database, agentId, options.environment ?? process.env),
      );
      // `provider/model`: the harness is told the model's own name.
      return name ? name.slice(name.indexOf("/") + 1) : null;
    },
  });
  return { tokens, proxy, access };
}
