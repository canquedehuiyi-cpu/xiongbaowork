/**
 * 主动场景冒烟（期 3）：员工自己认领看板上的卡并做完；安静时段里不发通知，也不开工。
 *
 * 照 `smoke-background.ts` 的做法，场景和判分都写在文件里；不同的是这一项的东西都在服务器里（心跳、认领、交付闭环、
 * 通知投递），不是一句交给员工的话，所以不进 `smoke.ts` 的真模型场景表，而是自己跑：接真库，用真的存储和真的
 * 心跳、认领、交付代码，只把「模型那一轮」换成固定的替身（它不是这里要测的）。不碰网络，不要任何密钥。
 *
 *   A  预置一张派给「前端」岗位的卡，开了心跳的员工醒来，自己认领：卡变成它名下一张跟着走的看板卡，替身员工按交付
 *      闭环接活、交付，卡进「等验收」，本人验收后结束；这一次醒来没有叫模型（清单是空的），账里记一次 acted。
 *   B  安静时段内：本人的安静时段盖住现在。心跳到点不叫模型也不认领（卡还留在那儿没人领），下一次排到时段结束；
 *      巡检的通知写进发件箱但推迟到时段结束，现在没有一条能被领去发。时段一结束，下一次醒来就把那张卡领走，
 *      通知也可以发了：推迟，没有丢。
 *
 * 用法（在 xiongbao/ 下）：bun scripts/e2e/employee-eval/smoke-proactive.ts
 * 环境：E2E_DATABASE_URL（应用角色 xiongbao_app，NOSUPERUSER NOBYPASSRLS），跑过迁移；也认 TEST_DATABASE_URL。
 */
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { createDatabase } from "../../../server/src/db/client";
import { createDeliveryRouter } from "../../../server/src/delivery/router";
import { createDeliveryStore } from "../../../server/src/delivery/store";
import { createHeartbeatRunner } from "../../../server/src/heartbeat/runner";
import { createHeartbeatStore } from "../../../server/src/heartbeat/store";
import { createCardAutonomy } from "../../../server/src/tasks/card-autonomy";
import { createBoardCards } from "../../../server/src/tasks/claim";
import { createDelivery } from "../../../server/src/tasks/delivery";
import { createTaskProjector } from "../../../server/src/tasks/projector";
import { runAsTenant } from "../../../server/src/tenant/context";
import {
  createQuietUntil,
  createUserPreferencesStore,
} from "../../../server/src/user-preferences";
import { createWorkQueue } from "../../../server/src/work/queue";

const url =
  process.env.E2E_DATABASE_URL?.trim() || process.env.TEST_DATABASE_URL?.trim();
const ownerUrl =
  process.env.E2E_OWNER_DATABASE_URL?.trim() ||
  process.env.TEST_DATABASE_ADMIN_URL?.trim();
if (!url || !ownerUrl)
  throw new Error(
    "E2E_DATABASE_URL and E2E_OWNER_DATABASE_URL are required (TEST_DATABASE_URL and TEST_DATABASE_ADMIN_URL also work).",
  );

let assertions = 0;
function check(condition: unknown, message: string): asserts condition {
  assertions += 1;
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`  ok  ${message}`);
}

const db = createDatabase(url);
/*
 * 种数据和读回结果用库的属主连接，和 G8 一样：它只做这两件事，被测的代码全部走应用角色。一条连接、
 * 平台帧，每一行自己写明租户。
 */
const owner = new SQL(ownerUrl, { max: 1 });
await owner`select set_config('app.tenant_id', 'platform', false)`;
const queue = createWorkQueue(db);
const prefix = `smoke-proactive-${randomUUID().slice(0, 8)}`;
const person = `${prefix}-person`;
const employee = `${prefix}-bot`;
const role = "前端";
const asPerson = <T>(work: () => T): T => runAsTenant(person, work);
const asPlatform = <T>(work: () => T): T => runAsTenant("platform", work);
type Row = Record<string, unknown>;

// 时钟由这里拨：心跳的网格、安静时段都认它，所以「现在是夜里」不用等到夜里。
let clock = new Date("2026-11-20T03:00:00Z"); // 上海 11:00，白天
const now = () => clock;

const heartbeats = createHeartbeatStore(db, { queue, now });
const cards = createBoardCards(db);
const prefs = createUserPreferencesStore(db);
const quietUntil = createQuietUntil(db, now);
const delivery = createDelivery(db);
const projector = createTaskProjector(db);

