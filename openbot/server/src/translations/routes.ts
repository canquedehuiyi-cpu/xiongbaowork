import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
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

  return routes;
}
