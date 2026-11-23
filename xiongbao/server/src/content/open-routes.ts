import { type Context, Hono, type MiddlewareHandler } from "hono";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { ArtifactScope } from "../computer/artifact-access";
import { computerKeyText } from "../computer/computer-key";
import type { ComputerGateway } from "../computer/gateway";
import type { DeploymentConfig } from "../config";
import type { ContentAccess } from "./access";
import { contentCookies } from "./server";
import { resolveServedPath } from "./static";
import {
  type ContentGrant,
  hostCodeOf,
  issueOpenToken,
  OPEN_TOKEN_TTL_MS,
  readSessionToken,
} from "./token";

/**
 * `POST /api/computers/:botId/open`: turn "show me this folder" into a link to the content server.
 *
 * Everything that decides who may look is here and in `ContentAccess`; the content server only
 * honours what was signed. The link carries a one-time-style token (thirty minutes, its own label)
 * that the content server swaps for an HttpOnly cookie, so the address a person ends up on holds no
 * credential of the one-time kind.
 */

const NOT_FOUND = "There is no such folder.";

/** Longest folder path accepted, matching the longest path the static server will resolve. */
const MAX_PATH_LENGTH = 1024;

/** What `app` kind says until forwarding to a local web app exists. */
const APP_PLACEHOLDER = "程序转发将在后续版本提供";
const NOT_CONFIGURED = "这个部署没有配置内容源，暂时不能直接打开网页。";

export type OpenRoutesDeps = {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  /** `config.content` and `config.keyEncryptionKey`. */
  content: DeploymentConfig["content"];
  key: string;
  access: Pick<ContentAccess, "authorize">;
  gateway: Pick<ComputerGateway, "statFile">;
  auditStore?: AuditStore;
  now?: () => number;
};

type Body =
  | { kind: "dir"; path: string; scope: ArtifactScope | null }
  | { kind: "app"; port: number; path?: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The request body as one of the two shapes, or null for anything else (a 400). */
function parseBody(raw: unknown): Body | null {
  if (!isRecord(raw)) return null;
  const scope: ArtifactScope = {};
  let scoped = false;
  for (const name of ["channel", "run", "task"] as const) {
    const value = raw[name];
    if (value === undefined) continue;
    if (typeof value !== "string") return null;
    scope[name] = value;
    scoped = true;
  }
  if (raw.kind === "dir") {
    return typeof raw.path === "string"
      ? { kind: "dir", path: raw.path, scope: scoped ? scope : null }
      : null;
  }
  if (raw.kind === "app") {
    const { port, path } = raw;
    if (
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1024 ||
      port > 65535
    ) {
      return null;
    }
    if (path !== undefined && typeof path !== "string") return null;
    return { kind: "app", port, ...(path !== undefined ? { path } : {}) };
  }
  return null;
}

export function createOpenRoutes(deps: OpenRoutesDeps) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const now = deps.now ?? Date.now;
  const { content } = deps;

  routes.post(
    "/:botId/open",
    deps.requireUser,
    async (context: Context<{ Variables: AppVariables }>) => {
      const botId = context.req.param("botId") ?? "";
      const body = parseBody(await context.req.json().catch(() => null));
      if (body === null) {
        return context.json({ error: "A folder to open is required." }, 400);
      }
      const mode =
        content.domain !== undefined
          ? "domain"
          : content.port !== undefined
            ? "port"
            : null;
      if (mode === null) {
        return context.json({ available: false, reason: NOT_CONFIGURED });
      }
      if (body.kind === "app") {
        // The shape is checked and nothing else: forwarding is a later task, not half of one here.
        return context.json({ available: false, reason: APP_PLACEHOLDER });
      }

      // The folder is the same safe relative path the static server resolves, so what is opened is
      // always something it would serve: never the workspace root, never a hidden segment.
      const index = resolveServedPath(body.path, "");
      if (index === null || body.path.length > MAX_PATH_LENGTH) {
        return context.json({ error: NOT_FOUND }, 404);
      }
      const dir = index.slice(0, -"/index.html".length);

      const actor = {
        id: context.var.actor.id,
        role: context.var.actor.role,
      };
      const access = await deps.access.authorize(actor, {
        botId,
        dir,
        scope: body.scope,
      });
      if (!access) return context.json({ error: NOT_FOUND }, 404);

      // The computer's own word on it: a folder, with a page in it. A computer this server cannot
      // look into (a paired personal one) cannot be shown, so it is refused rather than guessed at.
      let folder: Awaited<ReturnType<typeof deps.gateway.statFile>>;
      let page: Awaited<ReturnType<typeof deps.gateway.statFile>>;
      try {
        folder = await deps.gateway.statFile(access.seat, { path: dir });
        page = await deps.gateway.statFile(access.seat, { path: index });
      } catch {
        return context.json(
          { error: "The computer could not be reached." },
          502,
        );
      }
      if (
        folder === null ||
        folder === "absent" ||
        folder.kind !== "folder" ||
        page === null ||
        page === "absent" ||
        page.kind !== "file"
      ) {
        return context.json({ error: NOT_FOUND }, 404);
      }

      const issuedAt = now();
      const grant: ContentGrant = {
        person: actor.id,
        bot: botId,
        seat: computerKeyText(access.seat.key),
        ...(body.scope?.channel !== undefined
          ? { channel: body.scope.channel }
          : {}),
        ...(body.scope?.run !== undefined ? { run: body.scope.run } : {}),
        ...(body.scope?.task !== undefined ? { task: body.scope.task } : {}),
        target: { kind: "dir", path: dir },
        exp: issuedAt + OPEN_TOKEN_TTL_MS,
      };
      const token = issueOpenToken(grant, deps.key);

      /*
       * Where the link points. Domain mode: the grant's own subdomain, over HTTPS (the reverse
       * proxy's). Port mode: the host this very request was addressed to, with the content port.
       * The host is the one the browser used, and only the request itself says whether it was TLS:
       * no forwarded header is read, because this deployment has no trusted-proxy setting that
       * would make one believable.
       */
      let url: string;
      let replaces = false;
      if (mode === "domain") {
        url = `https://${hostCodeOf(grant)}.${content.domain}/__open/${token}`;
      } else {
        const requested = new URL(context.req.url);
        url = `${requested.protocol}//${requested.hostname}:${content.port}/__open/${token}`;
        /*
         * One cookie per browser here, so a second open replaces the first. The application's
         * requests carry the content cookie too (cookies ignore ports): its signature is checked
         * and only the person and the target are looked at, never trusted for anything more.
         */
        for (const value of contentCookies(context.req.raw)) {
          const current = readSessionToken(value, deps.key, issuedAt);
          if (current === null) continue;
          replaces =
            current.person === actor.id &&
            hostCodeOf(current) !== hostCodeOf(grant);
          break;
        }
      }

      if (deps.auditStore) {
        await recordAuditEvent(deps.auditStore, {
          eventType: "content.opened",
          targetType: "bot",
          targetId: botId,
          actorUserId: actor.id,
          payload: {
            bot: botId,
            kind: "dir",
            path: dir,
            scopeType:
              grant.task !== undefined
                ? "task"
                : grant.channel !== undefined
                  ? "channel"
                  : "none",
            scopeId: grant.task ?? grant.channel ?? null,
            ...(grant.run !== undefined ? { run: grant.run } : {}),
            mode,
          },
        });
      }

      return context.json({
        url,
        mode,
        expiresAt: new Date(grant.exp).toISOString(),
        replaces,
      });
    },
  );

  return routes;
}
