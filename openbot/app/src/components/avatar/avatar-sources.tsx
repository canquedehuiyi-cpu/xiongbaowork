import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AVATAR_SOURCE_LABEL_LIMIT,
  AVATAR_SOURCE_LIMIT,
  AVATAR_SOURCE_NOTE_LIMIT,
  type AvatarSource,
  type AvatarSourceInput,
  addAvatarSourceMutationOptions,
  avatarConnectorsQueryOptions,
  avatarSourcesQueryOptions,
  removeAvatarSourceMutationOptions,
  sourceLength,
} from "@/lib/avatar/sources";
import {
  devicesQueryOptions,
  type RegisteredDevice,
} from "@/lib/devices/queries";
import { knowledgeNotebooksQueryOptions } from "@/lib/knowledge/queries";
import { advanceOnboardingMutationOptions } from "@/lib/onboarding/mutations";

/**
 * Where a person tells their 分身 where their material lives (story F1, stages 1 and 2).
 *
 * Two places, one vocabulary: the onboarding step right after the welcome, and the 分身's own detail
 * page, where a person who skipped the step configures it later (spec D3). Two kinds of source:
 *
 * - 文字声明: a name and a note in the person's own words. Nothing is read, uploaded or linked, and
 *   the page says so, because "信息来源" otherwise reads like a folder picker.
 * - 本地文件夹 (stage 2): one of the read-only folders the person's own machine offers, chosen from
 *   what their online devices report. The folder was added on the machine, in the device app or
 *   with the runner's `--add-root`; here it is only picked, by name. With no paired machine the
 *   option says how to pair one and the other kind can still be saved (D4).
 *
 * - 知识库 (stage 3, S3): one of the person's own notebooks on the 知识库 screen. Saving it lets the
 *   分身 search that notebook, and only the notebooks picked here.
 * - 连接器 (stage 3, S4): one of the accounts the person connected under 「设置 › 已连接的账号」. Saving
 *   it gives the 分身 that connector's read tools in the person's own account, under the same approval
 *   rules as any tool. One the administrator has not listed for people says so and cannot be picked.
 *
 * Each kind says what reaches the model and is agreed to with one tick (D6) before it can be saved:
 * a declaration's name and note go into every prompt, a folder's files and a notebook's passages go
 * to the model when the 分身 reads them, and so does what a connector fetches.
 */

type SourceKind = "declaration" | "local_folder" | "notebook" | "connector";

/** One folder a machine offers, with the machine it is on. */
type OfferedFolder = {
  deviceId: string;
  deviceName: string;
  ref: string;
  name: string;
};

/** The folders the person's online machines offer, in the order the device list gives them. */
function offeredFolders(devices: RegisteredDevice[]): OfferedFolder[] {
  return devices
    .filter((device) => device.online)
    .flatMap((device) =>
      (device.roots ?? []).map((root) => ({
        deviceId: device.deviceId,
        deviceName: device.name,
        ref: root.ref,
        name: root.name,
      })),
    );
}

/** A draft as the person typed it, and whether it can be saved as it stands. */
function draftProblem(label: string, note: string): string | null {
  if (label.trim().length === 0) return "请给这个信息来源起个名字。";
  if (sourceLength(label.trim()) > AVATAR_SOURCE_LABEL_LIMIT)
    return `名称最多 ${AVATAR_SOURCE_LABEL_LIMIT} 个字。`;
  if (sourceLength(note.trim()) > AVATAR_SOURCE_NOTE_LIMIT)
    return `说明最多 ${AVATAR_SOURCE_NOTE_LIMIT} 个字。`;
  return null;
}

function ModelNotice({
  checked,
  id,
  onChange,
}: {
  checked: boolean;
  id: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-[12px] border border-border p-[12px] text-sm">
      <p className="text-muted-foreground">
        分身每次回答时，会把这些信息来源的名称和说明一起发送给你所用的模型服务。这里只登记文字说明，不会读取或上传任何文件。
      </p>
      <label className="flex items-center gap-2" htmlFor={id}>
        <Checkbox
          checked={checked}
          id={id}
          onCheckedChange={(next) => onChange(next === true)}
        />
        我已了解，信息来源的说明会发送给模型服务
      </label>
    </div>
  );
}

