import { useFrontendTool, useHumanInTheLoop } from "@copilotkit/react-core/v2";
import { NOT_SHOWN, NOT_SHOWN_TAIL } from "@openbot/shared/component-markers";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FAILED_UNREADABLE,
  FAILED_WENT_WRONG,
  FailedCard,
  RefusedCard,
} from "@/components/gallery/refused";
import {
  agentComponentsQueryOptions,
  announceGallery,
  componentKeys,
  decideComponent,
  type GrantedComponent,
} from "@/lib/components/queries";
import { useActiveBotId, useDeclaredBotId } from "@/lib/copilot/active-bot";
import {
  GALLERY_COMPONENTS,
  type GalleryComponent,
  galleryManifest,
} from "@/lib/copilot/gallery-registry";
import { browserCallFailed } from "@/lib/plugins/tool-result";

/**
 * 一次已经结束的 gallery 调用为什么什么都没画出来；它不是这种情况就是 undefined。
 *
 * 失败的常常是参数：Claude Code 会在浏览器执行调用之前拒绝不是合法 JSON 的参数。照那些参数去画，
 * 表格就一直「正在等待完整的表格数据…」，重新打开对话也一样。结果说它失败了，而结果正是重新打开时
 * 保留下来的东西。还在流式输出或执行中的调用不算。
 *
 * 决策类组件只在参数读不懂时才算：等待时被停掉的决策也会以失败结果结束，但它的参数没问题，
 * 卡片上那个问题仍然是主人被问到的问题，照常画。
 */
export function galleryCallFailure(
  spec: GalleryComponent,
  call: { status?: unknown; args?: unknown; result?: unknown },
): string | undefined {
  if (call.status !== "complete") return undefined;
  /*
   * 假设：卡片类调用成功时的结果（`spec.confirmation` 或默认确认）和拒绝（`NOT_SHOWN` 开头）都不以
   * `Error: ` 开头。`browserCallFailed` 把 `Error: ` 开头的结果算作 CopilotKit 跑不了的调用；哪天某个
   * 组件的确认文案以它开头，这里就会把成功画成「没能显示」。
   */
  if (
    !browserCallFailed(
      typeof call.result === "string" ? call.result : undefined,
    )
  )
    return undefined;
  const fit = argumentsFit(spec, call.args);
  if (spec.kind === "decision")
    return fit === false ? FAILED_UNREADABLE : undefined;
  return fit === false ? FAILED_UNREADABLE : FAILED_WENT_WRONG;
}

/** 调用的参数是不是组件要的；schema 不能当场回答时为 undefined。只对已结束的调用问。 */
function argumentsFit(
  spec: GalleryComponent,
  args: unknown,
): boolean | undefined {
  const verdict = spec.parameters?.["~standard"]?.validate(args ?? {});
  if (!verdict || verdict instanceof Promise) return undefined;
  return !verdict.issues;
}

/**
 * Register compiled gallery components once per name, scoped to the active Bot with `available`.
 * Handlers still recheck grants at call time because a run's offered tool list is only a snapshot.
 */
export function GalleryTools() {
  const queryClient = useQueryClient();
  useEffect(() => {
    void announceGallery(galleryManifest()).then((added) => {
      if (added.length > 0) {
        void queryClient.invalidateQueries({ queryKey: componentKeys.all });
      }
    });
  }, [queryClient]);

  // Active Bot comes from the route/channel surface currently driving the provider.
  const grantsFor = useActiveBotId();
  // See sandboxed-tools: the placeholder Bot is not fetchable, so the grant query waits for a
  // surface to declare a real one.
  const declared = useDeclaredBotId();
  const { data: granted } = useQuery(agentComponentsQueryOptions(declared));
  const held = useMemo(
    () =>
      new Map(
        (granted ?? []).map((component: GrantedComponent) => [
          component.name,
          component.description,
        ]),
      ),
    [granted],
  );

  return (
    <>
      {GALLERY_COMPONENTS.map((spec) =>
        spec.kind === "decision" ? (
          <GrantedDecision held={held} key={spec.name} spec={spec} />
        ) : (
          <GrantedTool
            grantsFor={grantsFor}
            held={held}
            key={spec.name}
            spec={spec}
          />
        ),
      )}
    </>
  );
}

