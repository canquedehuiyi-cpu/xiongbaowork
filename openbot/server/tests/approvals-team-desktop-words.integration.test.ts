import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  DEFAULT_DESKTOP_ACTION_WORDS,
  desktopActionWordsOf,
} from "../../shared/desktop-control";
import {
  saveTeamActionKinds,
  saveTeamDesktopActionWords,
  saveTeamReviewerGuidance,
  teamDesktopActionWords,
  teamSettingsColumns,
} from "../src/approvals/extra-columns";
import { createApprovalStore } from "../src/approvals/store";
import { ApprovalRefusedError } from "../src/approvals/types";
import { createDatabase } from "../src/db/client";
import { approvalTeamSettings } from "../src/db/schema/approvals";
import { users } from "../src/db/schema/core";
import { asPlatform, runAsTenant } from "../src/tenant/context";
import { createAdminRequest, seedAdministrator } from "./support/admin-request";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The team's desktop action words (0202): the words that make clicking a control on a paired
 * computer ask every time. Stored on the one team settings row as a nullable `text[]`; null is the
 * default list (`DEFAULT_DESKTOP_ACTION_WORDS`), so a team that never saved one keeps it, and a
 * later change to the default reaches it.
 *
 * Through the real store on PostgreSQL. The admin saves from their own frame with the capability,
 * as the admin routes do; members read it in their own frames, as the gate does.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createApprovalStore(database);
const asAdminRequest = createAdminRequest(database);
const prefix = `desktop-words-${randomUUID()}`;
const admin = `${prefix}-admin`;
const member = `${prefix}-member`;
let releaseAdministrator: (() => Promise<void>) | undefined;
let priorTeam: Awaited<ReturnType<typeof readTeamRow>>[number] | undefined;

const readTeamRow = () =>
  database
    .select(teamSettingsColumns)
    .from(approvalTeamSettings)
    .where(eq(approvalTeamSettings.id, "team"));

/** The column itself, read in `frame`: what is stored, not what the store makes of it. */
const storedWords = (frame: string) =>
  runAsTenant(frame, () =>
    database
      .select({ words: teamDesktopActionWords })
      .from(approvalTeamSettings)
      .where(eq(approvalTeamSettings.id, "team")),
  );

const save = (words: string[] | null) =>
  asAdminRequest(admin, () =>
    store.policy!.setTeamSettings(admin, { desktopActionWords: words }),
  );

/** What a member's gate reads. */
const membersView = () =>
  runAsTenant(member, () => store.policy!.teamSettings());

beforeAll(async () => {
  releaseAdministrator = await seedAdministrator(database, admin);
  await asPlatform(async () => {
    await database
      .insert(users)
      .values({ id: member, email: `${member}@example.test` });
    // The team settings row is deployment-wide, so this file puts it back as it found it.
    [priorTeam] = await readTeamRow();
  });
});

beforeEach(async () => {
  // Each test starts from a team that never saved anything.
  await asPlatform(() =>
    database
      .delete(approvalTeamSettings)
      .where(eq(approvalTeamSettings.id, "team")),
  );
});

afterAll(async () => {
  await asPlatform(async () => {
    await database
      .delete(approvalTeamSettings)
      .where(eq(approvalTeamSettings.id, "team"));
    // The columns outside the frozen db/schema/approvals.ts go back separately
    // (approvals/extra-columns.ts).
    if (priorTeam) {
      const { actionKinds, reviewerGuidance, desktopActionWords, ...columns } =
        priorTeam;
      await database.insert(approvalTeamSettings).values(columns);
      await saveTeamActionKinds(database, actionKinds);
      await saveTeamReviewerGuidance(database, reviewerGuidance);
      await saveTeamDesktopActionWords(database, desktopActionWords);
    }
    await database.delete(users).where(eq(users.id, member));
  });
  await releaseAdministrator?.();
  await database.$client.close();
});

