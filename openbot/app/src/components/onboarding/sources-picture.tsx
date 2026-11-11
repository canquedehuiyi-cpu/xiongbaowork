import {
  IconFolder,
  IconFileText,
  IconPlugConnected,
} from "@tabler/icons-react";
import { BearMascot } from "@/components/layout/workbench-empty";
import { IllustrationFrame } from "./illustration-frame";

const KINDS = [
  { icon: IconFileText, title: "文字声明", note: "资料放在哪里、是什么" },
  { icon: IconFolder, title: "本地文件夹", note: "只读，交给分身查看" },
  {
    icon: IconPlugConnected,
    title: "知识库与连接器",
    note: "你自己的知识库和账号",
  },
] as const;

/**
 * The picture beside the 分身's sources step: 熊宝 over the three kinds of source the form on the
 * left registers. A picture only — inert and labelled as a whole — so the step's real controls stay
 * the only ones on the page.
 */
export function SourcesPicture() {
  return (
    // Desktop only: on a phone the form is already long, and a picture under it is only more scroll.
    <div className="hidden w-full min-w-0 justify-center lg:flex">
      <IllustrationFrame
        className="flex flex-col items-center gap-5 p-6"
        label="分身回答与你有关的问题时，会参考你登记的文字说明、本地文件夹、知识库和连接器"
      >
        <BearMascot mood="cute" size={72} />
        <ul className="flex w-full flex-col gap-2">
          {KINDS.map(({ icon: Icon, title, note }) => (
            <li
              className="flex min-w-0 items-center gap-3 rounded-[14px] bg-background p-3 ring-1 ring-border"
              key={title}
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-accent text-foreground">
                <Icon aria-hidden className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block truncate font-medium text-sm">
                  {title}
                </span>
                <span className="block truncate text-muted-foreground text-xs">
                  {note}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </IllustrationFrame>
    </div>
  );
}