function GrantedTool({
  grantsFor,
  spec,
  held,
}: {
  grantsFor: string;
  spec: GalleryComponent;
  held: Map<string, string>;
}) {
  const description = held.get(spec.name);
  const isHeld = description !== undefined;

  /**
   * Refusals decided by the server, keyed by the call they refused.
   *
   * Per-call keys preserve the original render for calls made before a grant was revoked.
   */
  const [refusals, setRefusals] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );

  const Component = spec.Component;

  const render = useCallback(
    (props: {
      toolCallId?: string;
      status?: string;
      args?: Record<string, unknown>;
      result?: string;
    }) => {
      const refusal = props.toolCallId
        ? refusals.get(props.toolCallId)
        : undefined;
      if (refusal) {
        return <RefusedCard reason={refusal} title={spec.title} />;
      }
      /*
       * A stored refusal. The in-memory map above is gone once the page reloads, and a headless turn
       * never had one: the server answered the call itself (`server/src/components/headless.ts`).
       * The result is what survives, so a call that drew nothing is drawn as the refusal it was.
       */
      if (props.result?.startsWith(NOT_SHOWN)) {
        const lead = `${NOT_SHOWN}${spec.title}. `;
        const reason = (
          props.result.startsWith(lead)
            ? props.result.slice(lead.length)
            : props.result.slice(NOT_SHOWN.length)
        ).replace(NOT_SHOWN_TAIL, "");
        return <RefusedCard reason={reason} title={spec.title} />;
      }
      const failure = galleryCallFailure(spec, props);
      if (failure) return <FailedCard reason={failure} title={spec.title} />;
      // Render from the polled grant snapshot so revocations show before a new call starts.
      if (!isHeld) {
        return (
          <RefusedCard
            reason={`${spec.title} is not available to this Bot at the moment. An administrator grants components per Bot, and can unpublish one for every Bot at once.`}
            title={spec.title}
          />
        );
      }
      return <Component {...(props.args ?? {})} />;
    },
    [Component, isHeld, refusals, spec],
  );

  useFrontendTool({
    name: spec.name,
    // Published descriptions are model-facing runtime behavior.
    description: description ?? spec.description,
    parameters: spec.parameters,
    // Keep the hook mounted and hide revoked grants from the model to preserve hook order.
    available: isHeld,
    handler: async (
      args: Record<string, unknown>,
      context: { toolCall?: { id?: string } },
    ) => {
      const decision = await decideComponent(
        spec.name,
        grantsFor,
        spec.reads?.(args ?? {}) ?? [],
      );
      if (!decision.allowed) {
        const reason = decision.reason ?? "That component is not allowed here.";
        const id = context?.toolCall?.id;
        if (id) {
          setRefusals((current) => new Map(current).set(id, reason));
        }
        // Led with the same words the card shows, so the transcript and the card agree.
        return `${NOT_SHOWN}${spec.title}. ${reason}${NOT_SHOWN_TAIL}`;
      }
      return spec.confirmation ?? "It is now on screen for the person.";
    },
    render,
  });

  return null;
}

function GrantedDecision({
  spec,
  held,
}: {
  spec: GalleryComponent;
  held: Map<string, string>;
}) {
  const description = held.get(spec.name);
  const isHeld = description !== undefined;
  const Component = spec.Component;

  /** Stable component type so in-progress decision cards do not remount. */
  const Render = useMemo(
    () =>
      function DecisionRender(props: Record<string, unknown>) {
        const failure = galleryCallFailure(spec, props);
        if (failure) return <FailedCard reason={failure} title={spec.title} />;
        if (isHeld) return <Component {...props} />;
        return (
          <RefusedDecision
            respond={
              props.respond as ((result: unknown) => Promise<void>) | undefined
            }
            title={spec.title}
          />
        );
      },
    [Component, isHeld, spec],
  );

  useHumanInTheLoop({
    name: spec.name,
    description: description ?? spec.description,
    parameters: spec.parameters,
    available: isHeld,
    render: Render,
  });

  return null;
}

/**
 * A decision the Bot was not allowed to ask for.
 *
 * Decision tools suspend the run, so a refusal must also answer the tool call.
 */
function RefusedDecision({
  title,
  respond,
}: {
  title: string;
  respond?: (result: unknown) => Promise<void>;
}) {
  const reason = `${title} is not available to this Bot at the moment, so the person was not asked. An administrator grants components per Bot, and can unpublish one for every Bot at once.`;

  useEffect(() => {
    if (!respond) return;
    void respond(reason).catch(() => {
      // The run being gone is not a failure worth reporting: there is nothing left to answer.
    });
  }, [respond, reason]);

  return <RefusedCard reason={reason} title={title} />;
}
