import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { RecentDeliveries } from "@/components/reachability/recent-deliveries";
import type { Reachability } from "@/lib/delivery";
import { settleReactWork } from "./settle-react-work";

/**
 * 可达性 › 最近送达 (upstream's Settings → Notifications, Recent deliveries): every message sent the
 * person outside the web app, named in the words the rest of the page uses. A row once read
 * "push · attention" and "failed": the server's own names for the channel, the kind and the state.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

type Delivery = Reachability["deliveries"][number];

/** One `delivery_outbox` row as `/api/delivery` returns it. */
const delivery = (
  id: string,
  transport: Delivery["transport"],
  kind: Delivery["kind"],
  state: Delivery["state"],
  error: string | null = null,
): Delivery & Record<string, unknown> => ({
  id,
  ownerUserId: "person",
  channelId: "channel",
  agentId: "bot",
  threadId: "thread",
  bindingId: null,
  deviceId: null,
  transport,
  text: "What was sent",
  kind,
  requestId: null,
  state,
  providerId: null,
  error,
  createdAt: "2026-10-30T22:24:30Z",
  updatedAt: "2026-10-30T22:24:30Z",
});

/** The section as 可达性 draws it, with what `/api/delivery` listed. */
function draw(deliveries: ReturnType<typeof delivery>[]) {
  return render(<RecentDeliveries deliveries={deliveries} />);
}

const rowOf = (title: HTMLElement) => title.closest("li")?.textContent ?? "";

test("each row names its kind and its channel in the words the routing switches use", async () => {
  const view = draw([
    delivery(
      "ping",
      "push",
      "attention",
      "failed",
      "Expo delivery failed (DeviceNotRegistered).",
    ),
    delivery("reply", "slack", "reply", "delivered"),
    delivery("approval", "teams", "approval", "sent"),
    delivery("question", "sms", "question", "queued"),
  ]);
  const ping = rowOf(await view.findByText("有事需要你"));
  expect(ping).toContain("原生推送");
  expect(ping).toContain("送达失败");
  expect(ping).toContain("Expo delivery failed (DeviceNotRegistered).");
  expect(rowOf(view.getByText("回复"))).toContain("Slack");
  expect(rowOf(view.getByText("回复"))).toContain("已送达");
  expect(rowOf(view.getByText("审批请求"))).toContain("Microsoft Teams");
  expect(rowOf(view.getByText("审批请求"))).toContain("已发出");
  expect(rowOf(view.getByText("提问"))).toContain("短信");
  expect(rowOf(view.getByText("提问"))).toContain("排队中");
  const page = view.container.textContent ?? "";
  for (const raw of ["attention", "push ·", "slack ·", "teams", "sms ·"])
    expect(page).not.toContain(raw);
});

test("a state with no plain word of its own is never shown as the server's name for it", async () => {
  const view = draw([
    delivery(
      "unsure",
      "slack",
      "attention",
      "unknown",
      "OpenTag delivery failed (invalid_auth).",
    ),
    delivery(
      "stopped",
      "sms",
      "attention",
      "opted_out",
      "Twilio reports this number opted out (21610). Nothing was sent.",
    ),
    delivery("handed", "push", "reply", "accepted"),
    delivery("going", "slack", "question", "running"),
  ]);
  expect(await view.findAllByText("有事需要你")).toHaveLength(2);
  const page = view.container.textContent ?? "";
  for (const raw of ["unknown", "opted_out", "accepted", "running"])
    expect(page).not.toContain(raw);
  expect(page).toContain("状态未知");
  expect(page).toContain("对方已退订");
  expect(page).toContain("发送中");
});
