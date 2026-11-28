import type { Message } from "@ag-ui/core";
import { IconDownload } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import type { TranscriptNote } from "@/components/channels/chat-transcript";
import {
  groupTurnArtifactEvents,
  mergedTurnArtifacts,
  type TrackedTurnArtifacts,
  type TurnArtifactGroup,
  turnArtifactEvents,
} from "@/lib/channels/turn-artifact-events";
import { client } from "@/lib/client";
import {
  artifactDownloadHref,
  artifactFolderOf,
  artifactHref,
  isWorkspaceScope,
  normalizedArtifactPath,
  writtenPathsInTurn,
} from "@/lib/computers/artifact";
import { callComputer } from "@/lib/computers/call";
import {
  type FilePreviewTarget,
  usePreviewTarget,
} from "@/lib/computers/preview";
import { previewKindOf } from "../../../../shared/preview-kind";

/*
 * 一轮里存下的文件，摆在对话末尾成一页清单。
 *
 * 员工保存文件的那一行写的是它存的路径，一轮存三四个就要划好几屏；人要的又往往不是「你存了没」，
 * 而是「把它给我」。这一页把本轮写成功的文件收在一起，每个都是一条下载链接，能预览的类型旁边还有
 * 「预览」（为什么有的作用域不给链接，见 `lib/computers/artifact.ts`）。
 *
 * 清单的来源是本轮的写入事件，不是工作区的目录：一个员工的工作区里有它历史上写过的所有东西，
 * 把那份列表说成「本轮产物」是假话。`POST /files/list` 只用来核文件还在不在、顺手报个大小——
 * 写完又被删掉的不列，目录没读完（`truncated`）时不据此说文件不在。
 */

/** 一轮最多列这么几个：写几十个文件的那是在同步目录，不是交付一件东西。 */
export const TURN_ARTIFACT_LIMIT = 8;

/** 最多点这么几个目录去核：更多的目录只按写入事件列，不报大小。 */
const LISTED_FOLDERS = 4;

/** 一个文件在清单上的一行。 */
type ArtifactRow = {
  path: string;
  /** 目录里读到的字节数；没核到（清单没读完、那个目录没去点）时没有。 */
  bytes?: number;
};

/** 点目录点出来的结果。 */
type Listed = {
  /**
   * 目录里确实有的文件，按工作区根算的相对路径，带上目录报的大小。
   *
   * 「在不在」看 `has`，值只用来写大小：目录有时报不出一个文件的大小，那样的文件也是在的。
   */
  present: Map<string, number | undefined>;
  /** 去过、且读完的目录：文件在这一批里没出现，就是真不在了。 */
  read: Set<string>;
  /** 有目录读到自己的上限就停了：这时「没出现」什么也不说明。 */
  truncated: boolean;
};

/**
 * 这台员工的文件工具是不是在它自己的工作区里干活，而且是服务器答过的「是」，不是我们猜的。
 *
 * 问的是 `GET /api/computers/:botId/local-tools` 的 `machine`，和存文件那一行（`copilot/computer-tools.tsx`
 * 的 `useLocalTools`）同一个问题、同一个查询键：一处给链接，另一处不会说这台机器不在工作区上——同一
 * 份答案在 react-query 的缓存里，不会多打一次。
 *
 * 没答、答不上（一个人的浏览器只答它自己那三条读）、答 `device`，都算「不知道」，这一页就不出：清单里
 * 每一行都是一条下载链接，链接点开 404 比不列这一页更糟——这一页刚说过「文件在这儿」。配对电脑的项目
 * 模式里文件写进的是项目根，下载路由只认工作区根（根透传另立 WP-0.5，需安全评审）。
 */
function useWorkspaceFiles(botId: string | undefined): boolean {
  const { data } = useQuery({
    queryKey: ["computers", "local-tools", botId ?? ""],
    queryFn: async () => {
      const response = await client(
        `/api/computers/${encodeURIComponent(botId ?? "")}/local-tools`,
        { fallback: "读不到这台电脑在哪里。" },
      );
      return (await response.json()) as { machine?: string };
    },
    enabled: botId !== undefined && botId.trim() !== "",
    staleTime: 60_000,
  });
  return isWorkspaceScope(data?.machine);
}

