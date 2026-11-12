import {
  EMPTY_WHAT_IF_ACTION,
  missingFrom,
  type WhatIfAction,
} from "@openbot/shared/what-if";
import { IconSparkles } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import {
  PageCard,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { ActionChips } from "@/components/what-if/action-chips";
import { WhatIfResultView } from "@/components/what-if/what-if-result";
import { shortName } from "@/lib/brand";
import { isComposing } from "@/lib/composing";
import {
  askWhatIf,
  checkWhatIf,
  type WhatIfChecked,
} from "@/lib/what-if/check";
import { whatIfVocabularyQueryOptions } from "@/lib/what-if/queries";

/**
 * `action` is an action to start from, as JSON: what "Try a change" on an Audit row's "Why did this
 * happen?" hands over, so the admin can change one thing and check again.
 */
export const Route = createFileRoute("/_authed/admin/what-if")({
  validateSearch: z.object({ action: z.string().optional() }),
  component: WhatIfPage,
});

/** The longest question the server takes. */
const QUESTION_LIMIT = 500;

/** An action handed over in the address, or none. Only the action's own fields are read. */
/*
 * What is still missing, in Chinese. `missingFrom` is shared with the server, whose refusals stay in
 * its own words; this page says them in the person's.
 */
const MISSING_WORDS: Record<string, string> = {
  "Choose a Bot.": "选一位员工。",
  "Choose a person or a group, not both.": "选一个人或一个组，不能都选。",
  "Choose whose account it runs on.": "选它用谁的账号运行。",
  "Choose what starts the run.": "选是什么发起这次运行。",
  "Choose an app.": "选一个应用。",
  "Choose one of the app's tools.": "选这个应用的一个工具。",
  "Choose an app or the computer.": "选一个应用，或者它的电脑。",
  "Choose what the Bot does on its computer.": "选员工在电脑上做什么。",
  "Enter a web site, such as www.linkedin.com.":
    "填一个网站，比如 www.linkedin.com。",
  "Enter the web site it's on.": "填它所在的网站。",
};

function missingWords(missing: string | null): string | null {
  if (missing === null) return null;
  const tooLong = /^Keep the (\w+) under (\d+) characters\.$/.exec(missing);
  if (tooLong) {
    const field =
      tooLong[1] === "command"
        ? "命令"
        : tooLong[1] === "file"
          ? "文件"
          : "按钮或字段";
    return `${field}请控制在 ${tooLong[2]} 个字符以内。`;
  }
  return MISSING_WORDS[missing] ?? missing;
}

function actionFrom(raw: string | undefined): WhatIfAction | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<string, unknown>>;
    const action = { ...EMPTY_WHAT_IF_ACTION };
    for (const key of Object.keys(action) as (keyof WhatIfAction)[])
      if (typeof parsed[key] === "string")
        (action as Record<string, string>)[key] = parsed[key] as string;
    return action;
  } catch {
    return null;
  }
}

/**
 * "What would happen if…": an admin asks what OpenBot would do with one action. The model only reads
 * the question as the action, shown as chips the admin can change; Check then asks every control in
 * the order OpenBot asks them, and says which one decides.
 *
 * Under What happened in Admin, beside Audit, whose rows answer the same question about the past.
 */
function WhatIfPage() {
  const search = Route.useSearch();
  const vocabulary = useQuery(whatIfVocabularyQueryOptions());
  const [text, setText] = useState("");
  const [asking, setAsking] = useState(false);
  const [askProblem, setAskProblem] = useState<string | null>(null);
  const [unclear, setUnclear] = useState<string | null>(null);
  /** The question the chips were read from, until the admin starts over. */
  const [asked, setAsked] = useState<string | null>(null);
  const [action, setActionState] = useState<WhatIfAction>(
    () => actionFrom(search.action) ?? EMPTY_WHAT_IF_ACTION,
  );
  const [checked, setChecked] = useState<WhatIfChecked | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkProblem, setCheckProblem] = useState<string | null>(null);
  const question = text.trim();

  const setAction = (next: WhatIfAction) => {
    setActionState(next);
    // The answer below is for the action as it was checked; a change makes it stale.
    setChecked(null);
    setCheckProblem(null);
  };

  const ask = async () => {
    if (!question || asking) return;
    setAskProblem(null);
    setUnclear(null);
    setAsking(true);
    try {
      const reading = await askWhatIf(question);
      if (reading.understood === "no") setUnclear(reading.unclear);
      else {
        setAsked(question);
        setAction(reading.action);
      }
    } catch (thrown) {
      setAskProblem((thrown as Error).message);
    } finally {
      setAsking(false);
    }
  };

  const missing = vocabulary.data
    ? missingWords(missingFrom(action, vocabulary.data))
    : "正在读取这个部署的员工和应用。";

  const check = async () => {
    if (missing || checking) return;
    setCheckProblem(null);
    setChecking(true);
    try {
      setChecked(await checkWhatIf(action, asked ?? undefined));
    } catch (thrown) {
      setCheckProblem((thrown as Error).message);
    } finally {
      setChecking(false);
    }
  };

  return (
    <PageShell
      description={`问问员工做某个动作时${shortName()}会怎么处理。每一道管控按${shortName()}检查的顺序作答，你能看到是哪一道做的决定。`}
      title="动作推演"
    >
      <form
        className="flex flex-col gap-2"
        data-asking={asking ? "true" : undefined}
        onSubmit={(event) => {
          event.preventDefault();
          void ask();
        }}
      >
        <InputGroup>
          <InputGroupAddon>
            <IconSparkles />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="问问会发生什么"
            maxLength={QUESTION_LIMIT}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              // A composing IME's Enter picks a word. It doesn't ask.
              if (event.key === "Enter" && isComposing(event))
                event.preventDefault();
            }}
            placeholder="定时任务运行销售员工时，它能用 Gmail 发邮件吗？"
            value={text}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              disabled={!question || asking}
              size="sm"
              type="submit"
              variant="default"
            >
              {asking ? "正在解读…" : "提问"}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        {askProblem ? (
          <p
            className="text-destructive text-sm"
            data-what-if-problem
            role="alert"
          >
            {askProblem}
          </p>
        ) : unclear ? (
          <p
            className="text-amber-700 text-sm dark:text-amber-500"
            data-what-if-unclear
          >
            {unclear}
          </p>
        ) : null}
      </form>

      <PageSection
        description={
          asked
            ? `这是${shortName()}对你问题的理解。哪里不对就改掉，再检查。`
            : "在上面提一个问题，或者自己设定这个动作。"
        }
        title="动作"
      >
        <PageCard
          className="mt-4"
          footer={
            <Button
              disabled={Boolean(missing) || checking}
              onClick={() => void check()}
              type="button"
            >
              {checking ? "正在检查…" : "检查"}
            </Button>
          }
        >
          {vocabulary.isError ? (
            <p className="text-destructive text-sm" role="alert">
              读不到这个部署的员工和应用，请刷新页面。
            </p>
          ) : (
            <ActionChips
              action={action}
              onChange={setAction}
              vocabulary={vocabulary.data}
            />
          )}
          {missing && vocabulary.data ? (
            <p
              className="mt-3 text-muted-foreground text-sm"
              data-what-if-missing
            >
              {missing}
            </p>
          ) : null}
          {checkProblem ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              {checkProblem}
            </p>
          ) : null}
        </PageCard>
      </PageSection>

      {checked ? (
        <PageSection
          description={`每一道管控，按${shortName()}检查的顺序排列。`}
          title="会发生什么"
        >
          <WhatIfResultView result={checked.result} />
        </PageSection>
      ) : null}
    </PageShell>
  );
}
