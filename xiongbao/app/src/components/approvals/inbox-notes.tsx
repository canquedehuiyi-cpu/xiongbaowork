import { IconQuote, IconX } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useInboxNotesEnabled } from "@/lib/deployment/queries";
import {
  addNoteMutationOptions,
  type NoteInput,
  removeNoteMutationOptions,
  sendNotesMutationOptions,
} from "@/lib/inbox-notes/mutations";
import {
  inboxNotesQueryOptions,
  type NoteItemKind,
  type ReviewChapter,
} from "@/lib/inbox-notes/queries";

/*
 * 审批箱批注（试点，开关 XIONGBAO_PILOT_INBOX_NOTES）：一条等你确认的事项上可以写多条批注，每条可以引用事项里
 * 的一段话；点「发送」后合成一条消息，回到发起这件事的对话里，员工不用停下来等。开关没开时这里什么都不画。
 */

/** 一条批注最多这么长；服务器也按这个收。 */
const NOTE_MAX = 2000;

/** 一条批注引用的那一段，最多这么长；服务器也按这个收。 */
const QUOTE_MAX = 1000;

/**
 * 选中的文字是不是在 `source` 里面，是的话连同它在 `source` 全文里的起止位置一起取出来。
 * 起止位置按去掉首尾空白后的文字算，和存下来的引用原文对得上。
 */