function DraftFields({
  idPrefix,
  label,
  note,
  onLabel,
  onNote,
}: {
  idPrefix: string;
  label: string;
  note: string;
  onLabel: (value: string) => void;
  onNote: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor={`${idPrefix}-label`}>名称</label>
        <Input
          id={`${idPrefix}-label`}
          onChange={(event) => onLabel(event.target.value)}
          placeholder="例如：周报"
          value={label}
        />
        <span className="text-muted-foreground text-xs">
          {sourceLength(label.trim())}/{AVATAR_SOURCE_LABEL_LIMIT}
        </span>
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor={`${idPrefix}-note`}>说明（可选）</label>
        <Textarea
          id={`${idPrefix}-note`}
          onChange={(event) => onNote(event.target.value)}
          placeholder="例如：在飞书 / 工作 / 周报，每周五更新"
          value={note}
        />
        <span className="text-muted-foreground text-xs">
          {sourceLength(note.trim())}/{AVATAR_SOURCE_NOTE_LIMIT}
        </span>
      </div>
    </div>
  );
}

/** Where a saved folder is, in words: its machine, and whether the machine still offers it. */
function folderWhere(
  source: Extract<AvatarSource, { kind: "local_folder" }>,
  devices: RegisteredDevice[] | undefined,
): string {
  if (!devices) return "本地文件夹";
  const device = devices.find((entry) => entry.deviceId === source.deviceId);
  if (!device) return "本地文件夹 · 设备已移除";
  if (!(device.roots ?? []).some((root) => root.ref === source.rootRef))
    return `本地文件夹 · ${device.name} · 设备上已不再提供这个文件夹`;
  return `本地文件夹 · ${device.name}${device.online ? "" : " · 离线"}`;
}

