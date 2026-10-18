import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Badge, GalleryFrame } from "@/components/gallery/frame";
import { Button } from "@/components/ui/button";
import type { AgentFormValues } from "@/lib/agents/form";
import {
  botCardAnswer,
  checkProposal,
  createdBotIdIn,
  type ProposedBot,
  wasCreated,
} from "@/lib/agents/proposal";

/**
 * The coworker a Bot has written, put in front of the person before it exists.
 *
 * WHY THERE IS A CARD AT ALL. A coworker is not a document: the role description below becomes a
 * standing instruction handed to a model on every turn in every channel it is in, and it was written
 * by something that was told about the job second-hand. So the same rule the template consent screen
 * follows applies here — the whole of that text is shown, unabridged and unclipped, before anything
 * is created, because a person cannot agree to instructions they were not shown.
 *
 * The whole tool is this card. There is no handler behind it: the run suspends here, and nothing is
 * written until a button is pressed.
 *
 * WHAT IT DELIBERATELY CANNOT DO. No address, no connector, no tool, no boundary and no visibility
 * change. The coworker arrives private, holding whatever skills were agreed and nothing else, and
 * everything it might reach is granted afterwards on its profile by somebody who may. A card that
 * could grant capability would make "ask the Bot for it" the fastest route around the screens that
 * exist to decide it.
 */

/** What creating actually did, since creating and granting are two calls and one can fail alone. */
export type CreatedBot = {
  agentId: string;
  name: string;
  granted: string[];
  failed: string[];
};

export type ProposedBotCardProps = {
  /** Partial while the model is still streaming the arguments. */
  args: Partial<ProposedBot>;
  /**
   * A coworker already here whose name this one reuses, when there is one.
   *
   * Drives the wording and nothing else. Names do not have to be unique, so this is not a refusal —
   * it is the fact somebody needs in order to notice they are about to end up with two Renewal Desks
   * on one roster and no way to tell them apart in a channel list.
   */
  clashes?: { title: string; ownership: string };
  /** Answering resumes the Bot. Absent while streaming, and once this card has been answered. */
  respond?: (result: unknown) => Promise<void>;
  /** The recorded answer, once there is one. Completed cards show it instead of controls. */
  result?: string;
  create: (values: AgentFormValues, skills: string[]) => Promise<CreatedBot>;
};

/**
 * `ownershipOf` answers in the words the model reads; the card says the same fact to the person.
 * An ownership this map has never heard of is shown as it came, rather than dropped.
 */
const OWNERSHIP_WORD: Record<string, string> = {
  yours: "你的",
  "the deployment's": "部署自带的",
  "somebody else's": "别人的",
};

