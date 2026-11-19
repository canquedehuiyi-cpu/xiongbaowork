import type { AcpHarness, AcpOpenModel } from "../../../../shared/acp";
import type { AgentModelTokens } from "./token";
import type { ModelWire } from "./upstream";

/**
 * What an external employee's `acp.open` carries so its agent sends model requests to the proxy
 * (`./proxy.ts`) instead of using the owner's own settings.
 *
 * ONLY WHERE IT WORKS. Codex and Claude Code are pointed at the proxy; Hermes and the owner's own
 * agent are not (they have no such setting here). An employee with no model of its own in XiongBao, a
 * deployment that has no public address for the device to reach, and a deployment that switched the
 * proxy off all get nothing, and the agent then runs on what the owner configured, as before.
 */

const WIRE_OF: Partial<Record<AcpHarness, ModelWire>> = {
  codex: "responses",
  "claude-code": "messages",
};

export type AcpModelAccess = {
  /** The `model` block for this open, or null for none. Never throws. */
  issue(input: {
    tenantId: string;
    agentId: string;
    threadId: string;
    harness: AcpHarness;
  }): Promise<AcpOpenModel | null>;
};

export function createAcpModelAccess(options: {
  tokens: AgentModelTokens;
  /** The proxy's address without a version segment, or undefined where devices cannot reach one. */
  baseUrl: string | undefined;
  /** The model this employee is bound to (its name alone), null when it has none of its own. */
  boundModel: (tenantId: string, agentId: string) => Promise<string | null>;
}): AcpModelAccess {
  return {
    async issue({ tenantId, agentId, threadId, harness }) {
      const wire = WIRE_OF[harness];
      if (!wire || !options.baseUrl) return null;
      try {
        const model = await options.boundModel(tenantId, agentId);
        if (!model) return null;
        const { token, expiresAt } = options.tokens.issue({
          tenantId,
          agentId,
          threadId,
        });
        return { baseUrl: options.baseUrl, token, model, wire, expiresAt };
      } catch {
        return null;
      }
    },
  };
}

export type AgentModelProxyConfig = {
  enabled: boolean;
  /** The proxy's address without a version segment, when there is a public one. */
  baseUrl: string | undefined;
  perMinute: number | undefined;
};

/**
 * `XIONGBAO_AGENT_MODEL_PROXY` (`off`, `0` or `false` switches it off), `XIONGBAO_AGENT_MODEL_PUBLIC_URL`
 * (the address devices reach this server at, when it is not the deployment's public address) and
 * `XIONGBAO_AGENT_MODEL_RATE_PER_MINUTE`.
 */
export function readAgentModelProxyConfig(
  environment: Readonly<Record<string, string | undefined>>,
  publicUrl: string | undefined,
  route: string,
): AgentModelProxyConfig {
  const off = /^(off|0|false)$/i.test(
    environment.XIONGBAO_AGENT_MODEL_PROXY?.trim() ?? "",
  );
  const origin = (
    environment.XIONGBAO_AGENT_MODEL_PUBLIC_URL?.trim() ||
    publicUrl ||
    ""
  ).replace(/\/+$/, "");
  let baseUrl: string | undefined;
  try {
    const url = new URL(origin);
    if (url.protocol === "https:" || url.protocol === "http:")
      baseUrl = `${url.origin}${route}`;
  } catch {
    baseUrl = undefined;
  }
  const rate = Number(environment.XIONGBAO_AGENT_MODEL_RATE_PER_MINUTE);
  return {
    enabled: !off,
    baseUrl: off ? undefined : baseUrl,
    perMinute: Number.isSafeInteger(rate) && rate > 0 ? rate : undefined,
  };
}
