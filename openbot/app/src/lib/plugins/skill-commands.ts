import type { UseQueryResult } from "@tanstack/react-query";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { CommandOption } from "@/components/channels/composer";
import {
  agentPluginsQueryOptions,
  type GrantedPlugins,
} from "@/lib/plugins/queries";
import { useZh } from "@/lib/translations/queries";

/**
 * One granted skill as a `/` menu command.
 *
 * A CHIP, NOT AN EXPANSION. `prompt` used to paste the skill's whole instruction into the box, which
 * meant a person watched a paragraph they did not write appear over the message they were typing,
 * and had to scroll past it to reach their own words.
 *
 * The chip stays, one token wide, and `channel-chat` reads `draft.commandIds` on send and puts the
 * instruction in front of the run. Nothing is hidden by this that was not already: the instruction
 * is the skill's own text, visible on the skills page, and a skill is an instruction rather than a
 * capability — it can only ask for tools the Bot already holds.
 *
 * M4: upstream's #1226 sends `/<command>` and lets the server look the skill up
 * (`server/src/plugins/picked-skill.ts`); this fork did not take picked skill (M3), so the
 * instruction still travels on the option.
 */
function toCommand(
  skill: GrantedPlugins["skills"][number],
  zh: (text: string) => string,
): CommandOption {
  return {
    id: skill.slug,
    name: skill.slug,
    description: zh(skill.summary || skill.title),
    kind: "chip",
    /*
     * Carried on the option rather than looked up again at send time. `applyCommandChips` only
     * substitutes `prompt` for `kind: "prompt"`, so on a chip this is inert payload, and the
     * alternative is a second query racing the first for the same rows.
     */
    prompt: skill.instructions,
  };
}

/**
 * Granted skills as `/` menu commands. Each one inserts a chip, not composer text.
 */
export function useSkillCommands(agentId: string): CommandOption[] {
  const { data } = useQuery(agentPluginsQueryOptions(agentId));
  // The menu line is for the person; the chip still carries the skill's own instruction.
  const zh = useZh();

  return useMemo(
    () => (data?.skills ?? []).map((skill) => toCommand(skill, zh)),
    [data, zh],
  );
}

/**
 * Every skill any of these Bots offers, for a composer that has not picked its Bot yet: the home
 * page, where the Bot is chosen with `@` or routed to after sending.
 *
 * `botsFor` says which of them offer a skill, so a message that runs one goes to a Bot that has it.
 */
export function useAnyBotSkillCommands(agentIds: readonly string[]): {
  commands: CommandOption[];
  botsFor: (slug: string) => string[];
} {
  /*
   * Combined inside `useQueries`, which reruns this only when a Bot's skills or this function
   * change, so the composer's triggers are not rebuilt on every render. Keyed on the ids' text, since
   * the roster array itself is new on each render.
   */
  const key = agentIds.join(",");
  const zh = useZh();
  const combine = useCallback(
    (results: UseQueryResult<GrantedPlugins>[]) => {
      const ids = key.split(",");
      const commands = new Map<string, CommandOption>();
      const bots = new Map<string, string[]>();
      results.forEach((result, index) => {
        const agentId = ids[index];
        if (!agentId) return;
        for (const skill of result.data?.skills ?? []) {
          if (!commands.has(skill.slug))
            commands.set(skill.slug, toCommand(skill, zh));
          bots.set(skill.slug, [...(bots.get(skill.slug) ?? []), agentId]);
        }
      });
      return {
        commands: [...commands.values()],
        botsFor: (slug: string) => bots.get(slug) ?? [],
      };
    },
    [key, zh],
  );
  return useQueries({
    queries: agentIds.map((id) => agentPluginsQueryOptions(id)),
    combine,
  });
}
