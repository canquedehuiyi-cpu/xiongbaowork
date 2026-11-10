import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ComponentPreview } from "@/components/component-preview";
import { PageShell } from "@/components/layout/page-shell";
import { SettingsItemBackground } from "@/components/settings/background";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { componentDisplayTitle } from "@/lib/components/display-title";
import { componentListQueryOptions } from "@/lib/components/queries";
import { galleryComponent } from "@/lib/copilot/gallery-registry";

/**
 * What a Bot can draw, for the person it draws for.
 *
 * The same gallery an administrator governs, with none of the governing. Published components only:
 * an unpublished one is not something any Bot can put on screen, so listing it here would describe a
 * capability nobody has.
 *
 * Each card says what the component shows in the person's words, its `summary`. Not the published
 * description: that is written for the model, names other tools and says "deployment", and was shown
 * here until a person read "Show what this deployment has actually been doing" under Activity
 * report. A playground component has no words but the ones its admin
 * published, so it keeps those.
 */
export const Route = createFileRoute("/_authed/settings/components-gallery/")({
  component: RouteComponent,
});

function RouteComponent() {
  const components = useQuery(componentListQueryOptions());
  const published = components.data?.filter((component) => component.published);

  return (
    <PageShell
      width="workbench"
      description="员工可以在对话里直接画出来、代替大段文字描述的组件。某位员工能用哪些，由管理员决定。"
      title="组件展示"
    >
      {components.isPending ? null : components.error ? (
        <p className="mt-6 text-destructive text-sm" role="alert">
          读不到组件。
        </p>
      ) : published?.length === 0 ? (
        <Empty className="mt-6 min-h-[30dvh] rounded-[14px] border border-dashed">
          <EmptyHeader>
            <EmptyTitle>还没有发布任何组件</EmptyTitle>
            <EmptyDescription className="text-pretty">
              管理员发布组件后，会显示在这里。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="mt-6 grid w-full grid-cols-1 gap-[11px] sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {published?.map((component) => (
            /*
             * No status dot, unlike the Admin tiles. Everything listed here is published by
             * definition, so a dot saying so would be the same mark on every tile.
             */
            <Link
              className="flex aspect-square flex-col overflow-hidden rounded-[14px] border border-border bg-card text-left shadow-[inset_0_1px_0_rgb(255_255_255/0.03)] outline-none transition-colors hover:border-ring focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              data-testid={`gallery-${component.name}`}
              key={component.name}
              params={{ name: component.name }}
              to="/settings/components-gallery/$name"
            >
              <div className="min-h-28 p-4">
                <h4 className="line-clamp-1 font-medium text-sm">
                  {componentDisplayTitle(component)}
                </h4>
                <p className="mt-2 line-clamp-2 text-muted-foreground text-xs">
                  {galleryComponent(component.name)?.summary ??
                    component.publishedDescription}
                </p>
              </div>
              <div className="relative flex-1">
                <div className="absolute top-0 left-0 h-full w-full p-3">
                  <SettingsItemBackground className="h-full w-full rounded-[9px]" />
                </div>
                <div className="absolute top-0 left-0 z-10 h-full w-full p-3">
                  <ComponentPreview
                    kind={component.kind}
                    name={component.name}
                  />
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </PageShell>
  );
}
