import { IconChevronRight, IconNotes } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Textarea } from "@/components/ui/textarea";
import { saveInstructionsMutationOptions } from "@/lib/settings/mutations";
import {
  INSTRUCTIONS_LIMIT,
  instructionsQueryOptions,
} from "@/lib/settings/queries";
import { queryClient } from "@/query-client";

/**
 * One box, applied to every coworker in every channel.
 *
 * WHAT IT IS FOR, said on the screen rather than left to be guessed. A coworker's role and this are
 * both durable instructions and a person meeting them for the first time has no reason to know which
 * belongs where, so the description draws the line the prompt draws: the role says what a coworker
 * is for, this says how the person wants things done. Without that sentence the obvious mistake is
 * to write a job description here and get it applied to every coworker at once.
 */
const DESCRIPTION =
  "对所有频道里的所有员工都生效。员工的角色说明写它做什么；这里写你希望事情怎么做，比如写作风格，或者怎么介绍你的公司。";

/**
 * The standing instructions as a row on General: what they say, cut to two lines, and a dialog to write them. A free
 * text is a summary and a dialog on these screens, so a long box does not take over the page.
 */
export function StandingInstructionsRow() {
  const stored = useQuery(instructionsQueryOptions());
  const [open, setOpen] = useState(false);
  const written = stored.data?.trim();
  return (
    <>
      <Item
        render={<button onClick={() => setOpen(true)} type="button" />}
        size="sm"
      >
        <ItemMedia variant="icon">
          <IconNotes />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>长期指令</ItemTitle>
          <ItemDescription>
            {stored.error
              ? "长期指令没能加载。"
              : written || "还没有。告诉所有员工你希望事情怎么做。"}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <IconChevronRight className="size-4 text-muted-foreground" />
        </ItemActions>
      </Item>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>长期指令</DialogTitle>
            <DialogDescription>{DESCRIPTION}</DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            <StandingInstructionsEditor />
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The fork's settings page draws the instructions as a section of their own rather than as upstream's
 * row and dialog; both are kept so the page can use either.
 */
export function StandingInstructions() {
  return (
    <PageSection description={DESCRIPTION} title="长期指令">
      <StandingInstructionsEditor />
    </PageSection>
  );
}

/** The box itself, with its count and Save: in the row's dialog. */
function StandingInstructionsEditor() {
  const stored = useQuery(instructionsQueryOptions());
  const save = useMutation(saveInstructionsMutationOptions(queryClient));

  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  /*
   * The box holds the stored text until somebody types, and their typing after that.
   *
   * Null is "has not been edited", which is not the same as "is empty": seeding the state with ""
   * and then filling it in when the read lands would overwrite whatever they had already started
   * typing into a box that was ready before the network was.
   */
  useEffect(() => {
    if (stored.data !== undefined && draft === null) setDraft(stored.data);
  }, [stored.data, draft]);

  const text = draft ?? stored.data ?? "";
  const over = text.trim().length > INSTRUCTIONS_LIMIT;
  const unchanged = stored.data !== undefined && text === stored.data;

  const submit = () => {
    setProblem(null);
    setSaved(false);
    save.mutate(text, {
      onError: (thrown: Error) => setProblem(thrown.message),
      /* The server trims, so the box settles to what was actually stored rather than what was sent. */
      onSuccess: (asStored) => {
        setDraft(asStored);
        setSaved(true);
      },
    });
  };

  return (
    <>
      {stored.isPending ? null : stored.error ? (
        <p className="text-destructive text-sm" role="alert">
          {stored.error.message}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <Textarea
            aria-label="长期指令"
            className="min-h-40"
            disabled={save.isPending}
            onChange={(event) => {
              setDraft(event.target.value);
              setSaved(false);
            }}
            placeholder="我们是两个人，不是一个团队。用简体中文写，别把我们的产品叫作“平台”。"
            value={text}
          />
          <div className="flex flex-row items-center justify-between gap-4">
            <p
              className={
                over
                  ? "text-destructive text-xs"
                  : "text-muted-foreground text-xs"
              }
            >
              {text.trim().length} / {INSTRUCTIONS_LIMIT} 字
            </p>
            <div className="flex flex-row items-center gap-3">
              {/*
               * One line, and only the news. A save that worked says so until the next keystroke; a
               * refusal shows the server's own sentence, which names what was wrong with it.
               */}
              {problem ? (
                <span className="text-destructive text-xs" role="alert">
                  {problem}
                </span>
              ) : saved ? (
                <span className="text-muted-foreground text-xs">已保存</span>
              ) : null}
              <Button
                disabled={save.isPending || over || unchanged}
                onClick={submit}
                size="sm"
              >
                保存
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
