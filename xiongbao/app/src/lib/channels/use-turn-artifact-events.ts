import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  createTurnArtifactTracker,
  type TrackedTurnArtifacts,
  type TurnArtifactTracker,
} from "./turn-artifact-events";

/** 只用到事件订阅的代理（对话里的 `useAgent` 给的就是）。 */
type EventSource = {
  subscribe?: (subscriber: TurnArtifactTracker["subscriber"]) => {
    unsubscribe(): void;
  };
};

/**
 * 一段对话里记下的本轮产物事件。一个（代理，线程）一份：换了代理或线程就重新记，同一个代理对象切到别的线程
 * 也不会把上一段的清单带过去。订阅在渲染之后立刻挂上，要早于加入线程的 effect（写在它前面），重放的历史
 * 才听得到。
 */
export function useTurnArtifactEvents(
  agent: EventSource | undefined,
  threadId: string,
): readonly TrackedTurnArtifacts[] {
  const ref = useRef<{
    agent: unknown;
    threadId: string;
    tracker: TurnArtifactTracker;
  } | null>(null);
  if (ref.current?.agent !== agent || ref.current?.threadId !== threadId)
    ref.current = { agent, threadId, tracker: createTurnArtifactTracker() };
  const { tracker } = ref.current;
  useEffect(() => {
    const subscription = agent?.subscribe?.(tracker.subscriber);
    return () => subscription?.unsubscribe();
  }, [agent, tracker]);
  return useSyncExternalStore(tracker.listen, tracker.events, tracker.events);
}
