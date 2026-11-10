import type { ConnectPrompt } from "@openbot/shared/connect-prompt";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AppAccessAction,
  appAccessSentence,
} from "@/components/plugins/app-access-action";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { Button } from "@/components/ui/button";
import { agentQueryOptions } from "@/lib/agents/queries";
import { type AppAccess, botAppQueryOptions } from "@/lib/app-access/queries";
import { useDeclaredBotId } from "@/lib/copilot/active-bot";
import { type CardPlace, useCarryOn } from "@/lib/copilot/carry-on";
import {
  accessRequestKeys,
  accessRequestQueryOptions,
  cancelAccessRequest,
} from "@/lib/plugins/access-requests";
import { asText } from "@/lib/plugins/tool-result";
import {
  type AppAccessRequestCard as Card,
  REQUEST_APP_ACCESS_TOOL,
  readAppAccessRequestAnswer,
} from "../../../../shared/app-access-request";
import { ConnectAppCard } from "./connect-app-card";

/**
 * `request_app_access` 的回答里的卡片，不是这个工具或不是卡片时为 null。
 *
 * 运行时把工具的字符串编码成 JSON 带进消息，所以先用 {@link asText} 解开，再读标记。
 */
export function readAppAccessCard(
  name: string,
  result: string | undefined,
): { card: Card } | null {
  if (name !== REQUEST_APP_ACCESS_TOOL || result === undefined) return null;
  const read = readAppAccessRequestAnswer(asText(result));
  return read ? { card: read.card } : null;
}

const ANSWERED: Record<"approved" | "dismissed" | "cancelled", string> = {
  approved: "管理员已批准",
  dismissed: "管理员已驳回",
  cancelled: "申请已撤回",
};

/**
 * 对话里的「申请访问」卡片：应用名，以及「已向管理员申请访问」或「已有待处理的申请」。
 *
 * 画出来时向服务端读这条申请现在的状态，而不是只信工具回答里写的：申请人读得到，就显示处理结果，还在等
 * 时给一个「撤回申请」按钮；别人看这段对话时读不到这条申请，卡片照样显示，但没有按钮。
 */
