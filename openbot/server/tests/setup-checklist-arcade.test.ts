import { describe, expect, test } from "bun:test";
import {
  type SetupFacts,
  type SetupFix,
  type SetupRow,
  setupRows,
} from "../src/setup/checklist";

/*
 * 「更多应用」那一行按部署会用的那个连接应用提供商给修法（X5 合入 M5a 后补上 Arcade，上游
 * `setup/checklist.ts` 的 `BROKER`）：Arcade 部署缺的是 ARCADE_API_KEY，不是 COMPOSIO_API_KEY。没说是
 * 哪个提供商时仍是 Composio，与以前一样。
 */
const facts = (apps: SetupFacts["apps"]): SetupFacts => ({
  intelligence: { state: "ready" },
  model: {
    provider: "openai",
    source: "environment",
    verdict: "available",
    model: "gpt-5.6-terra",
  },
  computer: false,
  apps,
  chat: false,
});

const appsRow = (apps: SetupFacts["apps"]): SetupRow | undefined =>
  setupRows(facts(apps), { productName: "OpenBot", audience: "admin" }).find(
    (row) => row.id === "apps",
  );

describe("the more-apps row names the broker the deployment would use", () => {
  test("an Arcade deployment is told to set ARCADE_API_KEY, with Arcade's guide", () => {
    expect(appsRow({ configured: false, provider: "arcade" })?.fix).toEqual({
      kind: "env",
      names: ["ARCADE_API_KEY"],
      docsUrl: undefined,
    });
  });

  test("a Composio deployment, and one that does not say, keep the Composio fix", () => {
    const composio: SetupFix = {
      kind: "env",
      names: ["COMPOSIO_API_KEY"],
      docsUrl: undefined,
    };
    expect(appsRow({ configured: false, provider: "composio" })?.fix).toEqual(
      composio,
    );
    expect(appsRow({ configured: false })?.fix).toEqual(composio);
  });

  test("a configured broker is ready whichever it is, and offers no fix", () => {
    expect(appsRow({ configured: true, provider: "arcade" })?.status).toBe(
      "ready",
    );
    expect(appsRow({ configured: true, provider: "arcade" })?.fix).toBeNull();
  });
});
