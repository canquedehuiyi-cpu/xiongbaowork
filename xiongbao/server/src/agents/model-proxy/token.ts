import { sign, verify } from "../../auth/signed-value";

/**
 * The short-lived pass an external employee's agent (Codex, Claude Code) presents to the model proxy.
 *
 * WHAT IT IS FOR. The agent runs on the owner's computer but speaks to the employee's model through
 * this server, which swaps in the real credential and counts the usage. The agent therefore needs
 * something to prove which employee is asking, and that something must be worth nothing if it leaks:
 * it opens one door (the proxy), for one employee, in one tenant, for a few hours. The real key never
 * leaves the server.
 *
 * WHAT IT SAYS. Tenant, employee and thread, signed with a key derived from the deployment's
 * encryption key under its own label (so no other signed value can be passed off as one of these),
 * with its issue and expiry times. It is not stored: the signature is the whole check, as for a run
 * assertion (`agents/callback-token.ts`), and a database dump holds no working pass.
 *
 * WHEN IT STOPS WORKING. At its expiry (12 hours), or at once when the proxy finds the employee gone
 * (deleted, no longer an external employee, or not that tenant's): the proxy asks for the employee on
 * every request, so deleting one takes its pass away without anybody having to remember to revoke it.
 * `revoke` additionally cuts passes issued before a moment for one employee, in this process.
 *
 * ONE PASS PER PROCESS, NOT PER THREAD. An employee's agent is one process on the computer, shared by
 * its threads, and takes its pass from its environment when it starts. The pass names the thread the
 * process was opened for, which is the thread its calls are recorded under.
 */

const LABEL = "xiongbao:agent-model-pass:v1";

/** Recognisable on sight, so a leaked one can be found in a log or by a secret scanner. */
export const AGENT_MODEL_TOKEN_PREFIX = "xbm_";

/** How long a pass is good for. */
export const AGENT_MODEL_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

export type AgentModelClaims = {
  tenantId: string;
  agentId: string;
  threadId: string;
  /** Milliseconds since the epoch. */
  issuedAt: number;
  expiresAt: number;
};

export type AgentModelTokens = {
  issue(claims: { tenantId: string; agentId: string; threadId: string }): {
    token: string;
    expiresAt: number;
  };
  /** The claims of a pass this deployment signed that has not expired or been revoked, else null. */
  verify(token: string | undefined): AgentModelClaims | null;
  /** Passes of this employee issued up to now stop working (this process only). */
  revoke(target: { tenantId: string; agentId: string }): void;
};

export function createAgentModelTokens(options: {
  encryptionKey: string;
  now?: () => number;
  ttlMs?: number;
}): AgentModelTokens {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? AGENT_MODEL_TOKEN_TTL_MS;
  /** `tenant\nagent` → the moment before which passes no longer count. */
  const revoked = new Map<string, number>();
  const keyOf = (tenantId: string, agentId: string) =>
    `${tenantId}\n${agentId}`;

  return {
    issue({ tenantId, agentId, threadId }) {
      const issuedAt = now();
      const expiresAt = issuedAt + ttlMs;
      const payload = Buffer.from(
        JSON.stringify({
          v: 1,
          t: tenantId,
          a: agentId,
          h: threadId,
          i: issuedAt,
          e: expiresAt,
        }),
        "utf8",
      ).toString("base64url");
      return {
        token: `${AGENT_MODEL_TOKEN_PREFIX}${sign(payload, options.encryptionKey, LABEL)}`,
        expiresAt,
      };
    },

    verify(token) {
      if (!token?.startsWith(AGENT_MODEL_TOKEN_PREFIX)) return null;
      const payload = verify(
        token.slice(AGENT_MODEL_TOKEN_PREFIX.length),
        options.encryptionKey,
        LABEL,
      );
      if (!payload) return null;
      let claims: unknown;
      try {
        claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      } catch {
        return null;
      }
      if (typeof claims !== "object" || claims === null) return null;
      const { v, t, a, h, i, e } = claims as Record<string, unknown>;
      if (
        v !== 1 ||
        typeof t !== "string" ||
        !t ||
        typeof a !== "string" ||
        !a ||
        typeof h !== "string" ||
        !h ||
        typeof i !== "number" ||
        typeof e !== "number"
      )
        return null;
      const current = now();
      if (current >= e || i > current + 60_000) return null;
      const cutoff = revoked.get(keyOf(t, a));
      if (cutoff !== undefined && i <= cutoff) return null;
      return {
        tenantId: t,
        agentId: a,
        threadId: h,
        issuedAt: i,
        expiresAt: e,
      };
    },

    revoke({ tenantId, agentId }) {
      const current = now();
      revoked.set(keyOf(tenantId, agentId), current);
      // A revocation older than the longest pass it could cover has nothing left to cut.
      for (const [key, at] of revoked)
        if (at + ttlMs < current) revoked.delete(key);
    },
  };
}
