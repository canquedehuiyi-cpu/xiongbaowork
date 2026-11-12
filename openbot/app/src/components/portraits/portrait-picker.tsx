import { IconPencil, IconPhotoUp, IconRefresh } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, useRef, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AVATAR_MOTION_LABELS,
  type AvatarMotionState,
} from "@/components/portraits/preset-animations";
import { shortName } from "@/lib/brand";
import {
  BAO_ROLE_GROUPS,
  BAO_ROLE_PRESETS,
  blobToBase64,
  PORTRAIT_PRESETS,
  PORTRAIT_VIDEO_MAX_BYTES,
  type PortraitKind,
  portraitIndex,
  portraitsQueryOptions,
  resetPortraitMutationOptions,
  setPortraitMutationOptions,
} from "@/lib/portraits/queries";
import { PORTRAIT_ACCEPT, squarePortrait } from "@/lib/portraits/resize";
import { cn } from "@/lib/utils";
import { PRESET_IMAGES } from "./preset-images";

/** A video's length in seconds, or null when the browser cannot read it. */
function videoDuration(file: Blob): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(video.duration) ? video.duration : null);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    video.src = url;
  });
}

/** A video avatar is a short loop: at most this many seconds. */
const PORTRAIT_VIDEO_MAX_SECONDS = 6;

const KIND_LABEL: Record<PortraitKind, string> = {
  coworker: "员工",
  group: "群组",
};

/**
 * Choosing a 头像 for a coworker or a group: one of 熊宝's five expressions, a picture of one's own,
 * or back to the drawing its seed makes. Every choice is saved the moment it is made, so the dialog
 * has no save button to forget; the face at the top is the saved one, read back from the server.
 */
