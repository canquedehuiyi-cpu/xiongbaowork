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
  blobToBase64,
  PORTRAIT_PRESETS,
  type PortraitKind,
  portraitIndex,
  portraitsQueryOptions,
  resetPortraitMutationOptions,
  setPortraitMutationOptions,
} from "@/lib/portraits/queries";
import { PORTRAIT_ACCEPT, squarePortrait } from "@/lib/portraits/resize";
import { cn } from "@/lib/utils";
import { PRESET_IMAGES } from "./preset-images";

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
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = save.isPending || reset.isPending || preparing;

  const fail = (thrown: unknown) =>
    setProblem(thrown instanceof Error ? thrown.message : "头像没有保存成功。");

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setProblem(null);
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
            」选一个熊宝表情，或上传一张自己的图片。工作区里的每个人都会看到这个头像。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-4">
          <AbstractAvatar
            decorative
            name={name}
            portrait={{ kind, id }}
            seed={seed}
            size={88}
          />
          <fieldset className="w-full">
            <legend className="mb-2 text-[12px] text-muted-foreground">
              熊宝表情
            </legend>
            <div className="grid grid-cols-5 gap-2">
              {PORTRAIT_PRESETS.map((preset) => {
                const selected = current?.preset === preset.value;
                return (
                  <button
                    aria-pressed={selected}
                    className={cn(
                      "flex flex-col items-center gap-1 rounded-lg p-1.5 text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50",
                      selected
                        ? "bg-accent text-foreground ring-1 ring-brand-gold"
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
            {preparing || save.isPending ? "正在保存…" : "上传图片"}
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
}: {
  kind: PortraitKind;
  id: string;
  name: string;
  seed: string;
  size: number;
  className?: string;
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
          name={name}
          portrait={{ kind, id }}
          seed={seed}
          size={size}
        />
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -bottom-0.5 flex size-[18px] items-center justify-center rounded-full bg-brand-gold text-brand-gold-foreground opacity-0 shadow-sm ring-2 ring-background transition-opacity group-hover/portrait:opacity-100 group-focus-visible/portrait:opacity-100 [@media(hover:none)]:opacity-100"
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
