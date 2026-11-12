import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { shortName } from "../brand";
import { PORTRAIT_MAX_BYTES, sniffPortrait } from "./image";
import {
  PORTRAIT_PRESETS,
  type PortraitKind,
  type PortraitPreset,
  type PortraitStore,
  type PortraitSummary,
} from "./store";

type Ctx = { Variables: AppVariables };
type Actor = AppVariables["actor"];

/**
 * What a coworker's face may be shown to and changed by: the coworker's own rules, asked of the
 * coworker store, so a 头像 can never reach further than the coworker it belongs to. A private
 * coworker's face is seen by those who may see the coworker; it is changed by those who may manage it.
 */
export type CoworkerFaceAccess = {
  /** The ids of every coworker this person may see. */
  visible(actor: Actor): Promise<Set<string>>;
  canSee(actor: Actor, id: string): Promise<boolean>;
  canChange(actor: Actor, id: string): Promise<boolean>;
};

/** A base64 body a little over the byte limit, so the size is refused before anything is decoded. */
const MAX_BODY_CHARACTERS = Math.ceil((PORTRAIT_MAX_BYTES * 4) / 3) + 1024;

function isKind(value: string): value is PortraitKind {
  return value === "coworker" || value === "group";
}

function isPreset(value: unknown): value is PortraitPreset {
  return (
    typeof value === "string" &&
    (PORTRAIT_PRESETS as readonly string[]).includes(value)
  );
}

function portraitDto(portrait: PortraitSummary) {
  return {
    kind: portrait.kind,
    id: portrait.id,
    preset: portrait.preset,
    // Versioned by the write's time, so a replaced picture is a new URL and the old one can be cached.
    imageUrl: portrait.hasImage
      ? `/api/portraits/${portrait.kind}/${encodeURIComponent(portrait.id)}/image?v=${portrait.updatedAt.getTime()}`
      : null,
    updatedAt: portrait.updatedAt.toISOString(),
  };
}

/**
 * 头像 for coworkers (员工) and groups (群组): one list for the workspace, the uploaded pictures, and
 * choosing or clearing one.
 *
 * A group's face follows the group's own rule: anybody in the workspace may change a group, so
 * anybody may change its face. A coworker's follows the coworker's (`CoworkerFaceAccess`).
 */
export function createPortraitRoutes(
  store: PortraitStore,
  coworkers: CoworkerFaceAccess,
  requireUser: MiddlewareHandler<Ctx>,
) {
  const routes = new Hono<Ctx>();

  /** Null when the caller may change this subject's face, otherwise the refusal to send. */
  async function refuseChange(
    context: Context<Ctx>,
    kind: PortraitKind,
    id: string,
  ) {
    const actor = context.var.actor;
    if (kind === "group") {
      return (await store.groupExists(id))
        ? null
        : context.json({ error: "没有这个群组。" }, 404);
    }
    if (!(await coworkers.canSee(actor, id))) {
      return context.json({ error: "没有这个员工。" }, 404);
    }
    return (await coworkers.canChange(actor, id))
      ? null
      : context.json(
          { error: "只有这个员工的负责人或管理员可以更换它的头像。" },
          403,
        );
  }

  routes.get("/", requireUser, async (context) => {
    const all = await store.list();
    const visible = all.some((portrait) => portrait.kind === "coworker")
      ? await coworkers.visible(context.var.actor)
      : new Set<string>();
    return context.json({
      portraits: all
        .filter(
          (portrait) => portrait.kind === "group" || visible.has(portrait.id),
        )
        .map(portraitDto),
    });
  });

  routes.get("/:kind/:id/image", requireUser, async (context) => {
    const kind = context.req.param("kind");
    const id = context.req.param("id");
    if (!isKind(kind)) return context.json({ error: "没有这种头像。" }, 404);
    if (
      kind === "coworker" &&
      !(await coworkers.canSee(context.var.actor, id))
    ) {
      return context.json({ error: "没有这个员工。" }, 404);
    }
    const image = await store.image(kind, id);
    if (!image) return context.json({ error: "没有上传的头像。" }, 404);
    return new Response(Buffer.from(image.bytes), {
      headers: {
        "content-type": image.contentType,
        // The URL carries the version, so a cached copy is never stale; private because it is behind
        // a session.
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  });

  routes.put("/:kind/:id", requireUser, async (context) => {
    const kind = context.req.param("kind");
    const id = context.req.param("id");
    if (!isKind(kind)) return context.json({ error: "没有这种头像。" }, 404);
    const raw = await context.req.text();
    if (raw.length > MAX_BODY_CHARACTERS) {
      return context.json({ error: "图片太大了，请换一张小一些的。" }, 413);
    }
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      body =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
    } catch {
      body = {};
    }

    let choice:
      | { preset: PortraitPreset }
      | {
          image: {
            contentType: NonNullable<ReturnType<typeof sniffPortrait>>;
            bytes: Uint8Array;
          };
        };
    if (body.preset !== undefined) {
      if (!isPreset(body.preset)) {
        return context.json({ error: `没有这个${shortName()}表情。` }, 400);
      }
      choice = { preset: body.preset };
    } else if (typeof body.image === "string") {
      const bytes = new Uint8Array(Buffer.from(body.image, "base64"));
      if (bytes.length === 0) {
        return context.json({ error: "图片是空的。" }, 400);
      }
      if (bytes.length > PORTRAIT_MAX_BYTES) {
        return context.json({ error: "图片太大了，请换一张小一些的。" }, 413);
      }
      const contentType = sniffPortrait(bytes);
      if (!contentType) {
        return context.json(
          { error: "头像只能是 PNG、JPEG、WebP 或 GIF 图片。" },
          415,
        );
      }
      choice = { image: { contentType, bytes } };
    } else {
      return context.json(
        { error: `请选择一个${shortName()}表情，或上传一张图片。` },
        400,
      );
    }

    const refusal = await refuseChange(context, kind, id);
    if (refusal) return refusal;
    const portrait = await store.set(kind, id, choice, context.var.actor.id);
    return context.json({ portrait: portraitDto(portrait) });
  });

  routes.delete("/:kind/:id", requireUser, async (context) => {
    const kind = context.req.param("kind");
    const id = context.req.param("id");
    if (!isKind(kind)) return context.json({ error: "没有这种头像。" }, 404);
    const refusal = await refuseChange(context, kind, id);
    if (refusal) return refusal;
    await store.remove(kind, id);
    return context.json({ ok: true });
  });

  return routes;
}