/** 去点本轮写过的目录，看那些文件还在不在。 */
async function listWrittenFolders(
  botId: string,
  paths: readonly string[],
): Promise<Listed> {
  const folders = [...new Set(paths.map(artifactFolderOf))].slice(
    0,
    LISTED_FOLDERS,
  );
  const present = new Map<string, number | undefined>();
  const read = new Set<string>();
  let truncated = false;
  for (const folder of folders) {
    const result = await callComputer(botId, "/files/list", {
      method: "POST",
      body: { path: folder },
    });
    // 读不到这个目录（没有、太远、被拦）什么也不说明：只算没去过，不据此删掉一行。
    if (result.ok !== true) continue;
    read.add(folder);
    if (result.truncated === true) truncated = true;
    for (const entry of Array.isArray(result.entries) ? result.entries : []) {
      const shape = entry as {
        path?: unknown;
        kind?: unknown;
        bytes?: unknown;
      };
      if (shape?.kind !== "file" || typeof shape.path !== "string") continue;
      const path = normalizedArtifactPath(shape.path);
      if (path === undefined) continue;
      present.set(
        path,
        typeof shape.bytes === "number" && Number.isFinite(shape.bytes)
          ? shape.bytes
          : undefined,
      );
    }
  }
  return { present, read, truncated };
}

/** 这一轮的清单：写入成功、且没被目录证明确实不在了的文件。 */
function rowsOf(
  paths: readonly string[],
  listed: Listed | undefined,
): ArtifactRow[] {
  if (!listed) return [];
  const rows: ArtifactRow[] = [];
  for (const path of paths) {
    const here = listed.present.has(path);
    // 去过这个目录、读完了、里面没有它：它被删了，或者从来就不在工作区里。
    if (!here && listed.read.has(artifactFolderOf(path)) && !listed.truncated)
      continue;
    const bytes = listed.present.get(path);
    rows.push({ path, ...(here && bytes !== undefined ? { bytes } : {}) });
  }
  return rows;
}

function TurnArtifacts({
  botId,
  paths,
}: {
  botId: string;
  paths: readonly string[];
}) {
  const workspace = useWorkspaceFiles(botId);
  const shown = paths.slice(0, TURN_ARTIFACT_LIMIT);
  const listed = useQuery({
    queryKey: ["computer-artifacts", botId, shown.join("\n")],
    queryFn: () => listWrittenFolders(botId, shown),
    enabled: workspace && shown.length > 0,
    staleTime: 15_000,
    retry: 0,
  });
  // 配对电脑的项目模式：链接点不开，这一页就不出现（那一行也一样没有链接，两边一个口径）。
  if (!workspace) return null;
  const rows = rowsOf(shown, listed.data);
  if (rows.length === 0) return null;
  return (
    <div
      className="flex min-w-0 max-w-full flex-col gap-1 text-sm text-muted-foreground"
      data-artifact-list=""
    >
      {/* 和它上面那些执行行同一副外壳：一行一件事，图标在前，状态不只写在颜色里。 */}
      <div className="inline-flex min-w-0 max-w-full items-center gap-[7px] rounded-[10px] border border-border bg-card px-[10px] py-[5px]">
        <span className="shrink-0 self-center">
          <IconDownload
            aria-hidden
            className="size-[14px] shrink-0 text-faint"
          />
        </span>
        <span className="shrink-0 whitespace-nowrap">本轮产物</span>
      </div>
      {rows.map((row) => {
        const href = artifactDownloadHref(botId, row.path);
        if (href === undefined) return null;
        return (
          <div
            key={row.path}
            className="inline-flex min-w-0 max-w-full items-baseline gap-1.5 self-start rounded-[10px] border border-border bg-card px-[10px] py-[5px]"
          >
            {/* 路径标在链接本身：老清单里「这一行」就是这条下载链接，端到端测试按它取 href。 */}
            <a
              className="inline-flex min-w-0 max-w-full items-baseline gap-1.5 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              data-artifact-path={row.path}
              // 空值：文件名由路由的 Content-Disposition 定（安全决策 A4——回来的是附件，不是这个源上的
              // 一页）。写成 `download` 在 JSX 里等于 true，存下来会变成一个叫 true 的文件。
              download=""
              href={href}
              rel="noopener"
            >
              <span className="min-w-0 truncate">{row.path}</span>
              {row.bytes === undefined ? null : (
                <span className="shrink-0 opacity-70">
                  {formatBytes(row.bytes)}
                </span>
              )}
            </a>
            {/*
             * 和事件版同一个按钮、同一个面板。不带范围：和这一行的下载一样，按看的人自己的那台电脑取
             * （老清单只在单聊出现，看的人就是这段对话的主人），不比下载放得更宽。
             */}
            <PreviewButton target={{ botId, path: row.path }} />
          </div>
        );
      })}
      {listed.data?.truncated === true ? (
        // 目录到自己定的上限就停了，本轮写过的文件可能就在没读到的那一段里：说出来，
        // 别让一份短的清单被当成一份全的。
        <span className="opacity-70" data-artifact-truncated="">
          工作区里的文件太多，这份清单可能没列全。
        </span>
      ) : null}
      {paths.length > shown.length ? (
        <span className="opacity-70">
          这一轮还存了 {paths.length - shown.length} 个文件，没在这里列出。
        </span>
      ) : null}
    </div>
  );
}

