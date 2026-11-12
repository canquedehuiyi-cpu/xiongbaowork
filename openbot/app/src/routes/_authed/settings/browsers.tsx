import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { BrowserSections } from "@/components/settings/browsers/browser-sections";
import { editionOf } from "@/lib/edition-guard";

export const Route = createFileRoute("/_authed/settings/browsers")({
  // The edition decides where the disclosure says a recording goes, so it is read before the page draws.
  beforeLoad: async ({ context }) => {
    await editionOf(context.queryClient);
  },
  component: BrowsersPage,
});

/** Connect the OpenBot Recorder in this browser, and see or disconnect every browser connected as you. */
function BrowsersPage() {
  return (
    <PageShell
      title="浏览器"
      description="在这个浏览器里连接录制器，自己做一遍任务来教员工。你录下的内容会进入你自己的学习空间。"
    >
      <BrowserSections />
    </PageShell>
  );
}