test("a fresh team has no list (null) and uses the default", async () => {
  // No team row at all.
  const none = await membersView();
  expect(none.desktopActionWords).toBeNull();
  expect(desktopActionWordsOf(none.desktopActionWords ?? undefined)).toBe(
    DEFAULT_DESKTOP_ACTION_WORDS,
  );

  // A row saved for something else: the column is left null, not filled with the default.
  await asAdminRequest(admin, () =>
    store.policy!.setTeamSettings(admin, { hostCommandsCap: "ask" }),
  );
  expect(await storedWords("platform")).toEqual([{ words: null }]);
  const saved = await membersView();
  expect(saved.hostCommandsCap).toBe("ask");
  expect(saved.desktopActionWords).toBeNull();
  expect(desktopActionWordsOf(saved.desktopActionWords ?? undefined)).toBe(
    DEFAULT_DESKTOP_ACTION_WORDS,
  );
});

test("a list is saved normalised and read back", async () => {
  // Trimmed, blanks and repeats dropped, order kept.
  const saved = await save([
    "  归档 ",
    "发送",
    "",
    "   ",
    "归档",
    "Archive",
    "\t发送\n",
  ]);
  expect(saved.desktopActionWords).toEqual(["归档", "发送", "Archive"]);
  expect(await storedWords("platform")).toEqual([
    { words: ["归档", "发送", "Archive"] },
  ]);
  expect((await membersView()).desktopActionWords).toEqual([
    "归档",
    "发送",
    "Archive",
  ]);
  expect(
    desktopActionWordsOf((await membersView()).desktopActionWords ?? undefined),
  ).toEqual(["归档", "发送", "Archive"]);

  // Another setting saved later leaves the list as it was.
  await asAdminRequest(admin, () =>
    store.policy!.setTeamSettings(admin, { enforceAutoReview: true }),
  );
  expect((await membersView()).desktopActionWords).toEqual([
    "归档",
    "发送",
    "Archive",
  ]);

  // Nothing left after normalising is no list: the default again.
  expect((await save(["", "  "])).desktopActionWords).toBeNull();
  expect(await storedWords("platform")).toEqual([{ words: null }]);

  // Null puts the default back.
  await save(["归档"]);
  expect((await save(null)).desktopActionWords).toBeNull();
  expect(await storedWords("platform")).toEqual([{ words: null }]);
  expect((await membersView()).desktopActionWords).toBeNull();
});

test("more than 50 words or a 21-character word is refused", async () => {
  // At the limits: 50 words (repeats do not count), 20 characters counted as Chinese characters
  // and as code points, not UTF-16 units.
  const fifty = Array.from({ length: 50 }, (_, i) => `词${i}`);
  const twentyChinese = "一二三四五六七八九十甲乙丙丁戊己庚辛壬癸";
  const twentyEmoji = "😀".repeat(20);
  expect([...twentyChinese]).toHaveLength(20);
  expect(twentyEmoji.length).toBe(40);
  const atLimit = [...fifty.slice(0, 48), twentyChinese, twentyEmoji];
  expect(
    (await save([...atLimit, "词0", ` ${twentyChinese} `])).desktopActionWords,
  ).toEqual(atLimit);

  for (const words of [
    [...fifty, "再一个"],
    [`${twentyChinese}子`],
    ["a".repeat(21)],
    [`${twentyEmoji}😀`],
  ]) {
    await expect(save(words)).rejects.toBeInstanceOf(ApprovalRefusedError);
  }
  // A refused save changes nothing.
  expect((await membersView()).desktopActionWords).toEqual(atLimit);
});

test("another tenant cannot read or write this team's list", async () => {
  await save(["归档"]);

  // Every person's own frame reads the team's list, as their gate must (G01-E team_read); a frame
  // that is nobody's — `system` — reads nothing.
  expect(await storedWords(member)).toEqual([{ words: ["归档"] }]);
  expect(await storedWords("system")).toEqual([]);

  // A member's save, and an admin's without the capability (a routine's frame), are refused by the
  // database and change nothing.
  await expect(
    runAsTenant(member, () =>
      store.policy!.setTeamSettings(member, { desktopActionWords: ["发送"] }),
    ),
  ).rejects.toThrow();
  await expect(
    runAsTenant(admin, () =>
      store.policy!.setTeamSettings(admin, { desktopActionWords: ["发送"] }),
    ),
  ).rejects.toThrow();
  // Straight at the column from the member's frame: the row is visible to read, not to update.
  await runAsTenant(member, () =>
    saveTeamDesktopActionWords(database, ["发送"]),
  );
  expect(await storedWords("platform")).toEqual([{ words: ["归档"] }]);
  expect((await membersView()).desktopActionWords).toEqual(["归档"]);
});
