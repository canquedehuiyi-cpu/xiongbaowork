import { BotResponsibilities } from "@/components/responsibilities/bot-responsibilities";
import { RoutinesList } from "@/components/routines/routines-list";
import { cn } from "@/lib/utils";
import { useMuse } from "../context";
import { Divider, MuseScreen, museText, StatusDot } from "../ui";
import { NoBot } from "./activity";

/**
 * Goals: what the centre Bot keeps doing for the person. OpenMuse's "Tracking" is XiongBao's routines,
 * and its "Goals" are XiongBao's responsibilities, which XiongBao itself titles Goals on a Bot's page.
 * Both lists are XiongBao's own, with every switch, Run now, history and Delete they offer.
 */
export function GoalsScreen() {
  const { bot } = useMuse();
  if (!bot) {
    return (
      <MuseScreen title="目标">
        <NoBot />
      </MuseScreen>
    );
  }
  return (
    <MuseScreen title="目标">
      <section>
        <div className="flex items-center gap-2.5">
          <StatusDot tone="green" />
          <h2
            className={cn(
              museText.heading,
              "text-[var(--openmuse-green-text)]",
            )}
          >
            定时任务
          </h2>
        </div>
        <RoutinesList agentId={bot.id} embedded />
      </section>
      <Divider className="mt-8" />
      <div className="[&>section]:mt-6">
        <BotResponsibilities agentId={bot.id} />
      </div>
    </MuseScreen>
  );
}