function SavedSources({
  onRemove,
  removingId,
  sources,
}: {
  onRemove: (id: string) => void;
  removingId: string | null;
  sources: AvatarSource[];
}) {
  // The machines, only when a folder is on the list: a list of declarations asks nothing more.
  const hasFolder = sources.some((source) => source.kind === "local_folder");
  const devices = useQuery({ ...devicesQueryOptions(), enabled: hasFolder });
  if (sources.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">还没有登记信息来源。</p>
    );
  }
  return (
    <ul
      aria-label="已登记的信息来源"
      className="flex flex-col divide-y divide-border overflow-hidden rounded-[12px] border border-border bg-background/40"
    >
      {sources.map((source) => (
        <li
          className="flex items-start justify-between gap-3 px-[12px] py-[10px]"
          key={source.id}
        >
          <div className="flex min-w-0 flex-col">
            <span className="font-medium text-sm">{source.label}</span>
            {source.kind === "local_folder" ? (
              <span className="text-muted-foreground text-xs">
                {folderWhere(source, devices.data)}
              </span>
            ) : null}
            {source.kind === "notebook" ? (
              <span className="text-muted-foreground text-xs">
                知识库 · {source.title}
              </span>
            ) : null}
            {source.kind === "connector" ? (
              <span className="text-muted-foreground text-xs">
                连接器 · {source.title}
              </span>
            ) : null}
            {source.note ? (
              <span className="text-muted-foreground text-xs">
                {source.note}
              </span>
            ) : null}
          </div>
          <Button
            aria-label={`删除 ${source.label}`}
            disabled={removingId === source.id}
            onClick={() => onRemove(source.id)}
            size="sm"
            variant="ghost"
          >
            {removingId === source.id ? "正在删除…" : "删除"}
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** The shared state of both places: the saved list, the draft, the tick, and the two writes. */
function useSourceEditor() {
  const queryClient = useQueryClient();
  const state = useQuery(avatarSourcesQueryOptions());
  const add = useMutation(addAvatarSourceMutationOptions(queryClient));
  const remove = useMutation(removeAvatarSourceMutationOptions(queryClient));
  const [kind, setKind] = React.useState<SourceKind>("declaration");
  const [label, setLabel] = React.useState("");
  const [note, setNote] = React.useState("");
  const [consent, setConsent] = React.useState(false);
  // The folder draft, kept apart so switching back and forth loses neither.
  const [folder, setFolder] = React.useState<OfferedFolder | null>(null);
  const [folderLabel, setFolderLabel] = React.useState("");
  const [folderNote, setFolderNote] = React.useState("");
  const [folderConsent, setFolderConsent] = React.useState(false);
  // A notebook or a connector draft: which one, an optional note, and its own tick.
  const [picked, setPicked] = React.useState<{
    notebook: string | null;
    connector: string | null;
  }>({ notebook: null, connector: null });
  const [pickedNote, setPickedNote] = React.useState("");
  const [pickedConsent, setPickedConsent] = React.useState({
    notebook: false,
    connector: false,
  });

  const sources = state.data?.sources ?? [];
  const full = sources.length >= AVATAR_SOURCE_LIMIT;
  const asFolder = kind === "local_folder";
  const asPicked = kind === "notebook" || kind === "connector";
  const drafted = asFolder
    ? folder !== null
    : asPicked
      ? picked[kind] !== null
      : label.trim().length > 0 || note.trim().length > 0;
  const problem = asFolder
    ? folderProblem(folderLabel, folderNote)
    : asPicked
      ? folderProblem("", pickedNote)
      : draftProblem(label, note);
  const agreed = asFolder
    ? folderConsent
    : asPicked
      ? pickedConsent[kind]
      : consent;

  /** Save the draft, then clear it. Resolves false when it was refused, so a caller can stop. */
  const saveDraft = async () => {
    let input: AvatarSourceInput | null;
    if (asFolder) {
      input = folder && {
        kind: "local_folder",
        deviceId: folder.deviceId,
        rootRef: folder.ref,
        label: folderLabel.trim(),
        note: folderNote.trim(),
      };
    } else if (kind === "notebook") {
      input = picked.notebook
        ? {
            kind: "notebook",
            notebookId: picked.notebook,
            label: "",
            note: pickedNote.trim(),
          }
        : null;
    } else if (kind === "connector") {
      input = picked.connector
        ? {
            kind: "connector",
            serverId: picked.connector,
            label: "",
            note: pickedNote.trim(),
          }
        : null;
    } else {
      input = { label: label.trim(), note: note.trim() };
    }
    if (!input) return false;
    try {
      await add.mutateAsync(input);
    } catch {
      return false;
    }
    if (asFolder) {
      setFolder(null);
      setFolderLabel("");
      setFolderNote("");
    } else if (asPicked) {
      setPicked((current) => ({ ...current, [kind]: null }));
      setPickedNote("");
    } else {
      setLabel("");
      setNote("");
    }
    return true;
  };

  return {
    add,
    agreed,
    consent,
    drafted,
    folder,
    folderConsent,
    folderLabel,
    folderNote,
    full,
    kind,
    label,
    note,
    picked,
    pickedConsent,
    pickedNote,
    problem,
    remove,
    saveDraft,
    setConsent,
    setFolder,
    setFolderConsent,
    setFolderLabel,
    setFolderNote,
    setKind,
    setLabel,
    setNote,
    setPicked,
    setPickedConsent,
    setPickedNote,
    sources,
    state,
  };
}

type SourceEditor = ReturnType<typeof useSourceEditor>;

/** A folder draft's name may be empty (the machine's name for it is used); a note is optional. */
function folderProblem(label: string, note: string): string | null {
  if (sourceLength(label.trim()) > AVATAR_SOURCE_LABEL_LIMIT)
    return `名称最多 ${AVATAR_SOURCE_LABEL_LIMIT} 个字。`;
  if (sourceLength(note.trim()) > AVATAR_SOURCE_NOTE_LIMIT)
    return `说明最多 ${AVATAR_SOURCE_NOTE_LIMIT} 个字。`;
  return null;
}

/** Which kind of source the draft is. A declaration unless the person picks a folder. */
function KindSwitch({ editor }: { editor: SourceEditor }) {
  return (
    <fieldset aria-label="信息来源类型" className="flex flex-wrap gap-2">
      {(
        [
          ["declaration", "文字声明"],
          ["local_folder", "本地文件夹"],
          ["notebook", "知识库"],
          ["connector", "连接器"],
        ] as const
      ).map(([value, name]) => (
        <Button
          aria-pressed={editor.kind === value}
          key={value}
          onClick={() => editor.setKind(value)}
          size="sm"
          type="button"
          variant={editor.kind === value ? "default" : "outline"}
        >
          {name}
        </Button>
      ))}
    </fieldset>
  );
}

/**
 * Pick one of the folders the person's online machines offer, name it if they like, and agree that
 * what the 分身 reads in it goes to the model.
 *
 * No machine at all is the D4 case: how to pair one, and that the other kind can be saved meanwhile.
 * `pairingHref` is where My Devices is; during onboarding there is none to follow yet (the rest of
 * the app opens after it), so the step names the place instead of linking to it.
 */
function FolderPicker({
  editor,
  idPrefix,
  pairingHref,
}: {
  editor: SourceEditor;
  idPrefix: string;
  pairingHref?: string;
}) {
  const devices = useQuery(devicesQueryOptions());
  const taken = new Set(
    editor.sources.flatMap((source) =>
      source.kind === "local_folder" ? [source.rootRef] : [],
    ),
  );

  if (devices.isPending) {
    return <p className="text-muted-foreground text-sm">正在读取你的设备…</p>;
  }
  if (devices.isError) {
    return (
      <p className="text-muted-foreground text-sm">
        暂时读不到你的设备列表，请稍后再试。你可以先登记文字声明。
      </p>
    );
  }
  if (devices.data.length === 0) {
    return (
      <div className="flex flex-col gap-2 rounded-[12px] border border-border p-[12px] text-sm">
        <p className="font-medium">还没有配对的设备</p>
        <p className="text-muted-foreground">
          本地文件夹放在你自己的电脑上。先在电脑上安装熊宝数字员工设备端，并在「设置
          ›
          我的设备」里配对；然后在设备端添加要交给分身的文件夹，再回到这里选择。你可以先保存文字声明。
        </p>
        {pairingHref ? (
          <a className="text-primary underline" href={pairingHref}>
            前往「我的设备」配对电脑
          </a>
        ) : (
          <p className="text-muted-foreground">
            完成引导后，可以在分身详情页添加本地文件夹。
          </p>
        )}
      </div>
    );
  }
  const offered = offeredFolders(devices.data);
  if (offered.length === 0) {
    const online = devices.data.some((device) => device.online);
    return (
      <p className="text-muted-foreground text-sm">
        {online
          ? "你的设备还没有提供本地文件夹。请在设备端窗口的「本地文件夹」里添加一个，几秒后这里就会出现。"
          : "你的设备目前都不在线。打开电脑上的设备端后，这里会列出它提供的文件夹。"}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm">选择一个文件夹</legend>
        {offered.map((entry) => {
          const id = `${idPrefix}-folder-${entry.ref}`;
          const already = taken.has(entry.ref);
          return (
            <label
              className="flex items-center gap-2 rounded-[10px] border border-border bg-background/40 p-[8px] text-sm"
              htmlFor={id}
              key={`${entry.deviceId}/${entry.ref}`}
            >
              <input
                checked={editor.folder?.ref === entry.ref}
                disabled={already}
                id={id}
                name={`${idPrefix}-folder`}
                onChange={() => editor.setFolder(entry)}
                type="radio"
              />
              <span>
                {entry.name}
                <span className="text-muted-foreground">
                  {" "}
                  · {entry.deviceName}
                  {already ? " · 已登记" : ""}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor={`${idPrefix}-folder-label`}>名称（可选）</label>
        <Input
          id={`${idPrefix}-folder-label`}
          onChange={(event) => editor.setFolderLabel(event.target.value)}
          placeholder={editor.folder?.name ?? "留空则使用文件夹在设备上的名称"}
          value={editor.folderLabel}
        />
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor={`${idPrefix}-folder-note`}>文件夹说明（可选）</label>
        <Textarea
          id={`${idPrefix}-folder-note`}
          onChange={(event) => editor.setFolderNote(event.target.value)}
          placeholder="例如：季度报告和客户合同"
          value={editor.folderNote}
        />
      </div>
      <div className="flex flex-col gap-2 rounded-[12px] border border-border p-[12px] text-sm">
        <p className="text-muted-foreground">
          分身只能读取这个文件夹，不能修改、删除或在里面运行命令。它需要时会读取其中的文件，读到的内容会发送给你所用的模型服务；读取
          .env、密钥这类可能含有机密的文件前，会先征求你的同意。服务器只记录文件夹的名称，不记录它在电脑上的位置。
        </p>
        <label
          className="flex items-center gap-2"
          htmlFor={`${idPrefix}-folder-consent`}
        >
          <Checkbox
            checked={editor.folderConsent}
            id={`${idPrefix}-folder-consent`}
            onCheckedChange={(next) => editor.setFolderConsent(next === true)}
          />
          我已了解，分身读取的文件内容会发送给模型服务
        </label>
      </div>
    </div>
  );
}

/** A note for a notebook or connector, and the tick that agrees to what reaches the model (D6). */
function PickedFooter({
  consentLabel,
  editor,
  idPrefix,
  notice,
  which,
}: {
  consentLabel: string;
  editor: SourceEditor;
  idPrefix: string;
  notice: string;
  which: "notebook" | "connector";
}) {
  return (
    <>
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor={`${idPrefix}-${which}-note`}>说明（可选）</label>
        <Textarea
          id={`${idPrefix}-${which}-note`}
          onChange={(event) => editor.setPickedNote(event.target.value)}
          placeholder={
            which === "notebook"
              ? "例如：客户拜访纪要，每次拜访后更新"
              : "例如：合同和报价单都在这里"
          }
          value={editor.pickedNote}
        />
      </div>
      <div className="flex flex-col gap-2 rounded-[12px] border border-border p-[12px] text-sm">
        <p className="text-muted-foreground">{notice}</p>
        <label
          className="flex items-center gap-2"
          htmlFor={`${idPrefix}-${which}-consent`}
        >
          <Checkbox
            checked={editor.pickedConsent[which]}
            id={`${idPrefix}-${which}-consent`}
            onCheckedChange={(next) =>
              editor.setPickedConsent((current) => ({
                ...current,
                [which]: next === true,
              }))
            }
          />
          {consentLabel}
        </label>
      </div>
    </>
  );
}

/**
 * Pick one of the person's own notebooks on the 知识库 screen (S3). Only theirs are listed; one
 * already given to the 分身 is shown but cannot be picked again. With none yet, the step says where
 * to make one; `knowledgeHref` is a link to it outside onboarding.
 */
function NotebookPicker({
  editor,
  idPrefix,
  knowledgeHref,
}: {
  editor: SourceEditor;
  idPrefix: string;
  knowledgeHref?: string;
}) {
  const notebooks = useQuery(knowledgeNotebooksQueryOptions());
  const taken = new Set(
    editor.sources.flatMap((source) =>
      source.kind === "notebook" ? [source.notebookId] : [],
    ),
  );
  if (notebooks.isPending) {
    return <p className="text-muted-foreground text-sm">正在读取你的知识库…</p>;
  }
  if (notebooks.isError) {
    return (
      <p className="text-muted-foreground text-sm">
        暂时读不到你的知识库，请稍后再试。你可以先登记文字声明。
      </p>
    );
  }
  if (notebooks.data.length === 0) {
    return (
      <div className="flex flex-col gap-2 rounded-[12px] border border-border p-[12px] text-sm">
        <p className="font-medium">还没有知识库</p>
        <p className="text-muted-foreground">
          先在「知识库」里新建一个知识库，把资料粘贴进去，再回到这里交给分身。你可以先保存其他信息来源。
        </p>
        {knowledgeHref ? (
          <a className="text-primary underline" href={knowledgeHref}>
            前往「知识库」新建
          </a>
        ) : (
          <p className="text-muted-foreground">
            完成引导后，可以在分身详情页添加知识库。
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm">选择一个你的知识库</legend>
        {notebooks.data.map((notebook) => {
          const id = `${idPrefix}-notebook-${notebook.id}`;
          const already = taken.has(notebook.id);
          return (
            <label
              className="flex items-center gap-2 rounded-[10px] border border-border bg-background/40 p-[8px] text-sm"
              htmlFor={id}
              key={notebook.id}
            >
              <input
                checked={editor.picked.notebook === notebook.id}
                disabled={already}
                id={id}
                name={`${idPrefix}-notebook`}
                onChange={() =>
                  editor.setPicked((current) => ({
                    ...current,
                    notebook: notebook.id,
                  }))
                }
                type="radio"
              />
              <span>
                {notebook.title}
                {already ? (
                  <span className="text-muted-foreground"> · 已添加</span>
                ) : null}
              </span>
            </label>
          );
        })}
      </fieldset>
      <PickedFooter
        consentLabel="我已了解，分身搜索到的知识库内容会发送给模型服务"
        editor={editor}
        idPrefix={idPrefix}
        notice="分身只能搜索和阅读你在这里选的知识库，不能修改它们。它需要时会搜索其中的资料，搜到的片段会发送给你所用的模型服务。删除这个信息来源后，分身立即不能再读取。"
        which="notebook"
      />
    </div>
  );
}

/**
 * Pick one of the accounts the person connected themselves (S4). Each one the server says cannot be
 * given to the 分身 (not listed by the administrator, nothing to read with) shows its reason and
 * cannot be picked. With none, the step says where to connect one.
 */
function ConnectorPicker({
  accountsHref,
  editor,
  idPrefix,
}: {
  accountsHref?: string;
  editor: SourceEditor;
  idPrefix: string;
}) {
  const connectors = useQuery(avatarConnectorsQueryOptions());
  if (connectors.isPending) {
    return (
      <p className="text-muted-foreground text-sm">正在读取你已连接的账号…</p>
    );
  }
  if (connectors.isError) {
    return (
      <p className="text-muted-foreground text-sm">
        暂时读不到你已连接的账号，请稍后再试。你可以先登记文字声明。
      </p>
    );
  }
  if (connectors.data.length === 0) {
    return (
      <div className="flex flex-col gap-2 rounded-[12px] border border-border p-[12px] text-sm">
        <p className="font-medium">还没有已连接的账号</p>
        <p className="text-muted-foreground">
          连接器用你自己的账号读取资料，例如云盘。先在「设置 ›
          已连接的账号」里用自己的账号连接，再回到这里交给分身。你可以先保存其他信息来源。
        </p>
        {accountsHref ? (
          <a className="text-primary underline" href={accountsHref}>
            前往「已连接的账号」
          </a>
        ) : (
          <p className="text-muted-foreground">
            完成引导后，可以在分身详情页添加连接器。
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm">选择一个你已连接的账号</legend>
        {connectors.data.map((connector) => {
          const id = `${idPrefix}-connector-${connector.serverId}`;
          return (
            <label
              className="flex items-start gap-2 rounded-[10px] border border-border bg-background/40 p-[8px] text-sm"
              htmlFor={id}
              key={connector.serverId}
            >
              <input
                checked={editor.picked.connector === connector.serverId}
                disabled={!connector.attachable}
                id={id}
                name={`${idPrefix}-connector`}
                onChange={() =>
                  editor.setPicked((current) => ({
                    ...current,
                    connector: connector.serverId,
                  }))
                }
                type="radio"
              />
              <span className="flex flex-col">
                <span>
                  {connector.title}
                  {connector.attached ? (
                    <span className="text-muted-foreground"> · 已添加</span>
                  ) : null}
                </span>
                {connector.reason ? (
                  <span className="text-muted-foreground text-xs">
                    {connector.reason}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </fieldset>
      <PickedFooter
        consentLabel="我已了解，分身通过连接器读到的内容会发送给模型服务"
        editor={editor}
        idPrefix={idPrefix}
        notice="分身会用你自己的账号、只用这个连接器里读取资料的工具；它读到的内容会发送给你所用的模型服务。每次调用都受你的审批规则约束，你禁用的工具它用不了。删除这个信息来源后，分身立即不能再使用这个连接器。"
        which="connector"
      />
    </div>
  );
}

/** The picker or the form for the kind the draft is. */
function DraftFor({
  editor,
  idPrefix,
  links,
}: {
  editor: SourceEditor;
  idPrefix: string;
  /** Where My Devices, 知识库 and 已连接的账号 are; none during onboarding. */
  links?: { pairing: string; knowledge: string; accounts: string };
}) {
  if (editor.kind === "local_folder") {
    return (
      <FolderPicker
        editor={editor}
        idPrefix={idPrefix}
        pairingHref={links?.pairing}
      />
    );
  }
  if (editor.kind === "notebook") {
    return (
      <NotebookPicker
        editor={editor}
        idPrefix={idPrefix}
        knowledgeHref={links?.knowledge}
      />
    );
  }
  if (editor.kind === "connector") {
    return (
      <ConnectorPicker
        accountsHref={links?.accounts}
        editor={editor}
        idPrefix={idPrefix}
      />
    );
  }
  return (
    <>
      <DraftFields
        idPrefix={idPrefix}
        label={editor.label}
        note={editor.note}
        onLabel={editor.setLabel}
        onNote={editor.setNote}
      />
      <ModelNotice
        checked={editor.consent}
        id={`${idPrefix}-consent`}
        onChange={editor.setConsent}
      />
    </>
  );
}

/**
 * The onboarding step (spec D3, D8): save and continue, or skip and configure it later.
 *
 * Both ways out write the step to the server before moving on, so a reload comes back to the step
 * after this one; skipping writes no source and leaves the 分身 待配置.
 */
export function SourcesStep({
  nextStep,
  onAdvanced,
}: {
  /** The wizard step this one leads to. */
  nextStep: number;
  onAdvanced: () => void;
}) {
  const queryClient = useQueryClient();
  const editor = useSourceEditor();
  const advance = useMutation(advanceOnboardingMutationOptions(queryClient));
  const busy = editor.add.isPending || advance.isPending;

  const moveOn = () => advance.mutate(nextStep, { onSuccess: onAdvanced });

  const canAddAnother =
    editor.agreed && editor.drafted && !editor.problem && !editor.full;
  const canContinue = editor.drafted
    ? canAddAnother
    : editor.sources.length > 0;

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4">
      <h1 className="text-center text-3xl font-semibold tracking-tight">
        告诉你的分身，你的资料在哪里
      </h1>
      <p className="text-center text-muted-foreground text-sm">
        写下资料放在哪里、是什么，或者把你的本地文件夹、知识库、已连接的账号交给分身，它回答与你本人有关的问题时会参考这些信息来源。最多{" "}
        {AVATAR_SOURCE_LIMIT} 个，之后也可以在分身的详情页修改。
      </p>

      <SavedSources
        onRemove={(id) => editor.remove.mutate(id)}
        removingId={
          editor.remove.isPending ? (editor.remove.variables ?? null) : null
        }
        sources={editor.sources}
      />

      {editor.full ? (
        <p className="text-muted-foreground text-sm">
          已经登记了 {AVATAR_SOURCE_LIMIT} 个信息来源，这是上限。
        </p>
      ) : (
        <>
          <KindSwitch editor={editor} />
          <DraftFor editor={editor} idPrefix="onboarding-source" />
        </>
      )}

      {editor.drafted && editor.problem ? (
        <p className="text-muted-foreground text-sm">{editor.problem}</p>
      ) : null}
      {editor.add.error || advance.error || editor.remove.error ? (
        <p className="text-destructive text-sm" role="alert">
          {(editor.add.error ?? advance.error ?? editor.remove.error)?.message}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <Button
          disabled={busy || !canContinue}
          onClick={async () => {
            if (editor.drafted && !(await editor.saveDraft())) return;
            moveOn();
          }}
          size="lg"
        >
          {busy ? "正在保存…" : "保存并继续"}
        </Button>
        <Button
          disabled={busy || !canAddAnother}
          onClick={() => void editor.saveDraft()}
          size="lg"
          variant="outline"
        >
          保存，再加一个
        </Button>
        <Button disabled={busy} onClick={moveOn} size="lg" variant="ghost">
          跳过，稍后在分身详情页配置
        </Button>
      </div>
    </div>
  );
}

/** The 分身's detail page: list, add and remove, the same rules as the step. */
export function AvatarSourcesPanel({
  accountsHref = "/connections",
  knowledgeHref = "/capabilities/knowledge",
  pairingHref = "/settings",
}: {
  /** Where 已连接的账号 is, for a person with no connected account yet (S4). */
  accountsHref?: string;
  /** Where the 知识库 screen is, for a person with no notebook yet (S3). */
  knowledgeHref?: string;
  /** Where My Devices is, for the pairing guidance (D4). */
  pairingHref?: string;
} = {}) {
  const editor = useSourceEditor();

  if (editor.state.isPending) {
    return <p className="text-muted-foreground text-sm">正在加载信息来源…</p>;
  }
  if (editor.state.isError) {
    return (
      <p className="text-destructive text-sm" role="alert">
        {editor.state.error.message}
      </p>
    );
  }

  const canAdd =
    editor.agreed && editor.drafted && !editor.problem && !editor.full;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        已登记 {editor.sources.length}/{AVATAR_SOURCE_LIMIT}
        {editor.state.data?.configuredAt === null ? " · 待配置" : ""}
      </p>
      <SavedSources
        onRemove={(id) => editor.remove.mutate(id)}
        removingId={
          editor.remove.isPending ? (editor.remove.variables ?? null) : null
        }
        sources={editor.sources}
      />
      {editor.full ? (
        <p className="text-muted-foreground text-sm">
          已经登记了 {AVATAR_SOURCE_LIMIT} 个信息来源，这是上限。
        </p>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (canAdd) void editor.saveDraft();
          }}
        >
          <KindSwitch editor={editor} />
          <DraftFor
            editor={editor}
            idPrefix="avatar-source"
            links={{
              pairing: pairingHref,
              knowledge: knowledgeHref,
              accounts: accountsHref,
            }}
          />
          {editor.drafted && editor.problem ? (
            <p className="text-muted-foreground text-sm">{editor.problem}</p>
          ) : null}
          <div>
            <Button
              disabled={editor.add.isPending || !canAdd}
              size="sm"
              type="submit"
            >
              {editor.add.isPending ? "正在保存…" : "添加信息来源"}
            </Button>
          </div>
        </form>
      )}
      {editor.add.error || editor.remove.error ? (
        <p className="text-destructive text-sm" role="alert">
          {(editor.add.error ?? editor.remove.error)?.message}
        </p>
      ) : null}
    </div>
  );
}