/** 清单里每个文件的一行：按内容宽度的卡片（单聊、群聊同一副，`self-start` 防止在纵向 flex 里被拉满整宽）。 */
const ROW =
  "inline-flex min-w-0 max-w-full items-baseline gap-1.5 self-start rounded-[10px] border border-border bg-card px-[10px] py-[5px]";

/** 「下载」链接的样式：本轮产物清单、交付卡、任务页的证据行共用同一组。 */
export const ARTIFACT_DOWNLOAD_LINK =
  "shrink-0 underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60";

/**
 * 「预览」按钮，和「下载」并排、同一个链接样式：点开右侧的预览面板。
 *
 * 只给有预览可看的类型（svg 之类只能下载的不给）；页面没有面板可开时也不画。
 */
export function PreviewButton({ target }: { target: FilePreviewTarget }) {
  const preview = usePreviewTarget();
  if (preview === undefined || previewKindOf(target.path) === "none")
    return null;
  return (
    <button
      aria-label={`预览 ${target.path}`}
      className={ARTIFACT_DOWNLOAD_LINK}
      onClick={() => preview.open(target)}
      type="button"
    >
      预览
    </button>
  );
}

/**
 * 有事件时的清单：一位员工一组，每个文件一行（文件名、大小、「下载」）。
 *
 * 链接带上这个对话和列出这个文件的那条事件所在的 run：服务器只放行「在哪里被宣布」的文件，同一轮被切成
 * 多次 run 时，各行的 run 不同。不依赖这台电脑在不在工作区上：事件是服务器在能取到文件的电脑上记的。
 */