export function AppAccessRequestCard({ card }: { card: Card }) {
  const cache = useQueryClient();
  const live = useQuery(accessRequestQueryOptions(card.requestId));
  const cancel = useMutation({
    mutationFn: () => cancelAccessRequest(card.requestId),
    onSettled: () =>
      cache.invalidateQueries({
        queryKey: accessRequestKeys.one(card.requestId),
      }),
  });
  const status = live.data?.status;
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm"
      data-app-access-request={card.requestId}
    >
      <p className="font-medium">{card.title}</p>
      <p className="text-muted-foreground">
        {card.status === "created" ? "已向管理员申请访问" : "已有待处理的申请"}
      </p>
      {status && status !== "pending" ? (
        <p role="status">{ANSWERED[status]}</p>
      ) : null}
      {status === "approved" && card.kind === "enable" ? (
        // 上架之后还要员工的主人自己装（D08），批准不等于马上能用。
        <p className="text-muted-foreground">
          应用已上架，员工的主人在装配页安装后即可使用。
        </p>
      ) : null}
      {status === "pending" ? (
        <div>
          <Button
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
            size="sm"
            variant="outline"
          >
            撤回申请
          </Button>
        </div>
      ) : null}
      {cancel.error ? (
        <p className="text-destructive" role="alert">
          {cancel.error.message}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A work app a Bot could not use, in front of the person, with the one thing that would let it.
 *
 * WHAT DRAWS ONE. Every way an app is out of reach for a call now reaches the transcript carrying
 * the same marker (`@openbot/shared/connect-prompt`): a person who has not connected, a Shared app
 * with no team account, an account the vendor has lost, and — with no call refused at all — the
 * `show_app_access` tool a Bot calls for an app it holds nothing for, switched off or not granted.
 * They used to end in three different places: a card with Connect, a sentence telling the person to
 * ask an administrator, and a sentence naming a settings page.
 *
 * LIVE, NEVER WHAT THE REFUSAL SAID. The marker names an app and a Bot; the state is asked of the
 * server for this person on that Bot when the card is drawn, and the shared app-access piece draws
 * that with the button that goes with it. A card scrolled back to an hour later says what is true
 * now — connected since, granted since, the request approved — and never offers a step that has
 * already been taken. Every write those buttons make refreshes the same key, so the card follows.
 *
 * THE ONE PLACE THE REFUSAL WINS. The call that finds an account gone at the vendor deletes its row,
 * so the live state normally says so itself. A refusal from before that, over a row that still
 * stands, reads `ready` live — and this card is drawn over exactly the call that failed. So a
 * `reconnect` or `shared` refusal over a live `ready` is drawn as the refusal says — unless the
 * account was connected after the refusal, which is the reconnection. Anything else live is newer
 * than the refusal and is drawn as it is.
 *
 * AND THEN THE TASK CARRIES ON. Once the app is ready — connected in the other tab, switched on and
 * given by an admin — the card sends the conversation on by itself, or offers Continue where it was
 * not watching when that happened. `place` is where the card sits in its conversation, without
 * which (a card drawn outside one) it only says the app is ready. See `lib/copilot/carry-on.ts`.
 */
export function AppAccessCard({
  prompt,
  place,
}: {
  prompt: ConnectPrompt;
  place?: CardPlace;
}) {
  const declared = useDeclaredBotId();
  const agentId = prompt.agentId ?? declared;
  /*
   * A refusal from before refusals named their Bot, on a surface that declared none: there is no Bot
   * to ask about, so the card it was drawn as then is the card it is drawn as now.
   */
  if (!agentId) return <ConnectAppCard {...prompt} place={place} />;
  return <LiveAppAccessCard agentId={agentId} place={place} prompt={prompt} />;
}

function LiveAppAccessCard({
  agentId,
  place,
  prompt,
}: {
  agentId: string;
  place: CardPlace | undefined;
  prompt: ConnectPrompt;
}) {
  const live = useQuery({
    ...botAppQueryOptions(agentId, prompt.serverId),
    /*
     * Read again whenever this tab has the focus back. What changes the state usually happens in
     * another tab — a consent screen, an admin's page for the app — and the person returning here
     * is the moment the card should say what is true now.
     */
    refetchOnWindowFocus: true,
  });
  const access = live.data ? asRefused(live.data, prompt) : null;
  const name = access?.displayName ?? prompt.title;
  // Only asked for by "Let Research Bot use your Gmail?", the one sentence that names the Bot.
  const bot = useQuery(agentQueryOptions(agentId)).data?.name;
  const { carried, offer } = useCarryOn({
    place,
    ready: access ? access.state === "ready" : null,
    // A refusal was blocked by definition; `show_app_access` says what it found.
    blockedWhenAsked: prompt.reason !== "access" || prompt.blocked === true,
    app: name,
  });
  /*
   * A read that failed falls back to what this card was before it read anything, where that was a
   * card at all: a person's own missing connection still gets its Connect button. The other reasons
   * had only ever been a sentence, and the sentence is what is left.
   */
  if (live.error && (prompt.reason ?? "connect") === "connect")
    return <ConnectAppCard {...prompt} place={place} />;
  return (
    <div
      className="my-2 flex w-full max-w-2xl flex-col gap-3 rounded-xl border border-border p-4"
      data-app-access={prompt.serverId}
      data-state={access?.state}
    >
      <div className="flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border">
          <PluginLogo logo={access?.logo} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="font-medium text-sm">{name}</p>
          {/*
           * Nothing while the read is open — no placeholder, per the data-access rule — and a
           * sentence of the card's own if it failed. NOT the refusal's message: that was written for
           * the model ("do not browse to its website"), and reads as an instruction to the wrong
           * reader. Otherwise the state, which is the server's.
           */}
          {live.isPending ? null : access ? (
            <p className="text-muted-foreground text-sm">
              {access.state !== "ready"
                ? refusedSentence(access, prompt, bot)
                : carried || offer
                  ? `${name} 现在可以用了。`
                  : prompt.reason !== "access"
                    ? `${name} 现在可以用了。再说一次，员工就能用它。`
                    : refusedSentence(access, prompt, bot)}
            </p>
          ) : (
            <p className="text-muted-foreground text-sm" role="alert">
              没能读到 {name} 的状态，请稍后再试。
            </p>
          )}
        </div>
      </div>
      {access && access.state !== "ready" ? (
        <div className="flex justify-end">
          <AppAccessAction access={access} agentId={agentId} />
        </div>
      ) : offer ? (
        <div className="flex justify-end">
          <Button onClick={offer} size="sm">
            继续
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The live state, or the refusal's where only the refusal can know: an account the vendor lost,
 * which the server still reads as `ready`. See the card's own comment.
 *
 * A lost team account is drawn as not connected with NO request to file — the server would answer
 * any request 409, since as far as it knows the account is fine — so the sentence says whose move it
 * is and the button is left out rather than offered and refused.
 *
 * A lost account on somebody else's Team Bot keeps the live `accountHolder`. Where that is the
 * owner's account, the override reads as the owner's reconnection — the sentence says only the owner
 * can, and `AppAccessAction` offers nothing — because a Reconnect pressed here would connect this
 * person's own account, which the Bot does not run on.
 */
function asRefused(live: AppAccess, prompt: ConnectPrompt): AppAccess {
  if (live.state !== "ready") return live;
  /*
   * Connected again since the refusal: that is the reconnection, and the live `ready` is true.
   * Compared as instants rather than as strings, because the two come from different clocks'
   * formatters and only the instant is the same.
   */
  if (
    prompt.at &&
    live.connectedAt &&
    Date.parse(live.connectedAt) > Date.parse(prompt.at)
  )
    return live;
  if (prompt.reason === "reconnect") return { ...live, state: "reconnect" };
  if (prompt.reason === "shared")
    return {
      ...live,
      state: "shared_not_connected",
      requestKind: null,
      request: null,
    };
  return live;
}

/** As the shared sentence, except a lost team account, which needs reconnecting rather than connecting. */
function refusedSentence(
  access: AppAccess,
  prompt: ConnectPrompt,
  bot: string | undefined,
): string {
  if (
    access.state === "shared_not_connected" &&
    prompt.reason === "shared" &&
    !access.requestKind
  )
    return `组织的 ${access.displayName} 账号需要重新连接，只有管理员能重新连接。`;
  return appAccessSentence(access, bot);
}