/** 替身员工：收到卡的话就按交付闭环接活、交付，和真员工调 accept_task、deliver_task 落到同样的库。 */
const roundsStarted: string[] = [];
const autonomy = createCardAutonomy({
  cards,
  board: projector,
  delivery,
  rounds: {
    startNudgeRun: async (tenantId, taskId, text) => {
      roundsStarted.push(text);
      const runId = randomUUID();
      check(
        await delivery.attachRun(tenantId, taskId, runId),
        "替身员工的这一轮挂到了卡上",
      );
      const accepted = await delivery.accept(tenantId, taskId, {
        runId,
        threadRef: "smoke-thread",
        actor: `agent:${employee}`,
        dueAt: null,
        criteria: "页面按钮改成红色",
      });
      check(accepted, "替身员工接活");
      const handedIn = await delivery.delivered(tenantId, taskId, {
        runId,
        agentId: employee,
        actor: `agent:${employee}`,
        deliverable: { kind: "deliverable", notes: ["按钮已改成红色"] },
      });
      check(handedIn, "替身员工交付");
      return "started";
    },
  },
  actorFor: async () => ({ id: person, role: "user" as const }),
  channels: {
    direct: async () =>
      ({ id: `${prefix}-chat`, threadId: `${prefix}-thread` }) as never,
  },
  quietUntil,
});

let modelTurns = 0;
const runner = createHeartbeatRunner({
  queue,
  store: heartbeats,
  owner: `${prefix}-runner`,
  runTurn: async () => {
    modelTurns += 1;
    return { replyText: "HEARTBEAT_OK" };
  },
  mintThreadId: () => `${prefix}-hb-thread`,
  actorFor: async () => ({ id: person, role: "user" as const }),
  channels: {
    direct: async () => {
      throw new Error("心跳没事时不该碰单聊");
    },
    recordActivity: async () => {
      throw new Error("心跳没事时不该写对话");
    },
  },
  quietUntil,
  dailyRuns: async () => 24,
  claimCards: ({ ownerUserId, agentId }) =>
    autonomy.claimAndStart(ownerUserId, agentId),
  now,
});

const outboxFor = async (): Promise<Row[]> =>
  await owner`select id, run_at from delivery_outbox o left join work_items w on w.kind = 'delivery.outbound' and w.key = o.id::text where o.owner_user_id = ${person}`;
const heartbeatItems = async (): Promise<{ key: string; run_at: Date }[]> =>
  await owner`select key, run_at from work_items where kind = 'heartbeat.run' and key like ${`${employee}:%`} and finished_at is null order by run_at desc`;
/** 把还没到点的那一条心跳拨到「现在」，等于时间走到了它。 */
const makeDue = () =>
  owner`update work_items set run_at = now() - interval '1 second' where kind = 'heartbeat.run' and key like ${`${employee}:%`} and finished_at is null`;

async function setup() {
  await owner`insert into users (id, email) values (${person}, ${`${person}@example.test`})`;
  await owner`insert into agents (id, tenant_id, name, type, configuration) values (${employee}, ${person}, '小前', 'built_in', '{}'::jsonb)`;
  await owner`insert into agent_profiles (agent_id, tenant_id, owner_user_id, title, role_description, avatar_seed, visibility) values (${employee}, ${person}, ${person}, ${role}, '', ${employee}, 'private')`;
  // 清单留空：这一次醒来只认领，不叫模型。
  const applied = await asPerson(() =>
    heartbeats.apply(person, employee, {
      enabled: true,
      intervalMinutes: 15,
      checklist: "",
    }),
  );
  check(applied.ok, "员工开了心跳（间隔 15 分钟）");
}

async function scenarioA() {
  console.log("A  员工自己认领一张卡并做完");
  const card = await asPerson(() =>
    cards.create({
      title: "把按钮改成红色",
      detail: "首页的提交按钮",
      role,
      priority: 2,
      createdBy: person,
    }),
  );
  clock = new Date("2026-11-20T03:16:00Z");
  await makeDue();
  const report = await asPlatform(() => runner.sweep());
  check(report.ran[0]?.outcome === "acted", "这一次醒来做了事（认领）");
  check(modelTurns === 0, "清单是空的：没有叫模型");
  const [listed] = (await asPerson(() => cards.list())).filter(
    (row) => row.id === card.id,
  );
  check(
    listed?.status === "claimed" && listed.claimedBy === employee,
    "卡被这位员工领走了",
  );
  const [task] =
    await owner`select id, status, tracked, executor_agent_id from tasks where id = ${listed?.taskId ?? randomUUID()}`;
  check(
    task?.tracked === true && task.executor_agent_id === employee,
    "开出一张跟着走的看板卡，执行人是它",
  );
  check(task?.status === "awaiting_review", "走完接活、交付：卡在「等验收」");
  check(
    roundsStarted[0]?.includes("把按钮改成红色"),
    "员工收到的话里有卡的标题",
  );
  const reviewed = await delivery.review(
    person,
    String(task?.id),
    `user:${person}`,
    "review",
  );
  check(reviewed === true, "本人验收");
  const [done] =
    await owner`select status from tasks where id = ${String(task?.id)}`;
  check(done?.status === "done", "卡结束了");
  const [ledger] =
    await owner`select outcome, cards_claimed from heartbeat_runs where agent_id = ${employee}`;
  check(
    ledger?.outcome === "acted" && ledger.cards_claimed === 1,
    "账里记了一次 acted、认领 1 张",
  );
  check((await outboxFor()).length === 0, "没有对本人发任何通知");
}