export function EventArtifacts({
  groups,
  channelId,
  nameOf,
  primaryBotId,
}: {
  groups: readonly TurnArtifactGroup[];
  channelId: string;
  nameOf?: ((botId: string) => string | undefined) | undefined;
  primaryBotId?: string | undefined;
}) {
  return (
    <div
      className="flex min-w-0 max-w-full flex-col gap-2 text-sm text-muted-foreground"
      data-artifact-list=""
    >
      <div className="inline-flex min-w-0 max-w-full items-center gap-[7px] self-start rounded-[10px] border border-border bg-card px-[10px] py-[5px]">
        <span className="shrink-0 self-center">
          <IconDownload
            aria-hidden
            className="size-[14px] shrink-0 text-faint"
          />
        </span>
        <span className="shrink-0 whitespace-nowrap">本轮产物</span>
      </div>
      {groups.map((group) => {
        // 不止一位员工，或不是这段对话自己的员工做的：写上是谁的。
        const named =
          groups.length > 1 || group.botId !== primaryBotId
            ? (nameOf?.(group.botId) ?? "员工")
            : null;
        return (
          <div
            className="flex min-w-0 max-w-full flex-col gap-1"
            data-artifact-group={group.botId}
            key={group.botId}
          >
            {named === null ? null : (
              <span className="opacity-70">{named}</span>
            )}
            {group.files.map((file) => {
              const href = artifactHref({
                botId: group.botId,
                path: file.path,
                scope: { channel: channelId, run: file.runId },
              });
              return (
                <div
                  className={ROW}
                  data-artifact-path={file.path}
                  key={file.path}
                >
                  <span className="min-w-0 truncate">{file.path}</span>
                  <span className="shrink-0 opacity-70">
                    {formatBytes(file.bytes)}
                  </span>
                  {href === undefined ? null : (
                    <PreviewButton
                      target={{
                        botId: group.botId,
                        path: file.path,
                        scope: { channel: channelId, run: file.runId },
                      }}
                    />
                  )}
                  {href === undefined ? null : (
                    <a
                      aria-label={`下载 ${file.path}`}
                      className={ARTIFACT_DOWNLOAD_LINK}
                      // 空值：文件名由路由的 Content-Disposition 定，见下面老清单同一处的说明。
                      download=""
                      href={href}
                      rel="noopener"
                    >
                      下载
                    </a>
                  )}
                </div>
              );
            })}
            {group.omitted > 0 ? (
              <span className="opacity-70">
                这一轮还有 {group.omitted} 项没列出
              </span>
            ) : null}
            {group.scanTruncated ? (
              <span className="opacity-70" data-artifact-truncated="">
                工作区文件太多，这份清单可能没列全
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 本轮产物清单，作为一条附注交进转录（和交付卡、外部员工的卡走同一套 `TranscriptNote`）。
 *
 * 挂在最后一行下面（`anchor: null`）：它说的是「刚做出来的东西」，跟着对话的末尾走，不跟着某一条
 * 消息走。这一轮没有写成功的文件时什么都不交，转录上也就不多空一格。
 */
export function turnArtifactNotes({
  messages,
  botId,
  events = [],
  channelId,
  nameOf,
}: {
  messages: ReadonlyArray<Readonly<Message>>;
  botId: string | undefined;
  /** 代理事件流里记下的本轮产物事件（`createTurnArtifactTracker`）。 */
  events?: readonly TrackedTurnArtifacts[];
  /** 这段对话的频道 id：下载链接带它，服务器据此查谁能看这段对话。 */
  channelId: string;
  nameOf?: (botId: string) => string | undefined;
}): TranscriptNote[] {
  // 有事件就按事件画；一份清单也没有（事件里一个文件都没有）时同样退回老办法。
  const groups = mergedTurnArtifacts(
    turnArtifactEvents(events, messages),
  ).filter((group) => group.files.length > 0);
  if (groups.length > 0)
    return [
      {
        key: "turn-artifacts",
        anchor: null,
        node: (
          <EventArtifacts
            channelId={channelId}
            groups={groups}
            nameOf={nameOf}
            primaryBotId={botId}
          />
        ),
      },
    ];
  if (botId === undefined || botId.trim() === "") return [];
  const paths = writtenPathsInTurn(messages);
  if (paths.length === 0) return [];
  return [
    {
      key: "turn-artifacts",
      anchor: null,
      node: <TurnArtifacts botId={botId} paths={paths} />,
    },
  ];
}

/**
 * 群聊末尾的「本轮产物」：员工回复行里记的事件（`groupTurnArtifactEvents`），频道是群的频道，
 * 链接各带自己那条事件的 run，每位员工一组、写上名字。这一轮没有产物什么都不画。
 */
export function GroupTurnArtifacts({
  messages,
  channelId,
  nameOf,
}: {
  messages: Parameters<typeof groupTurnArtifactEvents>[0];
  channelId: string;
  nameOf: (botId: string) => string | undefined;
}) {
  const groups = mergedTurnArtifacts(groupTurnArtifactEvents(messages)).filter(
    (group) => group.files.length > 0,
  );
  if (groups.length === 0) return null;
  return (
    <EventArtifacts channelId={channelId} groups={groups} nameOf={nameOf} />
  );
}

/** "1.2 GB", "340 MB": decimal units. */
function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