export function ProposedBotCard({
  args,
  clashes,
  respond,
  result,
  create,
}: ProposedBotCardProps) {
  const [sending, setSending] = useState<"create" | "decline" | null>(null);
  /**
   * A refusal from the server, kept on the card rather than answered with.
   *
   * The run stays suspended, because both things worth doing next need it to be — pressing again
   * after whatever the refusal named has been dealt with, or declining. Answering the tool with the
   * error would end the turn and leave the person retyping their request.
   */
  const [refusal, setRefusal] = useState<string | null>(null);

  if (result !== undefined) {
    /*
     * The coworker read back out of the answer rather than out of state. This card is re-rendered
     * from the transcript on every reload, when whatever this component remembered is gone; the id
     * is the server's, so unlike a skill's slug it is not in the arguments either. See
     * `createdBotIdIn`.
     */
    const madeId = wasCreated(result) ? createdBotIdIn(result) : null;
    return (
      <GalleryFrame
        action={<Badge tone="neutral">已完成</Badge>}
        title={titleFor(args.name, clashes)}
      >
        <p className="text-sm">{result}</p>
        {madeId ? <TalkToIt agentId={madeId} name={args.name} /> : null}
      </GalleryFrame>
    );
  }

  if (!respond) {
    return (
      <GalleryFrame title={titleFor(args.name, clashes)}>
        <p className="text-muted-foreground text-sm">正在写这位员工…</p>
      </GalleryFrame>
    );
  }

  const checked = checkProposal(args);
  if (!checked.ok) {
    return <Unwritable problems={checked.problems} respond={respond} />;
  }
  const { values, skills } = checked;

  const make = async () => {
    setSending("create");
    setRefusal(null);
    let outcome: CreatedBot;
    try {
      outcome = await create(values, skills);
    } catch (cause) {
      // Left on the card with the buttons still live. See `refusal` above.
      setSending(null);
      setRefusal(cause instanceof Error ? cause.message : "这位员工没有建成。");
      return;
    }
    /*
     * Pressing again is not offered from here on: the coworker exists, and a second press would make
     * a second one. The answer carries its id, which is what the completed card links to.
     */
    await answer(respond, botCardAnswer.created(outcome));
  };

  const decline = async () => {
    setSending("decline");
    await answer(respond, botCardAnswer.declined());
  };

  return (
    <GalleryFrame
      action={<Badge tone="caution">等你决定</Badge>}
      caption={
        clashes
          ? `这里已经有一位「${clashes.title}」，是${OWNERSHIP_WORD[clashes.ownership] ?? clashes.ownership}。名字可以重复，但两个同名的员工在频道列表里很难分清。`
          : "你按下按钮之前，什么都不会创建。"
      }
      title={titleFor(values.name, clashes)}
    >
      <dl className="grid grid-cols-[minmax(0,7rem)_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="truncate text-muted-foreground">名字</dt>
        <dd className="min-w-0 break-words font-medium">{values.name}</dd>
        <dt className="truncate text-muted-foreground">职责</dt>
        <dd className="min-w-0 break-words">{values.title}</dd>
        <dt className="truncate text-muted-foreground">技能</dt>
        <dd className="min-w-0 break-words">
          {skills.length > 0 ? (
            <span className="font-mono text-xs">
              {skills.map((slug) => `/${slug}`).join(", ")}
            </span>
          ) : (
            <span className="text-muted-foreground">无</span>
          )}
        </dd>
      </dl>

      <p className="mt-3 text-muted-foreground text-xs">
        它的常驻指令。每一轮都会把这段文字交给模型。
      </p>
      {/*
       * Scrolled rather than clamped, and the distinction is the whole point of the card. A clamp
       * hides the second half of an instruction that will run on somebody's behalf from the one
       * person being asked to agree to it; a scroller keeps every character reachable.
       */}
      <p className="mt-1 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
        {values.roleDescription}
      </p>

      <p className="mt-2 text-muted-foreground text-xs">
        它建好时是私有的，没有地址、没有连接器、也没有工具。它需要碰到的东西，之后在它的资料页里授予。
      </p>

      {refusal ? (
        <p className="mt-3 text-destructive text-sm" role="alert">
          {refusal}
        </p>
      ) : null}

      <div className="mt-4 flex gap-2">
        <Button
          disabled={Boolean(sending)}
          onClick={() => void make()}
          size="sm"
        >
          {sending === "create" ? "正在创建…" : "创建"}
        </Button>
        <Button
          disabled={Boolean(sending)}
          onClick={() => void decline()}
          size="sm"
          variant="outline"
        >
          {sending === "decline" ? "…" : "不创建"}
        </Button>
      </div>
    </GalleryFrame>
  );
}

function titleFor(
  name: string | undefined,
  clashes: { title: string } | undefined,
): string {
  const called = name?.trim() ? name.trim() : "一位新员工";
  return clashes ? `再创建一位「${called}」` : `创建「${called}」`;
}

/**
 * Where the next step happens.
 *
 * The profile rather than a channel, because it is the screen that answers both remaining questions
 * — what this coworker may reach, and whether anybody else can see it — and it carries the control
 * that opens a conversation.
 */
function TalkToIt({
  agentId,
  name,
}: {
  agentId: string;
  name: string | undefined;
}) {
  return (
    <Link
      className="mt-2 inline-block text-sm underline underline-offset-4"
      search={{ agent: agentId }}
      to="/agents"
    >
      打开「{name?.trim() || "这位员工"}」
    </Link>
  );
}

/**
 * A proposal that cannot be created as written.
 *
 * Answered rather than shown as a question, because there is nothing for the person to decide: the
 * fields are wrong in a way the model can fix, and the problems name their field so it can. The card
 * still appears, so the transcript has no silent gap where a coworker was nearly made.
 */
function Unwritable({
  problems,
  respond,
}: {
  problems: string[];
  respond: (result: unknown) => Promise<void>;
}) {
  /**
   * Answered once, guarded by a ref rather than by the dependency list.
   *
   * `problems` is rebuilt from the arguments on every render and the grant queries behind this card
   * poll, so a value-equal array arrives as a new identity every few seconds. Left to the deps, this
   * would answer the same tool call again on each of them.
   */
  const answered = useRef(false);
  useEffect(() => {
    if (answered.current) return;
    answered.current = true;
    void answer(respond, botCardAnswer.unwritable(problems));
  }, [problems, respond]);

  return (
    <GalleryFrame
      action={<Badge tone="neutral">未创建</Badge>}
      title="创建一位员工"
    >
      <p className="text-sm">
        按现在写的内容建不出这位员工，所以没有来问你。正在重新起草。
      </p>
    </GalleryFrame>
  );
}

/**
 * Answering, with a failure to answer swallowed deliberately.
 *
 * The only way `respond` rejects is a run that has already ended — a reload, a stop, a card answered
 * in another tab — and in every one of those the write has already happened or already not happened.
 * Throwing here would surface a React error over a decision the person has finished making.
 */
async function answer(
  respond: (result: unknown) => Promise<void>,
  text: string,
): Promise<void> {
  try {
    await respond(text);
  } catch {
    // The run this card belonged to is gone. Nothing further to do.
  }
}
