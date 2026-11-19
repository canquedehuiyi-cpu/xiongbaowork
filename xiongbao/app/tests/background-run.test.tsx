import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { Fragment } from "react";
import { backgroundHintNotes } from "@/components/channels/background-hint";
import { BackgroundRunBadge } from "@/components/channels/background-run-badge";
import {
  BACKGROUND_AFTER_MS,
  BACKGROUND_HINT,
  backgroundRunWords,
  beginTurn,
  endTurn,
  forgetBackgroundHint,
  hasServerTurn,
  observeRun,
  resetBackgroundRuns,
  serverTurnSince,
  useBackgroundHint,
  useBackgroundRun,
} from "@/lib/channels/background-run";
import type { ChannelWork } from "@/lib/channels/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * 「后台进行中 · 已跑 X 分钟」和第一次的那行提示（期九·四）。
 *
 * 起点以服务器说的为准（关掉再打开也接得上），这个页面自己发出这一轮的时刻次之，半路接上时看见的最后；
 * 部署没开这项就一概不说；页面自己发的一轮跑满一会儿才说，一句三秒的回答不闪；提示只出现一次，本机记着。
 */

const MINUTE = 60_000;
const NOW = new Date("2026-11-19T10:00:00.000Z").getTime();

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
beforeEach(() => {
  setSystemTime(new Date(NOW));
  queryClient.clear();
  resetBackgroundRuns();
  forgetBackgroundHint();
  setCapability(true);
});
afterEach(() => {
  cleanup();
  setSystemTime();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** What `/api/capabilities` said, as the page holds it. */
function setCapability(on: boolean | undefined) {
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: false,
    selfHostBanner: false,
    localEvaluation: false,
    edition: "team",
    ...(on === undefined ? {} : { chatServerComputerTools: on }),
  });
}

const turn = (minutesAgo: number, key = "run-1"): ChannelWork => ({
  kind: "turn",
  key,
  botId: "bot-1",
  botName: "研究员",
  since: new Date(NOW - minutesAgo * MINUTE).toISOString(),
});

type Channel = { id: string; work?: readonly ChannelWork[] } | undefined;

function Probe({ channel }: { channel: Channel }) {
  const run = useBackgroundRun(channel);
  return (
    <>
      <BackgroundRunBadge run={run} />
      <output>{run?.words ?? ""}</output>
    </>
  );
}

const around = (channel: Channel) => (
  <QueryClientProvider client={queryClient}>
    <Probe channel={channel} />
  </QueryClientProvider>
);

const words = (view: ReturnType<typeof render>) =>
  view.container.querySelector("output")?.textContent ?? "";

test("the words count whole minutes, and under a minute does not say zero", () => {
  expect(backgroundRunWords(0)).toBe("后台进行中 · 已跑不到 1 分钟");
  expect(backgroundRunWords(59_999)).toBe("后台进行中 · 已跑不到 1 分钟");
  expect(backgroundRunWords(MINUTE)).toBe("后台进行中 · 已跑 1 分钟");
  expect(backgroundRunWords(12 * MINUTE + 30_000)).toBe(
    "后台进行中 · 已跑 12 分钟",
  );
  // A clock that went backwards never reads negative.
  expect(backgroundRunWords(-5)).toBe("后台进行中 · 已跑不到 1 分钟");
});

test("the server's own list says when the turn began, earliest first", () => {
  const handoff: ChannelWork = {
    kind: "handoff",
    key: "h",
    botId: "ana",
    botName: "Ana",
    since: new Date(NOW - 99 * MINUTE).toISOString(),
  };
  expect(serverTurnSince(undefined)).toBeNull();
  // Somebody else's work is not this turn.
  expect(serverTurnSince([handoff])).toBeNull();
  expect(serverTurnSince([handoff, turn(3, "b"), turn(8, "a")])).toBe(
    NOW - 8 * MINUTE,
  );
  expect(hasServerTurn([{ work: [handoff] }, { work: [turn(1)] }])).toBe(true);
  expect(hasServerTurn([{ work: [handoff] }, {}])).toBe(false);
});

test("a turn the server says is running shows at once, from the time it began", () => {
  const view = render(around({ id: "c1", work: [turn(12)] }));
  expect(words(view)).toBe("后台进行中 · 已跑 12 分钟");
  const badge = view.container.querySelector("[data-background-run]");
  expect(badge?.textContent).toBe("后台进行中 · 已跑 12 分钟");
  expect(badge?.getAttribute("role")).toBe("status");
});