export function quoteFromSelection(
  source: HTMLElement | null,
  selection: Selection | null | undefined,
): NonNullable<NoteInput["quote"]> | null {
  if (!source || !selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const within = range.commonAncestorContainer;
  if (!source.contains(within)) return null;
  // 批注自己的文字不是事项的原文，不能被引用。
  const own = within instanceof Element ? within : within.parentElement;
  if (own?.closest("[data-inbox-notes]")) return null;
  const raw = range.toString();
  const text = raw.trim();
  if (!text) return null;
  const before = source.ownerDocument.createRange();
  before.selectNodeContents(source);
  before.setEnd(range.startContainer, range.startOffset);
  const start =
    before.toString().length + (raw.length - raw.trimStart().length);
  const cut = text.slice(0, QUOTE_MAX);
  return { text: cut, start, end: start + cut.length };
}

/** 一条事项上的批注：已写的几条、写新的一条、发送。 */
export function InboxNotes({
  kind,
  id,
  source,
}: {
  kind: NoteItemKind;
  id: string;
  /** 事项文字所在的元素：引用只取这里面选中的字。 */
  source: () => HTMLElement | null;
}) {
  const enabled = useInboxNotesEnabled();
  if (!enabled) return null;
  return <Notes id={id} kind={kind} source={source} />;
}

function Notes({
  kind,
  id,
  source,
}: {
  kind: NoteItemKind;
  id: string;
  source: () => HTMLElement | null;
}) {
  const cache = useQueryClient();
  const notes = useQuery({ ...inboxNotesQueryOptions(kind, id), retry: false });
  const [text, setText] = useState("");
  const [quote, setQuote] = useState<NoteInput["quote"] | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [sent, setSent] = useState<number | null>(null);
  // The factories refresh the notes; what is local to this panel is reset where each is called.
  const add = useMutation(addNoteMutationOptions(cache, { kind, id }));
  const remove = useMutation(removeNoteMutationOptions(cache, { kind, id }));
  const send = useMutation(sendNotesMutationOptions(cache, { kind, id }));
  const held = notes.data?.notes ?? [];
  const error = notes.error ?? add.error ?? remove.error ?? send.error;

  const quoteSelection = () => {
    const picked = quoteFromSelection(source(), window.getSelection?.());
    if (!picked) {
      setHint("先在上面选中想引用的一段文字。");
      return;
    }
    setHint(null);
    setQuote(picked);
  };

  return (
    <section
      aria-label="批注"
      className="flex flex-col gap-3 rounded-[13px] border border-border bg-card p-[14px]"
      data-inbox-notes=""
    >
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="font-semibold text-[13px]">批注</h4>
        <span className="text-[12px] text-muted-foreground">
          {held.length > 0 ? `已写 ${held.length} 条，还没发送` : "还没有批注"}
        </span>
      </div>

      {held.length > 0 ? (
        <ol
          aria-label="已写的批注"
          className="m-0 flex list-none flex-col gap-2 p-0"
        >
          {held.map((note, index) => (
            <li
              className="flex items-start gap-2 rounded-[9px] bg-muted px-3 py-2 text-[13px]"
              data-note=""
              key={note.id}
            >
              <span className="mt-px text-muted-foreground">{index + 1}.</span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                {note.quote ? (
                  <blockquote className="m-0 border-border border-l-2 pl-2 text-[12px] text-muted-foreground">
                    {note.quote.text}
                  </blockquote>
                ) : null}
                <p className="m-0 whitespace-pre-wrap">{note.text}</p>
              </div>
              <Button
                aria-label={`删除第 ${index + 1} 条批注`}
                disabled={remove.isPending}
                onClick={() => remove.mutate(note.id)}
                size="icon-sm"
                variant="ghost"
              >
                <IconX />
              </Button>
            </li>
          ))}
        </ol>
      ) : null}

      <div className="flex flex-col gap-2">
        {quote ? (
          <div className="flex items-start gap-2 border-border border-l-2 pl-2 text-[12px] text-muted-foreground">
            <span className="min-w-0 flex-1" data-pending-quote="">
              {quote.text}
            </span>
            <Button
              aria-label="不引用了"
              onClick={() => setQuote(null)}
              size="icon-sm"
              variant="ghost"
            >
              <IconX />
            </Button>
          </div>
        ) : null}
        <Textarea
          aria-label="写一条批注"
          maxLength={NOTE_MAX}
          onChange={(event) => setText(event.target.value)}
          placeholder="写一条批注"
          value={text}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            // 点按钮不能让上面选中的字失去选中，否则取不到要引用的那一段。
            onMouseDown={(event) => event.preventDefault()}
            onClick={quoteSelection}
            size="sm"
            variant="outline"
          >
            <IconQuote />
            引用选中的文字
          </Button>
          <Button
            disabled={add.isPending || !text.trim()}
            onClick={() =>
              add.mutate(
                { text: text.trim(), ...(quote ? { quote } : {}) },
                {
                  onSuccess: () => {
                    setText("");
                    setQuote(null);
                    setSent(null);
                  },
                },
              )
            }
            size="sm"
            variant="outline"
          >
            {add.isPending ? "正在保存…" : "添加批注"}
          </Button>
        </div>
        {hint ? (
          <p className="m-0 text-[12px] text-muted-foreground" role="status">
            {hint}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 border-border border-t pt-3">
        <div>
          <Button
            disabled={send.isPending || held.length === 0}
            onClick={() => send.mutate(undefined, { onSuccess: setSent })}
          >
            {send.isPending
              ? "正在发送…"
              : held.length > 0
                ? `发送 ${held.length} 条批注`
                : "发送批注"}
          </Button>
        </div>
        <p className="m-0 text-[12px] text-muted-foreground">
          {kind === "approval"
            ? "批注会在你批准或拒绝后送到员工。"
            : "发送后，所有批注会合成一条消息回到发起它的对话。员工不用停下来等，这条事项也还在这里等你确认。"}
        </p>
        {sent !== null ? (
          <p className="m-0 text-[13px]" role="status">
            已发送 {sent} 条批注，
            {kind === "approval"
              ? "会在你批准或拒绝后送到员工。"
              : "员工会在对话里看到。"}
          </p>
        ) : null}
        {error ? (
          <p className="m-0 text-[13px] text-destructive" role="alert">
            {error.message}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** 引导式评审：代码改动按文件路径分成三章，每章一句说明，没有文件的章不画。 */
export function GuidedReview({ id }: { id: string }) {
  const enabled = useInboxNotesEnabled();
  const notes = useQuery({
    ...inboxNotesQueryOptions("approval", id),
    enabled,
    retry: false,
  });
  const chapters = notes.data?.review?.filter(
    (chapter: ReviewChapter) => chapter.files.length > 0,
  );
  if (!enabled || !chapters?.length) return null;
  return (
    <section
      aria-label="引导式评审"
      className="flex flex-col gap-3"
      data-guided-review=""
    >
      <span className="text-[12px] text-[color:var(--wb-muted,var(--muted-foreground))]">
        引导式评审：按这个顺序看
      </span>
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {chapters.map((chapter: ReviewChapter, index: number) => (
          <li
            className="flex flex-col gap-1.5 rounded-[12px] border border-[color:var(--wb-line,var(--border))] bg-[color:var(--wb-card,var(--card))] p-3"
            data-chapter={chapter.id}
            key={chapter.id}
          >
            <div className="flex items-baseline justify-between gap-3">
              <b className="font-semibold">
                第 {index + 1} 章　{chapter.title}
              </b>
              <span className="text-[12px] text-muted-foreground">
                {chapter.files.length} 个文件
              </span>
            </div>
            <p className="m-0 text-[13px] text-muted-foreground">
              {chapter.summary}
            </p>
            <ul
              aria-label={`${chapter.title}的文件`}
              className="m-0 flex list-none flex-col gap-1 p-0"
            >
              {chapter.files.map((file) => (
                <li className="break-all font-mono text-[13px]" key={file}>
                  {file}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
}
