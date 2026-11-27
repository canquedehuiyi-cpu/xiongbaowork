import { createFileRoute } from "@tanstack/react-router";
import { LICENCE_NOTICE } from "@xiongbao/shared/licence-paragraph";
import { useDeferredValue, useEffect, useState } from "react";
import { PageShell } from "@/components/layout/page-shell";
import { Input } from "@/components/ui/input";
import { appConfig } from "@/lib/generated/application-config";
import { version } from "../../../../../package.json";

export const Route = createFileRoute("/_authed/settings/about")({
  component: AboutPage,
});

type Notice = {
  name: string;
  version: string;
  license: string;
  licenseText?: string;
};

/* 产品最初所基于代码的 MIT 许可作为清单里的一行（THIRD-PARTY-NOTICES.md 也以它开头）；没有版本号，版本列写「—」。 */
const BUNDLED_NOTICE: Notice = LICENCE_NOTICE;

/* 与生成清单同一排序规则（按名称的码元顺序），这一行才能落在固定位置。 */
function byName(a: Notice, b: Notice) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/* 版本号取仓库根 package.json：应用本身没有单独的版本来源，发版时改的就是这一处。 */
const APP_VERSION = version;

/** 产品名、版本，和第三方依赖清单（含随仓库附带的 MIT 许可）。 */
export function AboutPage() {
  const { productName, companyName } = appConfig.brand;
  return (
    <PageShell
      title="关于"
      description={`${productName} ${APP_VERSION}${companyName ? ` · © 2026 ${companyName}` : ""}`}
    >
      <section className="flex flex-col gap-3">
        <h2 className="font-medium text-sm">开源软件声明</h2>
        <p className="text-muted-foreground text-sm">
          本产品使用了以下开源软件。
        </p>
      </section>
      <ThirdPartyNotices />
    </PageShell>
  );
}

const loadGenerated = async () =>
  (await import("@/lib/generated/third-party-notices.json"))
    .default as Notice[];

/** `load` 可替换，只为让测试模拟清单加载失败。 */
export function ThirdPartyNotices({
  load = loadGenerated,
}: {
  load?: () => Promise<Notice[]>;
}) {
  // 1.8 MB 的许可全文只在打开本页时才取，不进主包。
  const [notices, setNotices] = useState<Notice[]>([BUNDLED_NOTICE]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    load().then(
      (list) => {
        if (!live) return;
        setNotices([...list, BUNDLED_NOTICE].sort(byName));
        setLoaded(true);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [load]);

  const needle = deferred.trim().toLowerCase();
  const shown = notices.filter((notice) =>
    notice.name.toLowerCase().includes(needle),
  );

  return (
    <section className="flex flex-col gap-3">
      <h3 className="font-medium text-[13px]">第三方依赖</h3>
      {/* 随仓库附带的许可行不依赖生成清单，加载中或失败时也要能看到。 */}
      {failed ? (
        <p className="text-destructive text-sm">第三方依赖清单加载失败。</p>
      ) : loaded ? null : (
        <p className="text-muted-foreground text-sm">正在加载…</p>
      )}
      {
        <>
          <Input
            aria-label="按名称搜索"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="按名称搜索"
            type="search"
            value={query}
          />
          <ul className="flex flex-col divide-y divide-border rounded-[9px] border border-border">
            {shown.map((notice) => {
              const id = `${notice.name}@${notice.version}`;
              const expanded = open === id;
              return (
                <li key={id}>
                  <button
                    aria-expanded={expanded}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] hover:bg-foreground/[0.03]"
                    onClick={() => setOpen(expanded ? null : id)}
                    type="button"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {notice.name}
                    </span>
                    <span className="text-muted-foreground">
                      {notice.version}
                    </span>
                    <span className="text-muted-foreground">
                      {notice.license}
                    </span>
                  </button>
                  {expanded ? (
                    <pre className="whitespace-pre-wrap border-border border-t bg-card p-3 text-[12px] text-muted-foreground">
                      {notice.licenseText ?? "未附许可全文"}
                    </pre>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      }
    </section>
  );
}