test("the minutes move on as time passes, once a second, and stop when the turn is over", async () => {
  const view = render(around({ id: "c1", work: [turn(1)] }));
  expect(words(view)).toBe("后台进行中 · 已跑 1 分钟");
  await act(async () => {
    setSystemTime(new Date(NOW + 2 * MINUTE));
    await new Promise((resolve) => setTimeout(resolve, 1_200));
  });
  expect(words(view)).toBe("后台进行中 · 已跑 3 分钟");
  view.rerender(around({ id: "c1", work: [] }));
  expect(words(view)).toBe("");
  expect(view.container.querySelector("[data-background-run]")).toBeNull();
});

test("nothing is said where the deployment does not run chat turns on the server", () => {
  setCapability(false);
  const off = render(around({ id: "c1", work: [turn(12)] }));
  expect(words(off)).toBe("");
  cleanup();
  // A server too old to say is the same as one that said no.
  setCapability(undefined);
  const silent = render(around({ id: "c1", work: [turn(12)] }));
  expect(words(silent)).toBe("");
});

test("a turn this page sent shows once it has run a little, not for a three-second answer", async () => {
  beginTurn("c1");
  const view = render(around({ id: "c1" }));
  expect(words(view)).toBe("");
  await act(async () => {
    setSystemTime(new Date(NOW + BACKGROUND_AFTER_MS + 1_000));
    await new Promise((resolve) => setTimeout(resolve, 1_200));
  });
  expect(words(view)).toBe("后台进行中 · 已跑不到 1 分钟");
  // The turn's end takes it down at once, wherever this page is by then.
  await act(async () => endTurn("c1"));
  expect(words(view)).toBe("");
});

test("the server's start beats this page's own, and this page's own beats one it only saw", () => {
  beginTurn("c1", NOW - 5 * MINUTE);
  observeRun("c1", NOW - 1 * MINUTE);
  const own = render(around({ id: "c1" }));
  expect(words(own)).toBe("后台进行中 · 已跑 5 分钟");
  cleanup();

  const server = render(around({ id: "c1", work: [turn(9)] }));
  expect(words(server)).toBe("后台进行中 · 已跑 9 分钟");
  cleanup();

  endTurn("c1");
  observeRun("c1", NOW - 4 * MINUTE);
  const seen = render(around({ id: "c1" }));
  expect(words(seen)).toBe("后台进行中 · 已跑 4 分钟");
});

test("each conversation has its own clock", () => {
  beginTurn("c1", NOW - 6 * MINUTE);
  const other = render(around({ id: "c2" }));
  expect(words(other)).toBe("");
});

/** The hint's hook, drawn as the transcript draws it: a note when it says so. */
function Hint({ active }: { active: boolean }) {
  const shown = useBackgroundHint(active);
  return (
    <div>
      {backgroundHintNotes(shown).map((note) => (
        <Fragment key={note.key}>{note.node}</Fragment>
      ))}
    </div>
  );
}
const hint = (view: ReturnType<typeof render>) =>
  view.container.querySelector("[data-background-hint]")?.textContent ?? null;

test("the first background run gets the line under its answer, and a later one does not", () => {
  const view = render(<Hint active={false} />);
  expect(hint(view)).toBeNull();
  view.rerender(<Hint active />);
  expect(hint(view)).toBe(BACKGROUND_HINT);
  expect(BACKGROUND_HINT).toBe("可以关掉页面，跑完会通知你");
  // It stays while the run does.
  view.rerender(<Hint active />);
  expect(hint(view)).toBe(BACKGROUND_HINT);
  // And is gone with it, for good.
  view.rerender(<Hint active={false} />);
  expect(hint(view)).toBeNull();
  view.rerender(<Hint active />);
  expect(hint(view)).toBeNull();
});

test("the line is remembered on this machine, so a reload does not bring it back", () => {
  const first = render(<Hint active />);
  expect(hint(first)).toBe(BACKGROUND_HINT);
  expect(
    window.localStorage.getItem("xiongbao:background-hint-shown"),
  ).not.toBe(null);
  cleanup();
  // A reload: the page forgets what it held in memory, the machine remembers.
  forgetBackgroundHint({ stored: false });
  const reloaded = render(<Hint active />);
  expect(hint(reloaded)).toBeNull();
  cleanup();
  // A machine that has never shown it shows it once more.
  forgetBackgroundHint();
  const fresh = render(<Hint active />);
  expect(hint(fresh)).toBe(BACKGROUND_HINT);
});

test("a browser that refuses storage still says it once per page", () => {
  const original = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() {
      throw new Error("storage refused");
    },
  });
  try {
    const view = render(<Hint active />);
    expect(hint(view)).toBe(BACKGROUND_HINT);
    view.rerender(<Hint active={false} />);
    view.rerender(<Hint active />);
    expect(hint(view)).toBeNull();
  } finally {
    if (original) Object.defineProperty(window, "localStorage", original);
  }
});
