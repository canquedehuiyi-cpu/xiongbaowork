import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { type AppVariables, requireAdmin } from "../auth/guards";
import { CATALOGUE } from "../plugins/catalogue";
import type { PluginStore } from "../plugins/store";
import type { TranslationStore } from "./store";

type Ctx = { Variables: AppVariables };

/**
 * 中文: the Chinese versions of what the Plugins and Skills screens show, for the texts that arrived
 * in English.
 *
 * Served beside `GET /api/plugins` rather than inside it, so the page draws at once from the catalogue
 * and fills in Chinese when this answers, and a deployment with no model configured loses nothing but
 * the translations. It reads exactly what that route reads for this person — the catalogue, the added
 * servers and their tools, and the skills they may see — so it can never return a translation of a
 * text the caller could not already read. Asking also queues what has no translation yet; the
 * background translator fills those in, and the next read has them.
 */
export function createTranslationRoutes(
  translations: TranslationStore,
  plugins: Pick<PluginStore, "listServers" | "listSkills">,
  requireUser: MiddlewareHandler<Ctx>,
) {
  const routes = new Hono<Ctx>();

  routes.get("/plugins", requireUser, async (context) => {
    const actor = context.var.actor;
    const [servers, skills] = await Promise.all([
      plugins.listServers(),
      plugins.listSkills({ id: actor.id, isAdmin: actor.role === "admin" }),
    ]);
    const texts: string[] = [];
    for (const entry of CATALOGUE) texts.push(entry.title, entry.summary);
    for (const server of servers) {
      texts.push(server.title, server.summary);
      for (const tool of server.tools) {
        if (tool.description) texts.push(tool.description);
      }
    }
    for (const skill of skills) {
      texts.push(skill.title, skill.summary, skill.instructions);
    }
    return context.json({ zh: await translations.chineseFor(texts) });
  });

  /**
   * Chinese for texts an administrator is looking at that no table holds: the Composio app
   * directory, read live from Composio and never stored. Administrators only, because it asks the
   * deployment's model about whatever text is sent, and bounded, so it cannot become a general
   * translation service.
   */
  routes.post("/lookup", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;
    const body = await context.req
      .json<Record<string, unknown>>()
      .catch((): Record<string, unknown> => ({}));
    const texts = Array.isArray(body.texts)
      ? body.texts.filter(
          (text): text is string =>
            typeof text === "string" && text.length <= LOOKUP_MAX_CHARACTERS,
        )
      : null;
    if (!texts || texts.length > LOOKUP_MAX_TEXTS) {
      return context.json(
        { error: `请发送最多 ${LOOKUP_MAX_TEXTS} 段要查的文字。` },
        400,
      );
    }
    return context.json({ zh: await translations.chineseFor(texts) });
  });

  return routes;
}

const LOOKUP_MAX_TEXTS = 60;
const LOOKUP_MAX_CHARACTERS = 2000;
