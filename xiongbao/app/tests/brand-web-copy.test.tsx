import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GENERATIVE_UI_DESIGN_SKILL } from "@/lib/copilot/generative-ui";
import { appConfig } from "@/lib/generated/application-config";
import { installedCards, marketCards } from "@/lib/plugins/market";
import type {
  CatalogueItem,
  PluginServer,
  PluginsPage,
} from "@/lib/plugins/queries";
import {
  LIBRARY_LOWER,
  OLD_NAME,
  OLD_PRODUCT,
  OLD_PRODUCT_LOWER,
} from "../../scripts/brand/guard/words";

const appSource = join(import.meta.dir, "../src");
const read = (path: string) => readFileSync(join(appSource, path), "utf8");

test("the generated-interface prompt names this delivery's product, not the upstream's", () => {
  expect(appConfig.brand.englishName).toBe("XiongBao Work");
  expect(GENERATIVE_UI_DESIGN_SKILL).toContain(
    "inside a sandboxed iframe in XiongBao Work's chat transcript",
  );
  expect(GENERATIVE_UI_DESIGN_SKILL).toContain(
    "PALETTE. XiongBao Work is neutral",
  );
  expect(GENERATIVE_UI_DESIGN_SKILL).not.toMatch(OLD_NAME);
});

test("the old orb logo is gone", () => {
  expect(
    existsSync(join(appSource, `assets/${OLD_PRODUCT_LOWER}-logo.png`)),
  ).toBe(false);
  expect(
    existsSync(
      join(appSource, `components/edition/${OLD_PRODUCT_LOWER}-logo.tsx`),
    ),
  ).toBe(false);
});

test("the banner no longer links to the upstream vendor", () => {
  const banner = read("components/layout/self-host-banner.tsx");
  expect(banner).not.toContain(`${LIBRARY_LOWER}.ai`);
  expect(banner).toContain("appConfig.brand.supportUrl");
});

test("admin hints show the XIONGBAO_ names and do not mention the old ones", () => {
  expect(read("components/manage/plugin-page.tsx")).toContain(
    "XIONGBAO_PUBLIC_URL",
  );
  expect(read("components/manage/plugin-page.tsx")).not.toContain("旧名");
  expect(read("routes/_authed/_app/responsibilities.tsx")).toContain(
    "XIONGBAO_INBOUND_EMAIL_DOMAIN",
  );
});

test("a built-in plugin installed before the rename shows the catalogue's vendor, not the stored upstream name", () => {
  const entry = {
    key: "routines",
    title: "Routines",
    vendor: "熊宝",
    summary: "",
    docsUrl: "",
    auth: "builtin",
  } as unknown as CatalogueItem;
  const stored = (provenance: string, vendor: string) =>
    ({
      id: "routines",
      title: "Routines",
      vendor,
      url: "builtin://routines",
      summary: "",
      docsUrl: "",
      provenance,
      authScheme: null,
      tools: [],
      withdrawn: [],
    }) as unknown as PluginServer;
  const page = (server: PluginServer) =>
    ({
      catalogue: [entry],
      servers: [server],
      skills: [],
    }) as unknown as PluginsPage;

  const [installed] = installedCards(
    page(stored("first-party", OLD_PRODUCT)),
    undefined,
  );
  expect(installed?.vendor).toBe("熊宝");
  const [market] = marketCards(
    page(stored("first-party", OLD_PRODUCT)),
    undefined,
  );
  expect(market?.vendor).toBe("熊宝");
  // A row an administrator typed in by address keeps the host it was derived from.
  const [custom] = installedCards(
    page(stored("custom", "mcp.example.com")),
    undefined,
  );
  expect(custom?.vendor).toBe("mcp.example.com");
});
