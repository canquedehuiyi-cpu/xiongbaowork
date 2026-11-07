import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { PageShell } from "@/components/layout/page-shell";
import { SidebarProvider } from "@/components/ui/sidebar";

/*
 * The five workbench pages share one frame (parity plan F1): full width, left-aligned 40 CSS px
 * from the sidebar's edge — the reference's main column starts at x≈280 beside a 240px sidebar —
 * rather than the centred reading column the settings-style pages use.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
});
afterEach(() => {
  cleanup();
});
afterAll(() => {
  GlobalRegistrator.unregister();
});

function frameOf(width?: "prose" | "wide" | "workbench") {
  const view = render(
    <SidebarProvider>
      <PageShell title="任务看板" width={width}>
        <p>正文</p>
      </PageShell>
    </SidebarProvider>,
  );
  const heading = view.getByRole("heading", { level: 1, name: "任务看板" });
  const frame = heading.closest("header")?.parentElement;
  if (!frame) throw new Error("no frame");
  const classes = frame.className.split(/\s+/);
  cleanup();
  return classes;
}

test("a workbench page sits 40px in, capped and centred on very wide screens, under a 28px title", () => {
  // Measured from docs/acceptance/qoderwake-reference: at 1696px the main column starts 40px in from
  // the sidebar; at ~2640px the 能力与资源 page is a ~1680px column centred in the main area.
  const classes = frameOf("workbench");
  expect(classes).toEqual(
    expect.arrayContaining(["px-[40px]", "mx-auto", "max-w-[1760px]"]),
  );
  const view = render(
    <SidebarProvider>
      <PageShell description="说明" title="任务看板" width="workbench">
        <p>正文</p>
      </PageShell>
    </SidebarProvider>,
  );
  const heading = view.getByRole("heading", { level: 1, name: "任务看板" });
  expect(heading.className).toContain("text-[28px]");
  expect(view.getByText("说明").className).toContain("text-[14px]");
});

test("the reading widths are unchanged", () => {
  expect(frameOf()).toEqual(expect.arrayContaining(["mx-auto", "max-w-2xl"]));
  expect(frameOf("wide")).toEqual(
    expect.arrayContaining(["mx-auto", "max-w-5xl"]),
  );
});