async function scenarioB() {
  console.log("B  安静时段内不发通知，也不开工");
  await asPerson(() =>
    prefs.quietHours?.patch(person, {
      enabled: true,
      start: "22:00",
      end: "08:00",
    }),
  );
  const card = await asPerson(() =>
    cards.create({ title: "夜里放进来的卡", role, createdBy: person }),
  );
  clock = new Date("2026-11-20T15:30:00Z"); // 上海 23:30
  check(
    (await quietUntil(person, { now: clock })) !== null,
    "现在在本人的安静时段里",
  );
  await makeDue();
  const sweep = await asPlatform(() => runner.sweep());
  check(
    sweep.skipped[0]?.reason === "quiet_hours",
    "心跳到点：因为安静时段没有做事",
  );
  const stillOpen = (await asPerson(() => cards.list())).find(
    (row) => row.id === card.id,
  );
  check(stillOpen?.status === "open", "卡还在那儿没人领");
  check(
    (await autonomy.kick(person, { role, urgent: false })) === 0,
    "新卡放进来的那一踢也不领",
  );
  // 通知：走真的投递路由，要写进发件箱，但不能现在就被领去发。
  const store = createDeliveryStore(db);
  const scope = {
    ownerUserId: person,
    channelId: `${prefix}-chat`,
    agentId: employee,
    threadId: `${prefix}-thread`,
  };
  const router = createDeliveryRouter({
    store,
    queue,
    owner: `${prefix}-delivery`,
    providers: { push: {} as never },
    authoriseScope: async () => true,
    scopeFor: async () => scope,
    runTurn: async () => ({ replyText: "" }),
    routeFor: async () => ({ allows: () => true, notify: true }) as never,
    quietUntil: (who, options) => quietUntil(who, { ...options, now: clock }),
  });
  await owner`insert into channels (id, tenant_id, name, description) values (${`${prefix}-chat`}, ${person}, '小前', '')`;
  await owner`insert into push_devices (id, tenant_id, owner_user_id, token, project_id, platform) values (${randomUUID()}, ${person}, ${person}, ${`${prefix}-token`}, ${prefix}, 'ios')`;
  // 人不在时「这一轮结束了」的通知：主动发出的，安静时段里要推迟。
  await asPerson(() =>
    router.notify(scope, {
      id: `${prefix}-ended`,
      kind: "reply",
      text: "做完了",
      away: { push: true, chat: true, chatText: "做完了" },
    }),
  );
  const held =
    await owner`select o.id, w.run_at from delivery_outbox o join work_items w on w.kind = 'delivery.outbound' and w.key = o.id::text where o.owner_user_id = ${person}`;
  check(held.length > 0, "主动发出的通知照常写进了发件箱");
  check(
    held.every(
      (row: { run_at: Date }) =>
        // 和拨过的时钟比，不和真实的「现在」比：时段结束是按拨过的时钟算的（2026-11-21 00:00 UTC），
        // 真实时间过了那一刻以后，拿 Date.now() 比就永远不成立。
        row.run_at.getTime() > clock.getTime() + 60 * 60_000,
    ),
    "它们都推迟到了时段结束，现在没有一条能被领去发",
  );
  // 时段结束：下一次醒来把卡领走，通知也到了可以发的时候。
  const [next] = await heartbeatItems();
  check(
    next !== undefined &&
      next.run_at.toISOString() >= "2026-11-21T00:00:00.000Z",
    "下一次醒来排在时段结束之后",
  );
  clock = new Date("2026-11-21T00:01:00Z");
  await makeDue();
  const after = await asPlatform(() => runner.sweep());
  check(after.ran[0]?.outcome === "acted", "时段结束后的那一次醒来做了事");
  const claimed = (await asPerson(() => cards.list())).find(
    (row) => row.id === card.id,
  );
  check(claimed?.status === "claimed", "夜里放进来的那张卡被领走了，没有丢");
}

async function cleanup() {
  await owner`delete from work_items where key like ${`${employee}:%`} or key in (select id::text from delivery_outbox where owner_user_id = ${person})`;
  await owner`delete from delivery_outbox where owner_user_id = ${person}`;
  await owner`delete from push_devices where owner_user_id = ${person}`;
  await owner`delete from board_cards where owner_user_id = ${person}`;
  await owner`delete from heartbeat_runs where owner_user_id = ${person}`;
  await owner`delete from task_events where tenant_id = ${person}`.catch(
    () => undefined,
  );
  await owner`delete from tasks where tenant_id = ${person}`;
  await owner`delete from users where id = ${person}`;
  await owner`delete from channels where id = ${`${prefix}-chat`}`;
  await owner`delete from agents where id = ${employee}`;
}

try {
  await setup();
  await scenarioA();
  await scenarioB();
  console.log(`主动场景冒烟通过（${assertions} 项）`);
} finally {
  await cleanup().catch((error) => console.warn("cleanup failed", error));
  await owner.close();
  await db.$client.end({ timeout: 5 });
}