export function PortraitPicker({
  kind,
  id,
  name,
  seed,
  open,
  onOpenChange,
}: {
  kind: PortraitKind;
  id: string;
  name: string;
  seed: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const portraits = useQuery(portraitsQueryOptions());
  const current = portraitIndex(portraits.data).get(`${kind}:${id}`);
  const save = useMutation(setPortraitMutationOptions(queryClient));
  const reset = useMutation(resetPortraitMutationOptions(queryClient));
  const [problem, setProblem] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  /** The motion state the preview face is playing, or null for the still. */
  const [previewMotion, setPreviewMotion] =
    useState<AvatarMotionState | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = save.isPending || reset.isPending || preparing;

  const fail = (thrown: unknown) =>
    setProblem(thrown instanceof Error ? thrown.message : "头像没有保存成功。");

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setProblem(null);
    if (file.type.startsWith("video/")) {
      // A video is sent as it was picked: the browser does not re-encode video, and the
      // server caps it at 2 MiB. Its length is checked here; the server cannot read it.
      if (file.size > PORTRAIT_VIDEO_MAX_BYTES) {
        setProblem("这段视频太大了，请换一段 2 MB 以内的 MP4 或 WebM 视频。");
        return;
      }
      setPreparing(true);
      const duration = await videoDuration(file);
      if (duration === null) {
        setPreparing(false);
        setProblem("这段视频无法读取，请换一段 MP4 或 WebM 视频。");
        return;
      }
      if (duration > PORTRAIT_VIDEO_MAX_SECONDS) {
        setPreparing(false);
        setProblem("这段视频太长了，请换一段 6 秒以内的 MP4 或 WebM 视频。");
        return;
      }
      try {
        const video = await blobToBase64(file);
        setPreparing(false);
        save.mutate({ kind, id, choice: { video } }, { onError: fail });
      } catch {
        setPreparing(false);
        setProblem("这段视频无法读取，请换一段 MP4 或 WebM 视频。");
      }
      return;
    }
    setPreparing(true);
    let image: string;
    try {
      image = await blobToBase64(await squarePortrait(file));
    } catch {
      setPreparing(false);
      setProblem("这张图片无法读取，请换一张 PNG、JPEG、WebP 或 GIF 图片。");
      return;
    }
    setPreparing(false);
    save.mutate({ kind, id, choice: { image } }, { onError: fail });
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) setProblem(null);
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>更换头像</DialogTitle>
          <DialogDescription>
            为{KIND_LABEL[kind]}「{name}
            」选一个{shortName()}
            表情或角色形象，或上传一张自己的图片、一段 6 秒以内的短视频。工作区里的每个人都会看到这个头像。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-4">
          <AbstractAvatar
            decorative
            motion={previewMotion ?? undefined}
            name={name}
            portrait={{ kind, id }}
            seed={seed}
            size={88}
          />
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <span>预览动态</span>
            {(["idle", "working"] as const).map((state) => (
              <button
                aria-pressed={previewMotion === state}
                className={cn(
                  "rounded-full px-2.5 py-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50",
                  previewMotion === state
                    ? "bg-accent text-foreground ring-1 ring-signal"
                    : "hover:bg-foreground/5 hover:text-foreground",
                )}
                disabled={busy}
                key={state}
                onClick={() =>
                  setPreviewMotion(previewMotion === state ? null : state)
                }
                type="button"
              >
                {AVATAR_MOTION_LABELS[state]}
              </button>
            ))}
          </div>
          <fieldset className="w-full">
            <legend className="mb-2 text-[12px] text-muted-foreground">
              {shortName()}表情
            </legend>
            <div className="grid grid-cols-5 gap-2">
              {PORTRAIT_PRESETS.map((preset) => {
                const selected = current?.preset === preset.value;
                return (
                  <button
                    aria-pressed={selected}
                    className={cn(
                      "flex flex-col items-center gap-1 rounded-[12px] p-1.5 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50",
                      selected
                        ? "bg-accent text-foreground ring-1 ring-signal"
                        : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                    )}
                    disabled={busy}
                    key={preset.value}
                    onClick={() => {
                      setProblem(null);
                      save.mutate(
                        { kind, id, choice: { preset: preset.value } },
                        { onError: fail },
                      );
                    }}
                    type="button"
                  >
                    <img
                      alt=""
                      className="size-[48px] rounded-full"
                      height={48}
                      src={PRESET_IMAGES[preset.value]}
                      width={48}
                    />
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <fieldset className="w-full">
            <legend className="mb-2 text-[12px] text-muted-foreground">
              角色形象
            </legend>
            {BAO_ROLE_GROUPS.map((group) => (
              <div className="mb-3" key={group}>
                <p className="mb-1 text-[12px] font-medium text-foreground">
                  {group}
                </p>
                <div className="grid grid-cols-5 gap-2">
                  {BAO_ROLE_PRESETS.filter((role) => role.group === group).map(
                    (role) => {
                      const selected = current?.preset === role.value;
                      return (
                        <button
                          aria-pressed={selected}
                          className={cn(
                            "flex flex-col items-center gap-1 rounded-[12px] p-1.5 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50",
                            selected
                              ? "bg-accent text-foreground ring-1 ring-signal"
                              : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                          )}
                          disabled={busy}
                          key={role.value}
                          onClick={() => {
                            setProblem(null);
                            save.mutate(
                              { kind, id, choice: { preset: role.value } },
                              { onError: fail },
                            );
                          }}
                          type="button"
                        >
                          <img
                            alt=""
                            className="size-[48px] rounded-full"
                            height={48}
                            src={PRESET_IMAGES[role.value]}
                            width={48}
                          />
                          {role.label}
                          <span className="text-[11px] text-muted-foreground">
                            {role.subtitle}
                          </span>
                        </button>
                      );
                    },
                  )}
                </div>
              </div>
            ))}
          </fieldset>
          <input
            accept={PORTRAIT_ACCEPT}
            aria-label="选择头像图片"
            className="sr-only"
            onChange={upload}
            ref={fileInput}
            tabIndex={-1}
            type="file"
          />
          {problem ? (
            <p className="text-destructive text-sm" role="alert">
              {problem}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            disabled={busy || !current}
            onClick={() => {
              setProblem(null);
              reset.mutate({ kind, id }, { onError: fail });
            }}
            type="button"
            variant="ghost"
          >
            <IconRefresh />
            恢复默认
          </Button>
          <Button
            disabled={busy}
            onClick={() => fileInput.current?.click()}
            type="button"
          >
            <IconPhotoUp />
            {preparing || save.isPending ? "正在保存…" : "上传图片/视频"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A face that opens the picker: the coworker's or group's avatar with a small pencil badge, for the
 * places that show one entity at a time (a detail header, a group card).
 */
export function EditablePortrait({
  kind,
  id,
  name,
  seed,
  size,
  className,
  motion,
}: {
  kind: PortraitKind;
  id: string;
  name: string;
  seed: string;
  size: number;
  className?: string;
  /**
   * The motion state the face plays — a detail header passes one so an uploaded video plays;
   * lists leave it out and stay still.
   */
  motion?: AvatarMotionState;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        aria-label={`更换「${name}」的头像`}
        className={cn(
          "group/portrait relative inline-flex shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
          className,
        )}
        onClick={(event) => {
          // Cards that are links themselves must not navigate when the face is clicked.
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
        title="更换头像"
        type="button"
      >
        <AbstractAvatar
          decorative
          motion={motion}
          name={name}
          portrait={{ kind, id }}
          seed={seed}
          size={size}
        />
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -bottom-0.5 flex size-[18px] items-center justify-center rounded-full bg-signal text-signal-foreground opacity-0 shadow-sm ring-2 ring-background transition-opacity group-hover/portrait:opacity-100 group-focus-visible/portrait:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <IconPencil className="size-[11px]" />
        </span>
      </button>
      {open ? (
        <PortraitPicker
          id={id}
          kind={kind}
          name={name}
          onOpenChange={setOpen}
          open={open}
          seed={seed}
        />
      ) : null}
    </>
  );
}
